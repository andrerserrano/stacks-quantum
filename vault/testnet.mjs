// The vault on Stacks testnet: deploy, open a WOTS+ vault, fund it, show an
// altered request refused, a signed withdrawal paid and its replay refused.
// Every step checks the chain or the state file first, so the script can be
// stopped and run again.
//
// Run: node testnet.mjs            sends transactions to testnet
//      node testnet.mjs --dry-run  builds every transaction and prints its
//                                  size, with keys held in memory. Sends nothing.
//
// The live path has not been run. It follows the script that put the shielded
// sBTC benchmark on testnet, and only the dry run has been exercised here.
//
// The signing key and the vault's master secret are throwaways made for this
// test. They live outside the repository, in ~/.config/pq-vault/testnet.json,
// readable only by their owner. They hold faucet STX and a mock token.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  Cl, ClarityVersion, Pc, PostConditionMode, broadcastTransaction, cvToJSON, fetchCallReadOnlyFunction,
  fetchNonce, getAddressFromPrivateKey, makeContractCall, makeContractDeploy, randomPrivateKey,
} from "@stacks/transactions";
import { CONTRACTS, CHAIN_ID, TENURE_BUDGET, source } from "./src/simnet.mjs";
import { sigCV, wallet } from "./src/vault.mjs";

const DRY = process.argv.includes("--dry-run");
const API = "https://api.testnet.hiro.so";
const EXPLORER = (txid) => `https://explorer.hiro.so/txid/${txid}?chain=testnet`;
const KEY_FILE = join(homedir(), ".config", "pq-vault", "testnet.json");
const STATE_FILE = "results/testnet.json";
const SCHEME = "wots";
const DEPOSIT = 5_000_000n; // 5 STX
const SBTC = 1_000_000n; // 0.01 mock sBTC
const AMOUNT = 1_000_000n; // 1 STX withdrawn
const FEES = { deploy: 150_000n, call: 30_000n };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// --- keys ---------------------------------------------------------------------

function loadKeys() {
  let keys;
  if (DRY) {
    keys = { deployer: randomPrivateKey(), recipient: randomPrivateKey(), master: randomBytes(32).toString("hex") };
  } else {
    if (!existsSync(KEY_FILE)) {
      mkdirSync(dirname(KEY_FILE), { recursive: true, mode: 0o700 });
      const fresh = {
        note: "Throwaway keys for the pq-vault testnet demo. Testnet only. Never fund these on mainnet.",
        created: new Date().toISOString(),
        deployer: randomPrivateKey(), recipient: randomPrivateKey(), master: randomBytes(32).toString("hex"),
      };
      writeFileSync(KEY_FILE, JSON.stringify(fresh, null, 1) + "\n", { mode: 0o600 });
      chmodSync(KEY_FILE, 0o600);
      log(`made new testnet keys in ${KEY_FILE}`);
    }
    keys = JSON.parse(readFileSync(KEY_FILE, "utf8"));
  }
  return {
    key: keys.deployer,
    deployer: getAddressFromPrivateKey(keys.deployer, "testnet"),
    recipient: getAddressFromPrivateKey(keys.recipient, "testnet"),
    master: Buffer.from(keys.master, "hex"),
  };
}

// --- chain access -------------------------------------------------------------

async function get(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(API + path);
      if (res.status === 404) return null;
      if (res.ok) return await res.json();
      if (attempt >= 5) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
    } catch (e) {
      if (attempt >= 5) throw e;
    }
    await sleep(3000 * (attempt + 1));
  }
}

const stxBalance = async (address) => BigInt((await get(`/extended/v1/address/${address}/stx`))?.balance ?? 0);
const isDeployed = async (address, name) => (await get(`/v2/contracts/interface/${address}/${name}`)) !== null;

async function read(contract, fn, args = []) {
  return cvToJSON(await fetchCallReadOnlyFunction({
    contractAddress: deployer, contractName: contract, functionName: fn, functionArgs: args,
    senderAddress: deployer, network: "testnet",
  }));
}

