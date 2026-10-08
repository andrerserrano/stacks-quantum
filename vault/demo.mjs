// The vault, told as a story, on simnet at Epoch 4.0.
//
// Alice keeps STX and sBTC in a vault. Mallory has her Stacks account key,
// the way an attacker who could break secp256k1 would. He can sign any
// transaction as Alice and he can read the mempool. He still cannot move the
// vault's funds anywhere Alice did not sign for.
//
// Run: npm run demo [wots|lamport]
// Writes results/demo-<scheme>.txt.

import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { Cl } from "@stacks/transactions";
import { boot, DEPLOYER, ALICE, BOB, MALLORY, TENURE_BUDGET, EPOCH, CLARITY_VERSION } from "./src/simnet.mjs";
import { SCHEMES, sigCV, wallet } from "./src/vault.mjs";

const scheme = process.argv[2] ?? "wots";
if (!SCHEMES[scheme]) throw new Error(`unknown scheme ${scheme}: use wots or lamport`);
const NAME = { wots: "WOTS+", lamport: "Lamport" }[scheme];
const ERRORS = { 201: "the next key is not acceptable", 203: "the nonce was already used", 204: "the vault does not hold that much", 205: "the signature does not match" };

const lines = [];
const say = (s = "") => { console.log(s); lines.push(s); };
const short = (b) => `${b.toString("hex").slice(0, 16)}...`;
const stxAmount = (u) => `${(Number(u) / 1e6).toLocaleString("en-US")} STX`;
const sbtcAmount = (u) => `${Number(u) / 1e8} sBTC`;

const t = await boot();
const verifier = Cl.contractPrincipal(DEPLOYER, scheme);
const alice = wallet({ master: randomBytes(32), chainId: t.chainId, vault: t.vault, verifier: t.id(scheme), scheme, account: 0 });
const id = Cl.buffer(alice.id);
const vault = () => {
  const s = t.read("pq-vault", "get-vault", [id]).value.value;
  return { key: Buffer.from(s.key.value, "hex"), nonce: Number(s.nonce.value), stx: BigInt(s.stx.value), sbtc: BigInt(s.sbtc.value) };
};
const submit = (r, sender) => t.call("pq-vault", `withdraw-${r.asset}`, [
  id, Cl.uint(r.nonce), Cl.uint(r.amount), Cl.principal(r.recipient), Cl.buffer(r.nextKey), verifier, sigCV(r.sig)], sender);
const outcome = (res) => {
  if (res.result.type === "ok") return "PAID";
  return `REFUSED: ${ERRORS[Number(res.result.value.value)] ?? Cl.prettyPrint(res.result)}`;
};
const attempt = (what, r, sender = ALICE) => say(`     ${what.padEnd(58)} ${outcome(submit(r, sender))}`);
const sign = (nonce, asset, amount, recipient) => alice.signWithdrawal({ nonce, asset, amount, recipient });

say(`A vault guarded by ${NAME} hash-based signatures`);
say(`Simnet, Epoch ${EPOCH}, Clarity ${CLARITY_VERSION}. The only cryptography in the signature check is SHA-256.`);
say();

say("1. Alice makes a one-time key on her device and opens a vault under its hash.");
t.call("pq-vault", "open", [Cl.buffer(alice.key(0)), verifier], ALICE);
t.call("sbtc-token", "mint", [Cl.uint(50_000_000), Cl.principal(ALICE)], DEPLOYER);
t.call("pq-vault", "deposit-stx", [id, Cl.uint(100_000_000)], ALICE);
t.call("pq-vault", "deposit-sbtc", [id, Cl.uint(50_000_000)], ALICE);
say(`     vault ${short(alice.id)} under key ${short(vault().key)}`);
say(`     deposited ${stxAmount(vault().stx)} and ${sbtcAmount(vault().sbtc)}`);
say();

say("2. Mallory has Alice's Stacks account key. He sends withdrawals from her own account.");
const guess = { nonce: 0, asset: "stx", amount: 100_000_000, recipient: MALLORY, nextKey: randomBytes(32) };
attempt("with no signature", { ...guess, sig: [] });
attempt("with a made-up signature", { ...guess, sig: Array.from({ length: SCHEMES[scheme].WORDS }, () => randomBytes(32)) });
const own = randomBytes(32);
attempt("signed with a one-time key of his own", {
  ...guess, sig: SCHEMES[scheme].sign(own, randomBytes(32)) });
say("     The vault never looks at who sent the transaction. Her account key opens nothing.");
say();

say(`3. Alice signs a withdrawal of 25 STX to Bob with her one-time key.`);
const first = sign(0, "stx", 25_000_000, BOB);
say(`     signature: ${first.sig.length} words, ${(first.sig.length * 32).toLocaleString("en-US")} bytes`);
say("   Mallory sees it in the mempool and tries to change it before it confirms.");
attempt("recipient changed to Mallory", { ...first, recipient: MALLORY }, MALLORY);
attempt("amount raised to 100 STX", { ...first, amount: 100_000_000 }, MALLORY);
attempt("next key swapped for his own", { ...first, nextKey: SCHEMES[scheme].publicKey(own) }, MALLORY);
attempt("asset changed, so 25 STX becomes 0.25 sBTC", { ...first, asset: "sbtc" }, MALLORY);
say();

say("4. Anyone can submit the request as Alice signed it. Here Mallory does.");
const bob = t.stx(BOB);
const paid = submit(first, MALLORY);
const cost = paid.costs.total;
say(`     ${"unchanged".padEnd(58)} ${outcome(paid)}`);
say(`     Bob received ${stxAmount(t.stx(BOB) - bob)}. The vault holds ${stxAmount(vault().stx)}.`);
say(`     cost: ${cost.runtime.toLocaleString("en-US")} runtime, ${((100 * cost.runtime) / TENURE_BUDGET.runtime).toFixed(3)}% of a tenure's budget`);
say(`     the vault is now under key ${short(vault().key)} and the old key is spent`);
say();

say("5. Mallory replays the request.");
attempt("the same request again", first, MALLORY);
attempt("the same request, claiming the new nonce and a new key", { ...first, nonce: 1, nextKey: randomBytes(32) }, MALLORY);
say();

say("6. Alice withdraws sBTC with her next key.");
const second = sign(1, "sbtc", 10_000_000, BOB);
const bobSbtc = t.sbtc(BOB);
attempt("0.1 sBTC to Bob", second, BOB);
say(`     Bob received ${sbtcAmount(t.sbtc(BOB) - bobSbtc)}. The vault holds ${stxAmount(vault().stx)} and ${sbtcAmount(vault().sbtc)}.`);
say();

say("What this shows: the vault pays only what its one-time key signed, once.");
say("What it does not show: the transaction that carries the signature, Stacks blocks");
say("and the Bitcoin behind sBTC are still secured by elliptic-curve signatures.");

mkdirSync("results", { recursive: true });
writeFileSync(`results/demo-${scheme}.txt`, lines.join("\n") + "\n");
