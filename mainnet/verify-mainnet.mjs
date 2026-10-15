// Public, read-only replay of the completed demo. No custody, journal or signing imports.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import stacks from './snapshot/source/vault/node_modules/@stacks/transactions/dist/index.js';
import { buildTransaction, validateCandidate, sha256, json } from './snapshot/mainnet/execution.mjs';
import * as lamport from './snapshot/source/vault/src/lamport.mjs';
import { verifySnapshot } from './verify-snapshot.mjs';

const { Cl, serializeCV, deserializeCV, deserializeTransaction, serializePayload } = stacks;
const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const origin = 'https://api.hiro.so';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function publicReadApi({ fetchImpl = globalThis.fetch, wait = sleep, intervalMs = 1100 } = {}) {
  const observations = {};
  let nextAt = 0;
  async function request(path, body) {
    const method = body ? 'POST' : 'GET';
    const permitted = body
      ? /^\/v2\/contracts\/call-read\/[A-Z0-9]+\/[a-zA-Z0-9_-]+\/(get-vault|withdrawal-digest|get-balance-available)$/.test(path)
      : /^\/(v2\/info|v2\/contracts\/source\/[A-Z0-9]+\/[a-zA-Z0-9_-]+\?proof=0|extended\/v1\/tx\/0x[0-9a-f]{64}(\/raw)?|extended\/v1\/block\/by_height\/[0-9]+|extended\/v1\/tx\/events\?tx_id=0x[0-9a-f]{64}&limit=50)$/.test(path);
    assert.ok(permitted, 'Read-only verifier refused an unapproved endpoint');
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = Math.max(Date.now(), nextAt); nextAt = start + intervalMs;
      if (start > Date.now()) await wait(start - Date.now());
      const response = await fetchImpl(origin + path, { method, ...(body && { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), signal: AbortSignal.timeout(15000) });
      if (response.status === 429 && attempt < 2) {
        const header = response.headers.get('retry-after');
        const numeric = header === null ? 2 : Number(header);
        const ms = Number.isFinite(numeric) ? numeric * 1000 : Date.parse(header) - Date.now();
        assert.ok(Number.isFinite(ms) && ms >= 0 && ms <= 60000, 'Provider cooldown exceeds the bounded read-only retry policy');
        await response.body?.cancel(); await wait(Math.max(1000, ms)); continue;
      }
      assert.ok(response.ok, `Public mainnet read failed: HTTP ${response.status} ${path}`);
      const data = await response.json();
      observations[`${method} ${path}${body ? ' ' + JSON.stringify(body) : ''}`] = data;
      return data;
    }
    throw Error('Public mainnet read exhausted retries');
  }
  return {
    observations,
    info: () => request('/v2/info'),
    transaction: id => request(`/extended/v1/tx/${id}`),
    raw: id => request(`/extended/v1/tx/${id}/raw`),
    block: height => request(`/extended/v1/block/by_height/${height}`),
    source: principal => request(`/v2/contracts/source/${principal.replace('.', '/')}?proof=0`),
    async events(id) {
      const d = await request(`/extended/v1/tx/events?tx_id=${id}&limit=50`);
      assert.ok(Array.isArray(d.events) && d.offset === 0 && d.limit === 50, 'Malformed event page');
      assert.ok(d.total === undefined ? d.events.length < d.limit : Number.isSafeInteger(d.total) && d.total === d.events.length, 'Incomplete or paginated event evidence');
      return d.events;
    },
    async read(principal, fn, args, sender) {
      const d = await request(`/v2/contracts/call-read/${principal.replace('.', '/')}/${fn}`, { sender, arguments: args.map(v => '0x' + serializeCV(v)) });
      assert.equal(d.okay, true, 'Read-only Clarity call failed');
      return deserializeCV(d.result);
    },
  };
}