async function mined(txid, what) {
  for (let i = 0; i < 360; i++) {
    const tx = await get(`/extended/v1/tx/${txid}`);
    if (tx && tx.tx_status !== "pending") return tx;
    if (i % 6 === 5) log(`  still waiting for ${what}`);
    await sleep(10_000);
  }
  throw new Error(`${what} was not mined within an hour: ${txid}`);
}

let dryNonce = 0n;
const nextNonce = async () => (DRY ? dryNonce++ : fetchNonce({ address: deployer, network: "testnet" }));

// Send a transaction and wait for it, or in a dry run report its size.
async function send(transaction, what) {
  const bytes = transaction.serializeBytes().length;
  if (DRY) {
    log(`${what}: ${bytes.toLocaleString("en-US")} bytes, not sent`);
    return { dry: true, bytes };
  }
  const res = await broadcastTransaction({ transaction, network: "testnet" });
  if (!res.txid || res.error) throw new Error(`${what} was not accepted: ${JSON.stringify(res)}`);
  log(`${what}: sent ${bytes.toLocaleString("en-US")} bytes, ${EXPLORER(res.txid)}`);
  const tx = await mined(res.txid, what);
  log(`  ${tx.tx_status}, block ${tx.block_height}, result ${tx.tx_result?.repr}`);
  return { ...tx, bytes };
}

async function call(contract, fn, args, postConditions, what) {
  const transaction = await makeContractCall({
    contractAddress: deployer, contractName: contract, functionName: fn, functionArgs: args,
    senderKey: key, network: "testnet", fee: FEES.call, nonce: await nextNonce(),
    postConditionMode: PostConditionMode.Deny, postConditions,
  });
  return send(transaction, what);
}

const record = (tx) => (tx.dry ? { bytes: tx.bytes } : {
  txid: tx.tx_id, status: tx.tx_status, result: tx.tx_result?.repr, bytes: tx.bytes, fee: tx.fee_rate,
  cost: { runtime: tx.execution_cost_runtime, readCount: tx.execution_cost_read_count, readLength: tx.execution_cost_read_length,
          writeCount: tx.execution_cost_write_count, writeLength: tx.execution_cost_write_length },
});

// --- the run --------------------------------------------------------------------

const { key, deployer, recipient, master } = loadKeys();
const vault = `${deployer}.pq-vault`;
const verifier = Cl.contractPrincipal(deployer, SCHEME);
mkdirSync("results", { recursive: true });
const state = !DRY && existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
if (state.deployer && state.deployer !== deployer) throw new Error(`${STATE_FILE} belongs to another key. Move it aside to start over.`);
Object.assign(state, { network: "testnet", scheme: SCHEME, deployer, recipient });
state.txs ??= {};
const save = () => { if (!DRY) writeFileSync(STATE_FILE, JSON.stringify(state, null, 1) + "\n"); };
const step = async (name, run) => {
  if (state.txs[name]) return;
  const tx = await run();
  state.txs[name] = record(tx);
  save();
  return tx;
};
save();
log(`${DRY ? "dry run, nothing is sent. " : ""}deployer ${deployer}`);

// 1. Testnet STX for fees and the deposit, from the faucet.
if (!DRY && (await stxBalance(deployer)) < 20_000_000n) {
  log("asking the faucet for testnet STX");
  const res = await fetch(`${API}/extended/v1/faucets/stx?address=${deployer}`, { method: "POST" });
  const body = await res.text();
  if (!res.ok) throw new Error(`the faucet refused: HTTP ${res.status} ${body}`);
  for (let i = 0; (await stxBalance(deployer)) === 0n; i++) {
    if (i > 90) throw new Error("the faucet's transfer did not arrive within 15 minutes");
    await sleep(10_000);
  }
}
if (!DRY) log(`balance ${Number(await stxBalance(deployer)) / 1e6} STX`);

// 2. Contracts.
for (const name of CONTRACTS) {
  if (!DRY && (await isDeployed(deployer, name))) continue;
  const transaction = await makeContractDeploy({
    contractName: name, codeBody: source(name), clarityVersion: ClarityVersion.Clarity6,
    senderKey: key, network: "testnet", fee: FEES.deploy, nonce: await nextNonce(),
    postConditionMode: PostConditionMode.Deny,
  });
  const tx = await send(transaction, `deploy ${name}`);
  if (!DRY && tx.tx_status !== "success") throw new Error(`deploying ${name} failed`);
  state.txs[`deploy ${name}`] = record(tx);
  save();
}

