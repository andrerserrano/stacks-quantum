import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import stacks from '../source/vault/node_modules/@stacks/transactions/dist/index.js';
import { Executor, TOKEN, LABELS, sha256, json, atomicWrite, buildTransaction } from './execution.mjs';
import { wallet, withdrawalDigest } from '../source/vault/src/vault.mjs';
import { fileJournal } from '../source/vault/src/journal.mjs';
import * as lamport from '../source/vault/src/lamport.mjs';

const { Cl, getAddressFromPrivateKey, privateKeyToPublic, TransactionSigner, PostConditionMode } = stacks;
const source = name => readFileSync(new URL(`./contracts/${name}.clar`, import.meta.url), 'utf8');
const principal = cv => Cl.prettyPrint(cv).replace(/^'/, '');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pq-mainnet-executor-test-'));
  // Public deterministic test keys only; no publicManifest(), Keychain or HTTP.
  const keys = Object.fromEntries(['operator','submitter','recipient'].map(role => [role, sha256(`executor-public-test/${role}`) + '01']));
  keys.master = sha256('executor-public-test/lamport-master');
  const accounts = Object.fromEntries(['operator','submitter','recipient'].map(role => [role, { address: getAddressFromPrivateKey(keys[role], 'mainnet'), publicKey: privateKeyToPublic(keys[role]), startNonce: '0' }]));
  const vault = `${accounts.operator.address}.pq-vault`, verifier = `${accounts.operator.address}.lamport`;
  const owner = wallet({ master: Buffer.from(keys.master,'hex'), chainId: 1, vault, verifier, scheme: 'lamport', account: 0 });
  const request = owner.withdrawal({ nonce: 0, asset: 'sbtc', amount: 1000n, recipient: accounts.recipient.address });
  const tokenSources = Object.fromEntries(['sbtc-token','sbtc-registry'].map(name => [name, readFileSync(new URL(`./evidence/${name}.deployed.clar`, import.meta.url),'utf8')]));
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

async function run(fn){const f=fixture();try{await fn(f);}finally{f.cleanup();}}

test('seven mainnet transactions: real SDK signatures, independent carrier, canonical evidence and one durable Lamport claim',()=>run(async f=>{
  for(let i=0;i<7;i++){
    assert.equal((await f.e.advance()).label,LABELS[i]);
    assert.equal(existsSync(join(f.root,'authorization.json')),i===6);
    f.mine();
  }
  const done=await f.e.advance();assert.equal(done.status,'complete');assert.equal(done.totalReservedFeesMicroStx,'7000');
  assert.equal((await f.e.inspect()).complete,true);assert.equal(f.chain.tokens[f.c.recipient],1000n);
  assert.deepEqual(f.chain.vault,{key:f.c.nextKey,nonce:'1',sbtc:'0'});
  assert.equal(readdirSync(join(f.root,'journal')).length,1);
  assert.equal(statSync(join(f.root,'authorization.json')).mode&0o777,0o600);
  const persisted=readFileSync(join(f.root,'execution.json'),'utf8');
  for(const secret of Object.values(f.keys))assert.equal(persisted.includes(secret),false);
  const count=f.chain.broadcasts.length;assert.equal((await f.e.advance()).status,'complete');assert.equal(f.chain.broadcasts.length,count);
}));

test('unfunded operator cannot access custody, initialize a journal, sign or broadcast',()=>run(async f=>{
  f.chain.stx[f.c.accounts.operator.address]=0n;
  await assert.rejects(f.e.advance(),/Fund operator/);
  assert.equal(f.secretReads(),0);assert.equal(f.chain.broadcasts.length,0);assert.equal(existsSync(join(f.root,'initialized.json')),false);
}));

test('operator sBTC funding is required before spending the first deployment fee',()=>run(async f=>{
  f.chain.tokens[f.c.accounts.operator.address]=0n;
  await assert.rejects(f.e.advance(),/1,000 sats/);assert.equal(f.secretReads(),0);
}));

test('wrong network stops before custody access',()=>run(async f=>{
  f.chain.networkId=0x80000000;await assert.rejects(f.e.advance(),/Mainnet/);assert.equal(f.secretReads(),0);
}));

test('fee above the whole cap stops before any signature',()=>run(async f=>{
  f.chain.fees[0]=20_000_001;await assert.rejects(f.e.advance(),/20 STX funded reserve/);assert.equal(f.secretReads(),0);
}));

