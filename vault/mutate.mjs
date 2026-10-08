// Remove each check from the contracts in turn and confirm that an attack
// gets through. A check whose removal changes nothing is either redundant or
// untested, and the report says which.
//
// The attacks sign the digest the contract reports, the way a wallet that
// trusts the contract would, so a mutated digest is tested on its merits.
//
// Run: npm run mutate
// Writes results/mutations.json.

import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { Cl } from "@stacks/transactions";
import { boot, source, DEPLOYER, ALICE, BOB, MALLORY } from "./src/simnet.mjs";
import { SCHEMES, keySecret, sigCV } from "./src/vault.mjs";

// Simnet prints a full trace to stderr whenever a call aborts. Aborts are
// expected here, so the traces are dropped.
console.error = () => {};

const verifier = (body) => `
(impl-trait .pq-verifier-trait.pq-verifier)
(define-public (verify (key (buff 32)) (digest (buff 32)) (sig (list 1024 (buff 32))))
  (begin ${body} (ok true)))`;
const REGISTRY = `
(define-data-var owner principal '${ALICE})
(define-read-only (get-owner) (var-get owner))
(define-public (set-owner (new principal))
  (begin (asserts! (is-eq tx-sender (var-get owner)) (err u1)) (var-set owner new) (ok true)))`;
const EXTRA = [
  ["registry", REGISTRY],
  ["yes", verifier("true")],
  ["thief", verifier(`(try! (stx-transfer? u1000000 tx-sender '${MALLORY}))`)],
  ["hijacker", verifier(`(try! (contract-call? .registry set-owner '${MALLORY}))`)],
  ["depositor", verifier(`(try! (as-contract? ((with-stx u500))
      (try! (contract-call? .pq-vault deposit-stx (unwrap-panic (element-at? sig u0)) u500))))`)],
];

// --- mutations ------------------------------------------------------------------

