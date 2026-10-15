import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifySnapshot, verifyExecutionEvidence } from '../verify-snapshot.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url));
const c=JSON.parse(read('snapshot/mainnet/candidate/manifest.json'));
const e=JSON.parse(read('evidence/mainnet-execution.json'));
const a=JSON.parse(read('evidence/completion-audit.json'));
test('published source and historical evidence pass offline verification',()=>assert.equal(verifySnapshot().consistent,true));
for(const path of ['snapshot/mainnet/execution.mjs','snapshot/mainnet/contracts/lamport.clar','snapshot/source/vault/src/journal.mjs','snapshot/source/vault/package-lock.json','snapshot/mainnet/evidence/sbtc-token.deployed.clar','snapshot/mainnet/candidate/manifest.json']) {
  test(`offline checker detects changed ${path}`,()=>assert.throws(()=>verifySnapshot({read:p=>p.replace(/^\.\//,'')===path?Buffer.concat([read(p),Buffer.from('\nchanged')]):read(p)})));
}
test('rewriting both execution evidence and its audit hash cannot silently change the historical record',()=>{
  const changed=structuredClone(e);changed.transactions[0].txid='0x'+'11'.repeat(32);
  const bytes=Buffer.from(JSON.stringify(changed));const audit={...a,executionEvidenceSha256:createHash('sha256').update(bytes).digest('hex')};
  assert.throws(()=>verifySnapshot({read:p=>p==='./evidence/mainnet-execution.json'?bytes:p==='./evidence/completion-audit.json'?Buffer.from(JSON.stringify(audit)):read(p)}),/Historical execution evidence changed/);
});
const mutations={
  duplicateTx:e=>{e.transactions[1].txid=e.transactions[0].txid;}, sender:e=>{e.transactions[0].sender=e.recipient;},
  nonce:e=>{e.transactions[3].nonce='0';}, result:e=>{e.transactions[2].result='(ok false)';},
  negativeFee:e=>{e.transactions[0].feeMicroStx='-1';}, fractionalFee:e=>{e.transactions[0].feeMicroStx='1.1';},
  feeTotal:e=>{e.actualFeesStx++;}, confirmationCount:e=>{e.transactions[0].confirmations=5;},
  confirmationSpacing:e=>{e.transactions[1].blockHeight=e.transactions[0].blockHeight+5;},
  depositRecipient:e=>{e.transactions[4].transfers[0].recipient=e.recipient;},
  topupAmount:e=>{e.transactions[5].transfers[0].amount='1';},
  duplicatePayout:e=>{e.transactions[6].transfers.push(e.transactions[6].transfers[0]);},
  wrongAsset:e=>{e.transactions[6].transfers[0].asset_id='wrong.token::sbtc-token';},
  wrongFinalVerifier:e=>{e.finalVault.verifier='wrong';}, unexpectedStx:e=>{e.finalVault.stx='1';},
  recipientIncrease:e=>{e.balances.recipient.sbtcSats='999';},
};
for(const [name,edit] of Object.entries(mutations))test(`historical evidence rejects ${name}`,()=>{
  const altered=structuredClone(e);edit(altered);assert.throws(()=>verifyExecutionEvidence(c,altered,a));
});
test('missing completion assertions and unfinished work cannot pass the audit',()=>{
  const altered=structuredClone(a);delete altered.requirements.oneDurableKeyClaimAndAuthorizationRetained;
  assert.throws(()=>verifyExecutionEvidence(c,e,altered));
  assert.throws(()=>verifyExecutionEvidence(c,e,{...a,remainingRequiredOnChainWork:['withdraw']}));
});
