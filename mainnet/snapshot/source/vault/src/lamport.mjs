// Lamport signatures over SHA-256, matching contracts/lamport.clar.
//
// 256 pairs of secrets, one pair per bit of the digest. A key signs one
// digest. A second signature with the same key reveals more secrets and
// weakens it.

import { createHash, createHmac } from "node:crypto";

export const BITS = 256;
export const WORDS = 512; // the revealed secrets, then the hashes of the hidden ones

const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const prf = (secret, label) => createHmac("sha256", secret).update(label).digest();

// The key is a running hash over the 256 pairs of public hashes.
const fold = (pubs) => {
  let h = Buffer.alloc(32);
  for (let i = 0; i < pubs.length; i += 2) h = sha256(h, pubs[i], pubs[i + 1]);
  return h;
};

const secretOf = (secret, i, b) => prf(secret, Buffer.from([0x6c, i, b]));
const bit = (digest, i) => (digest[i >> 3] >> (7 - (i & 7))) & 1;

// `secret` is 32 bytes and is used for this one key only.
export function publicKey(secret) {
  const pubs = [];
  for (let i = 0; i < BITS; i++) pubs.push(sha256(secretOf(secret, i, 0)), sha256(secretOf(secret, i, 1)));
  return fold(pubs);
}

export function sign(secret, digest) {
  const revealed = [], others = [];
  for (let i = 0; i < BITS; i++) {
    const b = bit(digest, i);
    revealed.push(secretOf(secret, i, b));
    others.push(sha256(secretOf(secret, i, 1 - b)));
  }
  return [...revealed, ...others];
}

export function verify(key, digest, sig) {
  if (sig.length !== WORDS || digest.length !== 32 || sig.some((w) => w.length !== 32)) return false;
  const pubs = [];
  for (let i = 0; i < BITS; i++) {
    const h = sha256(sig[i]), other = sig[BITS + i];
    pubs.push(...(bit(digest, i) ? [other, h] : [h, other]));
  }
  return fold(pubs).equals(key);
}
