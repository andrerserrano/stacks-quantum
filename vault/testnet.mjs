// The demo on Stacks testnet: the scripted run, and withdrawals made live.
//
//   node testnet.mjs                  rehearse the scripted run on a simnet and
//                                     build every testnet transaction. Sends nothing.
//   node testnet.mjs --send           send the scripted run to testnet
//   node testnet.mjs status           the vaults and accounts as testnet has them
//   node testnet.mjs report           write results/RUN.md: the run beside the
//                                     same steps on simnet, and a check that the
//                                     deployed source is the source in contracts/
//   node testnet.mjs withdraw 1 stx   check a new withdrawal against the chain
//       [--scheme lamport] [--to ADDRESS]
//   node testnet.mjs withdraw 1 stx --send     sign it and send it
//
// Nothing is signed with a vault key and nothing is sent without --send.
//
// The scripted run (src/story.mjs) deploys the contracts under a fresh key,
// opens a WOTS+ vault and a Lamport vault, shows forged and altered requests
// refused, and pays three signed withdrawals. Separate accounts deploy, own,
// submit and receive. Stopped and run again, it picks up where it stopped.
//
// The run is written to results/run.json, which the demo page reads. The
// rehearsal writes the same document to results/run.rehearsal.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cl } from "@stacks/transactions";
import { CONTRACTS, TENURE_BUDGET, source } from "./src/simnet.mjs";
import { fileJournal } from "./src/journal.mjs";
import { assemble, play, published, signChecked, story, vaultState, withdrawCall } from "./src/story.mjs";
import {
  API, JOURNAL, KEY_FILE, ROLES, addresses, amountText, explorer, faucet, get, loadKeys, netDriver, rehearsalKeys, rehearse, stxBalance, units, wallets,
} from "./src/testnet.mjs";

// The results sit beside this script, wherever it is run from. A run that
// could not find its own record would send its first steps a second time.
// The tests point this at a directory of their own.
const RESULTS = process.env.PQ_VAULT_RESULTS ?? fileURLToPath(new URL("./results/", import.meta.url));
const RUN_FILE = join(RESULTS, "run.json");
const REHEARSAL_FILE = join(RESULTS, "run.rehearsal.json");
const REPORT_FILE = join(RESULTS, "RUN.md");
const RECORDED = ["txid", "nonce", "status", "result", "bytes", "fee", "block", "time", "cost", "found"];

// The command line, read strictly. A mistyped option must stop the command,
// not turn into a different request under a one-time key.
const COMMANDS = { run: { words: 0, options: [] }, status: { words: 0, options: [] }, report: { words: 0, options: [] },
                   withdraw: { words: 2, options: ["scheme", "to"] } };
function parse(argv) {
  const words = [], options = {};
  let send = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--send") send = true;
    else if (a === "--scheme" || a === "--to") {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith("-")) throw new Error(`${a} needs a value`);
      if (a.slice(2) in options) throw new Error(`${a} is given twice`);
      options[a.slice(2)] = argv[++i];
    } else if (a.startsWith("-")) throw new Error(`unknown option ${a}. The options are --send, --scheme and --to`);
    else words.push(a);
  }
  const command = words[0] in COMMANDS ? words.shift() : "run";
  const takes = COMMANDS[command];
  if (words.length > takes.words) throw new Error(`"${words[takes.words]}" is not something ${command === "run" ? "this script" : command} understands: use status, withdraw or report, or nothing for the scripted run`);
  for (const name of Object.keys(options)) if (!takes.options.includes(name)) throw new Error(`--${name} does not apply to ${command === "run" ? "the scripted run" : command}`);
  if (send && takes.words === 0 && command !== "run") throw new Error(`--send does not apply to ${command}`);
  return { command, rest: words, options, send };
}

let command, rest, options, SEND;
const option = (name) => options[name];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fmt = (n) => Number(n).toLocaleString("en-US");
const write = (file, doc) => { mkdirSync(RESULTS, { recursive: true }); writeFileSync(file, JSON.stringify(doc, null, 1) + "\n"); };
const shown = (file) => `results/${file.slice(RESULTS.length).replace(/^\//, "")}`;

function table(run) {
  for (const s of run.steps) {
    console.log(`  ${s.name.padEnd(26)} ${s.by.padEnd(10)} ${fmt(s.bytes ?? 0).padStart(7)} bytes  ${s.result}`);
  }
}

