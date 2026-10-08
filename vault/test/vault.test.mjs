// The vault on simnet at Epoch 4.0, once per signature scheme.
//
// The claims under test are the ones the PRD asks the demo to make: a signed
// withdrawal is paid, and unauthorized, altered and replayed requests are not.
// The later groups cover what an independent review found on 8 October 2026.
//
// Run: npm test

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Cl } from "@stacks/transactions";
import { boot, source, DEPLOYER, ALICE, BOB, MALLORY } from "../src/simnet.mjs";
import { SCHEMES, keySecret, sigCV, vaultId, wallet, withdrawalDigest } from "../src/vault.mjs";
import * as wots from "../src/wots.mjs";

const OK = "(ok true)";
const ERR = { noVault: "(err u200)", key: "(err u201)", verifier: "(err u202)", nonce: "(err u203)",
              balance: "(err u204)", signature: "(err u205)", exists: "(err u206)" };
const show = (r) => Cl.prettyPrint(r.result);
const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();

// Verifiers that misbehave. Each says yes after trying something.
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
  ["pq-vault-copy", source("pq-vault")],
  ["registry", REGISTRY],
  ["yes", verifier("true")],
  // Takes STX from whoever tx-sender is: the submitter, if the vault lets it.
  ["thief", verifier(`(try! (stx-transfer? u1000000 tx-sender '${MALLORY}))`)],
  ["sbtc-thief", verifier(`(try! (contract-call? .sbtc-token transfer u1000 tx-sender '${MALLORY} none))`)],
  // Uses tx-sender's standing in another contract.
  ["hijacker", verifier(`(try! (contract-call? .registry set-owner '${MALLORY}))`)],
  // Deposits its own STX into the vault being spent, named by the first signature word.
  ["depositor", verifier(`(try! (as-contract? ((with-stx u500))
      (try! (contract-call? .pq-vault deposit-stx (unwrap-panic (element-at? sig u0)) u500))))`)],
];

let t;
before(async () => { t = await boot({ extra: EXTRA }); });

const verifierCV = (name) => Cl.contractPrincipal(DEPLOYER, name);
let nextAccount = 0;

// A wallet for a new vault, opened and funded. Every vault gets its own
// account number, the way a wallet has to.
function openVault(scheme, { stx = 0, sbtc = 0, master = randomBytes(32), account = nextAccount++, contract = "pq-vault" } = {}) {
  const w = wallet({ master, chainId: t.chainId, vault: t.id(contract), verifier: t.id(scheme), scheme, account });
  const opened = t.call(contract, "open", [Cl.buffer(w.key(0)), verifierCV(scheme)], ALICE);
  assert.equal(show(opened), `(ok 0x${w.id.toString("hex")})`);
  const v = { ...w, contract, master, account };
  fund(v, { stx, sbtc });
  return v;
}

function fund(v, { stx = 0, sbtc = 0 }) {
  if (stx) assert.equal(show(t.call(v.contract, "deposit-stx", [Cl.buffer(v.id), Cl.uint(stx)], ALICE)), OK);
  if (sbtc) {
    assert.equal(show(t.call("sbtc-token", "mint", [Cl.uint(sbtc), Cl.principal(ALICE)], DEPLOYER)), OK);
    assert.equal(show(t.call(v.contract, "deposit-sbtc", [Cl.buffer(v.id), Cl.uint(sbtc)], ALICE)), OK);
  }
}

const state = (v) => {
  const s = t.read(v.contract, "get-vault", [Cl.buffer(v.id)]).value.value;
  return { key: s.key.value, nonce: Number(s.nonce.value), stx: Number(s.stx.value), sbtc: Number(s.sbtc.value) };
};

const request = (v, { nonce, asset = "stx", amount, recipient = BOB }) => v.signWithdrawal({ nonce, asset, amount, recipient });

