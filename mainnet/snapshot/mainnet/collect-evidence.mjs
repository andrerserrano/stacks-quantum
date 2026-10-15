// Read-only completion audit. Neither Keychain access nor broadcasting is
// available to this collector. It refuses to publish an incomplete execution.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './accounts.mjs';
import { loadCandidate } from './execute.mjs';
import { mainnetApi } from './mainnet-api.mjs';
import { Executor, json, sha256, TOKEN, buildTransaction } from './execution.mjs';
import stacks from '../source/vault/node_modules/@stacks/transactions/dist/index.js';

// This read-only collector can honor longer provider cooldowns without
// changing the sealed live executor. Both numeric and HTTP-date headers work.
const fetchRead = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://api.hiro.so' || (init?.method === 'POST' && !url.pathname.startsWith('/v2/contracts/call-read/'))) throw new Error('Collector permits only mainnet evidence reads');
  for (let attempt=0;attempt<4;attempt++) {
    const response = await fetchRead(input,{...init,signal:AbortSignal.timeout(15000)});
    if(response.status!==429)return response;
    const header=response.headers.get('retry-after');
    const numeric=header===null?30:Number(header);
    const ms=Number.isFinite(numeric)?numeric*1000:Date.parse(header)-Date.now();
    const delay=Math.max(2000,Number.isFinite(ms)?ms:30000);
    if(delay>180000)throw new Error('Evidence provider requests a longer cooldown; retry collection later');
    console.error(`Read-only evidence request rate limited; retrying after ${Math.ceil(delay/1000)} seconds`);
    await response.body?.cancel();
    for(let left=delay;left>0;left-=30000)await new Promise(resolve=>setTimeout(resolve,Math.min(left,30000)));
  }
  throw new Error('Evidence provider remains rate limited');
};

const { c, hash } = loadCandidate();
const api = { ...mainnetApi(c, { intervalMs:3000 }), broadcast: async () => { throw new Error('Evidence collection cannot broadcast'); } };
const e = new Executor({ candidate:c, candidateHash:hash, root:join(ROOT,'execution'), journalPath:join(ROOT,'journal'), api,
  loadSecrets:()=>{throw new Error('Evidence collection cannot read private keys');} });