test('fee cap includes every previously signed transaction, not just the next fee',()=>run(async f=>{
  f.chain.stx[f.c.accounts.operator.address]=100_000_000n;f.chain.fees=[6_000_000,6_000_000,6_000_000,1000,1000,1000,1000];
  // Initial prices fit at the time of the first preflight; they rise later.
  f.chain.fees[0]=1_000_000;
  await f.prefix(1);f.chain.fees[0]=6_000_000;f.chain.fees[1]=8_500_000;f.chain.fees[2]=8_500_000;
  await f.prefix(2);f.chain.fees[3]=3_000_000;await assert.rejects(f.e.advance(),/Cumulative 20 STX/);
  assert.equal(f.secretReads(),3);assert.equal(f.chain.broadcasts.length,3);
}));

test('initial preflight is read-only and uses explicit first-call bids without claiming any key',()=>run(async f=>{
  f.chain.fees[3]=f.chain.fees[4]=f.chain.fees[6]='first-call';
  const p=await f.e.preflight();assert.equal(p.feesFitFundedReserve,true);assert.equal(p.fundingPresent,true);
  assert.equal(p.quotes.length,7);assert.equal(p.quotedOrExplicitFeesMicroStx,'2254000');
  assert.equal(f.secretReads(),0);assert.equal(existsSync(join(f.root,'initialized.json')),false);assert.equal(f.chain.broadcasts.length,0);
}));

test('missing withdrawal fee quote never claims the one-time key',()=>run(async f=>{
  await f.prefix(6);f.chain.fees[6]=null;const reads=f.secretReads();
  await assert.rejects(f.e.advance(),/fee estimate/);assert.equal(f.secretReads(),reads);
  assert.deepEqual(readdirSync(join(f.root,'journal')),[]);assert.equal(existsSync(join(f.root,'authorization.json')),false);
}));

test('wrong on-chain mainnet digest never claims the one-time key',()=>run(async f=>{
  await f.prefix(6);f.chain.wrongDigest=true;const reads=f.secretReads();
  await assert.rejects(f.e.advance(),/digest differs/);assert.equal(f.secretReads(),reads);assert.deepEqual(readdirSync(join(f.root,'journal')),[]);
}));

test('lost reply after acceptance reconciles the existing pending tx without another signature',()=>run(async f=>{
  f.chain.loseReply='after';await assert.rejects(f.e.advance(),/Lost reply/);
  const reads=f.secretReads(),saved=readFileSync(join(f.root,'execution.json'),'utf8');
  assert.equal((await f.make().advance()).status,'pending');assert.equal(f.secretReads(),reads);
  assert.equal(readFileSync(join(f.root,'execution.json'),'utf8'),saved);assert.equal(f.chain.broadcasts.length,1);
}));

test('lost reply before acceptance rebroadcasts exactly the saved bytes without custody access',()=>run(async f=>{
  f.chain.loseReply='before';await assert.rejects(f.e.advance(),/Lost reply/);const reads=f.secretReads();
  assert.equal((await f.make().advance()).status,'broadcast');assert.equal(f.secretReads(),reads);
  assert.equal(f.chain.broadcasts[0],f.chain.broadcasts[1]);
}));

test('dropped transaction is retried as the same transaction, with the same fee reservation',()=>run(async f=>{
  await f.e.advance();const s=f.e.state(),r=s.records[0];f.chain.txs.set(r.txid,{tx_status:'dropped_replace_by_fee'});
  await f.make().advance();assert.equal(f.chain.broadcasts[0],f.chain.broadcasts[1]);assert.equal(f.e.reserved(f.e.state()),1000n);
}));

test('a consumed account nonce with an unknown transaction stops rebroadcast',()=>run(async f=>{
  f.chain.loseReply='before';await assert.rejects(f.e.advance());f.chain.nonce[f.c.accounts.operator.address]=1;
  await assert.rejects(f.make().advance(),/nonce changed/);assert.equal(f.chain.broadcasts.length,1);assert.equal(f.secretReads(),1);
}));

test('success with too few canonical confirmations cannot advance',()=>run(async f=>{
  await f.e.advance();f.mine('success',1);assert.equal((await f.e.advance()).status,'confirming');assert.equal(f.chain.broadcasts.length,1);
}));