// Submit a request. `sender` defaults to an account with no tie to the vault.
function submit(v, r, { sender = MALLORY, contract = v.contract, verifier = v.scheme } = {}) {
  return t.call(contract, `withdraw-${r.asset}`, [
    Cl.buffer(r.id), Cl.uint(r.nonce), Cl.uint(r.amount), Cl.principal(r.recipient),
    Cl.buffer(r.nextKey), verifierCV(verifier), sigCV(r.sig),
  ], sender);
}

// A request no honest wallet would sign, signed anyway with the vault's key.
function signRaw(v, { nonce, asset = "stx", amount, recipient, nextKey }) {
  const digest = withdrawalDigest({ vault: t.id(v.contract), chainId: t.chainId, id: v.id, nonce, asset, amount, recipient, nextKey });
  return { id: v.id, nonce, asset, amount, recipient, nextKey, sig: SCHEMES[v.scheme].sign(v.secret(nonce), digest) };
}

for (const scheme of ["wots", "lamport"]) {
  describe(scheme, () => {
    test("the wallet and the contract compute the same id and digest", () => {
      const v = openVault(scheme);
      const r = request(v, { nonce: 0, amount: 123_456 });
      const id = t.read("pq-vault", "vault-id", [Cl.buffer(v.key(0)), verifierCV(scheme)]);
      assert.equal(id.value, v.id.toString("hex"));
      const digest = t.read("pq-vault", "withdrawal-digest", [
        Cl.buffer(v.id), Cl.uint(0), Cl.stringAscii("stx"), Cl.uint(123_456), Cl.principal(BOB), Cl.buffer(r.nextKey)]);
      assert.equal(digest.value, r.digest.toString("hex"));
      assert.equal(SCHEMES[scheme].verify(v.key(0), r.digest, r.sig), true);
    });

    test("a signed withdrawal pays the signed recipient, whoever submits it", () => {
      const v = openVault(scheme, { stx: 5_000_000 });
      const [bob, mallory] = [t.stx(BOB), t.stx(MALLORY)];
      const r = request(v, { nonce: 0, amount: 1_500_000 });
      assert.equal(show(submit(v, r, { sender: MALLORY })), OK);
      assert.equal(t.stx(BOB) - bob, 1_500_000n);
      assert.equal(t.stx(MALLORY), mallory);
      assert.deepEqual(state(v), { key: r.nextKey.toString("hex"), nonce: 1, stx: 3_500_000, sbtc: 0 });
    });

    test("each withdrawal installs the next key, and the chain of keys keeps working", () => {
      const v = openVault(scheme, { stx: 3_000_000 });
      const keys = new Set([state(v).key]);
      for (let nonce = 0; nonce < 3; nonce++) {
        assert.equal(show(submit(v, request(v, { nonce, amount: 1_000_000 }))), OK);
        keys.add(state(v).key);
      }
      assert.equal(keys.size, 4);
      assert.deepEqual({ nonce: state(v).nonce, stx: state(v).stx }, { nonce: 3, stx: 0 });
    });

    test("unauthorized: a request without the owner's signature is refused", () => {
      const v = openVault(scheme, { stx: 2_000_000 });
      const before = state(v);
      const honest = request(v, { nonce: 0, amount: 1_000_000, recipient: MALLORY });

      const random = { ...honest, sig: honest.sig.map(() => randomBytes(32)) };
      assert.equal(show(submit(v, random)), ERR.signature);

      // Signed by a stranger's key, for this vault.
      const stranger = wallet({ master: randomBytes(32), chainId: t.chainId, vault: t.vault, verifier: t.id(scheme), scheme, account: 0 });
      const digest = withdrawalDigest({ vault: t.vault, chainId: t.chainId, id: v.id, nonce: 0, asset: "stx", amount: 1_000_000, recipient: MALLORY, nextKey: stranger.key(1) });
      const forged = { ...honest, nextKey: stranger.key(1), sig: SCHEMES[scheme].sign(stranger.secret(0), digest) };
      assert.equal(show(submit(v, forged)), ERR.signature);

      assert.equal(show(submit(v, { ...honest, sig: [] })), ERR.signature);
      assert.deepEqual(state(v), before);
    });

    test("altered: changing any signed field breaks the signature", () => {
      const v = openVault(scheme, { stx: 2_000_000, sbtc: 2_000_000 });
      const other = openVault(scheme, { stx: 2_000_000, master: v.master });
      const before = state(v);
      const r = request(v, { nonce: 0, amount: 1_000_000 });

      const altered = {
        "a larger amount": { ...r, amount: 2_000_000 },
        "a smaller amount": { ...r, amount: 999_999 },
        "another recipient": { ...r, recipient: MALLORY },
        "another next key": { ...r, nextKey: randomBytes(32) },
        "another asset": { ...r, asset: "sbtc" },
        "another vault of the same owner": { ...r, id: other.id },
      };
      for (const [what, changed] of Object.entries(altered)) {
        assert.equal(show(submit(v, changed)), ERR.signature, what);
      }
      assert.deepEqual(state(v), before);
      assert.equal(state(other).stx, 2_000_000);
      assert.equal(show(submit(v, r)), OK);
    });

    test("altered: changing any word of the signature breaks it", () => {
      const v = openVault(scheme, { stx: 1_000_000 });
      const r = request(v, { nonce: 0, amount: 1_000_000 });
      const picks = scheme === "wots" ? r.sig.map((_, i) => i) : [0, 1, 127, 255, 256, 257, 400, 511];
      for (const i of picks) {
        const sig = r.sig.map((w, j) => (j === i ? Buffer.from(w.map((b, k) => (k === 31 ? b ^ 1 : b))) : w));
        assert.equal(show(submit(v, { ...r, sig })), ERR.signature, `word ${i}`);
      }
      assert.equal(state(v).nonce, 0);
    });

    test("malformed signatures are refused without aborting", () => {
      const v = openVault(scheme, { stx: 1_000_000 });
      const r = request(v, { nonce: 0, amount: 1_000_000 });
      const shapes = {
        "one word short": r.sig.slice(0, -1),
        "one word long": [...r.sig, randomBytes(32)],
        "a short word": r.sig.map((w, i) => (i === 3 ? w.subarray(0, 31) : w)),
        "an empty word": r.sig.map((w, i) => (i === 0 ? Buffer.alloc(0) : w)),
        "the largest signature the trait allows": Array.from({ length: 1024 }, () => randomBytes(32)),
      };
      for (const [what, sig] of Object.entries(shapes)) {
        assert.equal(show(submit(v, { ...r, sig })), ERR.signature, what);
      }
    });

    test("replayed: a request that was paid once is refused the second time", () => {
      const v = openVault(scheme, { stx: 5_000_000 });
      const bob = t.stx(BOB);
      const r = request(v, { nonce: 0, amount: 1_000_000 });
      assert.equal(show(submit(v, r)), OK);

      assert.equal(show(submit(v, r)), ERR.nonce);
      // Claiming the current nonce does not help. The request names the key
      // the vault already has, and under any other key the signature fails.
      assert.equal(show(submit(v, { ...r, nonce: 1 })), ERR.key);
      assert.equal(show(submit(v, { ...r, nonce: 1, nextKey: randomBytes(32) })), ERR.signature);
      assert.equal(t.stx(BOB) - bob, 1_000_000n);
      assert.equal(state(v).stx, 4_000_000);
    });

    test("replayed: a request cannot be moved to another deployment of the vault", () => {
      // A wallet never uses a key on two deployments. This one is made to, so
      // that the digest is what stops the replay.
      const v = openVault(scheme, { stx: 1_000_000 });
      assert.equal(show(t.call("pq-vault-copy", "open", [Cl.buffer(v.key(0)), verifierCV(scheme)], ALICE)), `(ok 0x${v.id.toString("hex")})`);
      const copy = { ...v, contract: "pq-vault-copy" };
      fund(copy, { stx: 1_000_000 });
      assert.equal(show(submit(copy, request(v, { nonce: 0, amount: 1_000_000 }))), ERR.signature);
      assert.equal(state(copy).stx, 1_000_000);
    });

    test("sBTC withdrawals work the same way", () => {
      const v = openVault(scheme, { stx: 1_000_000, sbtc: 250_000 });
      const bob = t.sbtc(BOB);
      const r = request(v, { nonce: 0, asset: "sbtc", amount: 100_000 });
      assert.equal(show(submit(v, { ...r, asset: "stx" })), ERR.signature);
      assert.equal(show(submit(v, r)), OK);
      assert.equal(t.sbtc(BOB) - bob, 100_000n);
      assert.deepEqual(state(v), { key: r.nextKey.toString("hex"), nonce: 1, stx: 1_000_000, sbtc: 150_000 });
      assert.equal(show(submit(v, r)), ERR.nonce);
    });

    test("a withdrawal larger than the balance fails and leaves the key in place", () => {
      const v = openVault(scheme, { stx: 1_000_000 });
      const r = request(v, { nonce: 0, amount: 1_500_000 });
      assert.equal(show(submit(v, r)), ERR.balance);
      assert.equal(state(v).nonce, 0);
      // The owner must not sign again with this key. The same request works once funded.
      assert.equal(show(t.call("pq-vault", "deposit-stx", [Cl.buffer(v.id), Cl.uint(500_000)], BOB)), OK);
      assert.equal(show(submit(v, r)), OK);
      assert.equal(show(submit(v, { ...request(v, { nonce: 1, amount: 1 }), amount: 0 })), ERR.balance);
    });

    test("only the verifier the vault was opened with is accepted", () => {
      const v = openVault(scheme, { stx: 1_000_000 });
      const r = request(v, { nonce: 0, amount: 1_000_000 });
      const other = scheme === "wots" ? "lamport" : "wots";
      assert.equal(show(submit(v, r, { verifier: other })), ERR.verifier);
      assert.equal(show(submit(v, r, { verifier: "yes" })), ERR.verifier);
    });

    test("a request that keeps the current key as the next key is refused", () => {
      const v = openVault(scheme, { stx: 1_000_000 });
      const r = signRaw(v, { nonce: 0, amount: 1000, recipient: BOB, nextKey: v.key(0) });
      assert.equal(show(submit(v, r)), ERR.key);
      assert.equal(show(submit(v, { ...r, nextKey: randomBytes(31) })), ERR.key);
      assert.equal(state(v).nonce, 0);
    });
  });
}

