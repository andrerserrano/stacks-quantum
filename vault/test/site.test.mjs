// The demo page's own Clarity encoding (site/clarity.js) against
// @stacks/transactions, and its amounts.
//
// Run: npm test

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Cl, cvToHex, getAddressFromPrivateKey, randomPrivateKey } from "@stacks/transactions";
import * as cv from "../../site/clarity.js";
import { amountText, units } from "../../site/amounts.js";
import { ledger, tenureShare } from "../../site/ledger.js";

const hex = (value) => cvToHex(value).slice(2);
const SOME = ["ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM", "ST000000000000000000002AMW42H", "SP000000000000000000002Q6VF78", "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4"];

describe("the page's Clarity encoding", () => {
  test("uints, buffers, strings and lists match the reference", () => {
    for (const n of [0n, 1n, 1_000_000n, 2n ** 64n, 2n ** 128n - 1n]) assert.equal(cv.uint(n), hex(Cl.uint(n)));
    for (const size of [0, 1, 32, 33]) {
      const b = randomBytes(size);
      assert.equal(cv.buffer(b.toString("hex")), hex(Cl.buffer(b)));
    }
    for (const s of ["", "stx", "sbtc"]) assert.equal(cv.stringAscii(s), hex(Cl.stringAscii(s)));
    const words = Array.from({ length: 68 }, () => randomBytes(32));
    assert.equal(cv.list(words.map((w) => cv.buffer(w.toString("hex")))), hex(Cl.list(words.map((w) => Cl.buffer(w)))));
    assert.throws(() => cv.uint(-1n), /not a uint/);
    assert.throws(() => cv.uint(2n ** 128n), /not a uint/);
    assert.throws(() => cv.buffer("abc"), /not hex/);
    assert.throws(() => cv.stringAscii("é"), /not ASCII/);
  });

  test("addresses and contract principals match the reference", async () => {
    const random = Array.from({ length: 40 }, () => getAddressFromPrivateKey(randomPrivateKey(), "testnet"));
    for (const address of [...SOME, ...random]) {
      assert.equal(await cv.principal(address), hex(Cl.principal(address)), address);
      assert.equal(await cv.principal(`${address}.pq-vault`), hex(Cl.principal(`${address}.pq-vault`)), address);
    }
    assert.equal(await cv.principal(`  ${SOME[0].toLowerCase()} `), hex(Cl.principal(SOME[0])));
  });

  test("a mistyped address is refused", async () => {
    const good = SOME[0];
    for (let i = 2; i < good.length; i++) {
      const typo = good.slice(0, i) + (good[i] === "A" ? "B" : "A") + good.slice(i + 1);
      if (typo !== good) await assert.rejects(cv.principal(typo), /typo|not a Stacks address/, typo);
    }
    for (const bad of ["", "hello", "ST", "0x1234", `${good}.`, `${good}.9lives`, `${good}.a.b`, good.slice(0, -1), `${good}0`]) {
      await assert.rejects(cv.principal(bad), /./, bad);
    }
  });

  test("decoding gives back what the contracts return", () => {
    const key = randomBytes(32);
    const vault = Cl.some(Cl.tuple({
      key: Cl.buffer(key), verifier: Cl.contractPrincipal(SOME[0], "wots"), nonce: Cl.uint(2), stx: Cl.uint(4_000_000), sbtc: Cl.uint(500_000) }));
    assert.deepEqual(cv.decode(cvToHex(vault)), {
      key: key.toString("hex"), nonce: 2n, sbtc: 500_000n, stx: 4_000_000n,
      verifier: { version: 26, hash: hex(Cl.principal(SOME[0])).slice(4), name: "wots" } });
    assert.equal(cv.decode(cvToHex(Cl.none())), null);
    assert.equal(cv.decode(cvToHex(Cl.bool(true))), true);
    assert.equal(cv.decode(cvToHex(Cl.bool(false))), false);
    assert.equal(cv.decode(cvToHex(Cl.buffer(key))), key.toString("hex"));
    assert.deepEqual(cv.decode(cvToHex(Cl.ok(Cl.uint(7)))), { ok: 7n });
    assert.deepEqual(cv.decode(cvToHex(Cl.error(Cl.uint(205)))), { err: 205n });
    assert.deepEqual(cv.decode(cvToHex(Cl.list([Cl.int(-5), Cl.stringAscii("stx"), Cl.stringUtf8("ok")]))), [-5n, "stx", "ok"]);
    assert.throws(() => cv.decode("0x02000000"), /cut short/);
    assert.throws(() => cv.decode("0x0300"), /left over/);
    assert.throws(() => cv.decode("0xff"), /unknown Clarity type/);
  });
});

