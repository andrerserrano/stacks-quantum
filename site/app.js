// The demo page. It reads one run document (data/run.json, built by sync.mjs)
// and draws the run from it. The live parts call read-only functions on the
// deployed contracts and read transactions through the Hiro API. The page
// holds no key and sends no transaction.

import { buffer, decode, list, principal, stringAscii, uint } from "./clarity.js";
import { LABEL, amountText, units } from "./amounts.js";
import { ledger, paid, tenureShare } from "./ledger.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("en-US");
const short = (s, head = 6, tail = 4) => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);
const money = (amount, asset) => `${amountText(amount, asset)} ${LABEL[asset]}`;

// h("p", { class: "x" }, "text", node): data only ever becomes text, never markup.
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false && c !== 0 && c !== 0n));
  return node;
}

const explorer = (what) => `https://explorer.hiro.so/txid/${what}?chain=testnet`;
const account = (address) => `https://explorer.hiro.so/address/${address}?chain=testnet`;
const link = (href, text) => h("a", { href, target: "_blank", rel: "noopener" }, text);

// --- the chain ------------------------------------------------------------------

let api;
async function get(path) {
  const res = await fetch(api + path, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`testnet answered ${res.status}`);
  return res.json();
}
async function callRead(contract, fn, args) {
  const [address, name] = contract.split(".");
  const res = await fetch(`${api}/v2/contracts/call-read/${address}/${name}/${fn}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: address, arguments: args.map((a) => `0x${a}`) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`testnet answered ${res.status}`);
  const answer = await res.json();
  if (!answer.okay) throw new Error(answer.cause ?? "the contract call failed");
  return decode(answer.result);
}

// --- what the run did, added up -----------------------------------------------------

// Who is who in a transfer. The submitter's account plays the attacker.
const who = (role, s) => ({
  deployer: "Deployer", owner: "Owner's account", recipient: "Recipient", wots: "Vault", lamport: "Lamport vault",
  submitter: s?.phase === "setup" ? "Submitter's account" : "Attacker",
})[role];
const holding = (b) => [BigInt(b.stx) && money(b.stx, "stx"), BigInt(b.sbtc) && `${amountText(b.sbtc, "sbtc")} test sBTC`].filter(Boolean).join(" and ") || "nothing";

// --- 1. the headline figures ------------------------------------------------------

const step = (doc, name) => doc.steps.find((s) => s.name === name && s.result);
// A figure from the run if it has one, and from the measurements otherwise.
function figures(doc) {
  const m = doc.measured, one = step(doc, "withdraw"), big = step(doc, "withdraw-lamport");
  return {
    transfer: m.transferBytes, call: m.callRuntime, tenure: m.budget.runtime, budget: m.budget,
    wots: { bytes: one?.bytes ?? m.wots.txBytes, runtime: one?.cost?.runtime ?? m.wots.runtime, cost: one?.cost, fromRun: Boolean(one) },
    lamport: { bytes: big?.bytes ?? m.lamport.txBytes, runtime: big?.cost?.runtime ?? m.lamport.runtime, fromRun: Boolean(big) },
  };
}
const share = (runtime, tenure) => `${((100 * runtime) / tenure).toFixed(3)}%`;

function facts(doc) {
  const f = figures(doc);
  $("fact-size").textContent = `${(f.wots.bytes / 1000).toFixed(1)} KB`;
  $("fact-times").textContent = Math.round(f.wots.bytes / f.transfer);
  // The share of a tenure on the limit that binds first, which is the number of reads.
  $("fact-share").textContent = f.wots.cost ? `${(100 * tenureShare(f.wots.cost, f.budget).share).toFixed(2)}%` : share(f.wots.runtime, f.tenure);
}

function notice(doc) {
  if (!doc.rehearsal) return;
  $("notice").textContent = "This is a rehearsal. The run below was simulated on one machine and has not been sent to testnet, so there are no transactions to open and the live checks are off.";
  $("notice").hidden = false;
}

// --- 3. the run -------------------------------------------------------------------

// Where the money is: the vaults as the chain has them now, and what the
// recipient and the attacker ended the run with.
function accounts(doc, book) {
  const live = doc.network === "testnet";
  const lines = (...text) => text.filter(Boolean).map((t) => h("p", { class: "line" }, t));

  const vault = (scheme) => {
    if (!doc.vaults[scheme]) return null;
    const big = h("p", { class: "figure" }), also = h("p", { class: "line" }), keys = h("p", { class: "line" });
    const status = h("span", {});
    const show = (s, note) => {
      big.textContent = money(s.stx, "stx");
      also.textContent = BigInt(s.sbtc) ? `and ${amountText(s.sbtc, "sbtc")} test sBTC` : "";
      const n = Number(s.nonce ?? s.key);
      keys.textContent = n
        ? `Guarded by key #${n}. ${n === 1 ? "Key #0 is" : n === 2 ? "Keys #0 and #1 are" : `Keys #0 to #${n - 1} are`} retired, and the vault will not accept ${n === 1 ? "it" : "them"} again.`
        : "Guarded by key #0, its first.";
      status.textContent = note;
    };
    const end = { ...(book.held[scheme] ?? { stx: 0n, sbtc: 0n }), key: book.key[scheme] ?? 0 };
    show(end, live ? "Reading from Stacks testnet" : "At the end of the rehearsal");
    if (live) {
      const read = async () => {
        try {
          const s = await callRead(doc.contracts["pq-vault"], "get-vault", [buffer(doc.vaults[scheme].id)]);
          if (s) show(s, `Read from Stacks testnet at ${new Date().toLocaleTimeString()}`);
        } catch {
          show(end, "Testnet did not answer. This is the state at the end of the run.");
        }
      };
      read();
      setInterval(() => { if (!document.hidden) read(); }, 15_000);
    }
    return h("div", { class: "acct vault" },
      h("p", { class: "label" }, scheme === "wots" ? "The vault" : "The Lamport vault"), big, also, keys,
      h("p", { class: "live" }, h("span", { class: "dot", "aria-hidden": "true" }), status));
  };

  // The recipient's own balances, read from the chain. The account only ever
  // received, so what it holds is what the vaults paid it.
  const recipient = () => {
    const got = book.held.recipient ?? { stx: 0n, sbtc: 0n };
    const big = h("p", { class: "figure" }), also = h("p", { class: "line" }), status = h("span", {});
    const show = (stx, sbtc, note) => {
      big.textContent = money(stx, "stx");
      also.textContent = BigInt(sbtc) ? `and ${amountText(sbtc, "sbtc")} test sBTC` : "";
      status.textContent = note;
    };
    show(got.stx, got.sbtc, live ? "Reading from Stacks testnet" : "At the end of the rehearsal");
    if (live) {
      const read = () => get(`/extended/v1/address/${doc.roles.recipient}/balances`).then((b) => {
        const token = Object.entries(b.fungible_tokens ?? {}).find(([id]) => id.startsWith(`${doc.contracts["sbtc-token"]}::`));
        show(b.stx.balance, token?.[1].balance ?? 0, `Its balance on Stacks testnet at ${new Date().toLocaleTimeString()}`);
      }).catch(() => show(got.stx, got.sbtc, "Testnet did not answer. This is the sum of the payments below."));
      read();
      setInterval(() => { if (!document.hidden) read(); }, 15_000);
    }
    return h("div", { class: "acct" }, h("p", { class: "label" }, "The recipient"), big, also,
      lines(`Received ${book.payments.length} payments the owner signed. It sent no transaction.`),
      h("p", { class: "live" }, h("span", { class: "dot", "aria-hidden": "true" }), status));
  };
  $("accounts").replaceChildren(...[
    vault("wots"),
    recipient(),
    h("div", { class: "acct" }, h("p", { class: "label" }, "The attacker"), h("p", { class: "figure" }, money(book.taken, "stx")),
      lines("taken from the vaults", `Tried ${book.attacks.length} times, from the owner's own account and from another. Every request was refused, as the transactions below show.`)),
    vault("lamport"),
  ].filter(Boolean));
}

