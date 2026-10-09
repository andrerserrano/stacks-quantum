// The signature schemes themselves: that the JavaScript and Clarity
// implementations agree on every input, that their outputs have not drifted,
// and what happens when a one-time key is used more than once.
//
// These are engineering tests. They show the code does what the design says.
// They do not show the design is secure, which takes a cryptographer.
//
// Run: npm test

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Cl } from "@stacks/transactions";
import { boot, ALICE, BOB, CHAIN_ID, DEPLOYER, MALLORY } from "../src/simnet.mjs";
import { SCHEMES, keySecret, sigCV, vaultId, wallet, withdrawalDigest } from "../src/vault.mjs";
import * as wots from "../src/wots.mjs";
import * as lamport from "../src/lamport.mjs";
import { STOLEN, forge, nextKeyOf, owner, search } from "../analysis/forge.mjs";
import { SECOND, addressOf, second } from "../analysis/forge-chosen.mjs";

const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const hash = (words) => sha256(...words).toString("hex");
const VAULT = `${DEPLOYER}.pq-vault`;
const verifierCV = (name) => Cl.contractPrincipal(DEPLOYER, name);
const show = (r) => Cl.prettyPrint(r.result);

let t;
before(async () => { t = await boot(); });
const onChain = (scheme, key, digest, sig) => Cl.prettyPrint(t.read(scheme, "check", [Cl.buffer(key), Cl.buffer(digest), sigCV(sig)])) === "true";

describe("fixed vectors", () => {
  // If one of these changes, keys derived by an earlier version no longer
  // open the vaults they were made for.
  test("key derivation, keys, ids, digests and signatures have not drifted", () => {
    const master = Buffer.alloc(32, 1);
    assert.equal(keySecret(master, { chainId: CHAIN_ID, vault: VAULT, scheme: "wots", account: 0, index: 0 }).toString("hex"),
      "ecbf9fc43fe969211c3926511678a634e4c6a5f41b3f2ae73be5ac12293cc2ba");
    const expected = {
      wots: { key0: "58d60195e67ddefd2b2d2ff8a43a484541cd56426d78b9edf24579867d5cf45d", key3: "968158b85cea73ec961ac1f210d09373d26b5ba5efa8d2b46dbb80a9c7e57ac5",
              id: "8cc7d3e6856ec4db8f3775081ecc0c496a697f6920912988debc92ba98677865", digest: "fe8d92d11a4d9b135458abd464747e3f3151bcd6f51c0a0a12aafd3beaca91f2",
              nextKey: "5cf0e3226a03f56d977e3f00df268fc7d6e506401564f716394064dc07a5cf0f", sig: "2baebbb940591094c2d20c4225a665cbc790ebf51ee69facdc08c5550fb879c8" },
      lamport: { key0: "e544301286e98766719624117c9875fb332254f82f26c0a6c806ccc7b9cc2efb", key3: "62015239e8556ba355ec5d6fac656ebdca7c504bcfe2fc579574a6f5043b71e2",
                 id: "6c96e3648621e22ce4f61fbcbf1a933f57aae77087477eaf9190ed22ea77fdff", digest: "12f8f41e91c6971e151e33ac03f06edcecd7632352b11c6a0dcc67d9195340b9",
                 nextKey: "2516d53b8594d4cc11e6d1ab2c7ed73d4879e67f2c247695903ecd409d903f22", sig: "68aab8ef8581a96bafa60db6d1b1d24c760ea9cb5373f050cb088b4d2d0dc447" },
    };
    for (const scheme of ["wots", "lamport"]) {
      const w = wallet({ master, chainId: CHAIN_ID, vault: VAULT, verifier: `${DEPLOYER}.${scheme}`, scheme, account: 7 });
      const r = w.signWithdrawal({ nonce: 3, asset: "sbtc", amount: 123456789n, recipient: BOB });
      assert.deepEqual({ key0: w.key(0).toString("hex"), key3: w.key(3).toString("hex"), id: w.id.toString("hex"),
        digest: r.digest.toString("hex"), nextKey: r.nextKey.toString("hex"), sig: hash(r.sig) }, expected[scheme], scheme);
      // The contract accepts the same vector.
      assert.equal(onChain(scheme, w.key(3), r.digest, r.sig), true, scheme);
    }
    const secret = Buffer.alloc(32, 0xab), digest = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
    assert.equal(wots.publicKey(secret).toString("hex"), "d59e271727d4b48d6e312758afca9b9c2f12727dfa2724747c5619d48086aaa9");
    assert.equal(hash(wots.sign(secret, digest)), "c7eb13e97c21c15a7ce624d5d0fcc59e77d0e4469cf577e6112639806100c562");
    assert.equal(lamport.publicKey(secret).toString("hex"), "cf1a6ebd0711e8edbe56d01f45e8facbf61d0ca5111cb256209d4f790a72ae8d");
    assert.equal(hash(lamport.sign(secret, digest)), "b473fbf75e05b042f3855af096bba3e154c51afbc0ade1b081146b0ce54395af");
  });
});