describe("wots", () => {
  test("walking a chain forward does not forge a signature for a higher digit", () => {
    const secret = randomBytes(32);
    const key = wots.publicKey(secret);
    let digest;
    do digest = randomBytes(32); while ((digest[0] >> 4) === 15);
    const sig = wots.sign(secret, digest);
    const check = (d, s) => Cl.prettyPrint(t.read("wots", "check", [Cl.buffer(key), Cl.buffer(d), sigCV(s)]));
    assert.equal(check(digest, sig), "true");

    // Raise the first digit by one and advance its chain by one step. Anyone
    // can do this from a published signature. The checksum now needs a chain
    // to move backwards, which takes a preimage.
    const d0 = digest[0] >> 4;
    const raised = Buffer.from(digest);
    raised[0] += 16;
    const seed = sig[0];
    const forged = [...sig];
    forged[1] = sha256(seed, Buffer.from([0, d0]), sig[1]);
    assert.equal(check(raised, forged), "false");
    assert.equal(wots.verify(key, raised, forged), false);
    assert.equal(check(raised, sig), "false");
  });

  test("the contract and the wallet agree as the checksum moves through its range", () => {
    // n zero nibbles and the rest 0xf gives a checksum of 15n, from 0 to 960,
    // which crosses every carry between the three checksum digits.
    const secret = randomBytes(32);
    const key = wots.publicKey(secret);
    for (let n = 0; n <= 64; n++) {
      const digest = Buffer.alloc(32, 0xff);
      for (let i = 0; i < n; i++) digest[i >> 1] &= i % 2 === 0 ? 0x0f : 0xf0;
      const sig = wots.sign(secret, digest);
      assert.equal(wots.verify(key, digest, sig), true);
      assert.equal(Cl.prettyPrint(t.read("wots", "check", [Cl.buffer(key), Cl.buffer(digest), sigCV(sig)])), "true", `${n} zero nibbles`);
    }
  });
});