// --- the scripted run -----------------------------------------------------------

async function run() {
  if (!SEND) {
    const doc = await rehearse(rehearsalKeys());
    write(REHEARSAL_FILE, doc);
    log("rehearsal on simnet, under keys that are public. Nothing was sent.");
    table(doc);
    log(`${doc.steps.length} steps returned what the story expects. Written to ${shown(REHEARSAL_FILE)}`);
    log("Send the run to testnet with: node testnet.mjs --send");
    return;
  }

  const fresh = !existsSync(KEY_FILE);
  const keys = loadKeys({ create: true });
  const who = addresses(keys);
  if (fresh) log(`made new testnet keys in ${KEY_FILE}`);
  const state = existsSync(RUN_FILE) ? JSON.parse(readFileSync(RUN_FILE, "utf8")) : {};
  if (state.roles && state.roles.deployer !== who.deployer) throw new Error(`${shown(RUN_FILE)} belongs to another key. Move it aside to start over.`);
  // Keys that have sent transactions and no record of which: going on would send the first steps again.
  if (!state.steps && (await get(`/extended/v1/address/${who.deployer}/nonces`))?.possible_next_nonce > 0) {
    throw new Error(`the demo keys in ${KEY_FILE} have already sent transactions, and ${shown(RUN_FILE)} is missing. ` +
      "Put the record back, or move the keys and their journal aside to start a new run.");
  }

  // The same run on a simnet first, under these addresses and keys.
  const journal = fileJournal(JOURNAL);
  await rehearse(keys, journal);
  log(`rehearsed on simnet under the testnet keys. Deployer ${who.deployer}`);

  if ((await stxBalance(who.deployer)) < 20_000_000n && !state.steps?.some((s) => s.name === "fund-submitter" && s.result)) {
    log("asking the faucet for testnet STX");
    await faucet(who.deployer);
  }
  log(`deployer balance ${amountText(await stxBalance(who.deployer), "stx")} STX`);

  const net = netDriver({ keys, who, send: true, log });
  const ws = wallets(keys, who, journal);
  const { steps, requests, ends } = story({ who, wallets: ws, read: net.read });
  const records = Object.fromEntries((state.steps ?? []).map((s) => [s.name, Object.fromEntries(RECORDED.filter((k) => k in s).map((k) => [k, s[k]]))]));
  const started = state.started ?? new Date().toISOString();
  const doc = (more = {}) => assemble({
    network: "testnet", api: API, who, wallets: ws, steps, records,
    requests: { ...state.requests, ...requests() }, started, live: state.live ?? [], ...more });
  const save = (more) => write(RUN_FILE, doc(more));
  save();
  try {
    await play(steps, net, { done: records, record: (s, rec) => { records[s.name] = rec; save(); } });
  } catch (e) {
    // A step that came back wrong is on chain as it is, and running again will
    // read the same answer. Anyone can cause this: once the owner's signed
    // request is public, a stranger may submit it before the script does.
    if (/expected .* got /.test(e.message)) e.message += ` It is recorded in ${shown(RUN_FILE)}. To run the demo again, move the keys, their journal and that file aside.`;
    throw e;
  }

  const final = { wots: await vaultState(net.read, ws.wots), lamport: await vaultState(net.read, ws.lamport) };
  // Each step returned the right result. The vaults also have to stand where
  // the story ends, unless withdrawals have been made by hand since.
  if (!state.live?.length && JSON.stringify(final) !== JSON.stringify(ends)) {
    throw new Error(`every step returned the expected result, but the vaults are not where the run should leave them: ${JSON.stringify(final)}`);
  }
  save({ final, finished: state.finished ?? new Date().toISOString() });
  table(doc());
  const paid = records.withdraw, big = records["withdraw-lamport"];
  log(`WOTS+ withdrawal: ${fmt(paid.cost.runtime)} runtime, ${((100 * paid.cost.runtime) / TENURE_BUDGET.runtime).toFixed(3)}% of a tenure, ${fmt(paid.bytes)} bytes`);
  log(`Lamport withdrawal: ${fmt(big.cost.runtime)} runtime, ${fmt(big.bytes)} bytes`);
  log(`the WOTS+ vault is at nonce ${final.wots.nonce} with ${amountText(final.wots.stx, "stx")} STX. Written to ${shown(RUN_FILE)}`);
}