describe("the wallet and the contract agree", () => {
  const flip = (b, bit = Math.floor(Math.random() * b.length * 8)) => { const c = Buffer.from(b); c[bit >> 3] ^= 1 << (bit & 7); return c; };
  // Ways to spoil a valid (key, digest, signature). Each returns the three again.
  const spoil = {
    "a bit of one signature word": (k, d, s) => { const i = Math.floor(Math.random() * s.length); return [k, d, s.map((w, j) => (j === i ? flip(w) : w))]; },
    "a bit of the digest": (k, d, s) => [k, flip(d), s],
    "a bit of the key": (k, d, s) => [flip(k), d, s],
    "two words swapped": (k, d, s) => { const c = [...s]; [c[1], c[2]] = [c[2], c[1]]; return [k, d, c]; },
    "one word dropped": (k, d, s) => [k, d, s.slice(0, -1)],
    "one word added": (k, d, s) => [k, d, [...s, randomBytes(32)]],
    "a word one byte short": (k, d, s) => [k, d, s.map((w, j) => (j === 5 ? w.subarray(0, 31) : w))],
    "a digest one byte short": (k, d, s) => [k, d.subarray(0, 31), s],
    "a key one byte short": (k, d, s) => [k.subarray(0, 31), d, s],
    "no signature": (k, d) => [k, d, []],
    "random words of the right count": (k, d, s) => [k, d, s.map(() => randomBytes(32))],
  };

  for (const [scheme, rounds] of [["wots", 60], ["lamport", 25]]) {
    test(`${scheme}: valid signatures are accepted and spoiled ones refused, by both, over random inputs`, () => {
      const lib = SCHEMES[scheme];
      let checked = 0;
      for (let round = 0; round < rounds; round++) {
        const secret = randomBytes(32), digest = randomBytes(32);
        const key = lib.publicKey(secret), sig = lib.sign(secret, digest);
        assert.equal(lib.verify(key, digest, sig), true);
        assert.equal(onChain(scheme, key, digest, sig), true);
        for (const [what, change] of Object.entries(spoil)) {
          const [k, d, s] = change(key, digest, sig);
          const here = lib.verify(k, d, s), there = onChain(scheme, k, d, s);
          assert.equal(here, there, `${what}: the wallet says ${here}, the contract ${there}`);
          assert.equal(there, false, what);
          checked++;
        }
        // A signature made for another digest, and one made under another key.
        const other = randomBytes(32);
        assert.equal(onChain(scheme, key, other, sig), false);
        assert.equal(onChain(scheme, lib.publicKey(other), digest, sig), false);
      }
      assert.equal(checked, rounds * Object.keys(spoil).length);
    });
  }

  test("wots: the edges of the digit range verify, in the wallet and in the contract", () => {
    const secret = randomBytes(32), key = wots.publicKey(secret);
    const edges = [Buffer.alloc(32, 0x00), Buffer.alloc(32, 0xff), Buffer.alloc(32, 0x0f), Buffer.alloc(32, 0xf0),
                   Buffer.concat([Buffer.alloc(16, 0x00), Buffer.alloc(16, 0xff)]), Buffer.concat([Buffer.from([0xff]), Buffer.alloc(31, 0x00)])];
    for (const digest of edges) {
      const sig = wots.sign(secret, digest);
      assert.equal(wots.verify(key, digest, sig), true, digest.toString("hex"));
      assert.equal(onChain("wots", key, digest, sig), true, digest.toString("hex"));
    }
    // Lowest and highest checksum: 0 for all-ones digits, 960 for all zeros.
    assert.deepEqual(wots.digits(Buffer.alloc(32, 0xff)).slice(64), [0, 0, 0]);
    assert.deepEqual(wots.digits(Buffer.alloc(32, 0x00)).slice(64), [3, 12, 0]);
  });

  test("wots: raising any one digit and walking its chain forward never verifies", () => {
    // What anyone can do with a published signature. The checksum then needs
    // a chain to go backwards, which takes a preimage.
    const secret = randomBytes(32), key = wots.publicKey(secret);
    const digest = Buffer.from(randomBytes(32).map((b) => b & 0xee));   // no digit is 15, so each can be raised
    const sig = wots.sign(secret, digest), seed = sig[0];
    for (let i = 0; i < 64; i++) {
      const raised = Buffer.from(digest);
      raised[i >> 1] += i % 2 === 0 ? 16 : 1;
      const d = wots.digits(digest)[i];
      const walked = sig.map((w, j) => (j === i + 1 ? sha256(seed, Buffer.from([i, d]), w) : w));
      assert.equal(wots.verify(key, raised, walked), false, `digit ${i}`);
      assert.equal(onChain("wots", key, raised, walked), false, `digit ${i}`);
    }
  });

  test("lamport: a signature covers no digest that differs in one bit", () => {
    const secret = randomBytes(32), key = lamport.publicKey(secret), digest = randomBytes(32);
    const sig = lamport.sign(secret, digest);
    for (let bit = 0; bit < 256; bit++) {
      const other = Buffer.from(digest);
      other[bit >> 3] ^= 0x80 >> (bit & 7);
      assert.equal(lamport.verify(key, other, sig), false, `bit ${bit}`);
      if (bit % 16 === 0) assert.equal(onChain("lamport", key, other, sig), false, `bit ${bit}`);
    }
  });

  test("the digest the wallet signs is the contract's, at the edges of every field", () => {
    const id = randomBytes(32), nextKey = randomBytes(32);
    const cases = [
      { nonce: 0, asset: "stx", amount: 1n, recipient: BOB },
      { nonce: 1, asset: "sbtc", amount: 2n ** 64n, recipient: MALLORY },
      { nonce: 2 ** 32, asset: "stx", amount: 2n ** 128n - 1n, recipient: `${DEPLOYER}.sbtc-token` },
      { nonce: Number.MAX_SAFE_INTEGER, asset: "sbtc", amount: 0n, recipient: ALICE },
    ];
    for (const c of cases) {
      const mine = withdrawalDigest({ vault: VAULT, chainId: CHAIN_ID, id, nextKey, ...c });
      const theirs = t.read("pq-vault", "withdrawal-digest", [
        Cl.buffer(id), Cl.uint(c.nonce), Cl.stringAscii(c.asset), Cl.uint(c.amount), Cl.principal(c.recipient), Cl.buffer(nextKey)]);
      assert.equal(theirs.value, mine.toString("hex"), JSON.stringify(c, (k, v) => (typeof v === "bigint" ? String(v) : v)));
    }
    // Every field changes the digest.
    const base = { vault: VAULT, chainId: CHAIN_ID, id, nextKey, nonce: 5, asset: "stx", amount: 10n, recipient: BOB };
    const variants = [{}, { nonce: 6 }, { asset: "sbtc" }, { amount: 11n }, { recipient: MALLORY }, { nextKey: randomBytes(32) }, { id: randomBytes(32) },
                      { chainId: 1 }, { vault: `${DEPLOYER}.pq-vault-2` }];
    assert.equal(new Set(variants.map((v) => withdrawalDigest({ ...base, ...v }).toString("hex"))).size, variants.length);
  });
});

