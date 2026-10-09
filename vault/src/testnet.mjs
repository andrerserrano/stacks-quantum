// Stacks testnet: the demo's keys, a driver that builds, sends and waits for
// the scripted run's transactions, and a rehearsal that sends nothing.
//
// The keys and the vaults' master secret are throwaways made for the demo.
// They live outside the repository, in ~/.config/pq-vault/, readable only by
// their owner, next to the journal of what each one-time key has signed.
// They hold faucet STX and a mock token. Never fund them on mainnet.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ClarityVersion, PostConditionMode, broadcastTransaction, fetchCallReadOnlyFunction, fetchNonce,
  getAddressFromPrivateKey, makeContractCall, makeContractDeploy, makeSTXTokenTransfer, randomPrivateKey,
} from "@stacks/transactions";
import { CHAIN_ID, boot, source } from "./simnet.mjs";
import { assemble, play, simDriver, story, vaultState } from "./story.mjs";
import { wallet } from "./vault.mjs";

// The Hiro API. The tests point it at a stand-in on localhost.
export const API = process.env.PQ_VAULT_API ?? "https://api.testnet.hiro.so";
const client = { baseUrl: API };
export const explorer = (txid) => `https://explorer.hiro.so/txid/${txid}?chain=testnet`;
const DIR = join(homedir(), ".config", "pq-vault");
export const KEY_FILE = join(DIR, "demo.json");
export const JOURNAL = join(DIR, "demo-journal");
export const ROLES = ["deployer", "owner", "submitter", "recipient"];
// A fixed fee per kind of transaction, or 10 uSTX a byte if that is more. A
// Lamport withdrawal is 19 KB and needs the second.
const FEES = { deploy: 150_000n, call: 30_000n, transfer: 10_000n, perByte: 10n };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How often a sent transaction is looked up. The tests shorten it.
const POLL = Number(process.env.PQ_VAULT_POLL_MS ?? 3000);

// --- amounts ------------------------------------------------------------------

const DECIMALS = { stx: 6, sbtc: 8 };

// "1.5" of an asset in its smallest unit, exactly. 1.5 STX is 1500000 uSTX.
export function units(text, asset) {
  const d = DECIMALS[asset];
  if (!d) throw new Error(`unknown asset ${asset}: use stx or sbtc`);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text ?? "");
  if (!m || (m[2]?.length ?? 0) > d) throw new Error(`"${text}" is not an amount of ${asset}`);
  return BigInt(m[1]) * 10n ** BigInt(d) + BigInt((m[2] ?? "").padEnd(d, "0"));
}

// And back: 1500000 uSTX is "1.5".
export function amountText(amount, asset) {
  const d = DECIMALS[asset];
  const s = String(amount).padStart(d + 1, "0");
  return `${s.slice(0, -d)}.${s.slice(-d)}`.replace(/\.?0+$/, "");
}

// --- keys ---------------------------------------------------------------------

// The demo's keys, made on first use if `create` is set.
export function loadKeys({ create = false } = {}) {
  if (!existsSync(KEY_FILE)) {
    if (!create) throw new Error(`no demo keys at ${KEY_FILE}. The scripted run makes them.`);
    mkdirSync(dirname(KEY_FILE), { recursive: true, mode: 0o700 });
    const fresh = {
      note: "Throwaway keys for the pq-vault testnet demo. Testnet only. Never fund these on mainnet.",
      created: new Date().toISOString(),
      ...Object.fromEntries(ROLES.map((role) => [role, randomPrivateKey()])),
      master: randomBytes(32).toString("hex"),
    };
    writeFileSync(KEY_FILE, JSON.stringify(fresh, null, 1) + "\n", { mode: 0o600 });
    chmodSync(KEY_FILE, 0o600);
  }
  return JSON.parse(readFileSync(KEY_FILE, "utf8"));
}

// Keys for a rehearsal, derived from a fixed label so that it repeats. They
// are public, and nothing is ever sent with them.
export function rehearsalKeys() {
  const make = (what) => createHash("sha256").update(`pq-vault/rehearsal/${what}`).digest("hex");
  return { ...Object.fromEntries(ROLES.map((role) => [role, `${make(role)}01`])), master: make("master") };
}