// --- a withdrawal made live -----------------------------------------------------

async function withdraw() {
  const [text, asset = "stx"] = rest;
  const scheme = option("scheme") ?? "wots";
  const keys = loadKeys();
  const who = addresses(keys);
  const net = netDriver({ keys, who, send: SEND, log });
  const ws = wallets(keys, who, fileJournal(JOURNAL));
  const w = ws[scheme];
  if (!w) throw new Error(`unknown scheme ${scheme}: use wots or lamport`);
  const amount = units(text, asset);
  const recipient = option("to") ?? who.recipient;

  // A withdrawal that was sent and never heard back from comes first. If the
  // chain has it, its result is recorded and nothing new is signed: asking
  // again must not turn one payment into two.
  const state = existsSync(RUN_FILE) ? JSON.parse(readFileSync(RUN_FILE, "utf8")) : { network: "testnet", roles: who };
  const callOf = (l) => {
    const q = l.request, bytes = (h) => Buffer.from(h, "hex");
    return { name: l.name, by: "submitter", kind: "call", ...withdrawCall(who, ws[q.scheme],
      { id: bytes(q.vault), nonce: q.nonce, asset: q.asset, amount: BigInt(q.amount), recipient: q.recipient, nextKey: bytes(q.nextKey), sig: q.sig.map(bytes) }) };
  };
  const keep = (entry) => {
    state.live = [...(state.live ?? []).filter((l) => l.name !== entry.name), entry];
    write(RUN_FILE, state);
  };
  const unsettled = (state.live ?? []).find((l) => l.txid && !l.result);
  const onChain = unsettled && (await get(`/extended/v1/tx/${unsettled.txid}`));
  if (onChain && !onChain.tx_status.startsWith("dropped")) {
    if (!SEND) return log(`an earlier withdrawal, ${unsettled.title}, is on chain with no result recorded here. Run with --send to record it.`);
    const rec = await net.exec(callOf(unsettled), { txid: unsettled.txid, nonce: unsettled.nonce });
    if (state.final) state.final[unsettled.request.scheme] = await vaultState(net.read, ws[unsettled.request.scheme]);
    keep({ ...unsettled, ...rec });
    return log(`an earlier withdrawal, ${unsettled.title}, had been sent with no result recorded. It is confirmed: ${rec.result}. ` +
      "Nothing new was signed. Run the command again if another withdrawal is wanted.");
  }

  const now = await vaultState(net.read, w);
  if (!now) throw new Error("this vault is not open on testnet. Send the scripted run first.");
  log(`${scheme} vault ${w.id.toString("hex").slice(0, 16)}... at nonce ${now.nonce}, holding ${amountText(now.stx, "stx")} STX and ${amountText(now.sbtc, "sbtc")} sBTC`);

  // The vault's current key signs once. If it has signed a request that has
  // not confirmed, that request is the only one it may send, so that comes
  // before any other reason to refuse.
  const request = { nonce: now.nonce, asset, amount, recipient };
  let u;
  try { u = w.withdrawal(request); } catch (e) { throw new Error(`${e.message}. Nothing was signed.`); }
  const held = w.signed(now.nonce);
  if (held && held.digest !== u.digest.toString("hex")) {
    throw new Error(`key ${now.nonce} has already signed ${amountText(held.amount, held.asset)} ${held.asset} to ${held.recipient}, and it has not confirmed. ` +
      `Send it again with: node testnet.mjs withdraw ${amountText(held.amount, held.asset)} ${held.asset} --scheme ${scheme} --to ${held.recipient} --send`);
  }
  // A request for more than the vault holds would use the key up and stay
  // payable for as long as the key lasts.
  if (!held && (amount === 0n || amount > BigInt(now[asset]))) throw new Error(`the vault cannot pay ${text} ${asset}. Nothing was signed.`);

  if (!SEND) {
    const digest = await net.read("pq-vault", "withdrawal-digest", [
      Cl.buffer(u.id), Cl.uint(u.nonce), Cl.stringAscii(asset), Cl.uint(amount), Cl.principal(recipient), Cl.buffer(u.nextKey)]);
    if (Cl.prettyPrint(digest) !== `0x${u.digest.toString("hex")}`) throw new Error("the contract computes a different digest");
    log(`${text} ${asset} to ${recipient}: the contract agrees on the digest. ${held ? "Already signed, not sent." : "Not signed, not sent."} Add --send.`);
    return;
  }

  const r = await signChecked(net.read, w, request);
  log(`signed with key ${now.nonce}: ${r.sig.length} words, ${fmt(r.sig.length * 32)} bytes. The verifier contract accepts it.`);
  const name = `live-${scheme}-${now.nonce}`;
  const step = { name, by: "submitter", kind: "call", ...withdrawCall(who, w, r) };
  // The request and its transaction are recorded before anything is sent, so
  // that sending it again after a failure sends the same transaction.
  const earlier = (state.live ?? []).find((l) => l.name === name && !l.result);
  const entry = (rec) => ({ name, title: `${amountText(amount, asset)} ${asset} to ${recipient}`, by: "submitter", sender: who.submitter,
    call: `${step.contract}.${step.fn}`, ...rec, request: published(w, r) });
  const rec = await net.exec(step, earlier && { txid: earlier.txid, nonce: earlier.nonce }, (sent) => keep(entry(sent)));
  const after = await vaultState(net.read, w);
  if (state.final) state.final[scheme] = after;
  keep(entry(rec));
  log(`${rec.result}. The vault is at nonce ${after.nonce} under key ${after.key.slice(0, 16)}... ${explorer(rec.txid)}`);
}