describe("key derivation", () => {
  const good = { chainId: CHAIN_ID, vault: VAULT, scheme: "wots", account: 0, index: 0 };
  const master = randomBytes(32);

  test("a path whose parts could be read two ways is refused", () => {
    // "1/2" and 3 would spell the same path as 1 and "2/3".
    for (const bad of [{ account: "1/2" }, { index: "2/3" }, { account: 1.5 }, { index: -1 }, { account: "1" }, { index: null }, { chainId: "1" },
                       { chainId: 2 ** 60 }, { scheme: "wots/0" }, { scheme: "toString" }, { vault: `${VAULT}/x` }, { vault: DEPLOYER }, { vault: "pq-vault" }]) {
      assert.throws(() => keySecret(master, { ...good, ...bad }), /whole number|unknown scheme|the vault is a contract/, JSON.stringify(bad));
    }
    for (const bad of [Buffer.alloc(31), Buffer.alloc(33), "00".repeat(32), null]) assert.throws(() => keySecret(bad, good), /32 bytes/);
    assert.equal(keySecret(master, good).length, 32);
  });

  test("no two paths give the same secret, over a grid of them", () => {
    const seen = new Set();
    for (const chainId of [1, CHAIN_ID]) for (const vault of [VAULT, `${DEPLOYER}.pq-vault-2`]) for (const scheme of ["wots", "lamport"]) {
      for (const account of [0, 1, 11]) for (const index of [0, 1, 10, 110]) seen.add(keySecret(master, { chainId, vault, scheme, account, index }).toString("hex"));
    }
    assert.equal(seen.size, 2 * 2 * 2 * 3 * 4);
    assert.notEqual(keySecret(randomBytes(32), good).toString("hex"), keySecret(master, good).toString("hex"));
  });

  test("the same owner under another verifier gets other keys", () => {
    // A vault's id covers its verifier, so one key under two verifiers would
    // open two vaults and sign once in each. Found by review on 9 October 2026.
    const base = { master, chainId: CHAIN_ID, vault: VAULT, scheme: "wots", account: 0 };
    const usual = wallet({ ...base, verifier: `${DEPLOYER}.wots` });
    const other = wallet({ ...base, verifier: `${DEPLOYER}.wots2` }), third = wallet({ ...base, verifier: `${BOB}.wots` });
    const keys = [usual, other, third].flatMap((w) => [w.key(0), w.key(1)]).map((k) => k.toString("hex"));
    assert.equal(new Set(keys).size, 6);
    assert.equal(new Set([usual, other, third].map((w) => w.id.toString("hex"))).size, 3);
    // The usual verifier is the one keys were derived under before, and they have not moved.
    assert.equal(keySecret(master, { ...good, verifier: `${DEPLOYER}.wots` }).toString("hex"), keySecret(master, good).toString("hex"));
    assert.notEqual(keySecret(master, { ...good, verifier: `${DEPLOYER}.wots2` }).toString("hex"), keySecret(master, good).toString("hex"));
    assert.throws(() => keySecret(master, { ...good, verifier: "wots/0" }), /the verifier is a contract/);
  });

  test("the wallet will not sign a request the contract can never pay", () => {
    // Signed, each of these would claim the key for nothing and lock the vault.
    const w = wallet({ master, chainId: CHAIN_ID, vault: VAULT, verifier: `${DEPLOYER}.wots`, scheme: "wots", account: 3 });
    const ok = { nonce: 0, asset: "stx", amount: 1, recipient: BOB };
    // The vault's own address spelled with O for 0 and L for 1 is the same principal on chain.
    const alias = `${DEPLOYER.replace(/0/g, "O").replace(/1/g, "L")}.pq-vault`;
    const bad = [{ asset: "STX" }, { asset: "btc" }, { asset: "" }, { amount: 0 }, { amount: -1 }, { amount: 1.5 }, { amount: "ten" }, { amount: 2n ** 128n },
                 { recipient: VAULT }, { recipient: alias }, { recipient: "not an address" }, { recipient: "" }, { nonce: -1 }, { nonce: 0.5 }];
    for (const change of bad) {
      assert.throws(() => w.signWithdrawal({ ...ok, ...change }), /the asset is|the amount must|cannot pay itself|is not a Stacks address|the nonce must/,
        JSON.stringify(change, (k, v) => (typeof v === "bigint" ? String(v) : v)));
    }
    assert.notEqual(alias, VAULT);
    // None of them claimed the key.
    assert.equal(w.signed(0), null);
    assert.equal(w.signWithdrawal(ok).sig.length, 68);
    for (const fine of [{ amount: 2n ** 128n - 1n, nonce: 1 }, { amount: "25", nonce: 2 }, { recipient: `${BOB}.some-contract`, nonce: 3 }, { asset: "sbtc", nonce: 4 }]) {
      assert.equal(w.signWithdrawal({ ...ok, ...fine }).sig.length, 68);
    }
  });

  test("the parts of a key come from separate labels", () => {
    // The seed, the chain starts and Lamport's secrets are all taken from one
    // secret. No two of them may be the same value.
    const secret = randomBytes(32);
    const sig = wots.sign(secret, Buffer.alloc(32, 0x00));     // all digits zero: the message chains' starts
    const low = wots.sign(secret, Buffer.alloc(32, 0xff));     // checksum zero: the checksum chains' starts
    const parts = [sig[0], ...sig.slice(1, 65), ...low.slice(65)];
    const ones = lamport.sign(secret, Buffer.alloc(32, 0xff)), zeros = lamport.sign(secret, Buffer.alloc(32, 0x00));
    parts.push(...ones.slice(0, 256), ...zeros.slice(0, 256));
    assert.equal(new Set(parts.map((p) => p.toString("hex"))).size, 1 + 67 + 512);
  });
});