const ROLE = {
  deployer: "Deploys the contracts and hands out test funds.",
  owner: "The owner's ordinary Stacks account. Opens and funds the vaults. The attacker is assumed to hold its key.",
  submitter: "An unrelated account. Plays the attacker who alters the request, then submits the requests as signed.",
  recipient: "Receives the withdrawals. Signs nothing.",
};
const PHASE = {
  setup: { title: "Setting up: contracts and test funds", folded: true },
  vault: { title: "The owner opens and funds a vault" },
  "account-key": { title: "An attacker who holds the owner's Stacks account key",
    note: "This is what breaking today's signatures would give an attacker. The requests are sent from the owner's own account." },
  mempool: { title: "An attacker who sees the owner's signed request before it confirms",
    note: "The owner has signed a request to pay 1 STX to the recipient. The attacker changes one field and gets it to the chain first." },
  withdraw: { title: "The request as the owner signed it", note: "An unrelated account submits it. The funds go where the owner signed." },
  rotate: { title: "The next key", note: "The first withdrawal installed a new key. This request is signed with it." },
  lamport: { title: "A second vault, under a Lamport key", note: "The same contract with the other signature scheme: open, deposit and one withdrawal. The attacks above were not repeated here." },
};

const SIGNATURE = { none: "None", attacker: "Made with a one-time key of the attacker's own", owner: "The owner's" };
function signature(s) {
  if (!s.signature) return null;
  const base = s.changed ? `The owner's, but the ${s.changed} was changed after signing` : SIGNATURE[s.signature];
  return `${base}. The request is for key #${s.key}.`;
}