// --- status ---------------------------------------------------------------------

async function status() {
  const keys = loadKeys();
  const who = addresses(keys);
  const net = netDriver({ keys, who });
  for (const [scheme, w] of Object.entries(wallets(keys, who, fileJournal(JOURNAL)))) {
    const v = await vaultState(net.read, w);
    if (!v) { console.log(`${scheme.padEnd(8)} vault ${w.id.toString("hex")} is not open`); continue; }
    const held = w.signed(v.nonce);
    console.log(`${scheme.padEnd(8)} vault ${w.id.toString("hex")}\n         nonce ${v.nonce}, key ${v.key.slice(0, 16)}..., ${amountText(v.stx, "stx")} STX, ${amountText(v.sbtc, "sbtc")} sBTC`);
    console.log(`         ${held ? `key ${v.nonce} has signed ${amountText(held.amount, held.asset)} ${held.asset} to ${held.recipient}, not yet confirmed` : `key ${v.nonce} has signed nothing`}`);
  }
  for (const role of ROLES) console.log(`${role.padEnd(10)} ${who[role]}  ${amountText(await stxBalance(who[role]), "stx")} STX`);
}

// --- report ---------------------------------------------------------------------

async function report() {
  const keys = loadKeys();
  const doc = JSON.parse(readFileSync(RUN_FILE, "utf8"));
  if (doc.roles.deployer !== addresses(keys).deployer) throw new Error(`${RUN_FILE} belongs to another key`);
  if (!doc.final) throw new Error("the run has not finished. Send it first.");

  // The same steps on a simnet under the same keys, so each digest and
  // signature is the one testnet saw.
  const sim = Object.fromEntries((await rehearse(keys, fileJournal(JOURNAL))).steps.map((s) => [s.name, s]));
  // The source testnet holds for each contract, against contracts/.
  for (const name of CONTRACTS) {
    const deployed = await get(`/v2/contracts/source/${doc.roles.deployer}/${name}`);
    if (deployed?.source !== source(name)) throw new Error(`${name} on testnet is not the source in contracts/`);
  }
  // What each transaction moved, read from the chain, against what the story
  // says it asked for. The demo page draws its transfers from the story, so
  // this is what ties them to the chain: a paid step moved exactly that, and a
  // refused step moved nothing.
  const place = { ...doc.roles, wots: doc.contracts["pq-vault"], lamport: doc.contracts["pq-vault"] };
  for (const s of doc.steps) {
    if (!s.txid || s.kind === "deploy") continue;
    const events = (await get(`/extended/v1/tx/events?tx_id=${s.txid}&limit=50`))?.events ?? [];
    const moved = events.filter((e) => e.asset && ["transfer", "mint"].includes(e.asset.asset_event_type))
      .map((e) => `${e.asset.amount} ${e.event_type === "stx_asset" ? "stx" : "sbtc"} ${e.asset.sender || "minted"} > ${e.asset.recipient}`);
    const from = s.call === "sbtc-token.mint" ? "minted" : place[s.asks?.from];
    const asked = s.asks && s.result.startsWith("(ok") ? [`${s.asks.amount} ${s.asks.asset} ${from} > ${place[s.asks.to]}`] : [];
    if (JSON.stringify(moved) !== JSON.stringify(asked)) throw new Error(`${s.name}: the chain shows [${moved}], the story says [${asked}]`);
  }

  const row = (s) => {
    // Simnet does not charge a deployment's analysis, so those are not compared.
    const mine = s.cost?.runtime, theirs = s.kind === "deploy" ? undefined : sim[s.name].cost?.runtime;
    const diff = mine && theirs ? `${mine >= theirs ? "+" : ""}${((100 * (mine - theirs)) / theirs).toFixed(2)}%` : "";
    return `| ${s.title} | ${s.by} | \`${s.result}\` | ${mine ? fmt(mine) : ""} | ${theirs ? fmt(theirs) : ""} | ${diff} | ${s.bytes ? fmt(s.bytes) : ""} | ${s.txid ? `[${s.txid.slice(0, 10)}](${explorer(s.txid)})` : ""} |`;
  };
  const paid = doc.steps.find((s) => s.name === "withdraw"), big = doc.steps.find((s) => s.name === "withdraw-lamport");
  const pct = (s) => `${((100 * s.cost.runtime) / TENURE_BUDGET.runtime).toFixed(3)}%`;
  const vault = (scheme, v) => `- ${scheme}: \`${doc.vaults[scheme].id}\`, at nonce ${v.nonce}, holding ${amountText(v.stx, "stx")} STX and ${amountText(v.sbtc, "sbtc")} mock sBTC`;

  writeFileSync(REPORT_FILE, `# The demo run on testnet

\`node testnet.mjs --send\` ran on ${doc.started.slice(0, 10)} against Stacks testnet at Epoch ${doc.epoch}, Clarity ${doc.clarity}. \`node testnet.mjs report\` then ran the same steps on simnet under the same keys, to compare cost, and wrote this file.

Four throwaway accounts took part. None of them can move a vault's funds.

| Account | Address |
| --- | --- |
${ROLES.map((role) => `| ${role} | \`${doc.roles[role]}\` |`).join("\n")}

