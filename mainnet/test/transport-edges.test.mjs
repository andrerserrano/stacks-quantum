import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainnetApi } from '../snapshot/mainnet/mainnet-api.mjs';
import stacks from '../snapshot/source/vault/node_modules/@stacks/transactions/dist/index.js';
const {Cl,serializeCV}=stacks;
const address='SP1BE4QPD9XK2A2TDJE7B40S00J9WZCW280ET3JBP', candidate={accounts:{operator:{address}},vault:`${address}.pq-vault`};
const response=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers});
async function stub(fetch,fn){const old=globalThis.fetch;globalThis.fetch=fetch;try{await fn(mainnetApi(candidate,{intervalMs:0,wait:async()=>{}}));}finally{globalThis.fetch=old;}}
test('frozen transport reads block and vault through the fixed mainnet endpoint',()=>stub(async(url,init)=>{
  if(url.endsWith('/by_height/100'))return response({canonical:true,height:100});
  assert.ok(url.endsWith('/pq-vault/get-vault'));assert.equal(init.method,'POST');return response({okay:true,result:'0x'+serializeCV(Cl.none())});
},async api=>{assert.equal((await api.block(100)).canonical,true);assert.equal((await api.read('get-vault',[])).type,'none');}));
for(const [label,edit] of Object.entries({negativeNonce:x=>{x.core.nonce=-1;},fractionalNonce:x=>{x.core.nonce=0.5;},lockedExceedsBalance:x=>{x.balance.stx.locked='101';},coreBalanceBehindIndex:x=>{x.core.balance='0x01';}})) {
  test(`frozen account transport refuses ${label}`,async()=>{
    const x={core:{balance:'0x64',nonce:0},balance:{stx:{balance:'100',locked:'0'}},nonces:{possible_next_nonce:0,detected_missing_nonces:[],detected_mempool_nonces:[]}};edit(x);
    await stub(async url=>response(url.includes('/v2/accounts/')?x.core:url.endsWith('/balances')?x.balance:x.nonces),async api=>assert.rejects(api.account(address)));
  });
}
for(const cv of [Cl.error(Cl.uint(1)),Cl.ok(Cl.bool(true))])test(`frozen token balance refuses ${Cl.prettyPrint(cv)}`,()=>stub(async()=>response({okay:true,result:'0x'+serializeCV(cv)}),async api=>assert.rejects(api.tokenBalance(address),/Unexpected sBTC/)));
test('frozen transport never treats a server failure as an absent deployment',()=>stub(async()=>response({},500),async api=>assert.rejects(api.source(candidate.vault),/500/)));
test('frozen transport stops after three throttled reads',async()=>{
  let calls=0;await stub(async()=>{calls++;return response({},429,{'retry-after':'0'});},async api=>assert.rejects(api.info(),/429/));assert.equal(calls,3);
});
for(const value of ['60','invalid'])test(`frozen transport refuses unsupported cooldown ${value}`,()=>stub(async()=>response({},429,{'retry-after':value}),async api=>assert.rejects(api.info(),/cooldown/)));
test('frozen read transport propagates timeout uncertainty',()=>stub(async()=>{throw new DOMException('timeout','TimeoutError');},async api=>assert.rejects(api.info(),/timeout/)));
