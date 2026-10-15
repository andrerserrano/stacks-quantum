import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './executor-fixture.mjs';
import { validateCandidate, verifyReviewedFiles, atomicWrite, json, sha256 } from '../snapshot/mainnet/execution.mjs';

async function run(fn) { const f = fixture(); try { await fn(f); } finally { f.cleanup(); } }
const edits = {
  testnet:c=>{c.chainId=2147483648;}, amount:c=>{c.amountSats='999';}, token:c=>{c.token='wrong.token';},
  priority:c=>{c.feePriority='high';}, cap:c=>{c.feeCapMicroStx='20000001';}, confirmations:c=>{c.confirmations=5;},
  reserve:c=>{c.submitterReserveMicroStx='2000001';}, bids:c=>{c.firstCallFeesMicroStx.open='1';},
  duplicateAccount:c=>{c.accounts.recipient=c.accounts.operator;}, wrongPublicKey:c=>{c.accounts.operator.publicKey=c.accounts.submitter.publicKey;},
  negativeNonce:c=>{c.accounts.operator.startNonce='-1';}, wrongVault:c=>{c.vault+='2';}, wrongRecipient:c=>{c.recipient=c.accounts.operator.address;},
  shortKey:c=>{c.keyCommitment='00';}, reusedSuccessor:c=>{c.nextKey=c.keyCommitment;}, wrongId:c=>{c.vaultId='00'.repeat(32);},
  wrongDigest:c=>{c.digest='00'.repeat(32);}, extraDeployment:c=>{c.sources.extra=c.sources.lamport;},
  changedSource:c=>{c.sources.lamport.code+='\n';}, missingTokenPin:c=>{delete c.tokenSourceHashes['sbtc-registry'];},
};
for (const [name, edit] of Object.entries(edits)) test(`candidate rejects ${name}`,()=>run(async f=>{
  edit(f.c); assert.throws(()=>validateCandidate(f.c)); assert.equal(f.secretReads(),0); assert.equal(f.chain.broadcasts.length,0);
}));

test('reviewed-file checks reject traversal and changed bytes',()=>run(async f=>{
  for (const name of ['../bad','/tmp/bad']) { f.c.reviewedFiles = {[name]:'00'.repeat(32)}; assert.throws(()=>verifyReviewedFiles(f.c,f.root),/Unsafe/); }
  atomicWrite(join(f.root,'public.txt'),'reviewed'); f.c.reviewedFiles={'public.txt':sha256('reviewed')};
  verifyReviewedFiles(f.c,f.root); atomicWrite(join(f.root,'public.txt'),'changed'); assert.throws(()=>verifyReviewedFiles(f.c,f.root),/Reviewed file changed/);
}));

const guards = [
  ['missing nonces',0,f=>{f.chain.missing=[0];},/unresolved/],
  ['changed token source',0,f=>{f.chain.sources.set(f.c.token,'changed');},/source changed/],
  ['occupied contract',0,f=>{f.chain.sources.set(`${f.c.accounts.operator.address}.lamport`,'occupied');},/occupied/],
  ['insufficient agreed reserve',0,f=>{f.chain.stx[f.c.accounts.operator.address]=19_999_999n;},/20 STX funding reserve/],
  ['missing vault',4,f=>{f.chain.vault=null;},/vault state differs/],
  ['wrong vault nonce',4,f=>{f.chain.vault.nonce='1';},/vault state differs/],
  ['wrong vault key',4,f=>{f.chain.vault.key='00'.repeat(32);},/vault state differs/],
  ['insufficient operator tokens',4,f=>{f.chain.tokens[f.c.accounts.operator.address]=999n;},/1,000 sats/],
  ['insufficient top-up principal',5,f=>{f.chain.stx[f.c.accounts.operator.address]=2_000_000n;},/Fund operator/],
  ['insufficient submitter fee balance',6,f=>{f.chain.stx[f.c.accounts.submitter.address]=999n;},/Fund submitter/],
];
for (const [label,count,edit,pattern] of guards) test(`unsigned stop: ${label}`,()=>run(async f=>{
  await f.prefix(count); edit(f); const reads=f.secretReads(), broadcasts=f.chain.broadcasts.length;
  await assert.rejects(f.make().advance(),pattern); assert.equal(f.secretReads(),reads); assert.equal(f.chain.broadcasts.length,broadcasts);
  assert.equal(existsSync(join(f.root,'authorization.json')),false);
}));

