import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import stacks from '../snapshot/source/vault/node_modules/@stacks/transactions/dist/index.js';
import { keySecret, sigCV, withdrawalDigest } from '../snapshot/source/vault/src/vault.mjs';
import * as lamport from '../snapshot/source/vault/src/lamport.mjs';
import { boot, operator, submitter, recipient, vault, verifier, TOKEN } from './clarity-fixture.mjs';

const { Cl }=stacks, show=r=>Cl.prettyPrint(r.result);
async function run(fn) { const t=await boot(); try {await fn(t);} finally {rmSync(t.dir,{recursive:true,force:true});} }
function rejected(t,r,before,expected) {assert.equal(show(r),expected);assert.deepEqual(t.snapshot(),before);assert.deepEqual(r.events,[]);}

test('official-token vault rejects all malformed Lamport lengths with contract errors and rollback',()=>run(async t=>{
  const r=t.sign(), before=t.snapshot();
  for (const n of [0,1,255,256,511,513,1024]) {
    const sig=Array.from({length:n},(_,i)=>r.sig[i%512]);
    rejected(t,t.withdraw(r,{sig}),before,'(err u205)');
  }
  for (const i of [0,255,256,511]) for (const n of [0,1,31]) {
    const sig=r.sig.map((w,j)=>j===i?w.subarray(0,n):w);
    rejected(t,t.withdraw(r,{sig}),before,'(err u205)');
  }
  // Above ABI maxima fail type checking rather than returning a vault error.
  assert.throws(()=>t.withdraw(r,{sig:[...r.sig,...r.sig,Buffer.alloc(32)]}));
  assert.deepEqual(t.snapshot(),before);
}));

test('official-token vault checks missing ID, nonce, verifier, successor and balance boundaries',()=>run(async t=>{
  const r=t.sign(), before=t.snapshot();
  for (const nonce of [1,2n**128n-1n]) rejected(t,t.withdraw(r,{nonce}),before,'(err u203)');
  for (const amount of [0,1001,2n**128n-1n]) rejected(t,t.withdraw(r,{amount}),before,'(err u204)');
  for (const n of [0,31]) rejected(t,t.withdraw(r,{nextKey:Buffer.alloc(n)}),before,'(err u201)');
  const args=[t.id,Cl.uint(0),Cl.uint(1000),Cl.principal(recipient),Cl.buffer(r.nextKey),Cl.contractPrincipal(operator,'pq-vault'),sigCV(r.sig)];
  // A real trait-compatible verifier, different from the pinned one.
  const other=readFileSync(new URL('../snapshot/mainnet/contracts/lamport.clar',import.meta.url),'utf8');
  assert.ok(['true','(ok true)'].includes(show(t.sim.deployContract('other-lamport',other,{clarityVersion:6},operator))));
  args[5]=Cl.contractPrincipal(operator,'other-lamport');
  rejected(t,t.call('withdraw-sbtc',args,submitter),before,'(err u202)');
  args[0]=Cl.buffer(Buffer.alloc(32)); args[5]=t.v;
  rejected(t,t.call('withdraw-sbtc',args,submitter),before,'(err u200)');
  rejected(t,t.call('deposit-sbtc',[Cl.buffer(Buffer.alloc(32)),Cl.uint(1)],operator),before,'(err u200)');
  rejected(t,t.call('open',[Cl.buffer(t.owner.key(0)),t.v]),before,'(err u206)');
}));

test('wrong-chain, wrong-contract and wrong-asset signatures cannot pay official sBTC',()=>run(async t=>{
  const r=t.sign(), before=t.snapshot();
  for (const override of [{chainId:1},{vault:`${operator}.other-vault`},{asset:'stx'}]) {
    const digest=withdrawalDigest({vault,chainId:t.chainId,id:r.id,nonce:0,asset:'sbtc',amount:1000n,recipient,nextKey:r.nextKey,...override});
    // Deliberate misuse of a public synthetic fixture key to test rejection.
    const sig=lamport.sign(t.owner.secret(0),digest);
    rejected(t,t.withdraw(r,{sig}),before,'(err u205)');
  }
}));

test('failed operator token deposit cannot credit a ledger or change a key',()=>run(async t=>{
  const before=t.snapshot(); const result=t.call('deposit-sbtc',[t.id,Cl.uint(1)],operator);
  assert.notEqual(show(result),'(ok true)'); assert.deepEqual(t.snapshot(),before); assert.deepEqual(result.events,[]);
}));