describe("keys", () => {
  test("a wallet never derives the same key for two vaults", () => {
    const master = randomBytes(32);
    const base = { chainId: t.chainId, vault: t.vault, scheme: "wots", account: 0, index: 0 };
    const secrets = [
      base,
      { ...base, index: 1 },
      { ...base, account: 1 },
      { ...base, scheme: "lamport" },
      { ...base, vault: t.id("pq-vault-copy") },
      { ...base, chainId: 1 },
    ].map((path) => keySecret(master, path).toString("hex"));
    assert.equal(new Set(secrets).size, secrets.length);
  });

  test("a key and verifier open one vault, once", () => {
    const v = openVault("wots", { stx: 1_000_000 });
    const again = () => t.call("pq-vault", "open", [Cl.buffer(v.key(0)), verifierCV("wots")], MALLORY);
    assert.equal(show(again()), ERR.exists);
    assert.equal(show(submit(v, request(v, { nonce: 0, amount: 400_000 }))), OK);
    // Still refused after the key has moved on, so a vault cannot be reset.
    assert.equal(show(again()), ERR.exists);
    assert.deepEqual({ nonce: state(v).nonce, stx: state(v).stx }, { nonce: 1, stx: 600_000 });
  });

  test("the wallet refuses to sign a payment to the vault contract", () => {
    const v = openVault("wots", { stx: 1_000_000 });
    assert.throws(() => request(v, { nonce: 0, amount: 1000, recipient: t.vault }), /cannot pay itself/);
    // Signed anyway, it fails on-chain and uses nothing up.
    const r = signRaw(v, { nonce: 0, amount: 1000, recipient: t.vault, nextKey: v.key(1) });
    assert.notEqual(show(submit(v, r)), OK);
    assert.deepEqual({ nonce: state(v).nonce, stx: state(v).stx }, { nonce: 0, stx: 1_000_000 });
  });
});