// What happened, as a class, a tag and a sentence.
function outcome(s) {
  if (s.result === "(err u205)") return ["refused", "Refused", "The signature does not match the request, so nothing moved."];
  if (s.result === "(err u203)") return ["refused", "Refused", `Key #${s.key} was spent by the payment above, so nothing moved.`];
  if (s.result?.startsWith("(err")) return ["refused", "Refused", `The contract answered ${s.result}. Nothing moved.`];
  if (s.signature) return ["paid", "Paid", `The vault paid, retired key #${s.key} and moved to key #${s.key + 1}.`];
  if (s.call === "pq-vault.open") return ["done", "Opened", "The vault now exists under the owner's first key, key #0."];
  if (s.call?.startsWith("pq-vault.deposit")) return ["done", "Deposited", null];
  return ["done", "Done", null];
}

// "Vault ── 1 STX ──▶ Recipient": solid if it moved, struck out if it did not.
function transfer(s, moved) {
  if (!s.asks) return null;
  const minted = s.call === "sbtc-token.mint";
  return h("p", { class: `transfer ${moved ? "moved" : "stopped"}` },
    h("span", { class: "party" }, minted ? "New test tokens" : who(s.asks.from, s)),
    h("span", { class: "arrow" }, h("span", { class: "amount" }, money(s.asks.amount, s.asks.asset))),
    h("span", { class: "party" }, who(s.asks.to, s)),
    h("span", { class: "sr" }, moved ? "(moved)" : "(asked for, did not move)"));
}

// What each argument of the contracts' functions is, in plain words.
const ARGUMENT = {
  key: "The vault's first key. It is a hash, and the one-time key behind it stays with the owner",
  id: "Which vault",
  nonce: "Which of the vault's keys this request is for",
  amount: "How much, in the smallest unit",
  recipient: "Who to pay",
  "next-key": "The key the vault moves to if this is paid",
  verifier: "The contract that checks the signature",
  to: "Who receives the new test tokens",
};