describe("the page's data", () => {
  test("site/data/run.json is the vault's latest run, with the measured costs", () => {
    // Refresh it with: node site/sync.mjs
    const at = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
    const source = existsSync(new URL("../results/run.json", import.meta.url)) ? "../results/run.json" : "../results/run.rehearsal.json";
    const { measured, ...page } = at("../../site/data/run.json");
    assert.deepEqual(page, at(source));
    assert.deepEqual(Object.keys(measured), ["on", "budget", "callRuntime", "transferBytes", "wots", "lamport"]);
    for (const n of [measured.budget.runtime, measured.budget.readCount, measured.callRuntime, measured.transferBytes, measured.wots.txBytes, measured.lamport.runtime]) assert.ok(n > 0);
  });

  test("the balances the page adds up are the ones the chain reported when the run ended", () => {
    const doc = JSON.parse(readFileSync(new URL("../../site/data/run.json", import.meta.url), "utf8"));
    const book = ledger(doc);
    for (const scheme of ["wots", "lamport"]) {
      assert.deepEqual({ nonce: book.key[scheme], stx: String(book.held[scheme].stx), sbtc: String(book.held[scheme].sbtc) },
        { nonce: doc.final[scheme].nonce, stx: doc.final[scheme].stx, sbtc: doc.final[scheme].sbtc }, scheme);
    }
    assert.deepEqual([book.held.recipient.stx, book.held.recipient.sbtc, book.taken], [2_000_000n, 500_000n, 0n]);
    assert.deepEqual([book.refused.length, book.payments.length, book.attacks.length], [6, 3, 5]);
    // After a refused step the vault holds what it held before it.
    const requests = book.steps.filter((s) => s.signature && s.vault === "wots");
    assert.deepEqual(requests.map((s) => `${s.after.stx}/${s.after.sbtc}/${s.after.key}`),
      ["5000000/1000000/0", "5000000/1000000/0", "5000000/1000000/0", "5000000/1000000/0", "5000000/1000000/0",
       "4000000/1000000/1", "4000000/1000000/1", "4000000/500000/2"]);
  });

  test("a withdrawal's share of a tenure is taken on the limit that binds first", () => {
    const doc = JSON.parse(readFileSync(new URL("../../site/data/run.json", import.meta.url), "utf8"));
    const paid = doc.steps.find((s) => s.name === "withdraw");
    const tight = tenureShare(paid.cost, doc.measured.budget);
    assert.equal(tight.limit, "readCount");
    assert.equal((100 * tight.share).toFixed(3), "0.030");
    assert.ok(paid.cost.runtime / doc.measured.budget.runtime < tight.share);
  });
});

describe("the page's amounts", () => {
  test("text and smallest units convert exactly, both ways", () => {
    assert.equal(units("1", "stx"), 1_000_000n);
    assert.equal(units("0.005", "sbtc"), 500_000n);
    assert.equal(amountText(4_000_000n, "stx"), "4");
    assert.equal(amountText("500000", "sbtc"), "0.005");
    for (const bad of ["1.0000001", "-1", "1e3", "", ".5", "abc"]) assert.throws(() => units(bad, "stx"), /not an amount/, bad);
  });
});
