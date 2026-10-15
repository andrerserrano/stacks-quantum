// Seal a public, reviewable candidate without accessing Keychain or signing.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { publicManifest } from './accounts.mjs';
import { mainnetApi } from './mainnet-api.mjs';
import { sha256, json, validateCandidate, TOKEN } from './execution.mjs';

export const MAINNET_ROOT = fileURLToPath(new URL('./', import.meta.url));
export const REVIEWED = [
  'contracts/pq-verifier-trait.clar', 'contracts/lamport.clar', 'contracts/pq-vault.clar',
  'execution.mjs', 'mainnet-api.mjs', 'execute.mjs', 'accounts.mjs', 'candidate.mjs', 'tools/keychain.swift',
  'verify-candidate.mjs',
];

export async function prepareCandidate() {
  const plan = JSON.parse(readFileSync(join(MAINNET_ROOT, 'prepared/plan.json'), 'utf8'));
  const m = publicManifest();
  const sources = Object.fromEntries(['pq-verifier-trait', 'lamport', 'pq-vault'].map(name => {
    const code = readFileSync(join(MAINNET_ROOT, `contracts/${name}.clar`), 'utf8');
    if (sha256(code) !== plan.sourceHashes[name]) throw new Error(`Candidate contract differs from previously prepared source: ${name}`);
    return [name, { sha256: sha256(code), code }];
  }));
  const c = {
    schema: 1, network: 'mainnet', chainId: 1, token: TOKEN, amountSats: '1000',
    feeCapMicroStx: '20000000', feePriority: 'low', confirmations: 6,
    submitterReserveMicroStx: '2000000',
    firstCallFeesMicroStx: { 'open-vault': '250000', 'deposit-sbtc': '500000', 'withdraw-sbtc': '1500000' },
    accounts: Object.fromEntries(Object.entries(m.accounts).map(([role,a]) => [role, { address: a.address, publicKey: a.publicKey, startNonce: '0' }])),
    vault: plan.vaultContract, verifier: plan.verifier, recipient: plan.recipient,
    vaultId: plan.vaultId, keyCommitment: plan.keyCommitment, nextKey: plan.nextKey, digest: plan.steps.find(s => s.label === 'withdraw-sbtc').digest,
    sources, tokenSourceHashes: Object.fromEntries(['sbtc-token', 'sbtc-registry'].map(name => [name, sha256(readFileSync(join(MAINNET_ROOT, `evidence/${name}.deployed.clar`), 'utf8').trim())])),
    reviewedFiles: Object.fromEntries(REVIEWED.map(path => [path, sha256(readFileSync(join(MAINNET_ROOT, path)))])),
    libraryPins: Object.fromEntries(['vault.mjs', 'journal.mjs', 'lamport.mjs', 'wots.mjs'].map(name => [name, sha256(readFileSync(new URL(`../source/vault/src/${name}`, import.meta.url)))])),
    dependenciesLockSha256: sha256(readFileSync(new URL('../source/vault/package-lock.json', import.meta.url))),
    keychainHelperSha256: m.helperSha256,
    preparedAt: new Date().toISOString(),
    reviewStatus: 'Candidate prepared for Leah\'s deeper review; no deployment or withdrawal signed by this preparation.',
  };
  for (const role of ['operator','submitter','recipient']) {
    if (plan.liveAccounts[role].address !== c.accounts[role].address) throw new Error('Prepared public accounts changed');
  }
  const api = mainnetApi(c), info = await api.info();
  if (info.network_id !== 1) throw new Error('Not mainnet');
  const accounts = await Promise.all(Object.entries(c.accounts).map(async ([role,a]) => [role, await api.account(a.address)]));
  for (const [role,a] of accounts) {
    if (a.missingNonces.length || a.mempoolNonces.length) throw new Error(`Reconcile ${role} account before candidate preparation`);
    c.accounts[role].startNonce = a.nonce;
  }
  for (const name of Object.keys(c.sources)) {
    if (await api.source(`${c.accounts.operator.address}.${name}`)) throw new Error('Contract name already occupied; do not reseal an active deployment');
  }
  validateCandidate(c);
  const dir = join(MAINNET_ROOT, 'candidate'); mkdirSync(dir, { recursive: true });
  const bytes = json(c), hash = sha256(bytes);
  writeFileSync(join(dir, 'manifest.json'), bytes);
  writeFileSync(join(dir, 'manifest.sha256'), `${hash}  manifest.json\n`);
  return { candidateSha256: hash, manifest: join(dir, 'manifest.json'), operator: c.accounts.operator.address, amountSats: c.amountSats, feeCapMicroStx: c.feeCapMicroStx, confirmations: c.confirmations, signing: false, broadcasts: 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Candidate preparation accepts no arguments');
  console.log(json(await prepareCandidate()));
}