describe("vault", () => {
  test("anyone can deposit, but only into a vault that exists", () => {
    const v = openVault("wots");
    assert.equal(show(t.call("pq-vault", "deposit-stx", [Cl.buffer(v.id), Cl.uint(10)], MALLORY)), OK);
    assert.equal(state(v).stx, 10);
    assert.equal(show(t.call("pq-vault", "deposit-stx", [Cl.buffer(randomBytes(32)), Cl.uint(10)], MALLORY)), ERR.noVault);
    assert.equal(show(t.call("pq-vault", "open", [Cl.buffer(randomBytes(31)), verifierCV("wots")], ALICE)), ERR.key);
  });

  test("a look-alike vault cannot take the id a depositor expects", () => {
    // Alice works out her vault's id before it exists. Mallory gets in first
    // with Alice's key and a verifier that says yes to anything.
    const alice = wallet({ master: randomBytes(32), chainId: t.chainId, vault: t.vault, verifier: t.id("wots"), scheme: "wots", account: 0 });
    const squat = t.call("pq-vault", "open", [Cl.buffer(alice.key(0)), verifierCV("yes")], MALLORY);
    assert.equal(squat.result.type, "ok");
    assert.notEqual(show(squat), `(ok 0x${alice.id.toString("hex")})`);
    // Her deposit goes to her id or nowhere.
    assert.equal(show(t.call("pq-vault", "deposit-stx", [Cl.buffer(alice.id), Cl.uint(5_000_000)], ALICE)), ERR.noVault);
    assert.equal(show(t.call("pq-vault", "open", [Cl.buffer(alice.key(0)), verifierCV("wots")], MALLORY)), `(ok 0x${alice.id.toString("hex")})`);
    const v = { ...alice, contract: "pq-vault" };
    fund(v, { stx: 5_000_000 });
    // Mallory opened it, and it is still Alice's.
    const empty = { ...request(v, { nonce: 0, amount: 5_000_000, recipient: MALLORY }), sig: [] };
    assert.equal(show(submit(v, empty, { verifier: "yes" })), ERR.verifier);
    assert.equal(show(submit(v, request(v, { nonce: 0, amount: 5_000_000 }))), OK);
  });

  test("a vault's balances are its own", () => {
    const small = openVault("wots", { stx: 1_000_000, sbtc: 1000 });
    const large = openVault("wots", { stx: 9_000_000, sbtc: 900_000 });
    assert.equal(show(submit(small, request(small, { nonce: 0, amount: 1_000_001 }))), ERR.balance);
    assert.equal(show(submit(small, request(small, { nonce: 0, asset: "sbtc", amount: 1001 }))), ERR.balance);
    assert.deepEqual(state(large), { key: large.key(0).toString("hex"), nonce: 0, stx: 9_000_000, sbtc: 900_000 });
  });
});