describe("what a second signature costs", () => {
  test("wots: two signatures on well-chosen digests give away the whole key", () => {
    const secret = randomBytes(32), key = wots.publicKey(secret);
    // All-zero digits publish the start of every message chain. All-ones
    // digits have checksum zero, which publishes the start of the other three.
    const a = wots.sign(secret, Buffer.alloc(32, 0x00)), b = wots.sign(secret, Buffer.alloc(32, 0xff));
    const seed = a[0], starts = [...a.slice(1, 65), ...b.slice(65)];
    // With no secret, a signature on anything.
    for (let n = 0; n < 5; n++) {
      const digest = randomBytes(32);
      const forged = [seed, ...wots.digits(digest).map((d, i) => { let v = starts[i]; for (let s = 0; s < d; s++) v = sha256(seed, Buffer.from([i, s]), v); return v; })];
      assert.equal(wots.verify(key, digest, forged), true);
      assert.equal(onChain("wots", key, digest, forged), true);
    }
  });

  test("lamport: two signatures on opposite digests give away the whole key", () => {
    const secret = randomBytes(32), key = lamport.publicKey(secret);
    const zeros = lamport.sign(secret, Buffer.alloc(32, 0x00)).slice(0, 256), ones = lamport.sign(secret, Buffer.alloc(32, 0xff)).slice(0, 256);
    const digest = randomBytes(32), bit = (i) => (digest[i >> 3] >> (7 - (i & 7))) & 1;
    const forged = [...Array.from({ length: 256 }, (_, i) => (bit(i) ? ones[i] : zeros[i])), ...Array.from({ length: 256 }, (_, i) => sha256(bit(i) ? zeros[i] : ones[i]))];
    assert.equal(lamport.verify(key, digest, forged), true);
    assert.equal(onChain("lamport", key, digest, forged), true);
  });

  // The owner's vault for a case from analysis/forge.mjs, opened and holding 5 STX.
  const victim = (n) => {
    const o = owner(n);
    assert.equal(show(t.call("pq-vault", "open", [Cl.buffer(o.key), verifierCV("wots")], ALICE)), `(ok 0x${o.id.toString("hex")})`);
    assert.equal(show(t.call("pq-vault", "deposit-stx", [Cl.buffer(o.id), Cl.uint(STOLEN)], ALICE)), "(ok true)");
    return o;
  };
  const steal = (o, sig, nextKey) => t.call("pq-vault", "withdraw-stx", [
    Cl.buffer(o.id), Cl.uint(0), Cl.uint(STOLEN), Cl.principal(MALLORY), Cl.buffer(nextKey), verifierCV("wots"), sigCV(sig)], MALLORY);
  const theft = (o, nextKey) => withdrawalDigest({ vault: VAULT, chainId: CHAIN_ID, id: o.id, nonce: 0, asset: "stx", amount: STOLEN, recipient: MALLORY, nextKey });

  test("a vault whose key signed three requests is emptied by a fourth nobody signed", () => {
    // The owner signs 1, 2 and 3 STX to Bob with one key and sends none of them.
    const o = victim(33761), held = t.stx(MALLORY);
    const published = [0, 1, 2].map((j) => o.request(j));
    // From those three signatures alone: search for a next key that makes the theft forgeable.
    const { counter, tries } = search(33761, 3);
    assert.ok(tries < 100_000, `${tries} hashes`);
    const nextKey = nextKeyOf(counter), sig = forge(published, theft(o, nextKey));
    assert.equal(show(steal(o, sig, nextKey)), "(ok true)");
    assert.equal(t.stx(MALLORY) - held, BigInt(STOLEN));
    // The attacker also named the next key, so the vault is no longer the owner's.
    assert.equal(t.read("pq-vault", "get-vault", [Cl.buffer(o.id)]).value.value.key.value, nextKey.toString("hex"));
  });

  test("two signatures are enough: a forgery found in a minute, paid by the vault", () => {
    // Two requests the attacker had no say in. Case 23920 is the cheapest of
    // 40,000 sampled keys: 71,774,325 hashes, about a minute on a laptop
    // (node analysis/forge.mjs 23920 2). The typical key costs about 2^61 here.
    // The answer is fixed so the test is fast.
    const o = victim(23920), held = t.stx(MALLORY);
    const published = [0, 1].map((j) => o.request(j));
    const nextKey = nextKeyOf(71_774_324);
    const sig = forge(published, theft(o, nextKey));
    assert.ok(sig, "the recorded next key no longer makes the theft forgeable");
    assert.equal(show(steal(o, sig, nextKey)), "(ok true)");
    assert.equal(t.stx(MALLORY) - held, BigInt(STOLEN));
  });

  test("if the attacker chooses what is signed second, any key falls in about 2^24 hashes", () => {
    // The owner's first request is public. The attacker asks for 2 STX at an
    // address it picked from a million, so that the two digests together leave
    // the cheapest forgery. Cases 1 and 2 are ordinary keys, not chosen for
    // being weak: 17,084,908 and 3,027,093 hashes (node analysis/forge-chosen.mjs 1).
    for (const [n, address, counter] of [[1, 952211, 17_084_907], [2, 594425, 3_027_092]]) {
      const o = victim(n), held = t.stx(MALLORY);
      const published = [o.request(0), second(n, addressOf(address))];
      assert.equal(published[1].amount, SECOND);
      // Both are honest signatures by the owner, valid under the same key.
      for (const p of published) assert.equal(onChain("wots", o.key, p.digest, p.sig), true);
      const nextKey = nextKeyOf(counter), sig = forge(published, theft(o, nextKey));
      assert.ok(sig, `case ${n}: the recorded answer no longer forges`);
      assert.equal(show(steal(o, sig, nextKey)), "(ok true)");
      assert.equal(t.stx(MALLORY) - held, BigInt(STOLEN));
    }
  });

  test("one signature is not enough: the same search finds nothing to walk forward from", () => {
    const o = victim(33761 + 1);
    const published = [o.request(0)];
    // A request the owner did not sign is forgeable only if every digit clears
    // the published one. Among 50,000 next keys, none does.
    let forgeable = 0;
    for (let counter = 0; counter < 50_000; counter++) if (forge(published, theft(o, nextKeyOf(counter)))) forgeable++;
    assert.equal(forgeable, 0);
    // And the published signature itself does not pay the attacker.
    assert.equal(show(steal(o, published[0].sig, published[0].nextKey)), "(err u205)");
  });
});

