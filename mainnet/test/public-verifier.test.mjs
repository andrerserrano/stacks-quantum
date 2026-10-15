import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicReadApi, verifyMainnet } from '../verify-mainnet.mjs';
const observation=JSON.parse(readFileSync(new URL('../evidence/independent-mainnet-audit.json',import.meta.url)));
const historical=JSON.parse(readFileSync(new URL('../evidence/mainnet-execution.json',import.meta.url)));
const response=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers});
function replay(edit=()=>{}) {
  const data=structuredClone(observation.observations); edit(data);
  const requests=[];
  const api=publicReadApi({intervalMs:0,wait:async()=>{},fetchImpl:async(url,init)=>{
    const path=new URL(url).pathname+new URL(url).search;
    const key=`${init.method} ${path}${init.body?' '+init.body:''}`; requests.push(key);
    assert.ok(Object.hasOwn(data,key),`Unexpected request: ${key}`); return response(data[key]);
  }});
  return {api,requests};
}
test('public chain responses reproduce all seven origin signatures, payloads, events, costs and final state offline',async()=>{
  const {api,requests}=replay(), r=await verifyMainnet({api});
  assert.equal(r.transactions.length,7);assert.equal(r.officialSbtcPaidSats,'1000');assert.equal(r.vaultEmptyNonceOneSuccessorInstalled,true);
  assert.equal(api.broadcast,undefined);assert.ok(requests.every(k=>k.startsWith('GET ')||k.startsWith('POST /v2/contracts/call-read/')));
});
const txKey=i=>`GET /extended/v1/tx/${historical.transactions[i].txid}`;
const eventKey=i=>`GET /extended/v1/tx/events?tx_id=${historical.transactions[i].txid}&limit=50`;
const mutations={
  wrongNetwork:d=>{d['GET /v2/info'].network_id=2147483648;},
  changedSource:d=>{const k=Object.keys(d).find(k=>k.includes('/source/')&&k.includes('/pq-vault?'));d[k].source+='changed';},
  changedRegistry:d=>{const k=Object.keys(d).find(k=>k.includes('/source/')&&k.includes('/sbtc-registry?'));d[k].source+='changed';},
  wrongTxId:d=>{d[txKey(0)].tx_id=historical.transactions[1].txid;},
  pending:d=>{d[txKey(0)].tx_status='pending';},
  vmAbort:d=>{d[txKey(6)].tx_status='abort_by_response';},
  postConditionAbort:d=>{d[txKey(6)].tx_status='abort_by_post_condition';},
  reorg:d=>{d[txKey(0)].canonical=false;},
  unanchored:d=>{d[txKey(0)].is_unanchored=true;},
  wrongMicroblock:d=>{d[txKey(0)].microblock_canonical=false;},
  wrongSender:d=>{d[txKey(0)].sender_address=historical.recipient;},
  wrongFee:d=>{d[txKey(0)].fee_rate='1';}, wrongNonce:d=>{d[txKey(0)].nonce=1;},
  tooFewConfirmations:d=>{d['GET /v2/info'].stacks_tip_height=historical.transactions[6].blockHeight+4;},
  noncanonicalBlock:d=>{d[`GET /extended/v1/block/by_height/${historical.transactions[0].blockHeight}`].canonical=false;},
  mismatchedBlockHash:d=>{d[`GET /extended/v1/block/by_height/${historical.transactions[0].blockHeight}`].hash='0x'+'00'.repeat(32);},
  lyingResultRepr:d=>{d[txKey(0)].tx_result.hex='0x080100000000000000000000000000000001';},
  alteredWire:d=>{const k=txKey(0)+'/raw';d[k].raw_tx=d[k].raw_tx.slice(0,-2)+'ff';},
  truncatedWire:d=>{const k=txKey(6)+'/raw';d[k].raw_tx=d[k].raw_tx.slice(0,-2);},
  trailingWire:d=>{const k=txKey(0)+'/raw';d[k].raw_tx+='00';},
  wrongEventTransaction:d=>{d[eventKey(4)].events[0].tx_id=historical.transactions[0].txid;},
  missingPayout:d=>{d[eventKey(6)].events=d[eventKey(6)].events.filter(e=>!e.asset);},
  extraPayout:d=>{d[eventKey(6)].events.push(d[eventKey(6)].events.find(e=>e.asset));d[txKey(6)].event_count++;},
  wrongRecipient:d=>{d[eventKey(6)].events.find(e=>e.asset).asset.recipient=historical.vault;},
  wrongAsset:d=>{d[eventKey(6)].events.find(e=>e.asset).asset.asset_id='wrong.token::sbtc-token';},
  wrongEventAmount:d=>{d[eventKey(6)].events.find(e=>e.asset).asset.amount='999';},
  changedCost:d=>{d[txKey(6)].execution_cost_runtime++;},
  changedContractLog:d=>{d[eventKey(6)].events.find(e=>e.contract_log).contract_log.value.hex='0x03';},
  unexpectedAssetEvent:d=>{d[eventKey(6)].events.push({tx_id:historical.transactions[6].txid,event_type:'non_fungible_token_asset',asset:{}});d[txKey(6)].event_count++;},
  changedVaultState:d=>{const k=Object.keys(d).find(k=>k.startsWith('POST ')&&k.includes('/get-vault '));d[k].result='0x09';},
  nonemptyVault:d=>{const k=Object.keys(d).find(k=>k.startsWith('POST ')&&k.includes('/get-balance-available '));d[k].result='0x070100000000000000000000000000000001';},
  changedDigest:d=>{const k=Object.keys(d).find(k=>k.startsWith('POST ')&&k.includes('/withdrawal-digest '));d[k].result='0x0200000020'+'00'.repeat(32);},
};
for (const [name,edit] of Object.entries(mutations)) test(`public verification rejects ${name}`,async()=>{
  const {api}=replay(edit);await assert.rejects(verifyMainnet({api}));
});

