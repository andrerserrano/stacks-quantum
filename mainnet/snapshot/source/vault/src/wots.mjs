// WOTS+ over SHA-256, matching contracts/wots.clar.
//
// 32-byte values, w = 16: 64 message digits and 3 checksum digits, so 67 hash
// chains of 15 steps. A key signs one digest. Signing a second digest with the
// same key lets anyone forge a third.

import { createHash, createHmac } from "node:crypto";

export const CHAINS = 67;
export const STEPS = 15;
export const WORDS = 68; // the public seed, then one value per chain

const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const prf = (secret, label) => createHmac("sha256", secret).update(label).digest();

// Chain i, step s.
const F = (seed, i, s, x) => sha256(seed, Buffer.from([i, s]), x);

function walk(seed, i, x, from, to) {
  for (let s = from; s < to; s++) x = F(seed, i, s, x);
  return x;
}

// The key is a running hash over the chain ends, starting from the seed.
const fold = (seed, ends) => ends.reduce((h, end) => sha256(h, end), seed);

// The 64 nibbles of the digest, high nibble first, then the checksum as three
// nibbles, most significant first.
export function digits(digest) {
  const d = [];
  for (const b of digest) d.push(b >> 4, b & 15);
  const csum = d.reduce((sum, v) => sum + (STEPS - v), 0);
  d.push((csum >> 8) & 15, (csum >> 4) & 15, csum & 15);
  return d;
}

const seedOf = (secret) => prf(secret, "seed");
const startOf = (secret, i) => prf(secret, Buffer.from([0x63, i]));

// `secret` is 32 bytes and is used for this one key only.
export function publicKey(secret) {
  const seed = seedOf(secret);
  const ends = Array.from({ length: CHAINS }, (_, i) => walk(seed, i, startOf(secret, i), 0, STEPS));
  return fold(seed, ends);
}

export function sign(secret, digest) {
  const seed = seedOf(secret);
  return [seed, ...digits(digest).map((d, i) => walk(seed, i, startOf(secret, i), 0, d))];
}

export function verify(key, digest, sig) {
  if (sig.length !== WORDS || digest.length !== 32 || sig.some((w) => w.length !== 32)) return false;
  const [seed, ...values] = sig;
  const ends = digits(digest).map((d, i) => walk(seed, i, values[i], d, STEPS));
  return fold(seed, ends).equals(key);
}

// How many hashes the verifier runs for this digest, before the final one.
export const verifierSteps = (digest) => digits(digest).reduce((sum, d) => sum + (STEPS - d), 0);