describe("the vault at its edges", () => {
  let nextAccount = 100;
  const open = (scheme, stx = 0) => {
    const w = wallet({ master: randomBytes(32), chainId: CHAIN_ID, vault: VAULT, verifier: `${DEPLOYER}.${scheme}`, scheme, account: nextAccount++ });
    assert.equal(show(t.call("pq-vault", "open", [Cl.buffer(w.key(0)), verifierCV(scheme)], ALICE)), `(ok 0x${w.id.toString("hex")})`);
    if (stx) assert.equal(show(t.call("pq-vault", "deposit-stx", [Cl.buffer(w.id), Cl.uint(stx)], ALICE)), "(ok true)");
    return w;
  };
  const submit = (w, r) => t.call("pq-vault", `withdraw-${r.asset}`, [
    Cl.buffer(r.id), Cl.uint(r.nonce), Cl.uint(r.amount), Cl.principal(r.recipient), Cl.buffer(r.nextKey), verifierCV(w.scheme), sigCV(r.sig)], MALLORY);
  const state = (w) => { const s = t.read("pq-vault", "get-vault", [Cl.buffer(w.id)]).value.value; return { key: s.key.value, nonce: Number(s.nonce.value), stx: Number(s.stx.value), sbtc: Number(s.sbtc.value) }; };

  test("a deposit of nothing, and a withdrawal of an asset the vault does not hold, are refused", () => {
    const w = open("wots", 1_000_000);
    assert.notEqual(show(t.call("pq-vault", "deposit-stx", [Cl.buffer(w.id), Cl.uint(0)], ALICE)), "(ok true)");
    assert.notEqual(show(t.call("pq-vault", "deposit-sbtc", [Cl.buffer(w.id), Cl.uint(0)], ALICE)), "(ok true)");
    assert.equal(show(submit(w, w.signWithdrawal({ nonce: 0, asset: "sbtc", amount: 1, recipient: BOB }))), "(err u204)");
    assert.deepEqual(state(w), { key: w.key(0).toString("hex"), nonce: 0, stx: 1_000_000, sbtc: 0 });
  });

  test("a vault pays out to its last unit and then holds nothing", () => {
    const w = open("wots", 3);
    for (let nonce = 0; nonce < 3; nonce++) assert.equal(show(submit(w, w.signWithdrawal({ nonce, asset: "stx", amount: 1, recipient: BOB }))), "(ok true)");
    assert.deepEqual(state(w), { key: w.key(3).toString("hex"), nonce: 3, stx: 0, sbtc: 0 });
    assert.equal(show(submit(w, w.signWithdrawal({ nonce: 3, asset: "stx", amount: 1, recipient: BOB }))), "(err u204)");
  });

  test("a request for a later key is refused until the vault reaches it", () => {
    const w = open("wots", 2_000_000);
    const second = w.signWithdrawal({ nonce: 1, asset: "stx", amount: 1_000_000, recipient: BOB });
    assert.equal(show(submit(w, second)), "(err u203)");
    assert.equal(show(submit(w, w.signWithdrawal({ nonce: 0, asset: "stx", amount: 1_000_000, recipient: BOB }))), "(ok true)");
    assert.equal(show(submit(w, second)), "(ok true)");
    assert.equal(state(w).nonce, 2);
  });

  test("one owner's signature does not open another owner's vault, or the same owner's other scheme", () => {
    const a = open("wots", 1_000_000), b = open("wots", 1_000_000), c = open("lamport", 1_000_000);
    const r = a.signWithdrawal({ nonce: 0, asset: "stx", amount: 1_000_000, recipient: MALLORY });
    assert.equal(show(submit(b, { ...r, id: b.id })), "(err u205)");
    assert.equal(show(t.call("pq-vault", "withdraw-stx", [
      Cl.buffer(c.id), Cl.uint(0), Cl.uint(1_000_000), Cl.principal(MALLORY), Cl.buffer(r.nextKey), verifierCV("wots"), sigCV(r.sig)], MALLORY)), "(err u202)");
    assert.equal(state(b).stx + state(c).stx, 2_000_000);
  });

  test("limit: the contract lets a request name a retired key as the next one", () => {
    // The contract keeps the current key only, so it cannot tell that a key was
    // used before. A wallet that names an old key would sign with it a second
    // time. This wallet derives each key from the vault's nonce and never does.
    const w = open("wots", 2_000_000);
    assert.equal(show(submit(w, w.signWithdrawal({ nonce: 0, asset: "stx", amount: 1_000_000, recipient: BOB }))), "(ok true)");
    const back = { id: w.id, nonce: 1, asset: "stx", amount: 1_000_000, recipient: BOB, nextKey: w.key(0) };
    const digest = withdrawalDigest({ vault: VAULT, chainId: CHAIN_ID, ...back });
    assert.equal(show(submit(w, { ...back, sig: wots.sign(w.secret(1), digest) })), "(ok true)");
    assert.equal(state(w).key, w.key(0).toString("hex"));
    // The old signature is still useless: it was made for nonce 0, and the vault is at 2.
    assert.equal(state(w).nonce, 2);
  });
});