test('a reorganization during collection fails the final block recheck',async()=>{
  const {api}=replay();const block=api.block;let lastReads=0;
  api.block=async h=>{const b=await block(h);return h===historical.transactions[6].blockHeight&&++lastReads>1?{...b,canonical:false}:b;};
  await assert.rejects(verifyMainnet({api}));
});
test('an unapproved path or write-shaped call is rejected before fetch',async()=>{
  let calls=0;const api=publicReadApi({fetchImpl:async()=>{calls++;throw Error('should not reach network');}});
  await assert.rejects(api.transaction('../transactions'));await assert.rejects(api.source('https://other.example/evil'));
  await assert.rejects(api.read(historical.vault,'transfer',[],historical.recipient));assert.equal(calls,0);
});
for (const [name,body] of Object.entries({partial:{limit:50,offset:0,total:2,events:[{}]},fullUncounted:{limit:50,offset:0,events:Array(50).fill({})},offset:{limit:50,offset:50,events:[]},malformed:{events:null}})) {
  test(`public evidence rejects ${name} event page`,async()=>{
    const api=publicReadApi({intervalMs:0,fetchImpl:async()=>response(body)});await assert.rejects(api.events(historical.transactions[0].txid));
  });
}
test('read retries honor a bounded Retry-After, carry a timeout and never retry a write',async()=>{
  let calls=0;const waits=[];const api=publicReadApi({intervalMs:0,wait:async ms=>waits.push(ms),fetchImpl:async(url,init)=>{
    calls++;assert.equal(init.method,'GET');assert.ok(init.signal);return calls===1?response({},429,{'retry-after':'1'}):response({network_id:1});
  }});assert.equal((await api.info()).network_id,1);assert.equal(calls,2);assert.deepEqual(waits,[1000]);assert.equal(api.broadcast,undefined);
});
for(const header of ['999','invalid','-1'])test(`unsafe provider cooldown fails closed (${header})`,async()=>{
  let calls=0;const api=publicReadApi({intervalMs:0,fetchImpl:async()=>{calls++;return response({},429,{'retry-after':header});}});
  await assert.rejects(api.info());assert.equal(calls,1);
});
test('persistent throttling, HTTP errors, malformed JSON and read failures cannot yield success',async()=>{
  for (const fetchImpl of [async()=>response({},429,{'retry-after':'0'}),async()=>response({},500),async()=>new Response('bad JSON'),async()=>{throw new DOMException('timed out','TimeoutError');}]) {
    const api=publicReadApi({intervalMs:0,wait:async()=>{},fetchImpl});await assert.rejects(api.info());
  }
});

test('HTTP-date Retry-After is supported for bounded read retries',async()=>{
  let calls=0;const waits=[];const api=publicReadApi({intervalMs:0,wait:async ms=>waits.push(ms),fetchImpl:async()=>++calls===1?response({},429,{'retry-after':new Date(Date.now()+20000).toUTCString()}):response({network_id:1})});
  assert.equal((await api.info()).network_id,1);assert.equal(calls,2);assert.ok(waits[0]>=1000&&waits[0]<=20000);
});
test('read-only Clarity failures and invalid serialized values are rejected',async()=>{
  for(const body of [{okay:false,cause:'failure'},{okay:true,result:'invalid'}]){
    const api=publicReadApi({intervalMs:0,fetchImpl:async()=>response(body)});await assert.rejects(api.read(historical.vault,'get-vault',[],historical.recipient));
  }
});
