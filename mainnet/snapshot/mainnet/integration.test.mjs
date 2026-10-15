import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getSDK } from '../source/vault/node_modules/@stacks/clarinet-sdk/dist/esm/node/src/index.js';
import stacks from '../source/vault/node_modules/@stacks/transactions/dist/index.js';
import { wallet, sigCV, withdrawalDigest } from '../source/vault/src/vault.mjs';
import { fileJournal } from '../source/vault/src/journal.mjs';
import * as lamport from '../source/vault/src/lamport.mjs';
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
const report = {
  generatedAt: new Date().toISOString(), localOnly: true, liveTransactions: 0, token: TOKEN,
  tokenSourceSha256: hash('./evidence/sbtc-token.deployed.clar'),
  testSourceSha256: hash('./integration.test.mjs'),
  contractSourceSha256: Object.fromEntries(['pq-vault', 'lamport', 'pq-verifier-trait'].map(name => [name, hash(`./contracts/${name}.clar`)])),
  contractRejections: [], scenarios: [],
};

async function boot({ verifierName = 'lamport', verifierSource } = {}) {
  const sim = await getSDK({ trackCosts: true, trackCoverage: false });
  await sim.initEmptySession({ enabled: false, api_url: '', initial_height: 1, use_mainnet_wallets: true });
  sim.setEpoch('4.0');
  sim.setLocalAccounts([operator, submitter, recipient, TOKEN_ADDRESS]);
  for (const address of [operator, submitter, recipient]) sim.mintSTX(address, 100_000_000n);
  // This SDK preloads sBTC contracts even in an empty session. Verify the
  // preloaded source matches the mainnet source read today (trailing newline
  // normalization only), rather than silently assuming its version.
  for (const name of ['sbtc-registry', 'sbtc-token']) {
    assert.equal(sim.getContractSource(`${TOKEN_ADDRESS}.${name}`).trim(), src(`./evidence/${name}.deployed.clar`).trim());
  }
  for (const name of ['pq-verifier-trait', 'lamport', 'pq-vault']) {
    assert.ok(['true', '(ok true)'].includes(repr(sim.deployContract(name, src(`./contracts/${name}.clar`), { clarityVersion: 6 }, operator))));
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

// These call Clarity directly: a thrown JS exception, a script guard, or an
// outer transaction post-condition cannot satisfy these rejection assertions.
function assertRejected(t, result, expected, before, label) {
  assert.equal(repr(result), expected, label);
  assert.deepEqual(t.snapshot(), before, `${label}: vault state and all sBTC balances unchanged`);
  assert.deepEqual(result.events, [], `${label}: no withdrawal or token-transfer event`);
  report.contractRejections.push({ case: label, vaultResponse: repr(result), stateAndBalancesUnchanged: true, events: result.events });
}

test('deployed sBTC code: Lamport payout, tampering, replay, key state and persistent signer guard', async () => {
  const t = await boot();
  try {
    const r = t.sign(), before = t.snapshot();
    const digest = t.sim.callReadOnlyFn(vault, 'withdrawal-digest', [t.id, Cl.uint(0), Cl.stringAscii('sbtc'), Cl.uint(1000), Cl.principal(recipient), Cl.buffer(r.nextKey)], operator).result;
    assert.equal(digest.value, r.digest.toString('hex'));
    report.chainId = t.chainId;
    // A second signer instance must see the persistent journal, not just memory.
    const restored = wallet({ master: createHash('sha256').update('pq-vault/mainnet-integration/public-fixture').digest(), chainId: t.chainId, vault, verifier, scheme: 'lamport', account: 0, journal: fileJournal(t.dir) });
    assert.throws(() => restored.signWithdrawal({ nonce: 0, asset: 'sbtc', amount: 999n, recipient }), /already signed/);
    assert.equal(restored.signWithdrawal({ nonce: 0, asset: 'sbtc', amount: 1000n, recipient }).digest.toString('hex'), r.digest.toString('hex'));
    report.scenarios.push('persistent journal refuses a different message; exact retry allowed', 'JS and Clarity digests match');
    for (const [label, override] of [
      ['changed recipient', { recipient: operator }],
      ['changed amount', { amount: 999n }],
      ['changed successor', { nextKey: Buffer.alloc(32, 3) }],
      ['invalid signature', { sig: r.sig.map(() => Buffer.alloc(32)) }],
    ]) {
      assertRejected(t, t.withdraw(r, override), '(err u205)', before, label);
      report.scenarios.push(`${label} rejected without changing balance or state`);
    }
    assertRejected(t, t.withdraw(r, { nextKey: t.owner.key(0) }), '(err u201)', before, 'current key as successor');
    report.scenarios.push('current key cannot be its own successor');
    const crossChainDigest = withdrawalDigest({ vault, chainId: t.chainId === 1 ? 0x80000000 : 1, id: r.id, nonce: 0, asset: 'sbtc', amount: 1000n, recipient, nextKey: r.nextKey });
    assert.notEqual(crossChainDigest.toString('hex'), r.digest.toString('hex'));
    report.scenarios.push('digest separates mainnet and testnet');
    const result = t.withdraw(r);
    assert.equal(repr(result), '(ok true)');
    assert.equal(t.balance(recipient), 1000n);
    assert.equal(t.balance(vault), 0n);
    assert.match(t.state(), /nonce[^0-9]*u?1/);
    assert.ok(t.state().includes(r.nextKey.toString('hex')));
    report.withdrawalCosts = result.costs.total;
    report.scenarios.push('different carrier pays sBTC to the signed recipient; vault drained and key advanced');
    const paid = t.snapshot();
    assertRejected(t, t.withdraw(r), '(err u203)', paid, 'completed withdrawal replay');
    report.scenarios.push('replay rejected');
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

for (const [name, response, otherBranch] of [
  ['false-verifier', '(ok false)', '(err u777)'],
  ['error-verifier', '(err u777)', '(ok true)'],
]) {
  test(`vault fails closed when its pinned verifier returns ${response}`, async () => {
    // Pin the test verifier at open, so this exercises the verifier response
    // rather than the earlier wrong-verifier check (u202). Both branches give
    // the stub the trait's full (response bool uint) return type.
    const verifierSource = `(impl-trait .pq-verifier-trait.pq-verifier)
      (define-public (verify (key (buff 32)) (digest (buff 32)) (sig (list 1024 (buff 32))))
        (if (is-eq (len digest) u32) ${response} ${otherBranch}))`;
    const t = await boot({ verifierName: name, verifierSource });
    try {
      const r = t.sign();
      assert.equal(lamport.verify(t.owner.key(0), r.digest, r.sig), true);
      const actual = t.sim.callPublicFn(`${operator}.${name}`, 'verify', [Cl.buffer(t.owner.key(0)), Cl.buffer(r.digest), sigCV(r.sig)], submitter);
      assert.equal(repr(actual), response);
      const before = t.snapshot();
      assertRejected(t, t.withdraw(r), '(err u205)', before, response);
      report.scenarios.push(`pinned verifier ${response} produces vault (err u205); no state, balance or event effects`);
    } finally { rmSync(t.dir, { recursive: true, force: true }); }
  });
}

test('sBTC transfer failure rolls back vault balance, nonce and key', async () => {
  const t = await boot();
  try {
    const before = t.state();
    // Deliberately bypass the client guard with a public synthetic test key:
    // a correctly signed self-transfer passes signature verification but the
    // real sBTC ft-transfer? refuses sender == recipient. One message only.
    const r = { id: t.owner.id, nonce: 0, amount: 1000n, recipient: vault, nextKey: t.owner.key(1) };
    r.digest = withdrawalDigest({ ...r, asset: 'sbtc', chainId: t.chainId, vault });
    r.sig = lamport.sign(t.owner.secret(0), r.digest);
    const failed = t.withdraw(r);
    assert.notEqual(repr(failed), '(ok true)');
    assert.equal(t.state(), before);
    assert.equal(t.balance(recipient), 0n);
    assert.equal(t.balance(vault), 1000n);
    report.scenarios.push('failed token transfer rolls back vault key, nonce and ledger');
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

process.on('exit', code => {
  report.passed = code === 0;
  writeFileSync(new URL('./evidence/integration-results.json', import.meta.url), JSON.stringify(report, (_, v) => typeof v === 'bigint' ? String(v) : v, 2) + '\n');
});