export const addresses = (keys) => Object.fromEntries(ROLES.map((role) => [role, getAddressFromPrivateKey(keys[role], "testnet")]));

// --- chain access -------------------------------------------------------------

export async function get(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(API + path);
      if (res.status === 404) return null;
      if (res.ok) return await res.json();
      if (attempt >= 5) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
    } catch (e) {
      if (attempt >= 5) throw e;
    }
    await sleep(POLL * (attempt + 1));
  }
}

export const stxBalance = async (address) => BigInt((await get(`/extended/v1/address/${address}/stx`))?.balance ?? 0);
const isDeployed = async (address, name) => (await get(`/v2/contracts/interface/${address}/${name}`)) !== null;

// Ask the faucet for testnet STX and wait for it to arrive.
export async function faucet(address) {
  const res = await fetch(`${API}/extended/v1/faucets/stx?address=${address}`, { method: "POST" });
  if (!res.ok) throw new Error(`the faucet refused: HTTP ${res.status} ${await res.text()}`);
  for (let i = 0; (await stxBalance(address)) === 0n; i++) {
    if (i > 90) throw new Error("the faucet's transfer did not arrive within 15 minutes");
    await sleep(10_000);
  }
}

// Wait for a transaction to leave the mempool. A transaction just sent again
// can still read as dropped for a while, so `patience` polls of that are let go.
async function mined(txid, what, log, patience = 0) {
  for (let i = 0; i < 1200; i++) {
    const tx = await get(`/extended/v1/tx/${txid}`);
    if (tx && tx.tx_status !== "pending" && !(tx.tx_status.startsWith("dropped") && i < patience)) return tx;
    if (i % 20 === 19) log(`  still waiting for ${what}`);
    await sleep(POLL);
  }
  throw new Error(`${what} was not mined within an hour: ${txid}`);
}

// --- the driver ---------------------------------------------------------------