test('known limits: direct transfers bypass the ledger, retirement does not close the contract',()=>run(async t=>{
  const r=t.sign(); assert.equal(show(t.withdraw(r)),'(ok true)');
  t.sim.mintFT(`${TOKEN}.sbtc-token`,operator,2n);
  assert.equal(show(t.sim.callPublicFn(TOKEN,'transfer',[Cl.uint(1),Cl.principal(operator),Cl.principal(vault),Cl.none()],operator)),'(ok true)');
  assert.equal(t.balance(vault),1n); assert.match(t.state(),/sbtc: u0/);
  assert.equal(show(t.call('deposit-sbtc',[t.id,Cl.uint(1)],operator)),'(ok true)');
  assert.equal(t.balance(vault),2n); assert.match(t.state(),/sbtc: u1/);
}));

test('Appendix A: independently reconstruct every Lamport pair, bit and commitment; verify Clarity',()=>run(async t=>{
  const vector=JSON.parse(readFileSync(new URL('../snapshot/mainnet/evidence/lamport-format-vector.json',import.meta.url)));
  const H=b=>createHash('sha256').update(b).digest(), MAC=(k,m)=>createHmac('sha256',k).update(m).digest();
  const seed=MAC(Buffer.from(vector.masterHex,'hex'),Buffer.from(vector.path));
  assert.equal(seed.toString('hex'),vector.seedHex);
  assert.deepEqual(keySecret(Buffer.from(vector.masterHex,'hex'),{chainId:vector.chainId,vault:vector.vault,verifier:vector.verifier,scheme:'lamport',account:0,index:0}),seed);
  const pairs=Array.from({length:256},(_,i)=>[0,1].map(b=>MAC(seed,Buffer.from([0x6c,i,b]))));
  const pub=pairs.map(pair=>pair.map(H));
  let key=Buffer.alloc(32); for (const [p0,p1] of pub) key=H(Buffer.concat([key,p0,p1]));
  assert.equal(key.toString('hex'),vector.keyHex);
  const digest=Buffer.from(vector.digestHex,'hex');
  const bit=(d,i)=>(d[i>>3]>>(7-(i%8)))&1;
  const sign=d=>[...pairs.map((p,i)=>p[bit(d,i)]),...pub.map((p,i)=>p[1-bit(d,i)])];
  const sig=sign(digest); assert.equal(H(Buffer.concat(sig)).toString('hex'),vector.signatureSha256);
  assert.deepEqual(lamport.sign(seed,digest),sig); assert.deepEqual(lamport.publicKey(seed),key);
  const check=(d,s,k=key)=>show(t.sim.callReadOnlyFn(verifier,'check',[Cl.buffer(k),Cl.buffer(d),sigCV(s)],operator));
  assert.equal(check(digest,sig),'true');
  for (let i=0;i<256;i++) {
    const d=Buffer.from(digest);d[i>>3]^=0x80>>(i%8);assert.equal(check(d,sig),'false',`changed digest bit ${i}`);
  }
  for (const d of [Buffer.alloc(32),Buffer.alloc(32,255),Buffer.alloc(32,0x80),Buffer.alloc(32,1)]) assert.equal(check(d,sign(d)),'true');
  const lsb=[...pairs.map((p,i)=>p[(digest[i>>3]>>(i%8))&1]),...pub.map((p,i)=>p[1-((digest[i>>3]>>(i%8))&1)])];
  assert.equal(check(digest,lsb),'false');
  const interleaved=sig.slice(0,256).flatMap((w,i)=>[w,sig[256+i]]); assert.equal(check(digest,interleaved),'false');
  let reversed=Buffer.alloc(32);for(const [p0,p1] of pub)reversed=H(Buffer.concat([reversed,p1,p0])); assert.equal(check(digest,sig,reversed),'false');
  let wrongStart=H(Buffer.alloc(0));for(const [p0,p1] of pub)wrongStart=H(Buffer.concat([wrongStart,p0,p1]));assert.equal(check(digest,sig,wrongStart),'false');
  assert.equal(check(digest.subarray(0,31),sig),'false');assert.equal(check(digest,sig,key.subarray(0,31)),'false');
}));