for (const fee of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'1000',NaN]) test(`invalid fee quote rejected (${String(fee)})`,()=>run(async f=>{
  f.chain.fees[0]=fee; await assert.rejects(f.e.advance(),/fee estimate/); assert.equal(f.secretReads(),0);
}));

const receipts = [
  ['wrong transaction ID',t=>{t.tx_id='0x'+'00'.repeat(32);},/identity/],
  ['wrong sender',t=>{t.sender_address='wrong';},/identity/], ['wrong nonce',t=>{t.nonce=99;},/identity/],
  ['wrong fee',t=>{t.fee_rate='999';},/identity/], ['wrong result',t=>{t.tx_result.repr='(ok false)';},/result/],
  ['noncanonical microblock',t=>{t.microblock_canonical=false;},/noncanonical/],
];
for (const [label,edit,pattern] of receipts) test(`receipt refuses ${label}`,()=>run(async f=>{
  await f.prefix(1); edit(f.chain.txs.get(f.e.state().records[0].txid));
  await assert.rejects(f.e.advance(),pattern); assert.equal(f.secretReads(),1); assert.equal(f.chain.broadcasts.length,1);
}));

test('VM failure retains fee reservation and stops the sequence',()=>run(async f=>{
  await f.e.advance(); f.mine('abort_by_response'); await assert.rejects(f.e.advance(),/failed/);
  assert.equal(f.e.reserved(f.e.state()),1000n); assert.equal(f.chain.broadcasts.length,1);
}));

for (const field of ['candidateHash','role','nonce','wireSha256']) test(`tampered saved ${field} fails closed`,()=>run(async f=>{
  await f.prefix(1); const s=f.e.state();
  if(field==='candidateHash')s.candidateHash='wrong'; else s.records[0][field]='wrong';
  atomicWrite(join(f.root,'execution.json'),json(s));
  await assert.rejects(f.make().advance()); assert.equal(f.secretReads(),1); assert.equal(f.chain.broadcasts.length,1);
}));

test('a surviving journal cannot be adopted into an untracked run',()=>run(async f=>{
  mkdirSync(join(f.root,'journal')); await assert.rejects(f.e.advance(),/Untracked signing state/);
  assert.equal(f.secretReads(),0); assert.equal(existsSync(join(f.root,'initialized.json')),false);
}));

test('crash after durable authorization, before outer transaction: reuse exact authorization',()=>run(async f=>{
  await f.prefix(6); await f.e.authorization(); const auth=readFileSync(join(f.root,'authorization.json'),'utf8'), reads=f.secretReads();
  assert.equal(f.e.state().records.length,6); assert.equal(readdirSync(join(f.root,'journal')).length,1);
  assert.equal((await f.make().advance()).status,'broadcast'); assert.equal(f.secretReads(),reads+1,'only the ordinary account is loaded');
  assert.equal(readFileSync(join(f.root,'authorization.json'),'utf8'),auth); f.mine(); assert.equal((await f.e.advance()).status,'complete');
}));

for (const mode of ['wrong digest','invalid signature','lost claim']) test(`saved authorization refuses ${mode} before ordinary signing`,()=>run(async f=>{
  await f.prefix(6); await f.e.authorization();
  const path=join(f.root,'authorization.json'), a=JSON.parse(readFileSync(path));
  if(mode==='wrong digest')a.digest='00'.repeat(32);
  if(mode==='invalid signature')a.signature[0]='00'.repeat(32);
  if(mode==='lost claim')rmSync(join(f.root,'journal',`${f.c.keyCommitment}.json`));
  atomicWrite(path,json(a)); const reads=f.secretReads(); await assert.rejects(f.make().advance());
  assert.equal(f.secretReads(),reads); assert.equal(f.chain.broadcasts.length,6);
}));