// A fold-out with everything the chain holds for one transaction.
function record(doc, s) {
  if (!s.txid) return null;
  const body = h("div", { class: "record-body" }, "Reading the transaction from the chain.");
  const details = h("details", { class: "record" }, h("summary", {}, "On-chain record"), body);
  const known = { [doc.contracts["pq-vault"]]: "The vault contract",
    ...Object.fromEntries(Object.entries(doc.roles).map(([role, address]) => [address, `The ${role}'s account`])) };
  // The submitter's account is the attacker's wherever a request tries to pay it.
  if (s.asks?.to === "submitter" && s.signature) known[doc.roles.submitter] = "The attacker's account";
  const name = (address) => known[address] ?? short(address, 8, 6);
  details.addEventListener("toggle", async () => {
    if (!details.open || details.dataset.loaded) return;
    try {
      const tx = await get(`/extended/v1/tx/${s.txid}`);
      const events = (await get(`/extended/v1/tx/events?tx_id=${s.txid}&limit=20`)).events ?? [];
      const rows = [["Sent by", short(tx.sender_address, 8, 6), known[tx.sender_address] ?? ""]];
      if (tx.contract_call) {
        rows.push(["Function", tx.contract_call.function_name, `In ${tx.contract_call.contract_id.split(".")[1]}`]);
        for (const a of tx.contract_call.function_args ?? []) {
          const text = a.repr.replace(/^'/, "");
          if (a.name === "sig") {
            const words = (a.repr.match(/0x[0-9a-f]+/g) ?? []).length;
            rows.push(["sig", `${words} values`, words ? `The signature: ${fmt(words * 32)} bytes of hashes` : "The signature. This request carried none"]);
          } else {
            const amount = a.name === "amount" && s.asks ? `. Here ${money(a.repr.slice(1), s.asks.asset)}` : "";
            rows.push([a.name, short(text, 14, 8), `${ARGUMENT[a.name] ?? ""}${known[text] ? `: ${known[text].toLowerCase()}` : ""}${amount}`]);
          }
        }
      } else if (tx.token_transfer) {
        rows.push(["Transfer", money(tx.token_transfer.amount, "stx"), `To ${name(tx.token_transfer.recipient_address).toLowerCase()}`]);
      } else if (tx.smart_contract) {
        rows.push(["Deploys", tx.smart_contract.contract_id.split(".")[1], `${fmt(tx.smart_contract.source_code.length)} characters of Clarity`]);
      }
      rows.push(["Result", tx.tx_result?.repr ?? "", tx.tx_status === "success" ? "Accepted" : "Refused. The transaction is on chain as a failed call"]);
      const moves = events.filter((e) => e.asset?.asset_event_type === "transfer" || e.asset?.asset_event_type === "mint");
      for (const e of moves) {
        const amount = money(e.asset.amount, e.event_type === "stx_asset" ? "stx" : "sbtc");
        if (e.asset.asset_event_type === "mint") rows.push(["Created", amount, `New test tokens, to ${name(e.asset.recipient).toLowerCase()}`]);
        else rows.push(["Moved", amount, `${name(e.asset.sender)} to ${name(e.asset.recipient).toLowerCase()}`]);
      }
      if (!moves.length && tx.contract_call) rows.push(["Moved", "nothing", "No transfer is attached to this transaction"]);
      rows.push(["Cost", `${fmt(tx.execution_cost_runtime)} runtime`, `Fee of ${money(tx.fee_rate, "stx")}, paid by the sender. Block ${fmt(tx.block_height)}`]);
      body.replaceChildren(h("table", {}, h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", {}, c)))))),
        h("p", {}, "These are the fields that decide what happened. The explorer has the rest, such as the sender's own signature and its post-conditions. ", link(explorer(s.txid), "Open it there"), "."));
      details.dataset.loaded = "1";
    } catch (e) {
      body.textContent = `The chain could not be read just now: ${e.message}. Close and open this to try again.`;
    }
  });
  return details;
}

function timeline(doc, book) {
  const phases = [];
  for (const s of book.steps) {
    if (phases.at(-1)?.name !== s.phase) phases.push({ name: s.phase, steps: [] });
    phases.at(-1).steps.push(s);
  }
  const row = (s) => {
    const [cls, tag, sentence] = outcome(s);
    const meta = [`Sent by the ${s.by}'s account`, s.cost?.runtime && `${fmt(s.cost.runtime)} runtime`, s.bytes && `${fmt(s.bytes)} bytes`].filter(Boolean).join(" · ");
    const then = s.after && `The ${s.vault === "wots" ? "vault" : "Lamport vault"} ${cls === "refused" ? "still" : "then"} held ${holding(s.after)}.`;
    return h("li", { class: cls },
      h("span", { class: "mark", "aria-hidden": "true" }),
      h("div", { class: "what" },
        h("p", { class: "title" }, s.title),
        transfer(s, cls !== "refused"),
        signature(s) && h("p", { class: "note" }, h("strong", {}, "Signature: "), signature(s)),
        (sentence || then) && h("p", { class: "note" }, h("strong", {}, "Result: "), [sentence, then].filter(Boolean).join(" ")),
        h("p", { class: "meta" }, meta, s.txid && " · ", s.txid && link(explorer(s.txid), "View transaction")),
        record(doc, s)),
      h("span", { class: "tag" }, tag));
  };
  $("timeline").replaceChildren(...phases.map(({ name, steps }) => {
    const p = PHASE[name] ?? { title: name };
    const rows = h("ol", { class: "steps" }, steps.map(row));
    return p.folded
      ? h("details", { class: "phase" }, h("summary", {}, `${p.title} (${steps.length} steps)`), rows)
      : h("div", { class: "phase" }, h("header", {}, h("h3", {}, p.title), p.note && h("p", {}, p.note)), rows);
  }));

  $("run-title").textContent = `${book.refused.length} requests refused, ${book.payments.length} paid`;
  if (doc.rehearsal) {
    $("run-eyebrow").textContent = "The run, rehearsed";
    $("run-intro").textContent = "Start with where the money ended up, then follow each transaction.";
  }
  const live = doc.network === "testnet";
  $("roles").replaceChildren(...Object.entries(doc.roles).map(([role, address]) => h("li", {},
    h("strong", {}, role), ROLE[role], h("code", {}, live ? link(account(address), short(address, 8, 6)) : short(address, 8, 6)))));
}

// --- 4. change what the owner signed ------------------------------------------------

function forge(doc) {
  const r = doc.requests?.first;
  const panel = $("forge-panel");
  if (!r) return panel.replaceChildren(h("p", { class: "loading" }, "This run has no signed request to try."));
  const unit = LABEL[r.asset], signedAmount = amountText(r.amount, r.asset);
  const deposit = doc.steps.find((s) => s.asks?.to === r.scheme && s.asks.asset === r.asset && !s.signature);
  const whole = deposit ? amountText(deposit.asks.amount, r.asset) : signedAmount;

  const recipient = h("input", { id: "f-recipient", value: r.recipient, spellcheck: "false", autocomplete: "off" });
  const amount = h("input", { id: "f-amount", value: signedAmount, inputmode: "decimal", autocomplete: "off" });
  const verdict = h("div", { class: "verdict", "aria-live": "polite" },
    h("h3", {}, "Not asked yet"), h("p", {}, "Change the recipient or the amount, then ask the contract whether the owner's signature still covers it."));
  const ask = h("button", { class: "primary", type: "submit" }, "Ask the contract");
  const set = (to, much) => { recipient.value = to; amount.value = much; mark(); };
  // Highlight a field once it no longer says what the owner signed.
  const sameAmount = () => { try { return units(amount.value, r.asset) === BigInt(r.amount); } catch { return false; } };
  const mark = () => {
    recipient.classList.toggle("changed", recipient.value.trim().toUpperCase() !== r.recipient.toUpperCase());
    amount.classList.toggle("changed", !sameAmount());
  };
  recipient.addEventListener("input", mark);
  amount.addEventListener("input", mark);

  const say = (cls, title, text, details = []) => {
    verdict.className = `verdict ${cls}`;
    // replaceChildren would print a null or a 0 as text, so only nodes are passed.
    const parts = [h("h3", {}, title), h("p", {}, text)];
    if (details.length) parts.push(h("dl", {}, details.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))));
    verdict.replaceChildren(...parts);
  };

  async function check(event) {
    event.preventDefault();
    if (doc.network !== "testnet") {
      return say("", "Off in a rehearsal", "This check calls the contract on Stacks testnet. It turns on once the run has been sent there.");
    }
    let args;
    try {
      args = [buffer(r.vault), uint(r.nonce), stringAscii(r.asset), uint(units(amount.value, r.asset)), await principal(recipient.value), buffer(r.nextKey)];
    } catch (e) {
      return say("", "Check the request", `That cannot be sent to the contract: ${e.message}.`);
    }
    ask.disabled = true;
    ask.textContent = "Asking the contract";
    const began = performance.now();
    try {
      const digest = await callRead(doc.contracts["pq-vault"], "withdrawal-digest", args);
      const accepted = await callRead(doc.vaults[r.scheme].verifier, "check", [buffer(r.key), buffer(digest), list(r.sig.map(buffer))]);
      const details = [
        ["What the owner signed", h("code", {}, r.digest)],
        ["What this request hashes to, by the contract", h("code", {}, digest)],
        ["Checked by", h("span", {}, link(explorer(doc.vaults[r.scheme].verifier), doc.vaults[r.scheme].verifier.split(".")[1]),
          ` on Stacks testnet in ${Math.round(performance.now() - began)} ms. Read-only, no transaction.`)],
      ];
      if (accepted) say("accepted", "The signature matches", "This is exactly what the owner signed, so the verifier accepts it.", details);
      else say("refused", "The signature does not match", "The verifier refuses it. Changing anything the owner signed changes the hash, and a new signature needs the owner's one-time key.", details);
    } catch (e) {
      say("", "Testnet did not answer", `The contract could not be reached: ${e.message}. Nothing was checked. Try again in a moment.`);
    } finally {
      ask.disabled = false;
      ask.textContent = "Ask the contract";
    }
  }

  panel.replaceChildren(
    h("form", { onsubmit: check },
      h("label", { for: "f-recipient" }, "Pay to"), recipient,
      h("label", { for: "f-amount" }, `Amount, in ${unit}`), amount,
      h("div", { class: "presets" },
        h("button", { type: "button", onclick: () => set(doc.roles.submitter, signedAmount) }, "Pay the attacker instead"),
        h("button", { type: "button", onclick: () => set(r.recipient, whole) }, `Take all ${whole} ${unit}`),
        h("button", { type: "button", onclick: () => set(r.recipient, signedAmount) }, "As signed")),
      ask,
      h("details", { class: "signed" },
        h("summary", {}, `The owner's signature: ${r.sig.length} values, ${fmt(r.sig.length * 32)} bytes`),
        h("code", {}, r.sig.join(" ")))),
    verdict,
    h("p", { class: "aside" }, `This is the signature check on its own, against key #${r.nonce}, the key the vault held when the owner signed. The request was paid once in the run above and the vault moved to its next key, so the vault now refuses even the original.`));
}

