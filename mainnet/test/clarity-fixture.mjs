// Audit fixture: synthetic master, official recorded token source, local Clarity only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getSDK } from '../snapshot/source/vault/node_modules/@stacks/clarinet-sdk/dist/esm/node/src/index.js';
import stacks from '../snapshot/source/vault/node_modules/@stacks/transactions/dist/index.js';
import { wallet, sigCV, withdrawalDigest } from '../snapshot/source/vault/src/vault.mjs';
import { fileJournal } from '../snapshot/source/vault/src/journal.mjs';
import * as lamport from '../snapshot/source/vault/src/lamport.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Cl } = stacks;
const TOKEN_ADDRESS = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4';
const TOKEN = `${TOKEN_ADDRESS}.sbtc-token`;
// Public fixture addresses only. This test is reproducible without the local
// custody manifest, macOS Keychain, real private keys or network access.
const accounts = {
  operator: { address: 'SP1BE4QPD9XK2A2TDJE7B40S00J9WZCW280ET3JBP' },
  submitter: { address: 'SP366BJPDWZ8GRF0J3S7TR5C6TDD2P9N6JG14PM4P' },
  recipient: { address: 'SPTXG7A1RB8VZ0GM9SAQEKWHHYZ95MCNMGSM75P6' },
};
const operator = accounts.operator.address, submitter = accounts.submitter.address, recipient = accounts.recipient.address;
const vault = `${operator}.pq-vault`, verifier = `${operator}.lamport`;
const src = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const repr = r => Cl.prettyPrint(r.result);
const hash = path => createHash('sha256').update(src(path)).digest('hex');
export async function boot({ verifierName = 'lamport', verifierSource } = {}) {
  const sim = await getSDK({ trackCosts: true, trackCoverage: false });
  await sim.initEmptySession({ enabled: false, api_url: '', initial_height: 1, use_mainnet_wallets: true });
  sim.setEpoch('4.0');
  sim.setLocalAccounts([operator, submitter, recipient, TOKEN_ADDRESS]);
  for (const address of [operator, submitter, recipient]) sim.mintSTX(address, 100_000_000n);
  // This SDK preloads sBTC contracts even in an empty session. Verify the
  // preloaded source matches the mainnet source read today (trailing newline
  // normalization only), rather than silently assuming its version.
  for (const name of ['sbtc-registry', 'sbtc-token']) {
    assert.equal(sim.getContractSource(`${TOKEN_ADDRESS}.${name}`).trim(), src(`../snapshot/mainnet/evidence/${name}.deployed.clar`).trim());
  }
  for (const name of ['pq-verifier-trait', 'lamport', 'pq-vault']) {
    assert.ok(['true', '(ok true)'].includes(repr(sim.deployContract(name, src(`../snapshot/mainnet/contracts/${name}.clar`), { clarityVersion: 6 }, operator))));
  }
  if (verifierSource) {
    assert.ok(['true', '(ok true)'].includes(repr(sim.deployContract(verifierName, verifierSource, { clarityVersion: 6 }, operator))));
  }
  const chainId = Number(sim.execute('chain-id').result.value);
  // These are deliberately public, synthetic test secrets, unrelated to Keychain.
  const master = createHash('sha256').update('pq-vault/mainnet-integration/public-fixture').digest();
  const dir = mkdtempSync(join(tmpdir(), 'pq-lamport-journal-'));
  const owner = wallet({ master, chainId, vault, verifier: `${operator}.${verifierName}`, scheme: 'lamport', account: 0, journal: fileJournal(dir) });
  const id = Cl.buffer(owner.id), v = Cl.contractPrincipal(operator, verifierName);
  const call = (fn, args, sender = operator) => sim.callPublicFn(vault, fn, args, sender);
  const state = () => Cl.prettyPrint(sim.callReadOnlyFn(vault, 'get-vault', [id], operator).result);
  const balance = who => BigInt(sim.callReadOnlyFn(TOKEN, 'get-balance-available', [Cl.principal(who)], operator).result.value.value);
  const snapshot = () => ({ vault: state(), balances: [operator, submitter, recipient, vault].map(balance) });
  const sign = () => owner.signWithdrawal({ nonce: 0, asset: 'sbtc', amount: 1000n, recipient });
  const withdraw = (r, overrides = {}) => {
    const q = { ...r, ...overrides };
    return call('withdraw-sbtc', [id, Cl.uint(q.nonce), Cl.uint(q.amount), Cl.principal(q.recipient), Cl.buffer(q.nextKey), v, sigCV(q.sig)], submitter);
  };
  assert.equal(repr(call('open', [Cl.buffer(owner.key(0)), v])), `(ok 0x${owner.id.toString('hex')})`);
  // Local-only mint fixture. The deployed token and registry source are unmodified.
  sim.mintFT(`${TOKEN}.sbtc-token`, operator, 1000n);
  assert.equal(balance(operator), 1000n);
  assert.equal(repr(call('deposit-sbtc', [id, Cl.uint(1000)])), '(ok true)');
  assert.equal(balance(vault), 1000n);
  return { sim, chainId, owner, dir, call, id, v, state, balance, snapshot, sign, withdraw };
}


export { accounts, operator, submitter, recipient, vault, verifier, TOKEN };