test('custody master mismatch stops before claiming a one-time key',()=>run(async f=>{
  await f.prefix(6); f.keys.master='00'.repeat(32); await assert.rejects(f.e.advance(),/commitments differ/);
  assert.equal(readdirSync(join(f.root,'journal')).length,0); assert.equal(f.chain.broadcasts.length,6);
}));

test('simultaneous executors share one exclusive writer lock',()=>run(async f=>{
  let release, entered; const ready=new Promise(r=>{entered=r;}), gate=new Promise(r=>{release=r;});
  const info=f.api.info; let first=true;
  f.api.info=async()=>{if(first){first=false;entered();await gate;}return info();};
  const firstRun=f.e.advance(); await ready;
  await assert.rejects(f.make().advance(),/lock exists/); release(); await firstRun;
  assert.equal(f.chain.broadcasts.length,1);
}));

test('crash after journal claim but before authorization can only resume that same digest',()=>run(async f=>{
  await f.prefix(6);
  const {fileJournal}=await import('../snapshot/source/vault/src/journal.mjs');
  fileJournal(join(f.root,'journal')).claim(f.c.keyCommitment,{digest:f.c.digest});
  assert.equal(existsSync(join(f.root,'authorization.json')),false);
  await f.make().advance(); f.mine(); assert.equal((await f.e.advance()).status,'complete');
  assert.equal(readdirSync(join(f.root,'journal')).length,1);
}));

test('ordinary signing failure after Lamport persistence preserves authorization for recovery',()=>run(async f=>{
  await f.prefix(6);const correct=f.keys.submitter;f.keys.submitter=f.keys.operator;
  await assert.rejects(f.e.advance(),/Signing account differs/);
  const auth=readFileSync(join(f.root,'authorization.json'),'utf8');assert.equal(f.e.state().records.length,6);
  f.keys.submitter=correct;await f.make().advance();assert.equal(readFileSync(join(f.root,'authorization.json'),'utf8'),auth);
  f.mine();assert.equal((await f.e.advance()).status,'complete');
}));

test('lost withdrawal reply after acceptance never signs or broadcasts another instruction',()=>run(async f=>{
  await f.prefix(6);f.chain.loseReply='after';await assert.rejects(f.e.advance(),/Lost reply/);
  const reads=f.secretReads(),wire=f.e.state().records[6].wire;
  assert.equal((await f.make().advance()).status,'pending');assert.equal(f.secretReads(),reads);assert.equal(f.chain.broadcasts.length,7);
  assert.equal(f.e.state().records[6].wire,wire);f.mine();assert.equal((await f.e.advance()).status,'complete');
}));

test('a wrong broadcast reply ID leaves durable state for reconciliation, not a new signature',()=>run(async f=>{
  const broadcast=f.api.broadcast;f.api.broadcast=async tx=>{await broadcast(tx);return {txid:'00'.repeat(32)};};
  await assert.rejects(f.e.advance(),/Broadcast reply uncertain/);const reads=f.secretReads();
  assert.equal((await f.make().advance()).status,'pending');assert.equal(f.secretReads(),reads);assert.equal(f.chain.broadcasts.length,1);
}));

test('exact 20 STX cumulative fee boundary succeeds without exceeding either funded account',()=>run(async f=>{
  f.chain.fees=[17_995_000,1000,1000,1000,1000,1000,2_000_000];
  await f.prefix(7);assert.equal((await f.e.advance()).status,'complete');assert.equal(f.e.reserved(f.e.state()),20_000_000n);
  assert.equal(f.chain.stx[f.c.accounts.operator.address],0n);assert.equal(f.chain.stx[f.c.accounts.submitter.address],0n);
}));