const s = e.state();
if (s.records.length !== 7) throw new Error('Execution does not have all seven transactions');
await e.tokenSources(); await e.deployed(3);
const transactions = [];
for (const [index,r] of s.records.entries()) {
  const tx=stacks.deserializeTransaction(r.wire);tx.verifyOrigin();
  if(tx.chainId!==1||`0x${tx.txid()}`!==r.txid||sha256(tx.serializeBytes())!==r.wireSha256)throw new Error('Saved mainnet wire identity mismatch');
  const sig=index===6?tx.payload.functionArgs[6].value.map(w=>Buffer.from(w.value,'hex')):undefined;
  const expected=await buildTransaction(c,index,r.nonce,r.fee,sig),normalized=stacks.deserializeTransaction(expected.serialize());
  if(stacks.serializePayload(tx.payload)!==stacks.serializePayload(expected.payload)||json(tx.postConditions)!==json(normalized.postConditions)||tx.postConditionMode!==expected.postConditionMode||tx.anchorMode!==expected.anchorMode||tx.auth.spendingCondition.signer!==expected.auth.spendingCondition.signer)throw new Error('Saved transaction differs from candidate');
  const obs = await e.observation(r);
  if (obs.status !== 'confirmed') throw new Error('Canonical status changed while collecting evidence');
  const t=obs.tx;
  transactions.push({ label:r.label, txid:r.txid, bytes:r.wire.length/2, sender:t.sender_address, nonce:String(t.nonce), feeMicroStx:String(t.fee_rate), feeBasis:r.feeBasis,
    status:t.tx_status, result:t.tx_result.repr, canonical:t.canonical, blockHeight:t.block_height, blockHash:t.block_hash,
    confirmations:obs.depth, executionCost:{runtime:t.execution_cost_runtime,readCount:t.execution_cost_read_count,readLength:t.execution_cost_read_length,writeCount:t.execution_cost_write_count,writeLength:t.execution_cost_write_length},
    transfers:(await api.events(r.txid)).filter(v=>v.asset?.asset_event_type==='transfer').map(v=>({type:v.event_type,...v.asset})),
    explorer:`https://explorer.hiro.so/txid/${r.txid}?chain=mainnet` });
}
const fees=transactions.reduce((sum,t)=>sum+BigInt(t.feeMicroStx),0n);
if(fees>BigInt(c.feeCapMicroStx))throw new Error('Actual fees exceed the configured cap');
const vaultState=await e.vaultState();await e.assertVault(false,true);
const journalKeys=readdirSync(join(ROOT,'journal')).filter(n=>/^[0-9a-f]{64}\.json$/.test(n));
if(journalKeys.length!==1||journalKeys[0]!==`${c.keyCommitment}.json`)throw new Error('Unexpected one-time-key journal history');
const claim=JSON.parse(readFileSync(join(ROOT,'journal',journalKeys[0]),'utf8'));
if(claim.digest!==c.digest)throw new Error('Journal digest mismatch');
const balances={};
for(const role of ['operator','submitter','recipient']){
  const address=c.accounts[role].address;
  balances[role]={address,availableStxMicro:String((await api.account(address)).availableStx),sbtcSats:String(await api.tokenBalance(address))};
}
const report={verifiedAt:new Date().toISOString(),network:'mainnet',chainId:1,candidateSha256:hash,token:TOKEN,amountSats:c.amountSats,recipient:c.recipient,
  vault:c.vault,verifier:c.verifier,vaultId:c.vaultId,digest:c.digest,sourceHashes:Object.fromEntries(Object.entries(c.sources).map(([n,v])=>[n,v.sha256])),
  minimumStacksConfirmations:c.confirmations,feeCapMicroStx:c.feeCapMicroStx,actualFeesMicroStx:String(fees),actualFeesStx:Number(fees)/1e6,
  transactions,finalVault:vaultState,vaultSbtcSats:String(await api.tokenBalance(c.vault)),balances,
  recipientSbtcBefore:s.records[6].recipientBalanceBefore,recipientIncreaseSats:String(BigInt(balances.recipient.sbtcSats)-BigInt(s.records[6].recipientBalanceBefore)),
  oneTimeKeyClaims:journalKeys.length,initialClaimDigest:claim.digest,authorizationFileSha256:sha256(readFileSync(join(ROOT,'execution','authorization.json'))),
  complete:true,retiredOperationally:true,limitations:'One experimental withdrawal; no production audit, protocol change, many-time signing, consensus or Bitcoin reserve protection.'};
// Recheck the final block and payout after collection. An unchanged canonical
// final block fixes its ancestor chain; avoid a redundant full history pass.
const final=await e.observation(s.records[6]);
if(final.status!=='confirmed'||final.tx.block_hash!==transactions[6].blockHash)throw new Error('Execution changed during evidence collection');
await e.verifyEffect(s.records[6],6);
writeFileSync(new URL('./evidence/mainnet-execution.json',import.meta.url),json(report));
const lines=[
  '# Mainnet sBTC Lamport demo result', '',
  `Verified ${report.verifiedAt}. One mainnet withdrawal paid ${c.amountSats} sats of official sBTC to the signed recipient.`, '',
  `- Withdrawal: [${transactions[6].txid}](${transactions[6].explorer})`,
  `- Vault: \`${c.vault}\``, `- Verifier: \`${c.verifier}\``,
  `- Actual fees: ${report.actualFeesStx} STX across seven transactions (20 STX cap).`,
  `- Vault: 0 sBTC, nonce 1, planned successor installed. One durable initial-key claim.`,
  `- Each transaction has at least ${c.confirmations} canonical Stacks block confirmations; canonicality was rechecked at collection.`, '',
  '| Step | Result | Fee (STX) | Transaction |', '| --- | --- | --- | --- |',
  ...transactions.map(t=>`| ${t.label} | ${t.status} | ${Number(t.feeMicroStx)/1e6} | [${t.txid.slice(0,12)}...](${t.explorer}) |`), '',
  'Full source hashes, block identifiers, transfer events, balances and fee evidence are in `evidence/mainnet-execution.json`. The journal and signed bytes remain in private local custody. The vault is retired operationally; do not deposit more funds.', '',
  report.limitations, '',
];
writeFileSync(new URL('./Mainnet-demo-result.md',import.meta.url),lines.join('\n'));
console.log(json({complete:true,withdrawal:transactions[6].explorer,actualFeesStx:report.actualFeesStx,evidence:'review/mainnet/evidence/mainnet-execution.json',result:'review/mainnet/Mainnet-demo-result.md'}));