// --- 5. size and cost -----------------------------------------------------------------

function bars(doc) {
  const f = figures(doc);
  const chart = (title, note, rows, unit) => {
    const max = Math.max(...rows.map((r) => r.value));
    return h("div", { class: "chart" }, h("h3", {}, title), h("p", {}, note),
      h("ul", {}, rows.map((r) => h("li", { class: r.ours && "ours" },
        h("span", {}, r.label), h("span", { class: "value" }, `${fmt(r.value)} ${unit}`),
        h("span", { class: "bar", "aria-hidden": "true" }, h("span", { style: `width:${(100 * r.value) / max}%` }))))));
  };
  const day = new Date(`${doc.measured.on}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const ours = f.wots.fromRun && f.lamport.fromRun ? "The two withdrawals are from the run above" : `The two withdrawals were measured in simulation on ${day}`;
  // Runtime is not the limit that binds first. Say which is, and how many fit.
  const tight = f.wots.cost && tenureShare(f.wots.cost, f.budget);
  const reads = tight && tight.limit !== "runtime" ? ` Reads are the tighter limit, at ${(100 * tight.share).toFixed(3)}%, so about ${fmt(Math.floor(1 / tight.share))} withdrawals fit in one tenure.` : "";
  $("bars").replaceChildren(
    chart("Transaction size", `A withdrawal carries its signature with it. ${ours}.`, [
      { label: "A plain STX transfer", value: f.transfer },
      { label: "A WOTS+ withdrawal", value: f.wots.bytes, ours: true },
      { label: "A Lamport withdrawal", value: f.lamport.bytes },
    ], "bytes"),
    chart("Compute for the whole call", `In Clarity runtime units. One tenure allows ${fmt(f.tenure / 1e9)} billion, so a WOTS+ withdrawal uses ${share(f.wots.runtime, f.tenure)} of the runtime.${reads} ${ours}, and the first row in simulation.`, [
      { label: "A contract call that moves STX and checks no signature of its own", value: f.call },
      { label: "A WOTS+ withdrawal", value: f.wots.runtime, ours: true },
      { label: "A Lamport withdrawal", value: f.lamport.runtime },
    ], "units"));
}

function source(doc) {
  if (doc.network !== "testnet") return;
  const names = ["pq-vault", "wots", "lamport"].filter((n) => doc.contracts[n]);
  $("source").replaceChildren("Contracts on Stacks testnet: ",
    ...names.flatMap((n, i) => [i ? ", " : "", link(explorer(doc.contracts[n]), n)]), ".");
}

// --- start ------------------------------------------------------------------------------

async function start() {
  const res = await fetch("data/run.json");
  if (!res.ok) throw new Error(`data/run.json: ${res.status}`);
  const doc = await res.json();
  api = doc.api ?? "https://api.testnet.hiro.so";
  const book = ledger(doc);
  notice(doc);
  facts(doc);
  accounts(doc, book);
  timeline(doc, book);
  forge(doc);
  bars(doc);
  source(doc);
}

start().catch((e) => {
  console.error(e);
  $("notice").textContent = "The run's data could not be loaded, so the page shows its explanation only.";
  $("notice").hidden = false;
  $("timeline").replaceChildren();
  $("accounts").replaceChildren();
  $("forge-panel").replaceChildren(h("p", { class: "loading" }, "Not available."));
});