// 3. A vault under one-time key 0, funded with STX and mock sBTC. Its id
// follows from the key and the verifier, so the script knows it beforehand
// and never opens a second vault under the same key.
const owner = wallet({ master, chainId: CHAIN_ID, vault, verifier: `${deployer}.${SCHEME}`, scheme: SCHEME, account: 0 });
const id = Cl.buffer(owner.id);
state.vaultId = owner.id.toString("hex");
const onChain = async () => (DRY ? null : (await read("pq-vault", "get-vault", [id])).value);
if (!(await onChain())) {
  const tx = await call("pq-vault", "open", [Cl.buffer(owner.key(0)), verifier], [], "open a vault");
  if (!DRY && tx.tx_status !== "success") throw new Error("opening the vault failed");
  state.txs.open = record(tx);
  save();
}
log(`vault ${state.vaultId}`);
const sent = (amount) => [Pc.principal(deployer).willSendEq(amount).ustx()];
await step("deposit STX", () => call("pq-vault", "deposit-stx", [id, Cl.uint(DEPOSIT)], sent(DEPOSIT), "deposit 5 STX"));
await step("mint mock sBTC", () => call("sbtc-token", "mint", [Cl.uint(SBTC), Cl.standardPrincipal(deployer)], [], "mint mock sBTC"));
await step("deposit sBTC", () => call("pq-vault", "deposit-sbtc", [id, Cl.uint(SBTC)],
  [Pc.principal(deployer).willSendEq(SBTC).ft(`${deployer}.sbtc-token`, "sbtc")], "deposit mock sBTC"));

// 4. One signed withdrawal. Before anything is sent, the contract has to agree
// on the digest, because a one-time key cannot be used to try again.
// The request is always the same one, so running the script again signs
// nothing new with key 0.
const nonce = DRY ? 0 : Number((await onChain()).value.nonce.value);
const request = owner.signWithdrawal({ nonce: 0, asset: "stx", amount: AMOUNT, recipient });
if (!DRY && nonce === 0) {
  const digest = await read("pq-vault", "withdrawal-digest",
    [id, Cl.uint(0), Cl.stringAscii("stx"), Cl.uint(AMOUNT), Cl.standardPrincipal(recipient), Cl.buffer(request.nextKey)]);
  if (digest.value.replace(/^0x/, "") !== request.digest.toString("hex")) throw new Error("the contract computes a different digest. Nothing was sent.");
  log("the contract and the wallet agree on the digest");
}
const withdraw = (to, what) => call("pq-vault", "withdraw-stx",
  [id, Cl.uint(0), Cl.uint(AMOUNT), Cl.standardPrincipal(to), Cl.buffer(request.nextKey), verifier, sigCV(request.sig)],
  [Pc.principal(vault).willSendLte(AMOUNT).ustx()], what);

// The same signature with the recipient changed to the submitter. Refused.
await step("altered", () => withdraw(deployer, "altered request, recipient changed"));
// The request as signed. Paid.
await step("withdraw", () => withdraw(recipient, "signed withdrawal of 1 STX"));
// The same request again. Refused on its nonce.
await step("replay", () => withdraw(recipient, "replay of the paid request"));

// 5. Report.
if (DRY) {
  log("dry run complete. Run without --dry-run to send these to testnet.");
} else {
  const after = (await onChain()).value;
  state.vault = { nonce: Number(after.nonce.value), stx: after.stx.value, sbtc: after.sbtc.value, key: after.key.value };
  save();
  const w = state.txs.withdraw;
  log(`altered: ${state.txs.altered.result}   paid: ${w.result}   replay: ${state.txs.replay.result}`);
  log(`withdrawal: ${w.cost.runtime.toLocaleString("en-US")} runtime, ${((100 * w.cost.runtime) / TENURE_BUDGET.runtime).toFixed(3)}% of a tenure, ${w.bytes.toLocaleString("en-US")} bytes`);
  log(`vault now at nonce ${state.vault.nonce} with ${Number(state.vault.stx) / 1e6} STX. Results in ${STATE_FILE}`);
}
