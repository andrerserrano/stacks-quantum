// What a forgery costs once a one-time key has signed more than once.
//
// WOTS+: a new digest verifies if each of its 67 digits is at least the
// smallest digit published for that chain. A forger varies a field it is free
// to choose, the next key, and hashes until a digest qualifies. For a given
// set of signatures the chance that a random digest qualifies is computed
// exactly, by building the distribution of the checksum over the message
// digits that clear the bar. The spread comes from sampling the signatures.
//
// Lamport: a secret is revealed for every bit position where two of the
// signed digests differ. The forger has to match the remaining positions.
//
// The signed digests here are random: requests the forger had no say in, and
// a classical search. If the forger can choose part of what is signed second,
// WOTS+ falls to about 2^24. See forge-chosen.mjs.
//
// Run: node analysis/double-sign.mjs

import { randomBytes } from "node:crypto";
import { digits } from "../src/wots.mjs";

const SAMPLES = 3000;

// log2 of the expected number of digests a forger hashes.
function wotsWork(signed) {
  const lo = Array.from({ length: 67 }, (_, i) => Math.min(...signed.map((d) => d[i])));
  // dist[s] = chance that the first i message digits all clear the bar and
  // their checksum contributions add up to s.
  let dist = new Float64Array(961);
  dist[0] = 1;
  for (let i = 0; i < 64; i++) {
    const next = new Float64Array(961);
    for (let s = 0; s <= 15 * i; s++) {
      if (dist[s] === 0) continue;
      for (let t = 0; t <= 15 - lo[i]; t++) next[s + t] += dist[s] / 16;
    }
    dist = next;
  }
  let p = 0;
  for (let s = 0; s <= 960; s++) {
    if ((s >> 8) >= lo[64] && ((s >> 4) & 15) >= lo[65] && (s & 15) >= lo[66]) p += dist[s];
  }
  return -Math.log2(p);
}

function lamportWork(signed) {
  let hidden = 0;
  for (let i = 0; i < 256; i++) {
    const bit = (d) => (d[i >> 3] >> (7 - (i & 7))) & 1;
    if (signed.every((d) => bit(d) === bit(signed[0]))) hidden++;
  }
  return hidden;
}

const quantile = (xs, q) => xs[Math.floor(q * (xs.length - 1))];
const share = (xs, limit) => `${((100 * xs.filter((x) => x <= limit).length) / xs.length).toFixed(0)}%`;

console.log(`Work to forge after a one-time key has signed k digests, as log2 of hashes. ${SAMPLES} samples each.\n`);
console.log("scheme   k   10th pct   median   90th pct   within 2^40   within 2^64");
for (const k of [2, 3, 4]) {
  const w = [], l = [];
  for (let n = 0; n < SAMPLES; n++) {
    const signed = Array.from({ length: k }, () => randomBytes(32));
    w.push(wotsWork(signed.map((d) => digits(d))));
    l.push(lamportWork(signed));
  }
  w.sort((a, b) => a - b);
  l.sort((a, b) => a - b);
  const row = (name, xs) => console.log(`${name.padEnd(8)} ${k}   ${quantile(xs, 0.1).toFixed(1).padStart(8)}   ${quantile(xs, 0.5).toFixed(1).padStart(6)}   ${quantile(xs, 0.9).toFixed(1).padStart(8)}   ${share(xs, 40).padStart(11)}   ${share(xs, 64).padStart(11)}`);
  row("WOTS+", w);
  row("Lamport", l);
}
