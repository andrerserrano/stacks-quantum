// A forgery against a WOTS+ key that has signed more than once, found by
// search. This is the attack the sign-once guard exists to prevent.
//
// An owner signs k different requests with key 0 of a vault: 1 STX, 2 STX and
// so on to Bob. An attacker who sees them wants a request the owner never
// signed: the vault's whole 5 STX to Mallory. The attacker varies the one
// field it is free to choose, the next key, and hashes until every digit of
// the digest is at least the smallest digit already published for its chain.
// The signature then follows by walking each published value forward.
//
// The case is fixed by a number, so the result repeats. test/crypto.test.mjs
// submits the requests found here to the vault on simnet, where they are paid.
//
// Run: node analysis/forge.mjs <case> <k>     for example 23920 2, about a minute

import { createHash } from "node:crypto";
import { Cl, serializeCV } from "@stacks/transactions";
import { BOB, CHAIN_ID, DEPLOYER, MALLORY } from "../src/simnet.mjs";
import { SCHEMES, keySecret, vaultId, withdrawalDigest } from "../src/vault.mjs";
import { digits } from "../src/wots.mjs";

const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const VAULT = `${DEPLOYER}.pq-vault`, VERIFIER = `${DEPLOYER}.wots`;
export const STOLEN = 5_000_000;

// The owner's side of case `n`: a master secret, key 0 and the vault it opens.
export function owner(n) {
  const master = sha256(Buffer.from(`pq-vault/test/reuse/${n}`));
  const secret = (index) => keySecret(master, { chainId: CHAIN_ID, vault: VAULT, scheme: "wots", account: 0, index });
  const key = SCHEMES.wots.publicKey(secret(0));
  const id = vaultId(key, VERIFIER);
  // Request number j pays j + 1 STX to Bob, and all of them are for key 0.
  const request = (j) => {
    const r = { id, nonce: 0, asset: "stx", amount: (j + 1) * 1_000_000, recipient: BOB, nextKey: SCHEMES.wots.publicKey(secret(1)) };
    const digest = withdrawalDigest({ vault: VAULT, chainId: CHAIN_ID, ...r });
    return { ...r, digest, sig: SCHEMES.wots.sign(secret(0), digest) };
  };
  return { key, id, request };
}

// The attacker's next key for a counter: nothing but the counter and padding.
export const nextKeyOf = (counter) => {
  const b = Buffer.alloc(32, 0xee);
  b.writeBigUInt64BE(BigInt(counter));
  return b;
};

// The attacker's side: from published signatures alone, a signature on `digest`.
// Null if some digit of the digest is below everything published for its chain.
export function forge(published, digest) {
  const seed = published[0].sig[0], want = digits(digest);
  const sig = [seed];
  for (let i = 0; i < want.length; i++) {
    const from = published.map((p) => ({ d: digits(p.digest)[i], v: p.sig[i + 1] })).sort((a, b) => a.d - b.d)[0];
    if (want[i] < from.d) return null;
    let v = from.v;
    for (let s = from.d; s < want[i]; s++) v = sha256(seed, Buffer.from([i, s]), v);
    sig.push(v);
  }
  return sig;
}

// Search for a next key that makes the theft forgeable. Returns the counter and the tries.
export function search(n, k) {
  const o = owner(n);
  const published = Array.from({ length: k }, (_, j) => o.request(j));
  const lo = Array.from({ length: 67 }, (_, i) => Math.min(...published.map((p) => digits(p.digest)[i])));
  const marker = nextKeyOf(0);
  const bytes = Buffer.from(serializeCV(Cl.tuple({
    vault: Cl.contractPrincipal(DEPLOYER, "pq-vault"), chain: Cl.uint(CHAIN_ID), id: Cl.buffer(o.id), nonce: Cl.uint(0),
    asset: Cl.stringAscii("stx"), amount: Cl.uint(STOLEN), recipient: Cl.principal(MALLORY), "next-key": Cl.buffer(marker) })), "hex");
  const at = bytes.indexOf(marker);
  for (let counter = 0; ; counter++) {
    bytes.writeBigUInt64BE(BigInt(counter), at);
    const d = digits(createHash("sha256").update(bytes).digest());
    if (d.every((digit, i) => digit >= lo[i])) return { counter, tries: counter + 1 };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [n, k] = process.argv.slice(2).map(Number);
  const began = Date.now();
  const found = search(n, k);
  console.log(`case ${n}, ${k} signatures under one key: forged after ${found.tries.toLocaleString("en-US")} hashes, ` +
    `2^${Math.log2(found.tries).toFixed(1)}, in ${((Date.now() - began) / 1000).toFixed(1)} s. Counter ${found.counter}.`);
}