describe("hostile verifiers", () => {
  // Each vault here is opened under a verifier that says yes and tries
  // something first. The verifier can cheat its own vault. It must not reach
  // the submitter, the contract's funds or other vaults.
  const hostile = (name, { stx = 1_000_000 } = {}) => {
    const key = randomBytes(32);
    const id = vaultId(key, t.id(name));
    assert.equal(show(t.call("pq-vault", "open", [Cl.buffer(key), verifierCV(name)], MALLORY)), `(ok 0x${id.toString("hex")})`);
    assert.equal(show(t.call("pq-vault", "deposit-stx", [Cl.buffer(id), Cl.uint(stx)], MALLORY)), OK);
    const withdraw = (sender, sig = []) => t.call("pq-vault", "withdraw-stx", [
      Cl.buffer(id), Cl.uint(0), Cl.uint(100), Cl.principal(BOB), Cl.buffer(randomBytes(32)), verifierCV(name), sigCV(sig)], sender);
    return { id, withdraw, contract: "pq-vault" };
  };

  test("a verifier cannot take the submitter's funds", () => {
    const alice = t.stx(ALICE);
    assert.equal(show(hostile("thief").withdraw(ALICE)), ERR.signature);
    assert.equal(t.stx(ALICE), alice);
  });

  test("a verifier cannot use the submitter's standing in another contract", () => {
    assert.equal(show(hostile("hijacker").withdraw(ALICE)), ERR.signature);
    assert.equal(Cl.prettyPrint(t.read("registry", "get-owner")), `'${ALICE}`);
  });

  test("a verifier cannot take the funds the contract holds for other vaults", () => {
    const victim = openVault("wots", { stx: 5_000_000, sbtc: 50_000 });
    const held = [t.stx(t.vault), t.sbtc(t.vault)];
    assert.equal(show(hostile("thief").withdraw(MALLORY)), ERR.signature);
    assert.equal(show(hostile("sbtc-thief").withdraw(MALLORY)), ERR.signature);
    // Each refused call leaves the hostile vault's own 1 STX deposit behind.
    assert.deepEqual([t.stx(t.vault) - held[0], t.sbtc(t.vault) - held[1]], [2_000_000n, 0n]);
    assert.deepEqual({ stx: state(victim).stx, sbtc: state(victim).sbtc }, { stx: 5_000_000, sbtc: 50_000 });
  });

  test("a deposit made while a withdrawal is being checked is not lost", () => {
    t.simnet.transferSTX(1000, t.id("depositor"), ALICE);
    const v = hostile("depositor", { stx: 1000 });
    assert.equal(show(v.withdraw(ALICE, [v.id])), OK);
    assert.equal(state(v).stx, 1000 - 100 + 500);
  });
});
