import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { publicManifest, loadSecrets, ROOT } from './accounts.mjs';
import { mainnetApi } from './mainnet-api.mjs';
import { Executor, sha256, verifyReviewedFiles, json } from './execution.mjs';
import { MAINNET_ROOT } from './candidate.mjs';

export function loadCandidate() {
  const raw = readFileSync(join(MAINNET_ROOT, 'candidate/manifest.json'), 'utf8');
  const c = JSON.parse(raw), hash = sha256(raw);
  if (readFileSync(join(MAINNET_ROOT, 'candidate/manifest.sha256'), 'utf8') !== `${hash}  manifest.json\n`) throw new Error('Candidate manifest digest file does not match');
  verifyReviewedFiles(c, MAINNET_ROOT);
  for (const [name, expected] of Object.entries(c.libraryPins)) {
    if (!['vault.mjs','journal.mjs','lamport.mjs','wots.mjs'].includes(name) || sha256(readFileSync(new URL(`../source/vault/src/${name}`, import.meta.url))) !== expected) throw new Error('Reviewed signer library changed');
  }
  if (sha256(readFileSync(new URL('../source/vault/package-lock.json', import.meta.url))) !== c.dependenciesLockSha256) throw new Error('Dependency lock changed');
  const m = publicManifest();
  if (m.journal !== join(ROOT, 'journal')) throw new Error('Configured mainnet journal path changed');
  if (c.keychainHelperSha256 !== m.helperSha256) throw new Error('Keychain helper pin changed');
  for (const role of ['operator','submitter','recipient']) if (m.accounts[role].address !== c.accounts[role].address || m.accounts[role].publicKey !== c.accounts[role].publicKey) throw new Error('Public account manifest changed');
  return { c, hash };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['status','preflight','advance'].includes(command)) throw new Error('Use status, preflight, or advance --candidate-sha256 HASH');
  const { c, hash } = loadCandidate();
  if (command !== 'advance' && args.length) throw new Error('Read-only commands accept no arguments');
  if (command === 'advance' && (args.length !== 2 || args[0] !== '--candidate-sha256' || args[1] !== hash)) throw new Error('advance requires the exact reviewed candidate SHA-256');
  const e = new Executor({ candidate: c, candidateHash: hash, root: join(ROOT, 'execution'), journalPath: publicManifest().journal, api: mainnetApi(c), loadSecrets: () => {
    try { return loadSecrets(); } catch { throw new Error('Custody validation failed; no private keys were displayed'); }
  } });
  const result = command === 'status' ? await e.inspect() : command === 'preflight' ? await e.preflight() : await e.advance();
  console.log(json(result));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