const cut = (text) => (src) => src.replace(text, "");
const swap = (from, to) => (src) => src.replace(from, to);
const SIGNATURE_CHECK = /\(asserts!\s+\(unwrap! \(as-contract\? \(\)\s+(\(unwrap! \(contract-call\? verifier verify[\s\S]*?ERR-SIGNATURE\))\)\s+ERR-SIGNATURE\)\s+ERR-SIGNATURE\)/;
const WRITE = /\(map-set vaults id \(merge vault \{\s+key: next-key,[\s\S]*?\}\)\)\n/;
const DIGEST_HEAD = "{vault: current-contract, chain: chain-id, id: id, nonce: nonce,";
const DIGEST_TAIL = "asset: asset, amount: amount, recipient: recipient, next-key: next-key}";
// Move the write of the new state to after the signature check.
const writeLate = (src) => {
  const write = WRITE.exec(src)[0];
  const check = SIGNATURE_CHECK.exec(src)[0];
  return src.replace(write, "").replace(check, `${check}\n    ${write.trim()}`);
};

const MUTATIONS = [
  ["pq-vault", "accept the verifier's answer whatever it is", swap(SIGNATURE_CHECK, "$1")],
  ["pq-vault", "run the verifier as the submitter", swap(SIGNATURE_CHECK, "(asserts! $1 ERR-SIGNATURE)")],
  ["pq-vault", "write the vault's new state after the verifier runs", writeLate],
  ["pq-vault", "accept any verifier contract", cut("(asserts! (is-eq (contract-of verifier) (get verifier vault)) ERR-VERIFIER)")],
  ["pq-vault", "skip the nonce check", cut("(asserts! (is-eq nonce (get nonce vault)) ERR-NONCE)")],
  ["pq-vault", "skip the balance check", swap("(asserts! (and (> amount u0) (<= amount balance)) ERR-BALANCE)", "(asserts! (> amount u0) ERR-BALANCE)")],
  ["pq-vault", "allow a withdrawal of nothing", swap("(asserts! (and (> amount u0) (<= amount balance)) ERR-BALANCE)", "(asserts! (<= amount balance) ERR-BALANCE)")],
  ["pq-vault", "allow the current key as the next key", swap("(and (is-eq (len next-key) u32) (not (is-eq next-key key)))", "(is-eq (len next-key) u32)")],
  ["pq-vault", "skip the next key's length check", swap("(and (is-eq (len next-key) u32) (not (is-eq next-key key)))", "(not (is-eq next-key key))")],
  ["pq-vault", "keep the old key after a withdrawal", swap("key: next-key,\n", "key: key,\n")],
  ["pq-vault", "keep the old nonce after a withdrawal", swap("nonce: (+ nonce u1),", "nonce: nonce,")],
  ["pq-vault", "do not debit the vault", swap("stx: (if is-stx (- balance amount) (get stx vault)),", "stx: (get stx vault),")],
  ["pq-vault", "let a vault be opened twice", swap("(asserts! (map-insert vaults id", "(asserts! (map-set vaults id")],
  ["pq-vault", "number vaults instead of naming them by key and verifier",
    (src) => src.replace("(sha256 (unwrap-panic (to-consensus-buff? {key: key, verifier: verifier}))))",
                         "(sha256 (unwrap-panic (to-consensus-buff? (var-get opened)))))")
                .replace("(define-map vaults (buff 32)", "(define-data-var opened uint u0)\n(define-map vaults (buff 32)")
                .replace("(print {event: \"open\", id: id, key: key, verifier: (contract-of verifier)})", "(var-set opened (+ (var-get opened) u1))")],
  ["pq-vault", "leave the contract out of the digest", swap(DIGEST_HEAD, "{chain: chain-id, id: id, nonce: nonce,")],
  ["pq-vault", "leave the chain out of the digest", swap(DIGEST_HEAD, "{vault: current-contract, id: id, nonce: nonce,")],
  ["pq-vault", "leave the vault id out of the digest", swap(DIGEST_HEAD, "{vault: current-contract, chain: chain-id, nonce: nonce,")],
  ["pq-vault", "leave the nonce out of the digest", swap(DIGEST_HEAD, "{vault: current-contract, chain: chain-id, id: id,")],
  ["pq-vault", "leave the asset out of the digest", swap(DIGEST_TAIL, "amount: amount, recipient: recipient, next-key: next-key}")],
  ["pq-vault", "leave the amount out of the digest", swap(DIGEST_TAIL, "asset: asset, recipient: recipient, next-key: next-key}")],
  ["pq-vault", "leave the recipient out of the digest", swap(DIGEST_TAIL, "asset: asset, amount: amount, next-key: next-key}")],
  ["pq-vault", "leave the next key out of the digest", swap(DIGEST_TAIL, "asset: asset, amount: amount, recipient: recipient}")],
  ["wots", "accept extra words after the signature", cut("(is-eq (len sig) u68)")],
  ["wots", "skip the word length check", cut("(fold is-word sig true)")],
  ["lamport", "accept extra words after the signature", cut("(is-eq (len sig) u512)")],
  ["lamport", "skip the word length check", cut("(fold is-word sig true)")],
];

// Removing these leaves no attack open, and this is why.
const EXPECTED_SURVIVORS = {
  "skip the nonce check": "The nonce check is an early exit. The key has already changed, so a replay still fails on its key or its signature, at full cost.",
  "skip the balance check": "Clarity aborts the transaction when the debit underflows, so nothing is paid. The check turns that abort into a named error.",
  "allow a withdrawal of nothing": "A signed withdrawal of nothing only rotates the key. The transfer of zero then fails, so today nothing happens at all.",
  "skip the next key's length check": "A short next key would lock the vault, which hurts only its owner. No verifier accepts a key that is not 32 bytes.",
  "leave the chain out of the digest": "Simnet is one chain. A testnet signature replayed on mainnet cannot be tried here.",
  "leave the nonce out of the digest": "Each withdrawal already signs under a new key. The nonce in the digest only matters if an owner reuses a key.",
  "skip the word length check": "A short word changes the hash input, so the key no longer matches. The check keeps the encoding strict.",
};

// --- attacks --------------------------------------------------------------------
// Each returns true if something happened that never should.

const HONEST = "an honest withdrawal is refused";

function world(t) {
  const paid = (r) => Cl.prettyPrint(r.result) === "(ok true)";
  const call = (...a) => { try { return t.call(...a); } catch { return { result: Cl.error(Cl.uint(0)) }; } };
  const verifierCV = (name) => Cl.contractPrincipal(DEPLOYER, name);
  let account = 0;

  // Open a vault and return what its owner knows. The id is whatever the
  // contract says it is, so a mutated id scheme is tested on its merits.
  // A wallet's keys for a vault it has not opened yet.
  const keys = (scheme, { master = randomBytes(32), contract = "pq-vault" } = {}) => {
    const v = { scheme, master, contract, account: account++ };
    v.secret = (index) => keySecret(master, { chainId: t.chainId, vault: t.id("pq-vault"), scheme, account: v.account, index });
    v.key = (index) => SCHEMES[scheme].publicKey(v.secret(index));
    return v;
  };
  const open = (scheme, { stx = 0, sbtc = 0, master, contract = "pq-vault", verifier = scheme, key } = {}) => {
    const v = keys(scheme, { master, contract });
    const res = call(contract, "open", [Cl.buffer(key ?? v.key(0)), verifierCV(verifier)], ALICE);
    v.opened = res.result.type === "ok";
    v.id = v.opened ? Buffer.from(res.result.value.value, "hex") : Buffer.alloc(32);
    if (stx) call(contract, "deposit-stx", [Cl.buffer(v.id), Cl.uint(stx)], ALICE);
    if (sbtc) { call("sbtc-token", "mint", [Cl.uint(sbtc), Cl.principal(ALICE)], DEPLOYER); call(contract, "deposit-sbtc", [Cl.buffer(v.id), Cl.uint(sbtc)], ALICE); }
    return v;
  };
  const state = (v) => {
    const s = t.read(v.contract, "get-vault", [Cl.buffer(v.id)]).value.value;
    return { key: s.key.value, verifier: s.verifier.value, nonce: Number(s.nonce.value), stx: Number(s.stx.value), sbtc: Number(s.sbtc.value) };
  };
  // The owner signs what the contract says the digest is.
  const sign = (v, { nonce = 0, asset = "stx", amount, recipient = BOB, keyIndex = nonce, nextKey = v.key(keyIndex + 1) }) => {
    const digest = Buffer.from(t.read(v.contract, "withdrawal-digest",
      [Cl.buffer(v.id), Cl.uint(nonce), Cl.stringAscii(asset), Cl.uint(amount), Cl.principal(recipient), Cl.buffer(nextKey)]).value, "hex");
    return { id: v.id, nonce, asset, amount, recipient, nextKey, sig: SCHEMES[v.scheme].sign(v.secret(keyIndex), digest) };
  };
  const submit = (v, r, { contract = v.contract, verifier = v.scheme, sender = MALLORY } = {}) =>
    call(contract, `withdraw-${r.asset}`, [Cl.buffer(r.id), Cl.uint(r.nonce), Cl.uint(r.amount), Cl.principal(r.recipient),
      Cl.buffer(r.nextKey), verifierCV(verifier), sigCV(r.sig)], sender);

  return {
    // Not an attack: an honest withdrawal has to keep working, or the mutation
    // has broken the contract and proves nothing.
    [HONEST]: () => {
      const v = open("wots", { stx: 1000 });
      return !paid(submit(v, sign(v, { amount: 10 })));
    },
    "a look-alike vault takes the id a depositor expects": () => {
      // Alice asks the contract what id her vault will have. Mallory opens
      // first, with Alice's key and a verifier that says yes. Alice then opens
      // her vault and deposits to the id she was given.
      const alice = keys("wots");
      const expected = Buffer.from(t.read("pq-vault", "vault-id", [Cl.buffer(alice.key(0)), verifierCV("wots")]).value, "hex");
      call("pq-vault", "open", [Cl.buffer(alice.key(0)), verifierCV("yes")], MALLORY);
      call("pq-vault", "open", [Cl.buffer(alice.key(0)), verifierCV("wots")], ALICE);
      call("pq-vault", "deposit-stx", [Cl.buffer(expected), Cl.uint(1000)], ALICE);
      const grab = { id: expected, nonce: 0, asset: "stx", amount: 1000, recipient: MALLORY, nextKey: randomBytes(32), sig: [] };
      return paid(submit(alice, grab, { verifier: "yes" }));
    },
    "a signature is replayed on another deployment": () => {
      // A wallet never uses a key on two deployments. This one is made to.
      const v = open("wots", { stx: 1000 });
      const copy = open("wots", { stx: 1000, contract: "pq-vault-copy", key: v.key(0) });
      return copy.opened && paid(submit(copy, { ...sign(v, { amount: 1000 }), id: copy.id }));
    },
    "a request with no valid signature is paid": () => {
      const v = open("wots", { stx: 1000 });
      const r = sign(v, { amount: 1000, recipient: MALLORY });
      return paid(submit(v, { ...r, sig: r.sig.map(() => randomBytes(32)) }));
    },
    "the amount is raised": () => {
      const v = open("wots", { stx: 5000 });
      return paid(submit(v, { ...sign(v, { amount: 1000 }), amount: 5000 }));
    },
    "the recipient is changed": () => {
      const v = open("wots", { stx: 1000 });
      return paid(submit(v, { ...sign(v, { amount: 1000 }), recipient: MALLORY }));
    },
    "the next key is replaced, handing over the vault": () => {
      const v = open("wots", { stx: 1000 });
      return paid(submit(v, { ...sign(v, { amount: 10 }), nextKey: randomBytes(32) }));
    },
    "an STX signature withdraws sBTC": () => {
      const v = open("wots", { stx: 1000, sbtc: 1000 });
      return paid(submit(v, { ...sign(v, { amount: 1000 }), asset: "sbtc" }));
    },
    "a signature is used on another vault": () => {
      // A careless wallet moves two vaults to the same key at the same nonce.
      // A request signed for one must still not work on the other.
      const [v, other] = [open("wots", { stx: 1000 }), open("wots", { stx: 1000 })];
      submit(v, sign(v, { amount: 10 }));
      submit(other, sign(other, { amount: 10, nextKey: v.key(1) }));
      return paid(submit(other, { ...sign(v, { nonce: 1, amount: 500 }), id: other.id }));
    },
    "a paid request is paid again": () => {
      const v = open("wots", { stx: 5000 });
      const r = sign(v, { amount: 1000 });
      submit(v, r);
      return paid(submit(v, r)) || paid(submit(v, { ...r, nonce: state(v).nonce }));
    },
    "a vault pays out more than it holds": () => {
      const [v] = [open("wots", { stx: 1000 }), open("wots", { stx: 1_000_000 })];
      return paid(submit(v, sign(v, { amount: 500_000 })));
    },
    "a vault pays out the same balance twice": () => {
      const [v] = [open("wots", { stx: 1000 }), open("wots", { stx: 1_000_000 })];
      submit(v, sign(v, { amount: 1000 }));
      const s = state(v);
      return paid(submit(v, sign(v, { nonce: s.nonce, keyIndex: 1, amount: 1000 }))) ||
             paid(submit(v, sign(v, { nonce: s.nonce, keyIndex: 0, amount: 1000 })));
    },
    "a one-time key is still in place after it signed": () => {
      const v = open("wots", { stx: 1000 });
      const before = state(v).key;
      const kept = paid(submit(v, sign(v, { amount: 10 }))) && state(v).key === before;
      const w = open("wots", { stx: 1000 });
      return kept || (paid(submit(w, sign(w, { amount: 10, nextKey: w.key(0) }))) && state(w).key === w.key(0).toString("hex"));
    },
    "the nonce does not advance": () => {
      const v = open("wots", { stx: 1000 });
      return paid(submit(v, sign(v, { amount: 10 }))) && state(v).nonce === 0;
    },
    "a vault is reset by opening it again": () => {
      const v = open("wots", { stx: 1000 });
      submit(v, sign(v, { amount: 10 }));
      call("pq-vault", "open", [Cl.buffer(v.key(0)), verifierCV("wots")], MALLORY);
      const s = state(v);
      return s.nonce !== 1 || s.stx !== 990;
    },
    "a vault is emptied through a verifier it did not choose": () => {
      const v = open("wots", { stx: 1000 });
      const r = sign(v, { amount: 1000, recipient: MALLORY });
      return paid(submit(v, { ...r, sig: [] }, { verifier: "yes" }));
    },
    "a verifier takes the submitter's funds": () => {
      const v = open("wots", { stx: 1000, verifier: "thief" });
      const before = t.stx(ALICE);
      submit(v, { ...sign(v, { amount: 10 }), sig: [] }, { verifier: "thief", sender: ALICE });
      return t.stx(ALICE) < before;
    },
    "a verifier uses the submitter's standing in another contract": () => {
      const v = open("wots", { stx: 1000, verifier: "hijacker" });
      submit(v, { ...sign(v, { amount: 10 }), sig: [] }, { verifier: "hijacker", sender: ALICE });
      return !Cl.prettyPrint(t.read("registry", "get-owner")).includes(ALICE);
    },
    "a deposit made during a withdrawal is lost": () => {
      t.simnet.transferSTX(500, t.id("depositor"), ALICE);
      const v = open("wots", { stx: 1000, verifier: "depositor" });
      const ok = paid(submit(v, { ...sign(v, { amount: 100 }), sig: [v.id] }, { verifier: "depositor", sender: ALICE }));
      return ok && state(v).stx !== 1400;
    },
    "a WOTS+ signature with extra words is accepted": () => {
      const v = open("wots", { stx: 1000 });
      const r = sign(v, { amount: 10 });
      return paid(submit(v, { ...r, sig: [...r.sig, randomBytes(32)] }));
    },
    "a Lamport signature with extra words is accepted": () => {
      const v = open("lamport", { stx: 1000 });
      const r = sign(v, { amount: 10 });
      return paid(submit(v, { ...r, sig: [...r.sig, randomBytes(32)] }));
    },
    "a signature with a short word is accepted": () => {
      const v = open("wots", { stx: 1000 });
      const r = sign(v, { amount: 10 });
      return paid(submit(v, { ...r, sig: r.sig.map((w, i) => (i === 5 ? w.subarray(0, 31) : w)) }));
    },
  };
}

async function attack(override = {}) {
  const t = await boot({ override, extra: [["pq-vault-copy", override["pq-vault"] ?? source("pq-vault")], ...EXTRA] });
  return Object.entries(world(t)).filter(([, run]) => run()).map(([name]) => name);
}

// --- run ------------------------------------------------------------------------

const baseline = await attack();
if (baseline.length) throw new Error(`attacks succeed against the real contracts: ${baseline.join("; ")}`);
const ATTACKS = Object.keys(world({ id: () => "" })).length - 1;
console.log(`${ATTACKS} attacks tried against the real contracts: none gets through.\n`);

const rows = [];
for (const [contract, what, mutate] of MUTATIONS) {
  const original = source(contract);
  const mutated = mutate(original);
  if (mutated === original) throw new Error(`mutation did not apply: ${contract}: ${what}`);
  let through, error = null;
  try { through = await attack({ [contract]: mutated }); } catch (e) { through = []; error = String(e).slice(0, 300); }
  if (through.includes(HONEST)) throw new Error(`mutation breaks honest use: ${contract}: ${what}`);
  const expected = EXPECTED_SURVIVORS[what] ?? null;
  rows.push({ contract, mutation: what, caughtBy: through, survives: through.length === 0, reason: through.length === 0 ? expected : null, error });
  console.log(`${through.length ? "caught  " : "survives"}  ${contract}: ${what}${through.length ? `\n            -> ${through.join("\n            -> ")}` : `\n            (${error ?? expected ?? "UNEXPLAINED"})`}`);
}

const unexplained = rows.filter((r) => r.survives && (!r.reason || r.error));
mkdirSync("results", { recursive: true });
writeFileSync("results/mutations.json", JSON.stringify({ measured: new Date().toISOString().slice(0, 10), attacks: ATTACKS, rows }, null, 1) + "\n");
console.log(`\n${rows.filter((r) => !r.survives).length} of ${rows.length} mutations let an attack through. ${rows.filter((r) => r.survives && r.reason && !r.error).length} survive for a stated reason. ${unexplained.length} unexplained.`);
if (unexplained.length) process.exit(1);
