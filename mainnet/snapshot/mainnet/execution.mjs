// Mainnet-only, single-step executor. Tests inject a local API and synthetic
// secrets; the CLI fixes the production endpoint and never imports testnet.mjs.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import stacks from '../source/vault/node_modules/@stacks/transactions/dist/index.js';
import { wallet, sigCV, vaultId, withdrawalDigest } from '../source/vault/src/vault.mjs';
import { fileJournal } from '../source/vault/src/journal.mjs';
import * as lamport from '../source/vault/src/lamport.mjs';

const { Cl, Pc, PostConditionMode, ClarityVersion, TransactionSigner, deserializeTransaction,
  getAddressFromPublicKey, getAddressFromPrivateKey, makeUnsignedContractDeploy,
  makeUnsignedContractCall, makeUnsignedSTXTokenTransfer, serializePayload } = stacks;
export const TOKEN = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
export const LABELS = ['deploy-pq-verifier-trait', 'deploy-lamport', 'deploy-pq-vault', 'open-vault', 'deposit-sbtc', 'fund-submitter', 'withdraw-sbtc'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v, 2) + '\n';
const demand = (ok, why) => { if (!ok) throw new Error(why); };
const units = value => { demand(/^(0|[1-9][0-9]*)$/.test(String(value)), 'Invalid unsigned decimal'); return BigInt(value); };
const idHex = value => String(value).replace(/^0x/, '').toLowerCase();
const cvHex = cv => cv.value;
const cvPrincipal = cv => Cl.prettyPrint(cv).replace(/^'/, '');
const roleOf = index => index === 6 ? 'submitter' : 'operator';

export function atomicWrite(path, value) {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const folder = openSync(dir, 'r');
  try { fsyncSync(folder); } finally { closeSync(folder); }
}

export function validateCandidate(c) {
  demand(c.schema === 1 && c.network === 'mainnet' && c.chainId === 1, 'Candidate must be mainnet chain ID 1');
  demand(c.token === TOKEN && c.amountSats === '1000', 'Only the reviewed 1,000-sat official sBTC demo is supported');
  demand(c.feeCapMicroStx === '20000000' && c.feePriority === 'low', 'Expected the 20 STX cumulative cap and low-priority policy');
  demand(Number.isSafeInteger(c.confirmations) && c.confirmations >= 6, 'Require at least six canonical Stacks block confirmations');
  demand(c.submitterReserveMicroStx === '2000000', 'Unexpected submitter reserve');
  const bids = { 'open-vault': '250000', 'deposit-sbtc': '500000', 'withdraw-sbtc': '1500000' };
  demand(Object.keys(c.firstCallFeesMicroStx ?? {}).length === 3 && Object.entries(bids).every(([k,v]) => c.firstCallFeesMicroStx[k] === v), 'Unexpected first-call fee bids');
  const addresses = Object.values(c.accounts).map(a => a.address);
  demand(addresses.length === 3 && new Set(addresses).size === 3, 'Require three independent demo accounts');
  for (const role of ['operator', 'submitter', 'recipient']) {
    const a = c.accounts[role];
    demand(a && getAddressFromPublicKey(a.publicKey, 'mainnet') === a.address, 'Public account key/address mismatch');
    units(a.startNonce);
  }
  const issuer = c.accounts.operator.address;
  demand(c.vault === `${issuer}.pq-vault` && c.verifier === `${issuer}.lamport`, 'Unexpected contract principals');
  demand(c.recipient === c.accounts.recipient.address, 'Recipient is not the pinned demo account');
  for (const name of ['keyCommitment', 'nextKey', 'vaultId', 'digest']) demand(/^[0-9a-f]{64}$/.test(c[name]), `Invalid ${name}`);
  demand(c.keyCommitment !== c.nextKey, 'Successor must be fresh');
  demand(vaultId(Buffer.from(c.keyCommitment, 'hex'), c.verifier).toString('hex') === c.vaultId, 'Vault ID mismatch');
  demand(withdrawalDigest({ vault: c.vault, chainId: 1, id: Buffer.from(c.vaultId, 'hex'), nonce: 0, asset: 'sbtc', amount: units(c.amountSats), recipient: c.recipient, nextKey: Buffer.from(c.nextKey, 'hex') }).toString('hex') === c.digest, 'Withdrawal digest mismatch');
  demand(Object.keys(c.sources).sort().join() === ['lamport', 'pq-vault', 'pq-verifier-trait'].join(), 'Unexpected deployment set');
  for (const s of Object.values(c.sources)) demand(sha256(s.code) === s.sha256, 'Candidate source hash mismatch');
  for (const name of ['sbtc-token', 'sbtc-registry']) demand(/^[0-9a-f]{64}$/.test(c.tokenSourceHashes[name]), 'Missing token source pin');
  return c;
}

export function verifyReviewedFiles(c, root) {
  validateCandidate(c);
  for (const [path, expected] of Object.entries(c.reviewedFiles)) {
    demand(!path.startsWith('/') && !path.split('/').includes('..'), 'Unsafe review file path');
    demand(sha256(readFileSync(join(root, path))) === expected, `Reviewed file changed: ${path}`);
  }
}

export async function buildTransaction(c, index, nonce, fee, signature) {
  validateCandidate(c);
  const role = roleOf(index), a = c.accounts[role];
  const base = { publicKey: a.publicKey, network: 'mainnet', nonce: units(nonce), fee: units(fee), postConditionMode: PostConditionMode.Deny };
  if (index < 3) {
    const name = LABELS[index].slice('deploy-'.length);
    return makeUnsignedContractDeploy({ ...base, contractName: name, codeBody: c.sources[name].code, clarityVersion: ClarityVersion.Clarity6 });
  }
  if (index === 5) return makeUnsignedSTXTokenTransfer({ ...base, recipient: c.accounts.submitter.address, amount: units(c.submitterReserveMicroStx) });
  const id = Cl.bufferFromHex(c.vaultId), v = Cl.contractPrincipal(c.accounts.operator.address, 'lamport');
  let fn, args, postConditions = [];
  if (index === 3) { fn = 'open'; args = [Cl.bufferFromHex(c.keyCommitment), v]; }
  if (index === 4) {
    fn = 'deposit-sbtc'; args = [id, Cl.uint(c.amountSats)];
    postConditions = [Pc.principal(c.accounts.operator.address).willSendEq(c.amountSats).ft(TOKEN, 'sbtc-token')];
  }
  if (index === 6) {
    fn = 'withdraw-sbtc';
    args = [id, Cl.uint(0), Cl.uint(c.amountSats), Cl.principal(c.recipient), Cl.bufferFromHex(c.nextKey), v,
      sigCV(signature ?? Array.from({ length: 512 }, () => Buffer.alloc(32)))];
    postConditions = [Pc.principal(c.vault).willSendEq(c.amountSats).ft(TOKEN, 'sbtc-token')];
  }
  demand(fn, 'Unknown execution step');
  return makeUnsignedContractCall({ ...base, contractAddress: c.accounts.operator.address, contractName: 'pq-vault', functionName: fn, functionArgs: args, postConditions });
}

async function assertWire(c, record, tx) {
  demand(tx.chainId === 1 && tx.transactionVersion === 0, 'Stored transaction is not mainnet');
  demand(`0x${tx.txid()}` === record.txid && sha256(Buffer.from(record.wire, 'hex')) === record.wireSha256, 'Stored signed bytes/ID changed');
  demand(String(tx.auth.spendingCondition.fee) === record.fee && String(tx.auth.spendingCondition.nonce) === record.nonce, 'Stored fee/nonce changed');
  demand(tx.postConditionMode === PostConditionMode.Deny, 'Stored transaction must deny unexpected asset outflow');
  let signature;
  if (record.label === 'withdraw-sbtc') {
    signature = tx.payload.functionArgs?.[6]?.value?.map(w => Buffer.from(w.value, 'hex'));
    demand(signature && lamport.verify(Buffer.from(c.keyCommitment, 'hex'), Buffer.from(c.digest, 'hex'), signature), 'Stored withdrawal authorization does not match candidate');
  }
  const expected = await buildTransaction(c, LABELS.indexOf(record.label), record.nonce, record.fee, signature);
  // Compare wire encoding, not SDK-only string length metadata, which changes
  // when a transaction is deserialized.
  const normalized = deserializeTransaction(expected.serialize());
  demand(serializePayload(expected.payload) === serializePayload(tx.payload) && json(normalized.postConditions) === json(tx.postConditions), 'Stored payload/post-conditions differ from candidate');
  demand(tx.auth.authType === expected.auth.authType && tx.auth.spendingCondition.signer === expected.auth.spendingCondition.signer && tx.anchorMode === expected.anchorMode, 'Stored sender/authorization/anchor mode differs from candidate');
  tx.verifyOrigin();
}

export class Executor {
  constructor({ candidate, candidateHash, root, api, loadSecrets, journalPath = join(root, 'journal'), now = () => new Date().toISOString() }) {
    this.c = validateCandidate(candidate); this.hash = candidateHash; this.root = root; this.api = api; this.loadSecrets = loadSecrets; this.now = now;
    this.statePath = join(root, 'execution.json'); this.marker = join(root, 'initialized.json'); this.journalPath = journalPath;
    this.authorizationPath = join(root, 'authorization.json');
  }

  state() {
    const present = existsSync(this.statePath), marked = existsSync(this.marker);
    demand(present === marked, 'Execution state/initialization marker missing; stop for recovery');
    if (!present) return { schema: 1, candidateHash: this.hash, records: [], createdAt: this.now() };
    demand(existsSync(this.journalPath), 'Signer journal directory missing; stop for recovery');
    const s = JSON.parse(readFileSync(this.statePath, 'utf8'));
    demand(s.candidateHash === this.hash && JSON.parse(readFileSync(this.marker, 'utf8')).candidateHash === this.hash, 'Execution belongs to a different candidate');
    demand(s.records.length <= 7, 'Unexpected execution record count');
    for (const [index, r] of s.records.entries()) demand(r.label === LABELS[index] && r.role === roleOf(index) && r.nonce === this.nonce(index), 'Execution sequence/nonce changed');
    demand(this.reserved(s) <= units(this.c.feeCapMicroStx), 'Stored fee reservations exceed the cumulative cap');
    if (s.records.length === 7) {
      demand(existsSync(this.authorizationPath), 'Stored withdrawal authorization missing; stop for recovery');
      const auth = JSON.parse(readFileSync(this.authorizationPath, 'utf8'));
      const held = JSON.parse(readFileSync(join(this.journalPath, `${this.c.keyCommitment}.json`), 'utf8'));
      demand(auth.candidateHash === this.hash && auth.digest === this.c.digest && held.digest === this.c.digest, 'Withdrawal authorization/journal inconsistent; stop for recovery');
      const wireSig = deserializeTransaction(s.records[6].wire).payload.functionArgs[6].value.map(w => w.value);
      demand(json(wireSig) === json(auth.signature), 'Saved transaction differs from stored authorization');
    }
    return s;
  }

  save(s) { atomicWrite(this.statePath, json(s)); }

  async locked(fn) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    demand((statSync(this.root).mode & 0o077) === 0, 'Execution directory must be private');
    const path = join(this.root, 'executor.lock');
    try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw new Error('Executor lock exists; inspect its process before recovery'); throw e; }
    try { atomicWrite(join(path, 'owner.json'), json({ pid: process.pid, startedAt: this.now() })); return await fn(); }
    finally { rmSync(path, { recursive: true }); }
  }

  initialize(s) {
    if (existsSync(this.marker)) return;
    // Refuse to adopt previous authorization artifacts into a new run.
    demand(!existsSync(this.authorizationPath) && !existsSync(this.journalPath), 'Untracked signing state exists; stop for recovery');
    mkdirSync(this.journalPath, { mode: 0o700 });
    // A crash between these files fails closed on the next run.
    this.save(s); atomicWrite(this.marker, json({ candidateHash: this.hash, initializedAt: this.now() }));
  }

  async network() {
    const info = await this.api.info();
    demand(info.network_id === 1 && Number.isSafeInteger(info.stacks_tip_height), 'Mainnet network/height check failed');
    return info;
  }

  async tokenSources() {
    for (const name of ['sbtc-token', 'sbtc-registry']) {
      const source = await this.api.source(`${TOKEN.split('.')[0]}.${name}`);
      demand(source && sha256(source.source.trim()) === this.c.tokenSourceHashes[name], `Deployed ${name} source changed`);
    }
  }

  async deployed(count) {
    for (let i = 0; i < count; i++) {
      const name = LABELS[i].slice('deploy-'.length);
      const source = await this.api.source(`${this.c.accounts.operator.address}.${name}`);
      demand(source && sha256(source.source) === this.c.sources[name].sha256, `Deployed ${name} does not match candidate`);
    }
  }

  async vaultState() {
    const cv = await this.api.read('get-vault', [Cl.bufferFromHex(this.c.vaultId)]);
    if (cv.type === 'none') return null;
    demand(cv.type === 'some', 'Unexpected vault state response');
    const v = cv.value.value;
    return { key: cvHex(v.key), nonce: String(v.nonce.value), sbtc: String(v.sbtc.value), stx: String(v.stx.value), verifier: cvPrincipal(v.verifier) };
  }

  expectedVault(funded, paid = false) {
    return { key: paid ? this.c.nextKey : this.c.keyCommitment, nonce: paid ? '1' : '0', sbtc: funded && !paid ? this.c.amountSats : '0', stx: '0', verifier: this.c.verifier };
  }

  async assertVault(funded, paid = false) {
    demand(json(await this.vaultState()) === json(this.expectedVault(funded, paid)), 'On-chain vault state differs from expected key, nonce, verifier or ledger');
    demand(String(await this.api.tokenBalance(this.c.vault)) === (funded && !paid ? this.c.amountSats : '0'), 'Actual vault token balance differs from its ledger');
  }

  async observation(record) {
    const tx = await this.api.transaction(record.txid);
    if (!tx || tx.tx_status?.startsWith('dropped')) return { status: 'absent-or-dropped', tx };
    if (tx.tx_status === 'pending') return { status: 'pending', tx };
    demand(tx.tx_id === record.txid && tx.sender_address === this.c.accounts[record.role].address && String(tx.nonce) === record.nonce && String(tx.fee_rate) === record.fee, 'Indexed transaction identity/fee/nonce mismatch');
    demand(tx.canonical === true && tx.microblock_canonical !== false && tx.is_unanchored !== true, 'Transaction is noncanonical or unanchored; reconcile reorganization');
    const block = await this.api.block(tx.block_height), info = await this.network();
    demand(block && block.canonical === true && block.hash === tx.block_hash, 'Transaction block is no longer canonical');
    const depth = info.stacks_tip_height - tx.block_height + 1;
    if (tx.tx_status !== 'success') return { status: 'failed', tx, depth };
    demand(tx.tx_result?.repr === (record.label === 'open-vault' ? `(ok 0x${this.c.vaultId})` : '(ok true)'), 'Unexpected successful transaction result');
    return { status: depth >= this.c.confirmations ? 'confirmed' : 'confirming', tx, depth };
  }

  async events(record, assetType, sender, recipient, amount) {
    const events = await this.api.events(record.txid);
    const transfers = events.filter(e => ['stx_asset', 'fungible_token_asset'].includes(e.event_type) && e.asset?.asset_event_type === 'transfer');
    demand(transfers.length === 1, 'Expected exactly one asset transfer event');
    const e = transfers[0], a = e.asset;
    demand(e.event_type === assetType && a.sender === sender && a.recipient === recipient && String(a.amount) === String(amount), 'Asset transfer differs from signed plan');
    if (assetType === 'fungible_token_asset') demand(a.asset_id === `${TOKEN}::sbtc-token`, 'Wrong fungible-token asset');
  }

  async verifyEffect(record, index) {
    if (index < 3) return this.deployed(index + 1);
    if (index === 3) return this.assertVault(false);
    if (index === 4) {
      await this.events(record, 'fungible_token_asset', this.c.accounts.operator.address, this.c.vault, this.c.amountSats);
      return this.assertVault(true);
    }
    if (index === 5) {
      await this.events(record, 'stx_asset', this.c.accounts.operator.address, this.c.accounts.submitter.address, this.c.submitterReserveMicroStx);
      await this.assertVault(true);
      return;
    }
    await this.events(record, 'fungible_token_asset', this.c.vault, this.c.recipient, this.c.amountSats);
    await this.assertVault(false, true);
    demand(units(await this.api.tokenBalance(this.c.recipient)) === units(record.recipientBalanceBefore) + units(this.c.amountSats), 'Recipient token balance did not increase by exactly the demo amount');
  }

  async freshAccount(role, nonce) {
    const account = await this.api.account(this.c.accounts[role].address);
    demand(String(account.nonce) === String(nonce), 'Account nonce changed; reconcile existing transactions');
    demand(!account.missingNonces.length && !account.mempoolNonces.length, 'Account has unresolved/mempool transactions');
    return account;
  }

  nonce(index) { return String(units(this.c.accounts[roleOf(index)].startNonce) + BigInt(index === 6 ? 0 : index)); }

  async before(index) {
    await this.network(); await this.tokenSources();
    await this.deployed(Math.min(index, 3));
    if (index < 3) {
      const name = LABELS[index].slice('deploy-'.length);
      demand(await this.api.source(`${this.c.accounts.operator.address}.${name}`) === null, 'Contract name is already occupied');
    } else if (index === 3) {
      demand(await this.vaultState() === null, 'Vault already exists outside this execution record');
      demand(String(await this.api.tokenBalance(this.c.vault)) === '0', 'Unexpected pre-existing token balance');
    } else await this.assertVault(index >= 5);
    if (index === 4) demand(units(await this.api.tokenBalance(this.c.accounts.operator.address)) >= units(this.c.amountSats), 'Operator needs 1,000 sats of mainnet sBTC');
    if (index === 6) {
      const digest = await this.api.read('withdrawal-digest', [Cl.bufferFromHex(this.c.vaultId), Cl.uint(0), Cl.stringAscii('sbtc'), Cl.uint(this.c.amountSats), Cl.principal(this.c.recipient), Cl.bufferFromHex(this.c.nextKey)]);
      demand(digest.type === 'buffer' && cvHex(digest) === this.c.digest, 'On-chain withdrawal digest differs; do not sign');
    }
  }

  async authorization() {
    const c = this.c;
    if (existsSync(this.authorizationPath)) {
      const a = JSON.parse(readFileSync(this.authorizationPath, 'utf8'));
      demand(a.candidateHash === this.hash && a.digest === c.digest, 'Stored authorization belongs to another instruction');
      const sig = a.signature.map(w => Buffer.from(w, 'hex'));
      demand(lamport.verify(Buffer.from(c.keyCommitment, 'hex'), Buffer.from(c.digest, 'hex'), sig), 'Stored authorization is invalid');
      const held = fileJournal(this.journalPath).get(c.keyCommitment);
      demand(held?.digest === c.digest, 'Stored authorization has no matching durable journal claim');
      return sig;
    }
    const keys = this.loadSecrets();
    const owner = wallet({ master: Buffer.from(keys.master, 'hex'), chainId: 1, vault: c.vault, verifier: c.verifier, scheme: 'lamport', account: 0, journal: fileJournal(this.journalPath) });
    demand(owner.id.toString('hex') === c.vaultId && owner.key(0).toString('hex') === c.keyCommitment && owner.key(1).toString('hex') === c.nextKey, 'Keychain Lamport commitments differ from candidate');
    const r = owner.signWithdrawal({ nonce: 0, asset: 'sbtc', amount: units(c.amountSats), recipient: c.recipient });
    demand(r.digest.toString('hex') === c.digest, 'Signer digest mismatch');
    atomicWrite(this.authorizationPath, json({ candidateHash: this.hash, digest: c.digest, signature: r.sig.map(w => w.toString('hex')), createdAt: this.now() }));
    return r.sig;
  }

  async quote(index, nonce) {
    const sample = await buildTransaction(this.c, index, nonce, 0);
    const estimates = await this.api.estimate(sample);
    if (estimates?.reason === 'NoEstimateAvailable') {
      const fee = this.c.firstCallFeesMicroStx[LABELS[index]];
      demand(fee !== undefined, 'No estimate and no explicitly reviewed first-call bid');
      return { fee, basis: 'Explicit first-call bid: node returned NoEstimateAvailable' };
    }
    demand(Array.isArray(estimates) && estimates.length >= 1 && Number.isSafeInteger(estimates[0].fee) && estimates[0].fee > 0, 'No executable low-priority fee estimate; stop rather than use a placeholder');
    return { fee: String(estimates[0].fee), basis: 'Live low-priority node estimate' };
  }

  reserved(s) { return s.records.reduce((total, r) => total + units(r.fee), 0n); }

  async preflight() {
    demand(this.state().records.length === 0, 'Initial preflight is only for an unstarted run; use status after execution starts');
    await this.network(); await this.tokenSources();
    for (const name of Object.keys(this.c.sources)) demand(await this.api.source(`${this.c.accounts.operator.address}.${name}`) === null, 'Contract name already occupied');
    const accounts = {};
    for (const role of ['operator', 'submitter']) accounts[role] = await this.freshAccount(role, this.c.accounts[role].startNonce);
    const quotes = await Promise.all(LABELS.map(async (label, i) => ({ label, ...await this.quote(i, this.nonce(i)) })));
    const total = quotes.reduce((sum,q) => sum + units(q.fee), 0n);
    const operatorFees = quotes.slice(0,6).reduce((sum,q) => sum + units(q.fee), 0n);
    const affordable = total <= units(this.c.feeCapMicroStx) && operatorFees + units(this.c.submitterReserveMicroStx) <= units(this.c.feeCapMicroStx) && units(quotes[6].fee) <= units(this.c.submitterReserveMicroStx);
    const sbtc = String(await this.api.tokenBalance(this.c.accounts.operator.address));
    return { candidateHash: this.hash, network: 'mainnet', sourcePinsMatch: true, contractNamesAvailable: true,
      feeCapMicroStx: this.c.feeCapMicroStx, quotedOrExplicitFeesMicroStx: String(total), feesFitFundedReserve: affordable,
      quotes, operator: this.c.accounts.operator.address, operatorAvailableStxMicro: String(accounts.operator.availableStx), operatorSbtcSats: sbtc,
      fundingPresent: units(accounts.operator.availableStx) >= units(this.c.feeCapMicroStx) && units(sbtc) >= units(this.c.amountSats),
      requiredFunding: { mainnetSbtcSats: this.c.amountSats, stxMicro: this.c.feeCapMicroStx },
      confirmations: this.c.confirmations, signing: false, broadcasts: 0 };
  }

  async send(record) {
    const tx = deserializeTransaction(record.wire); await assertWire(this.c, record, tx);
    // The exact signed bytes are already durable. A network exception leaves
    // them untouched; the next invocation reconciles this same transaction ID.
    const reply = await this.api.broadcast(tx);
    demand(!reply.error && idHex(reply.txid) === idHex(record.txid), 'Broadcast reply uncertain/rejected; reconcile the saved transaction ID');
    return { status: 'broadcast', label: record.label, txid: record.txid, feeMicroStx: record.fee };
  }

  async advance() {
    return this.locked(async () => {
      const s = this.state();
      await this.network();
      // Recheck every predecessor's canonical status on every invocation.
      for (let i = 0; i < s.records.length; i++) {
        const r = s.records[i], obs = await this.observation(r);
        await assertWire(this.c, r, deserializeTransaction(r.wire));
        if (obs.status === 'failed') {
          r.observation = { status: obs.tx.tx_status, block: obs.tx.block_height, feeConsumed: r.fee }; this.save(s);
          throw new Error(`Transaction ${r.txid} failed (${obs.tx.tx_status}); fee remains counted; manual review required`);
        }
        if (i < s.records.length - 1) demand(obs.status === 'confirmed', 'A predecessor is no longer confirmed; stop for reorganization reconciliation');
        if (obs.status === 'confirmed') {
          // Historical state has advanced since earlier steps; verify their
          // transaction identity/canonicality, but verify the latest effect.
          if (i === s.records.length - 1) await this.verifyEffect(r, i);
          r.observation = { status: 'success', block: obs.tx.block_height, blockHash: obs.tx.block_hash, confirmations: obs.depth };
          continue;
        }
        if (obs.status === 'absent-or-dropped') {
          await this.before(i);
          const a = await this.freshAccount(r.role, r.nonce);
          demand(units(a.availableStx) >= units(r.fee) + (i === 5 ? units(this.c.submitterReserveMicroStx) : 0n), 'Insufficient STX to rebroadcast');
          return this.send(r);
        }
        return { status: obs.status, label: r.label, txid: r.txid, confirmations: obs.depth ?? 0, requiredConfirmations: this.c.confirmations };
      }
      if (s.records.length) this.save(s);
      if (s.records.length === 7) return { status: 'complete', candidateHash: this.hash, totalReservedFeesMicroStx: String(this.reserved(s)), transactions: s.records.map(r => ({ label: r.label, txid: r.txid, feeMicroStx: r.fee, ...r.observation })) };
      const index = s.records.length, role = roleOf(index), nonce = this.nonce(index);
      if (index === 0) demand((await this.preflight()).feesFitFundedReserve, 'Whole demo fee plan exceeds the 20 STX funded reserve; no signature created');
      await this.before(index);
      const account = await this.freshAccount(role, nonce);
      const { fee, basis: feeBasis } = await this.quote(index, nonce);
      demand(this.reserved(s) + units(fee) <= units(this.c.feeCapMicroStx), 'Cumulative 20 STX fee cap would be exceeded; no signature created');
      demand(units(account.availableStx) >= units(fee) + (index === 5 ? units(this.c.submitterReserveMicroStx) : 0n), `Fund ${role} with STX before this step`);
      // Check all initial funding before committing any deployment fee.
      if (index === 0) {
        demand(units(await this.api.tokenBalance(this.c.accounts.operator.address)) >= units(this.c.amountSats), 'Operator needs 1,000 sats of mainnet sBTC');
        demand(units(account.availableStx) >= units(this.c.feeCapMicroStx), 'Operator needs the agreed 20 STX funding reserve');
      }
      if (index === 5) {
        const { fee: withdrawalFee } = await this.quote(6, this.nonce(6));
        demand(units(withdrawalFee) <= units(this.c.submitterReserveMicroStx), 'Withdrawal fee exceeds pinned submitter reserve; review funding before proceeding');
        demand(this.reserved(s) + units(fee) + units(withdrawalFee) <= units(this.c.feeCapMicroStx), 'Remaining setup and withdrawal exceed the cumulative cap');
      }
      this.initialize(s);
      const recipientBalanceBefore = index === 6 ? String(await this.api.tokenBalance(this.c.recipient)) : undefined;
      const signature = index === 6 ? await this.authorization() : undefined;
      const tx = await buildTransaction(this.c, index, nonce, fee, signature);
      const keys = this.loadSecrets();
      demand(getAddressFromPrivateKey(keys[role], 'mainnet') === this.c.accounts[role].address, 'Signing account differs from candidate');
      new TransactionSigner(tx).signOrigin(keys[role]);
      tx.verifyOrigin();
      const record = { label: LABELS[index], role, nonce, fee, feeBasis, wire: tx.serialize(), wireSha256: sha256(tx.serializeBytes()), txid: `0x${tx.txid()}`, signedAt: this.now(), ...(recipientBalanceBefore !== undefined && { recipientBalanceBefore }) };
      s.records.push(record); this.save(s);
      return this.send(record);
    });
  }

  async inspect() {
    const s = this.state();
    await this.network();
    const records = [];
    for (const [i, r] of s.records.entries()) {
      await assertWire(this.c, r, deserializeTransaction(r.wire));
      const obs = await this.observation(r);
      records.push({ label: r.label, txid: r.txid, feeMicroStx: r.fee, status: obs.status, confirmations: obs.depth ?? 0 });
      if (obs.status === 'confirmed' && i === s.records.length - 1) await this.verifyEffect(r, i);
    }
    const operator = await this.api.account(this.c.accounts.operator.address);
    const sbtc = String(await this.api.tokenBalance(this.c.accounts.operator.address));
    return { candidateHash: this.hash, network: 'mainnet', operator: this.c.accounts.operator.address,
      operatorAvailableStxMicro: String(operator.availableStx), operatorSbtcSats: sbtc,
      initialFundingPresent: units(operator.availableStx) >= units(this.c.feeCapMicroStx) && units(sbtc) >= units(this.c.amountSats),
      feeCapMicroStx: this.c.feeCapMicroStx, reservedFeesMicroStx: String(this.reserved(s)), records,
      nextStep: LABELS[s.records.length] ?? null,
      complete: records.length === 7 && records.every(r => r.status === 'confirmed') };
  }
}