// Something `play` can run the steps on. With `send` unset it builds each
// transaction, reports its size and fee, and touches no network.
export function netDriver({ keys, who, send = false, log = () => {} }) {
  const counted = {};
  const nonce = async (address) => (send ? fetchNonce({ address, network: "testnet", client }) : BigInt((counted[address] = (counted[address] ?? -1) + 1)));

  function build(s, n, fee) {
    const base = { senderKey: keys[s.by], network: "testnet", fee, nonce: n };
    if (s.kind === "transfer") return makeSTXTokenTransfer({ ...base, recipient: s.to, amount: s.amount });
    const deny = { ...base, postConditionMode: PostConditionMode.Deny };
    if (s.kind === "deploy") return makeContractDeploy({ ...deny, contractName: s.contract, codeBody: source(s.contract), clarityVersion: ClarityVersion.Clarity6 });
    return makeContractCall({ ...deny, contractAddress: who.deployer, contractName: s.contract, functionName: s.fn, functionArgs: s.args, postConditions: s.pc ?? [] });
  }

  async function priced(s, n) {
    const draft = await build(s, n, FEES[s.kind]);
    const bytes = draft.serializeBytes().length;
    const byBytes = FEES.perByte * BigInt(bytes);
    const fee = byBytes > FEES[s.kind] ? byBytes : FEES[s.kind];
    return { transaction: fee === FEES[s.kind] ? draft : await build(s, n, fee), bytes, fee: String(fee) };
  }

  // A step is one transaction, fixed by the nonce it was first given. Built
  // again from that nonce it is the same transaction with the same id, so
  // sending it again after a crash, a lost reply or a drop can never run the
  // step twice.
  //
  // `pending` is the record of an interrupted run. `sent` is called with the
  // transaction's id and nonce BEFORE it is broadcast, so the record is on
  // disk whatever happens to the reply.
  async function exec(s, pending, sent = () => {}) {
    if (!send) {
      const { bytes, fee } = await priced(s, await nonce(who[s.by]));
      return { bytes, fee };
    }
    let { txid, nonce: pinned } = pending ?? {};
    if (!txid && s.kind === "deploy" && (await isDeployed(who.deployer, s.contract))) return { result: "(ok true)", status: "success", found: true };
    if (pinned === undefined) pinned = Number(await nonce(who[s.by]));
    const { transaction, bytes, fee } = await priced(s, BigInt(pinned));
    const id = `0x${transaction.txid()}`;
    if (txid && txid !== id) throw new Error(`${s.name}: the recorded transaction ${txid} cannot be rebuilt. The step or a key has changed since it was sent.`);
    if (!txid) sent({ txid: (txid = id), nonce: pinned, bytes, fee });

    for (let attempt = 0; attempt < 3; attempt++) {
      const known = await get(`/extended/v1/tx/${txid}`);
      const resend = !known || known.tx_status.startsWith("dropped");
      if (resend) {
        const res = await broadcastTransaction({ transaction, network: "testnet", client });
        // A refusal is final only if the chain does not have the transaction either.
        if ((!res.txid || res.error) && !(await get(`/extended/v1/tx/${txid}`))) throw new Error(`${s.name} was not accepted: ${JSON.stringify(res)}`);
        log(`${s.name}: sent ${bytes.toLocaleString("en-US")} bytes, ${explorer(txid)}`);
      }
      const tx = await mined(txid, s.name, log, resend ? 20 : 0);
      if (tx.tx_status.startsWith("dropped")) {
        log(`  ${s.name} was dropped (${tx.tx_status}). Sending the same transaction again.`);
        continue;
      }
      // A transaction rolled back by a post-condition still reports what its
      // function returned. It moved nothing, so it must not count as a result.
      if (tx.tx_status !== "success" && tx.tx_status !== "abort_by_response") {
        throw new Error(`${s.name} ended as ${tx.tx_status} and changed nothing: ${explorer(txid)}`);
      }
      log(`  ${tx.tx_status}, block ${tx.block_height}, result ${tx.tx_result?.repr}`);
      return {
        txid, nonce: pinned, status: tx.tx_status, result: tx.tx_result?.repr, bytes, fee: String(tx.fee_rate), block: tx.block_height, time: tx.block_time_iso,
        cost: { runtime: tx.execution_cost_runtime, readCount: tx.execution_cost_read_count, readLength: tx.execution_cost_read_length,
                writeCount: tx.execution_cost_write_count, writeLength: tx.execution_cost_write_length },
      };
    }
    throw new Error(`${s.name} was dropped three times and changed nothing: ${explorer(txid)}`);
  }

  const read = (contract, fn, args = []) => fetchCallReadOnlyFunction({
    contractAddress: who.deployer, contractName: contract, functionName: fn, functionArgs: args, senderAddress: who.deployer, network: "testnet", client });

  return { exec, read };
}

// --- the run ------------------------------------------------------------------

// The WOTS+ and Lamport wallets behind the demo's two vaults.
export const wallets = (keys, who, journal) => Object.fromEntries(["wots", "lamport"].map((scheme) => [scheme, wallet({
  master: Buffer.from(keys.master, "hex"), chainId: CHAIN_ID, vault: `${who.deployer}.pq-vault`,
  verifier: `${who.deployer}.${scheme}`, scheme, account: 0, ...(journal && { journal }),
})]));

// The scripted run on a simnet, under the addresses and keys testnet would
// see, so every digest and signature is the one that would be sent. Each
// testnet transaction is built for its size and fee. Nothing is sent, and it
// throws if a step does not return what the story expects.
//
// With the demo's real keys, pass the journal the run will use: a one-time
// key then signs here exactly what it will sign on testnet, and nothing else.
export async function rehearse(keys, journal) {
  const who = addresses(keys);
  const sim = simDriver(await boot({ deployer: who.deployer }), who);
  const net = netDriver({ keys, who });
  const ws = wallets(keys, who, journal);
  const { steps, requests } = story({ who, wallets: ws, read: sim.read });
  const records = {};
  const exec = async (s) => ({ ...(await net.exec(s)), ...(await sim.exec(s)) });
  await play(steps, { exec, read: sim.read }, { record: (s, rec) => { records[s.name] = rec; } });
  const final = { wots: await vaultState(sim.read, ws.wots), lamport: await vaultState(sim.read, ws.lamport) };
  return assemble({ network: "simnet", rehearsal: true, who, wallets: ws, steps, records, requests: requests(), final });
}