## Steps

| Step | Sent by | Result | Runtime, testnet | Runtime, simnet | Difference | Bytes | Transaction |
| --- | --- | --- | --- | --- | --- | --- | --- |
${doc.steps.map(row).join("\n")}

\`(err u205)\` is a signature that does not match, and \`(err u203)\` is a nonce that was already used.

Simnet does not charge the analysis of a new contract, so deployments have no simnet figure.

A WOTS+ withdrawal cost ${fmt(paid.cost.runtime)} runtime, ${pct(paid)} of a tenure's budget, in ${fmt(paid.bytes)} bytes. A Lamport withdrawal cost ${fmt(big.cost.runtime)} runtime, ${pct(big)}, in ${fmt(big.bytes)} bytes.

## Vaults at the end of the run

${Object.entries(doc.final).map(([scheme, v]) => vault(scheme, v)).join("\n")}

## Checked against the chain

When this file was written, two things were read back from testnet. The source held for each contract is the source in \`contracts/\`, byte for byte. And each transaction's transfers are the ones the story says: a paid step moved exactly the amount, from and to the parties named, and a refused step moved nothing.

## Contracts

${CONTRACTS.map((c) => `- \`${doc.contracts[c]}\``).join("\n")}

## What it does not show

- Real sBTC. The token is a mock with the same transfer check as \`sbtc-token\`.
- Behaviour under load, or a realistic fee. Every transaction paid a fixed fee on a quiet network.
- A wallet or a relayer. The requests were signed by a script.
- A review. No engineer outside this work and no cryptographer has read the contracts.

## The keys

The accounts' keys and the vaults' master secret are in \`~/.config/pq-vault/demo.json\`, outside the repository and readable only by its owner, next to the journal of what each one-time key has signed. They hold faucet STX and control a mock token. Do not fund them on mainnet.
`);
  log(`the deployed source matches contracts/, and every step moved what the story says. Written to ${shown(REPORT_FILE)}`);
}

// Output cut short by a closed pipe, as with `| head`, is not an error.
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); throw e; });

try {
  ({ command, rest, options, send: SEND } = parse(process.argv.slice(2)));
  await { run, withdraw, status, report }[command]();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
