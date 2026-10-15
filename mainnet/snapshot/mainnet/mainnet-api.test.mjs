import { test } from 'node:test';
import assert from 'node:assert/strict';
import stacks from '../source/vault/node_modules/@stacks/transactions/dist/index.js';
import { mainnetApi, API } from './mainnet-api.mjs';

const { Cl, serializeCV } = stacks;
const address='SP1BE4QPD9XK2A2TDJE7B40S00J9WZCW280ET3JBP';
const candidate={accounts:{operator:{address}},vault:`${address}.pq-vault`};
async function stub(handler,fn){const previous=globalThis.fetch;globalThis.fetch=handler;try{await fn(mainnetApi(candidate,{intervalMs:0,wait:async()=>{}}));}finally{globalThis.fetch=previous;}}
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

test('only the node NoEstimateAvailable error is exposed as an explicit first-call fee case',()=>stub(async(url,opts)=>{
  assert.equal(url,API+'/v2/fees/transaction');assert.equal(opts.method,'POST');assert.ok(opts.signal);
  return response({reason:'NoEstimateAvailable',reason_data:{message:'No estimate available for the provided payload.'}},400);
},async api=>{
  // Build a real public unsigned transfer for the SDK payload serializer.
  const pub=stacks.privateKeyToPublic('01'.padStart(64,'0')+'01');
  const sample=await stacks.makeUnsignedSTXTokenTransfer({publicKey:pub,network:'mainnet',nonce:0n,fee:0n,recipient:address,amount:1n});
  assert.deepEqual(await api.estimate(sample),{reason:'NoEstimateAvailable'});
}));

test('fee database errors are never converted into a first-call bid',()=>stub(async()=>response({reason:'DatabaseError'},500),async api=>{
  const pub=stacks.privateKeyToPublic('01'.padStart(64,'0')+'01');
  const sample=await stacks.makeUnsignedSTXTokenTransfer({publicKey:pub,network:'mainnet',nonce:0n,fee:0n,recipient:address,amount:1n});
  await assert.rejects(api.estimate(sample),/DatabaseError/);
}));

test('token read-only transport decodes the response and uses the fixed mainnet endpoint',()=>stub(async(url,opts)=>{
  assert.match(url,/^https:\/\/api\.hiro\.so\/v2\/contracts\/call-read\/SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4\/sbtc-token\/get-balance-available$/);
  const request=JSON.parse(opts.body);assert.equal(request.sender,address);assert.equal(request.arguments[0],'0x'+serializeCV(Cl.principal(address)));
  return response({okay:true,result:'0x'+serializeCV(Cl.ok(Cl.uint(1000)))});
},async api=>assert.equal(await api.tokenBalance(address),'1000')));

test('account transport subtracts locked STX and checks independent nonce views',()=>stub(async url=>{
  if(url.includes('/v2/accounts/'))return response({balance:'0x64',nonce:2});
  if(url.endsWith('/balances'))return response({stx:{balance:'100',locked:'20'}});
  return response({possible_next_nonce:2,detected_missing_nonces:[],detected_mempool_nonces:[]});
},async api=>assert.deepEqual(await api.account(address),{nonce:'2',availableStx:'80',missingNonces:[],mempoolNonces:[]})));

test('inconsistent account nonce views stop instead of selecting a nonce from one index',()=>stub(async url=>{
  if(url.includes('/v2/accounts/'))return response({balance:'0x64',nonce:2});
  if(url.endsWith('/balances'))return response({stx:{balance:'100',locked:'0'}});
  return response({possible_next_nonce:3,detected_missing_nonces:[],detected_mempool_nonces:[]});
},async api=>assert.rejects(api.account(address),/nonce views disagree/)));

test('partial paginated transfer evidence cannot pass verification',()=>stub(async()=>response({total:51,events:Array(50).fill({})}),async api=>assert.rejects(api.events('0x'+'00'.repeat(32)),/paginated/)));

test('missing transactions and missing contract sources are explicit null responses',()=>stub(async()=>response({},404),async api=>{
  assert.equal(await api.transaction('0x'+'00'.repeat(32)),null);assert.equal(await api.source(`${address}.pq-vault`),null);
}));

test('read-only 429 responses are retried with a bounded cooldown',async()=>{
  let calls=0;
  await stub(async()=>++calls<3?new Response('{}',{status:429,headers:{'retry-after':'1'}}):response({network_id:1}),async api=>assert.equal((await api.info()).network_id,1));
  assert.equal(calls,3);
});

test('broadcast 429 responses are not retried by the transport',async()=>{
  let calls=0;
  await stub(async()=>{calls++;return response({error:'rate limited'},429);},async api=>{
    assert.equal((await api.broadcast({serialize:()=> '00'})).error,'rate limited');
  });
  assert.equal(calls,1);
});
