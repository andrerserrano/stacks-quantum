// Offline consistency check only. This does not query the chain or access custody.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = path => readFileSync(new URL(path, import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = path => JSON.parse(read(path));
const candidateHash = 'f20785dfe1a21e3f8098cfa2268352f5ed07ebf8074ebaa4dc0a161a831535b4';
const prefix = './snapshot/mainnet/';
const c = parse(`${prefix}candidate/manifest.json`);
assert.equal(sha(read(`${prefix}candidate/manifest.json`)), candidateHash);
assert.equal(read(`${prefix}candidate/manifest.sha256`).toString(), `${candidateHash}  manifest.json\n`);
for (const [path, hash] of Object.entries(c.reviewedFiles)) {
  assert.equal(sha(read(prefix + path)), hash, `Sealed file changed: ${path}`);
}
for (const [name, source] of Object.entries(c.sources)) {
  const bytes = read(`${prefix}contracts/${name}.clar`);
  assert.equal(bytes.toString(), source.code);
  assert.equal(sha(bytes), source.sha256);
}
for (const [name, hash] of Object.entries(c.libraryPins)) {
  assert.equal(sha(read(`./snapshot/source/vault/src/${name}`)), hash, `Signer changed: ${name}`);
}
assert.equal(sha(read('./snapshot/source/vault/package-lock.json')), c.dependenciesLockSha256);
for (const [name, hash] of Object.entries(c.tokenSourceHashes)) {
  assert.equal(sha(read(`${prefix}evidence/${name}.deployed.clar`).toString().trim()), hash);
}

const e = parse('./evidence/mainnet-execution.json');
const audit = parse('./evidence/completion-audit.json');
assert.equal(sha(read('./evidence/mainnet-execution.json')), audit.executionEvidenceSha256);
assert.equal(e.candidateSha256, candidateHash);
assert.equal(audit.candidateSha256, candidateHash);
assert.equal(e.complete, true);
assert.equal(e.retiredOperationally, true);
assert.equal(e.chainId, 1);
assert.equal(e.token, c.token);
for (const field of ['vault', 'verifier', 'vaultId', 'digest', 'recipient', 'amountSats']) assert.equal(e[field], c[field]);
assert.deepEqual(e.sourceHashes, Object.fromEntries(Object.entries(c.sources).map(([name, s]) => [name, s.sha256])));
const labels = ['deploy-pq-verifier-trait', 'deploy-lamport', 'deploy-pq-vault', 'open-vault', 'deposit-sbtc', 'fund-submitter', 'withdraw-sbtc'];
assert.deepEqual(e.transactions.map(t => t.label), labels);
let fees = 0n;
for (const tx of e.transactions) {
  assert.equal(tx.status, 'success');
  assert.equal(tx.canonical, true);
  assert.ok(tx.confirmations >= c.confirmations);
  fees += BigInt(tx.feeMicroStx);
}
assert.equal(fees.toString(), e.actualFeesMicroStx);
assert.equal(e.actualFeesMicroStx, audit.actualFeesMicroStx);
assert.ok(fees <= BigInt(c.feeCapMicroStx));
assert.equal(e.transactions[6].txid, audit.withdrawalTxid);
assert.ok(e.transactions[6].transfers.some(t => t.asset_id === `${c.token}::sbtc-token` && t.sender === c.vault && t.recipient === c.recipient && t.amount === c.amountSats));
assert.equal(e.vaultSbtcSats, '0');
assert.equal(e.finalVault.sbtc, '0');
assert.equal(e.finalVault.nonce, '1');
assert.equal(e.finalVault.key, c.nextKey);
assert.equal(e.recipientIncreaseSats, c.amountSats);
assert.equal(e.oneTimeKeyClaims, 1);
assert.equal(e.initialClaimDigest, c.digest);

const integration = parse('./evidence/integration-results.json');
assert.equal(integration.passed, true);
assert.equal(integration.scenarios.length, 13);
assert.equal(integration.testSourceSha256, sha(read(`${prefix}integration.test.mjs`)));
assert.deepEqual(integration.contractSourceSha256, e.sourceHashes);
assert.ok(integration.contractRejections.every(r => r.stateAndBalancesUnchanged && r.events.length === 0));
console.log(JSON.stringify({ offline: true, candidateSha256: candidateHash, sealedFiles: Object.keys(c.reviewedFiles).length,
  historicalTransactions: e.transactions.length, actualFeesStx: e.actualFeesStx, consistent: true }, null, 2));