test('a predecessor reorganization stops all subsequent signing',()=>run(async f=>{
  await f.prefix(1);await f.e.advance();const first=f.e.state().records[0];f.chain.txs.get(first.txid).canonical=false;
  await assert.rejects(f.make().advance(),/noncanonical/);assert.equal(f.chain.broadcasts.length,2);assert.equal(f.secretReads(),2);
}));

test('post-condition abort consumes a counted fee but cannot be mistaken for payout or rotate the Lamport key',()=>run(async f=>{
  await f.prefix(6);await f.e.advance();f.mine('abort_by_post_condition');
  await assert.rejects(f.e.advance(),/failed.*abort_by_post_condition/);
  assert.equal(f.e.reserved(f.e.state()),7000n);assert.equal(f.chain.tokens[f.c.recipient],0n);assert.equal(f.chain.vault.nonce,'0');
  assert.equal(readdirSync(join(f.root,'journal')).length,1);assert.equal((await f.e.inspect()).complete,false);
}));

test('a modified stored payload is rejected even if its signature, txid and local wire hash were recomputed',()=>run(async f=>{
  f.chain.loseReply='before';await assert.rejects(f.e.advance());
  const s=f.e.state(),r=s.records[0],tx=await buildTransaction(f.c,0,r.nonce,r.fee);
  tx.payload.codeBody.content+='\n;; unreviewed edit\n';new TransactionSigner(tx).signOrigin(f.keys.operator);
  r.wire=tx.serialize();r.txid=`0x${tx.txid()}`;r.wireSha256=sha256(tx.serializeBytes());atomicWrite(join(f.root,'execution.json'),json(s));
  await assert.rejects(f.make().advance(),/payload\/post-conditions differ/);assert.equal(f.chain.broadcasts.length,1);
}));

test('mempool conflicts stop before custody access',()=>run(async f=>{
  f.chain.mempool=[0];await assert.rejects(f.e.advance(),/mempool/);assert.equal(f.secretReads(),0);
}));

test('a deployed source mismatch stops before funding or subsequent deployment',()=>run(async f=>{
  await f.prefix(1);f.chain.sources.set(`${f.c.accounts.operator.address}.pq-verifier-trait`,'different source');
  await assert.rejects(f.e.advance(),/does not match candidate/);assert.equal(f.chain.broadcasts.length,1);
}));

test('wrong token-transfer event cannot satisfy deposit evidence',()=>run(async f=>{
  await f.prefix(5);const r=f.e.state().records.at(-1);f.chain.eventMap.get(r.txid)[0].asset.recipient=f.c.recipient;
  await assert.rejects(f.e.advance(),/differs from signed plan/);assert.equal(f.chain.broadcasts.length,5);
}));

test('an inconsistent actual token balance and internal ledger stop before deposit',()=>run(async f=>{
  await f.prefix(4);f.chain.tokens[f.c.vault]=1n;await assert.rejects(f.e.advance(),/token balance differs/);assert.equal(f.chain.broadcasts.length,4);
}));

test('missing journal after initialization fails closed instead of creating an empty signer history',()=>run(async f=>{
  await f.prefix(1);rmSync(join(f.root,'journal'),{recursive:true});const reads=f.secretReads();
  await assert.rejects(f.make().advance(),/journal directory missing/);assert.equal(f.secretReads(),reads);
}));

test('missing state with a surviving initialization marker requires recovery',()=>run(async f=>{
  await f.prefix(1);rmSync(join(f.root,'execution.json'));await assert.rejects(f.make().advance(),/state\/initialization marker missing/);
}));

test('a second executor cannot run while the single-writer lock exists',()=>run(async f=>{
  mkdirSync(join(f.root,'executor.lock'));await assert.rejects(f.e.advance(),/Executor lock exists/);assert.equal(f.secretReads(),0);
}));

test('persistent claim for a different digest prevents Lamport signing',()=>run(async f=>{
  await f.prefix(6);fileJournal(join(f.root,'journal')).claim(f.c.keyCommitment,{digest:'ff'.repeat(32),amount:'999',asset:'sbtc',recipient:f.c.recipient});
  await assert.rejects(f.e.advance(),/already signed/);assert.equal(existsSync(join(f.root,'authorization.json')),false);assert.equal(f.chain.broadcasts.length,6);
}));

