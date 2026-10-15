// Local custody check only: derive public commitments, never sign or claim a
// one-time key. Private values stay in this process and are never printed.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { publicManifest, loadSecrets, ROOT } from './accounts.mjs';
import { loadCandidate } from './execute.mjs';
import { wallet } from '../source/vault/src/vault.mjs';
import { json } from './execution.mjs';

const { c, hash } = loadCandidate();
for (const name of ['pq-verifier-trait', 'lamport']) {
  assert.equal(readFileSync(new URL(`../source/vault/contracts/${name}.clar`, import.meta.url), 'utf8'), c.sources[name].code);
}
const prototype = readFileSync(new URL('../source/vault/contracts/pq-vault.clar', import.meta.url), 'utf8');
const rebound = prototype.replaceAll('(contract-call? .sbtc-token transfer', "(contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer");
assert.equal(c.sources['pq-vault'].code, ';; Mainnet candidate: sBTC calls are fixed to the official deployed token.\n;; Derived from the testnet prototype; no deployment has occurred.\n' + rebound);
const m = publicManifest(), keys = loadSecrets(m);
const owner = wallet({ master: Buffer.from(keys.master, 'hex'), chainId: 1, vault: c.vault, verifier: c.verifier, scheme: 'lamport', account: 0 });
assert.equal(owner.id.toString('hex'), c.vaultId);
assert.equal(owner.key(0).toString('hex'), c.keyCommitment);
assert.equal(owner.key(1).toString('hex'), c.nextKey);
assert.equal(owner.withdrawal({ nonce: 0, asset: 'sbtc', amount: 1000n, recipient: c.recipient }).digest.toString('hex'), c.digest);
const realSecrets = Object.values(keys).flatMap(s => [Buffer.from(s), Buffer.from(s.slice(0,64)), Buffer.from(s.slice(0,64), 'hex')]);
let checked = 0;
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) scan(path);
    else {
      const bytes = readFileSync(path);
      assert.equal(realSecrets.some(s => bytes.includes(s)), false, 'A private value appears in an artifact; stop before funding');
      checked++;
    }
  }
}
scan(new URL('./', import.meta.url).pathname);
console.log(json({ candidateSha256: hash, custodyAddressRoundTrip: true, lamportPublicCommitmentsMatch: true,
  contractChangesOnlyTokenBindingsAndComments: true,
  artifactFilesScanned: checked, privateValuesFoundInArtifacts: false,
  persistedMainnetAuthorizationPresent: existsSync(join(ROOT, 'execution/authorization.json')),
  initialKeyJournalClaimPresent: existsSync(join(m.journal, `${c.keyCommitment}.json`)),
  signing: false, broadcasts: 0 }));