export async function verifyMainnet({ api = publicReadApi(), candidate = readJson('./snapshot/mainnet/candidate/manifest.json'), evidence = readJson('./evidence/mainnet-execution.json') } = {}) {
  const c = validateCandidate(candidate), e = evidence;
  const info = await api.info();
  assert.equal(info.network_id, 1); assert.ok(Number.isSafeInteger(info.stacks_tip_height));
  for (const [name, source] of Object.entries(c.sources)) {
    assert.equal(sha256((await api.source(`${c.accounts.operator.address}.${name}`)).source), source.sha256, `Deployed ${name} changed`);
  }
  for (const [name, hash] of Object.entries(c.tokenSourceHashes)) {
    assert.equal(sha256((await api.source(`${c.token.split('.')[0]}.${name}`)).source.trim()), hash, `Deployed ${name} changed`);
  }
  const transactions = [];
  for (const [i, recorded] of e.transactions.entries()) {
    const t = await api.transaction(recorded.txid);
    assert.equal(t.tx_id, recorded.txid); assert.equal(t.tx_status, 'success');
    assert.equal(t.canonical, true); assert.equal(t.microblock_canonical, true); assert.equal(t.is_unanchored, false);
    assert.equal(t.sender_address, recorded.sender); assert.equal(String(t.nonce), recorded.nonce); assert.equal(t.fee_rate, recorded.feeMicroStx);
    assert.equal(t.block_height, recorded.blockHeight); assert.equal(t.block_hash, recorded.blockHash);
    assert.equal(t.tx_result.repr, recorded.result);
    assert.equal(Cl.prettyPrint(deserializeCV(t.tx_result.hex)), recorded.result, 'Receipt result hex disagrees with repr');
    const block = await api.block(t.block_height);
    assert.equal(block.canonical, true); assert.equal(block.hash, t.block_hash); assert.equal(block.height, t.block_height);
    const confirmations = info.stacks_tip_height - t.block_height + 1;
    assert.ok(confirmations >= c.confirmations, 'Insufficient canonical Stacks confirmations');
    const raw = (await api.raw(recorded.txid)).raw_tx;
    assert.match(raw, /^0x(?:[0-9a-fA-F]{2})+$/);
    assert.equal((raw.length - 2) / 2, recorded.bytes);
    const tx = deserializeTransaction(raw); tx.verifyOrigin();
    assert.equal(tx.serialize().toLowerCase(), raw.slice(2).toLowerCase(), 'Noncanonical or trailing wire bytes');
    assert.equal('0x' + tx.txid(), recorded.txid); assert.equal(tx.chainId, 1); assert.equal(tx.transactionVersion, 0);
    assert.equal(String(tx.auth.spendingCondition.fee), recorded.feeMicroStx); assert.equal(String(tx.auth.spendingCondition.nonce), recorded.nonce);
    let sig;
    if (i === 6) {
      sig = tx.payload.functionArgs[6].value.map(w => Buffer.from(w.value, 'hex'));
      assert.equal(lamport.verify(Buffer.from(c.keyCommitment, 'hex'), Buffer.from(c.digest, 'hex'), sig), true, 'Public Lamport authorization is invalid');
    }
    const expected = await buildTransaction(c, i, recorded.nonce, recorded.feeMicroStx, sig);
    const normalized = deserializeTransaction(expected.serialize());
    assert.equal(serializePayload(tx.payload), serializePayload(expected.payload), 'Public transaction payload differs from plan');
    assert.equal(json(tx.postConditions), json(normalized.postConditions), 'Public post-conditions differ from plan');
    assert.equal(tx.postConditionMode, expected.postConditionMode);
    assert.equal(tx.auth.authType, expected.auth.authType); assert.equal(tx.auth.spendingCondition.signer, expected.auth.spendingCondition.signer);
    assert.equal(tx.anchorMode, expected.anchorMode);
    const events = await api.events(recorded.txid);
    assert.equal(events.length, t.event_count, 'Event count differs from indexed receipt');
    for (const event of events) assert.equal(event.tx_id, recorded.txid, 'Event belongs to another transaction');
    const assetEvents = events.filter(v => /_asset$/.test(v.event_type));
    assert.equal(assetEvents.length, recorded.transfers.length, 'Unexpected extra/missing asset event');
    assert.deepEqual(assetEvents.map(v => ({ type: v.event_type, ...v.asset })), recorded.transfers);
    const logs = events.filter(v => v.event_type === 'smart_contract_log');
    const fields = i === 3 ? {event:Cl.stringAscii('open'),id:Cl.bufferFromHex(c.vaultId),key:Cl.bufferFromHex(c.keyCommitment),verifier:Cl.principal(c.verifier)}
      : i === 4 ? {event:Cl.stringAscii('deposit'),id:Cl.bufferFromHex(c.vaultId),asset:Cl.stringAscii('sbtc'),amount:Cl.uint(c.amountSats)}
      : i === 6 ? {event:Cl.stringAscii('withdraw'),id:Cl.bufferFromHex(c.vaultId),nonce:Cl.uint(0),asset:Cl.stringAscii('sbtc'),amount:Cl.uint(c.amountSats),recipient:Cl.principal(c.recipient),'next-key':Cl.bufferFromHex(c.nextKey)} : null;
    assert.equal(logs.length, fields ? 1 : 0, 'Unexpected contract log count');
    if (fields) {
      assert.equal(logs[0].contract_log.contract_id,c.vault); assert.equal(logs[0].contract_log.topic,'print');
      assert.equal(serializeCV(deserializeCV(logs[0].contract_log.value.hex)),serializeCV(Cl.tuple(fields)), 'Contract event differs from plan');
    }
    const costs = { runtime:t.execution_cost_runtime, readCount:t.execution_cost_read_count, readLength:t.execution_cost_read_length, writeCount:t.execution_cost_write_count, writeLength:t.execution_cost_write_length };
    assert.deepEqual(costs, recorded.executionCost, 'Recorded execution cost differs from chain');
    transactions.push({ label: recorded.label, txid: recorded.txid, confirmations, wireSha256: sha256(Buffer.from(raw.slice(2), 'hex')), originSignatureValid: true, payloadAndPostConditionsMatch: true, eventsAndCostsMatch: true });
  }
  const sender = c.accounts.operator.address;
  const state = await api.read(c.vault, 'get-vault', [Cl.bufferFromHex(c.vaultId)], sender);
  const expectedState = Cl.some(Cl.tuple({ key: Cl.bufferFromHex(c.nextKey), nonce: Cl.uint(1), sbtc: Cl.uint(0), stx: Cl.uint(0), verifier: Cl.principal(c.verifier) }));
  assert.equal(serializeCV(state), serializeCV(expectedState), 'Current vault state differs from completed plan');
  const balance = await api.read(c.token, 'get-balance-available', [Cl.principal(c.vault)], sender);
  assert.equal(serializeCV(balance), serializeCV(Cl.ok(Cl.uint(0))), 'Current vault token balance is nonzero');
  const digest = await api.read(c.vault, 'withdrawal-digest', [Cl.bufferFromHex(c.vaultId), Cl.uint(0), Cl.stringAscii('sbtc'), Cl.uint(c.amountSats), Cl.principal(c.recipient), Cl.bufferFromHex(c.nextKey)], sender);
  assert.equal(serializeCV(digest), serializeCV(Cl.bufferFromHex(c.digest)), 'Deployed digest differs from signed instruction');
  const last = e.transactions.at(-1), finalBlock = await api.block(last.blockHeight);
  assert.equal(finalBlock.canonical, true); assert.equal(finalBlock.hash, last.blockHash, 'Canonical final block changed during verification');
  return { verifiedAt: new Date().toISOString(), provider: origin, readOnly: true, candidateSha256:e.candidateSha256,
    transactions, officialSbtcPaidSats:c.amountSats, actualFeesStx:e.actualFeesStx, vaultEmptyNonceOneSuccessorInstalled:true,
    limitation:'Trusted RPC/indexer observations, not a trustless chain proof or cryptographic security audit. Private custody and historical signing chronology are verified separately.' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--record'), 'Use no arguments, or --record OUTPUT.json');
  verifySnapshot();
  const api = publicReadApi();
  const report = await verifyMainnet({ api });
  if (args.length) writeFileSync(args[1], json({ report, observations:api.observations }));
  console.log(json(report));
}
