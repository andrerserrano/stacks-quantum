// Audit harness adapted from the frozen synthetic-key fixture. No real custody or HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import stacks from '../snapshot/source/vault/node_modules/@stacks/transactions/dist/index.js';
import { Executor, TOKEN, LABELS, sha256, json, atomicWrite, buildTransaction } from '../snapshot/mainnet/execution.mjs';
import { wallet, withdrawalDigest } from '../snapshot/source/vault/src/vault.mjs';
import { fileJournal } from '../snapshot/source/vault/src/journal.mjs';
import * as lamport from '../snapshot/source/vault/src/lamport.mjs';

const { Cl, getAddressFromPrivateKey, privateKeyToPublic, TransactionSigner, PostConditionMode } = stacks;
const source = name => readFileSync(new URL(`../snapshot/mainnet/contracts/${name}.clar`, import.meta.url), 'utf8');
const principal = cv => Cl.prettyPrint(cv).replace(/^'/, '');

export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pq-mainnet-executor-test-'));
  // Public deterministic test keys only; no publicManifest(), Keychain or HTTP.
  const keys = Object.fromEntries(['operator','submitter','recipient'].map(role => [role, sha256(`executor-public-test/${role}`) + '01']));
  keys.master = sha256('executor-public-test/lamport-master');
  const accounts = Object.fromEntries(['operator','submitter','recipient'].map(role => [role, { address: getAddressFromPrivateKey(keys[role], 'mainnet'), publicKey: privateKeyToPublic(keys[role]), startNonce: '0' }]));
  const vault = `${accounts.operator.address}.pq-vault`, verifier = `${accounts.operator.address}.lamport`;
  const owner = wallet({ master: Buffer.from(keys.master,'hex'), chainId: 1, vault, verifier, scheme: 'lamport', account: 0 });
  const request = owner.withdrawal({ nonce: 0, asset: 'sbtc', amount: 1000n, recipient: accounts.recipient.address });
  const tokenSources = Object.fromEntries(['sbtc-token','sbtc-registry'].map(name => [name, readFileSync(new URL(`../snapshot/mainnet/evidence/${name}.deployed.clar`, import.meta.url),'utf8')]));
  const c = { schema: 1, network: 'mainnet', chainId: 1, token: TOKEN, amountSats: '1000', feeCapMicroStx: '20000000', feePriority: 'low', confirmations: 6, submitterReserveMicroStx: '2000000', firstCallFeesMicroStx: { 'open-vault': '250000', 'deposit-sbtc': '500000', 'withdraw-sbtc': '1500000' }, accounts, vault, verifier, recipient: accounts.recipient.address, vaultId: owner.id.toString('hex'), keyCommitment: owner.key(0).toString('hex'), nextKey: owner.key(1).toString('hex'), digest: request.digest.toString('hex'), sources: Object.fromEntries(['pq-verifier-trait','lamport','pq-vault'].map(name=>[name,{code:source(name),sha256:sha256(source(name))}])), tokenSourceHashes: Object.fromEntries(Object.entries(tokenSources).map(([name,code])=>[name,sha256(code.trim())])), reviewedFiles: {} };
  const chain = {
    height: 100, networkId: 1, sources: new Map(Object.entries(tokenSources).map(([name,code])=>[`${TOKEN.split('.')[0]}.${name}`,code])),
    txs: new Map(), blocks: new Map(), eventMap: new Map(), broadcasts: [], fees: Array(7).fill(1000),
    nonce: Object.fromEntries(Object.values(accounts).map(a=>[a.address,0])),
    stx: { [accounts.operator.address]:20_000_000n,[accounts.submitter.address]:0n,[accounts.recipient.address]:0n },
    tokens: { [accounts.operator.address]:1000n,[vault]:0n,[accounts.recipient.address]:0n },
    missing: [], mempool: [], vault: null, loseReply: null, wrongDigest: false,
  };
  let secretReads = 0;
  const api = {
    async info(){return { network_id: chain.networkId, stacks_tip_height: chain.height };},
    async source(p){return chain.sources.has(p)?{source:chain.sources.get(p)}:null;},
    async transaction(id){return chain.txs.get(id)??null;},
    async block(height){return chain.blocks.get(height)??null;},
    async events(id){return chain.eventMap.get(id)??[];},
    async account(address){return { nonce:String(chain.nonce[address]),availableStx:String(chain.stx[address]),missingNonces:chain.missing,mempoolNonces:chain.mempool };},
    async tokenBalance(address){return String(chain.tokens[address]??0n);},
    async read(fn,args){
      if(fn==='get-vault')return chain.vault?Cl.some(Cl.tuple({key:Cl.bufferFromHex(chain.vault.key),nonce:Cl.uint(chain.vault.nonce),sbtc:Cl.uint(chain.vault.sbtc),stx:Cl.uint(0),verifier:Cl.principal(c.verifier)})):Cl.none();
      if(fn==='withdrawal-digest')return Cl.bufferFromHex(chain.wrongDigest?'01'.repeat(32):withdrawalDigest({vault:c.vault,chainId:1,id:Buffer.from(args[0].value,'hex'),nonce:Number(args[1].value),asset:args[2].value,amount:args[3].value,recipient:principal(args[4]),nextKey:Buffer.from(args[5].value,'hex')}).toString('hex'));
      throw Error('Unexpected read function');
    },
    async estimate(tx){
      const p=tx.payload;
      const index=p.codeBody?LABELS.indexOf(`deploy-${p.contractName.content}`):p.functionName?({open:3,'deposit-sbtc':4,'withdraw-sbtc':6})[p.functionName.content]:5;
      if(chain.fees[index]===null)throw Error('No executable fee estimate');
      if(chain.fees[index]==='first-call')return {reason:'NoEstimateAvailable'};
      return [{fee:chain.fees[index]}];
    },
    async broadcast(tx){
      const persisted=JSON.parse(readFileSync(join(root,'execution.json'),'utf8')).records.at(-1);
      assert.equal(persisted.wire,tx.serialize(),'signed bytes must be durable before broadcast');
      assert.equal(persisted.txid,`0x${tx.txid()}`);
      assert.equal(statSync(join(root,'execution.json')).mode&0o777,0o600);
      tx.verifyOrigin(); assert.equal(tx.chainId,1); assert.equal(tx.postConditionMode,PostConditionMode.Deny);
      chain.broadcasts.push(tx.serialize());
      if(chain.loseReply==='before'){chain.loseReply=null;throw Error('Lost reply before acceptance');}
      chain.txs.set(persisted.txid,{tx_status:'pending'});
      if(chain.loseReply==='after'){chain.loseReply=null;throw Error('Lost reply after acceptance');}
      return {txid:tx.txid()};
    },
  };
  const make=()=>new Executor({candidate:c,candidateHash:sha256(json(c)),root,api,loadSecrets:()=>{secretReads++;return keys;}});
  const e=make();
  function mine(status='success',depth=6){
    const r=JSON.parse(readFileSync(join(root,'execution.json'),'utf8')).records.at(-1);
    const sender=c.accounts[r.role].address, index=LABELS.indexOf(r.label);
    assert.equal(chain.nonce[sender],Number(r.nonce));
    chain.nonce[sender]++; chain.stx[sender]-=BigInt(r.fee);
    const blockHeight=chain.height+1,hash=`0x${sha256('block/'+blockHeight)}`;
    chain.blocks.set(blockHeight,{canonical:true,hash});chain.height=blockHeight+depth-1;
    let result='(ok true)',events=[];
    const ft=(from,to,amount)=>({event_type:'fungible_token_asset',asset:{asset_event_type:'transfer',asset_id:`${TOKEN}::sbtc-token`,sender:from,recipient:to,amount:String(amount)}});
    if(status==='success'){
      if(index<3){const name=LABELS[index].slice(7);chain.sources.set(`${c.accounts.operator.address}.${name}`,c.sources[name].code);}
      if(index===3){chain.vault={key:c.keyCommitment,nonce:'0',sbtc:'0'};result=`(ok 0x${c.vaultId})`;}
      if(index===4){chain.tokens[c.accounts.operator.address]-=1000n;chain.tokens[vault]+=1000n;chain.vault.sbtc='1000';events=[ft(c.accounts.operator.address,vault,1000)];}
      if(index===5){chain.stx[c.accounts.operator.address]-=2_000_000n;chain.stx[c.accounts.submitter.address]+=2_000_000n;events=[{event_type:'stx_asset',asset:{asset_event_type:'transfer',sender:c.accounts.operator.address,recipient:c.accounts.submitter.address,amount:'2000000'}}];}
      if(index===6){
        const auth=JSON.parse(readFileSync(join(root,'authorization.json'),'utf8'));
        assert.equal(lamport.verify(Buffer.from(c.keyCommitment,'hex'),Buffer.from(c.digest,'hex'),auth.signature.map(w=>Buffer.from(w,'hex'))),true);
        chain.tokens[vault]-=1000n;chain.tokens[c.recipient]+=1000n;
        chain.vault={key:c.nextKey,nonce:'1',sbtc:'0'};events=[ft(vault,c.recipient,1000)];
      }
    }
    chain.eventMap.set(r.txid,events);
    chain.txs.set(r.txid,{tx_id:r.txid,sender_address:sender,nonce:Number(r.nonce),fee_rate:r.fee,tx_status:status,canonical:true,microblock_canonical:true,is_unanchored:false,block_height:blockHeight,block_hash:hash,tx_result:{repr:result}});
    return r;
  }
  async function prefix(count){for(let i=0;i<count;i++){const r=await e.advance();assert.equal(r.status,'broadcast');mine();}}
  return {root,c,keys,owner,chain,api,e,make,mine,prefix,secretReads:()=>secretReads,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