test('withdrawal retry preserves the exact saved Lamport authorization and ordinary signed bytes',()=>run(async f=>{
  await f.prefix(6);f.chain.loseReply='before';await assert.rejects(f.e.advance(),/Lost reply/);
  const auth=readFileSync(join(f.root,'authorization.json'),'utf8'),reads=f.secretReads();
  await f.make().advance();assert.equal(readFileSync(join(f.root,'authorization.json'),'utf8'),auth);assert.equal(f.secretReads(),reads);
  assert.equal(f.chain.broadcasts.at(-1),f.chain.broadcasts.at(-2));assert.equal(readdirSync(join(f.root,'journal')).length,1);
}));

test('fee too large for the submitter reserve stops before the operator sends its top-up',()=>run(async f=>{
  await f.prefix(5);f.chain.fees[6]=2_000_001;const reads=f.secretReads();
  await assert.rejects(f.e.advance(),/exceeds pinned submitter reserve/);assert.equal(f.secretReads(),reads);assert.equal(f.chain.broadcasts.length,5);
}));

test('only NoEstimateAvailable enables the exact reviewed first-call bids, all counted against the cap',()=>run(async f=>{
  f.chain.fees[3]=f.chain.fees[4]=f.chain.fees[6]='first-call';
  await f.prefix(7);assert.equal((await f.e.advance()).status,'complete');
  const r=f.e.state().records;
  assert.equal(r[3].fee,'250000');assert.equal(r[4].fee,'500000');assert.equal(r[6].fee,'1500000');
  assert.match(r[6].feeBasis,/Explicit first-call bid/);assert.equal(f.e.reserved(f.e.state()),2_254_000n);
}));

test('a deployment without an estimate cannot borrow a first-call fee policy',()=>run(async f=>{
  f.chain.fees[0]='first-call';await assert.rejects(f.e.advance(),/no explicitly reviewed/);assert.equal(f.secretReads(),0);
}));

test('lost authorization file stops a withdrawal retry without another signature',()=>run(async f=>{
  await f.prefix(6);f.chain.loseReply='before';await assert.rejects(f.e.advance());
  const reads=f.secretReads();rmSync(join(f.root,'authorization.json'));
  await assert.rejects(f.make().advance(),/authorization missing/);assert.equal(f.secretReads(),reads);assert.equal(f.chain.broadcasts.length,7);
}));

test('lost journal claim stops a withdrawal retry without replacing signing history',()=>run(async f=>{
  await f.prefix(6);f.chain.loseReply='before';await assert.rejects(f.e.advance());
  const reads=f.secretReads();rmSync(join(f.root,'journal',`${f.c.keyCommitment}.json`));
  await assert.rejects(f.make().advance());assert.equal(f.secretReads(),reads);assert.equal(f.chain.broadcasts.length,7);
}));

test('a transaction whose block hash no longer matches the canonical block cannot advance',()=>run(async f=>{
  await f.prefix(1);const r=f.e.state().records[0],tx=f.chain.txs.get(r.txid);f.chain.blocks.get(tx.block_height).hash='0x'+'ff'.repeat(32);
  await assert.rejects(f.e.advance(),/block is no longer canonical/);assert.equal(f.secretReads(),1);
}));

test('an unanchored receipt cannot satisfy the confirmation policy',()=>run(async f=>{
  await f.prefix(1);f.chain.txs.get(f.e.state().records[0].txid).is_unanchored=true;
  await assert.rejects(f.e.advance(),/unanchored/);assert.equal(f.chain.broadcasts.length,1);
}));

test('a wrong token asset in the withdrawal event cannot mark the demo complete',()=>run(async f=>{
  await f.prefix(7);const id=f.e.state().records[6].txid;f.chain.eventMap.get(id)[0].asset.asset_id='wrong.token::sbtc-token';
  await assert.rejects(f.e.advance(),/Wrong fungible-token/);assert.equal(f.chain.broadcasts.length,7);
}));

test('recipient balance evidence must independently agree with the payout event',()=>run(async f=>{
  await f.prefix(7);f.chain.tokens[f.c.recipient]=999n;
  await assert.rejects(f.e.advance(),/balance did not increase/);assert.equal(f.chain.broadcasts.length,7);
}));
