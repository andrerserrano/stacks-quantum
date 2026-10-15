import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import stacks from '../source/vault/node_modules/@stacks/transactions/dist/index.js';

const { randomPrivateKey, getAddressFromPrivateKey, privateKeyToPublic } = stacks;
export const ROOT = join(homedir(), '.local', 'share', 'pq-vault', 'mainnet');
export const MANIFEST = join(ROOT, 'accounts.public.json');
export const SERVICE = 'com.andre.stacks-quantum.mainnet-demo';
export const HELPER = join(ROOT, 'bin', 'keychain-store');

function keychain(action, account, input) {
  const p = spawnSync(HELPER, [action, SERVICE, account], {
    input, encoding: 'utf8', maxBuffer: 65536,
  });
  if (p.error || p.status !== 0) throw new Error(`Keychain ${action} failed; no secrets were displayed.`);
  return p.stdout;
}

export function publicManifest() {
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

export function loadSecrets(manifest = publicManifest()) {
  if (createHash('sha256').update(readFileSync(HELPER)).digest('hex') !== manifest.helperSha256) {
    throw new Error('Keychain helper changed; stop for review before accessing secrets.');
  }
  const secrets = JSON.parse(keychain('get', manifest.keychainAccount));
  for (const [role, value] of Object.entries(manifest.accounts)) {
    if (getAddressFromPrivateKey(secrets[role], 'mainnet') !== value.address) {
      throw new Error('Keychain/account manifest mismatch');
    }
  }
  return secrets;
}

function init() {
  if (existsSync(MANIFEST)) {
    loadSecrets(); // Verify existing custody before presenting a funding address.
    console.log(JSON.stringify(publicManifest(), null, 2));
    return;
  }
  mkdirSync(join(ROOT, 'bin'), { recursive: true, mode: 0o700 });
  chmodSync(ROOT, 0o700);
  if (!existsSync(HELPER)) {
    const src = fileURLToPath(new URL('./tools/keychain.swift', import.meta.url));
    const p = spawnSync('/usr/bin/swiftc', [src, '-o', HELPER], { encoding: 'utf8' });
    if (p.error || p.status !== 0) throw new Error(`Could not compile the Keychain helper: ${p.stderr}`);
    chmodSync(HELPER, 0o700);
  }
  const id = `lamport-sbtc-${randomUUID()}`;
  const roles = ['operator', 'submitter', 'recipient'];
  const secrets = Object.fromEntries(roles.map(role => [role, randomPrivateKey()]));
  secrets.master = randomBytes(32).toString('hex');
  const accounts = Object.fromEntries(roles.map(role => [role, {
    address: getAddressFromPrivateKey(secrets[role], 'mainnet'),
    publicKey: privateKeyToPublic(secrets[role]),
  }]));
  // Keychain add is exclusive; a duplicate account is an error, never overwrite.
  keychain('put', id, JSON.stringify(secrets));
  const manifest = {
    schema: 1, network: 'mainnet', chainId: 1, createdAt: new Date().toISOString(),
    purpose: 'Dedicated low-value Lamport sBTC demo; not a general-purpose wallet',
    custody: 'macOS Keychain, this Mac only, accessible while unlocked; no mnemonic created',
    keychainService: SERVICE, keychainAccount: id,
    helperSha256: createHash('sha256').update(readFileSync(HELPER)).digest('hex'),
    accounts,
    journal: join(ROOT, 'journal'),
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if ((statSync(MANIFEST).mode & 0o777) !== 0o600) throw new Error('Unexpected public manifest permissions');
  loadSecrets(manifest); // Round-trip the stored secrets and verify address derivation.
  console.log(JSON.stringify(manifest, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  if (process.argv[2] !== 'init' && process.argv[2] !== 'public') throw new Error('Use init or public; no secret-export command exists.');
  if (process.argv[2] === 'init') init();
  else console.log(JSON.stringify(publicManifest(), null, 2));
}
