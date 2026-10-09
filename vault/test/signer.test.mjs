// The reference signer: the guard that holds a one-time key to one request,
// and the scripted run the demo sends to testnet, here on simnet.
//
// Run: npm test

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cl, randomPrivateKey } from "@stacks/transactions";
import { boot, BOB, CHAIN_ID, MALLORY } from "../src/simnet.mjs";
import { fileJournal } from "../src/journal.mjs";
import { assemble, play, simDriver, story, vaultState } from "../src/story.mjs";
import { ROLES, addresses, amountText, rehearsalKeys, rehearse, units, wallets } from "../src/testnet.mjs";
import { SCHEMES, keySecret, sigCV, wallet } from "../src/vault.mjs";

const VAULT = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.pq-vault";
const newWallet = (more = {}) => wallet({
  master: randomBytes(32), chainId: CHAIN_ID, vault: VAULT, verifier: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.wots", scheme: "wots", account: 0, ...more });
const pay = (more = {}) => ({ nonce: 0, asset: "stx", amount: 1_000_000, recipient: BOB, ...more });
const tempDir = () => mkdtempSync(join(tmpdir(), "pq-vault-journal-"));

describe("sign once", () => {
  test("a key signs one request, and signs it again to the same signature", () => {
    const w = newWallet();
    assert.equal(w.signed(0), null);
    const first = w.signWithdrawal(pay());
    const again = w.signWithdrawal(pay());
    assert.deepEqual(again.sig, first.sig);
    assert.equal(w.signed(0).digest, first.digest.toString("hex"));
    assert.equal(SCHEMES.wots.verify(w.key(0), first.digest, first.sig), true);
  });

  test("a different request under the same key is refused, whatever differs", () => {
    const w = newWallet();
    w.signWithdrawal(pay());
    for (const change of [{ amount: 1_000_001 }, { recipient: MALLORY }, { asset: "sbtc" }]) {
      assert.throws(() => w.signWithdrawal(pay(change)), /already signed 1000000 stx/, JSON.stringify(change));
    }
    // The next key is free, and the first request still signs.
    assert.equal(w.signWithdrawal(pay({ nonce: 1, amount: 5 })).nonce, 1);
    assert.equal(w.signWithdrawal(pay()).nonce, 0);
  });

  test("building a request, or failing to, claims nothing", () => {
    const w = newWallet();
    w.withdrawal(pay({ amount: 7 }));
    assert.throws(() => w.signWithdrawal(pay({ recipient: VAULT })), /cannot pay itself/);
    assert.equal(w.signed(0), null);
    assert.equal(w.signWithdrawal(pay()).sig.length, 68);
  });

  test("a journal on disk holds across restarts", () => {
    const dir = tempDir(), master = randomBytes(32);
    const first = newWallet({ master, journal: fileJournal(dir) }).signWithdrawal(pay());

    const restarted = newWallet({ master, journal: fileJournal(dir) });
    assert.throws(() => restarted.signWithdrawal(pay({ recipient: MALLORY })), /already signed/);
    assert.deepEqual(restarted.signWithdrawal(pay()).sig, first.sig);

    // One entry, readable only by its owner, and no draft left behind.
    const files = readdirSync(dir);
    assert.deepEqual(files, [`${restarted.key(0).toString("hex")}.json`]);
    assert.equal(statSync(join(dir, files[0])).mode & 0o777, 0o600);
  });

  test("of several processes claiming one key at the same instant, one wins and all agree", async () => {
    const journal = new URL("../src/journal.mjs", import.meta.url).href;
    // Each process loads the module, then spins until a shared instant, so the claims collide.
    const claim = (dir, key, digest, at) => new Promise((resolve, reject) => {
      const code = `import { fileJournal } from ${JSON.stringify(journal)};
        const j = fileJournal(${JSON.stringify(dir)});
        while (Date.now() < ${at}) {}
        console.log(j.claim(${JSON.stringify(key)}, { digest: ${JSON.stringify(digest)} }).digest);`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", code]);
      let out = "", err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (status) => (status === 0 ? resolve(out.trim()) : reject(new Error(err))));
    });
    // Eight claimants on each of six keys at once, three times over. Against a
    // journal that checks and then writes, some key ends up with two holders.
    const round = async (n) => {
      const dir = tempDir(), key = randomBytes(32).toString("hex"), at = Date.now() + 900;
      const digests = Array.from({ length: 8 }, (_, i) => `digest-${n}-${i}`);
      const held = await Promise.all(digests.map((d) => claim(dir, key, d, at)));
      assert.equal(new Set(held).size, 1, `round ${n}: ${[...new Set(held)].join(", ")}`);
      assert.ok(digests.includes(held[0]));
      assert.equal(fileJournal(dir).get(key).digest, held[0]);
      assert.equal(readdirSync(dir).length, 1);
    };
    for (let batch = 0; batch < 3; batch++) await Promise.all(Array.from({ length: 6 }, (_, i) => round(batch * 6 + i)));
  });

  test("a journal key that is not 32 bytes of hex is refused", () => {
    const j = fileJournal(tempDir());
    for (const key of ["", "../../outside", "AB".repeat(32), "ab".repeat(31)]) {
      assert.throws(() => j.claim(key, { digest: "x" }), /32 bytes of hex/);
    }
  });

  test("limit: a wallet restored without its journal has lost the guard", () => {
    const master = randomBytes(32);
    newWallet({ master }).signWithdrawal(pay());
    // Nothing stops this second signature. Until the first request confirms,
    // the journal has to travel with the master secret.
    assert.equal(newWallet({ master }).signWithdrawal(pay({ recipient: MALLORY })).nonce, 0);
  });
});

describe("amounts", () => {
  test("text and smallest units convert exactly, both ways", () => {
    assert.equal(units("1", "stx"), 1_000_000n);
    assert.equal(units("12.000001", "stx"), 12_000_001n);
    assert.equal(units("0.005", "sbtc"), 500_000n);
    assert.equal(units("21000000", "sbtc"), 2_100_000_000_000_000n);
    for (const [amount, asset] of [[1n, "stx"], [500_000n, "sbtc"], [4_000_000n, "stx"], [0n, "sbtc"], [123_456_789n, "sbtc"]]) {
      assert.equal(units(amountText(amount, asset), asset), amount);
    }
    for (const bad of ["1.0000001", "-1", "1e3", "", ".5", "1.", "0x10", " 1"]) assert.throws(() => units(bad, "stx"), /not an amount/, bad);
    assert.throws(() => units("1", "btc"), /unknown asset/);
  });
});

describe("the scripted run", () => {
  let t, who, ws, plan, records, doc, keys;
  const read = (contract, fn, args) => t.read(contract, fn, args);

  before(async () => {
    keys = { ...Object.fromEntries(ROLES.map((role) => [role, randomPrivateKey()])), master: randomBytes(32).toString("hex") };
    who = addresses(keys);
    t = await boot({ deployer: who.deployer });
    ws = wallets(keys, who);
    const driver = simDriver(t, who);
    plan = story({ who, wallets: ws, read: driver.read });
    records = {};
    await play(plan.steps, driver, { record: (s, rec) => { records[s.name] = rec; } });
    const final = { wots: await vaultState(driver.read, ws.wots), lamport: await vaultState(driver.read, ws.lamport) };
    doc = assemble({ network: "simnet", who, wallets: ws, steps: plan.steps, records, requests: plan.requests(), final });
  });

  test("every step returns what the story expects, and the funds end where the owner signed", () => {
    assert.equal(new Set(Object.values(who)).size, 4);
    for (const s of doc.steps) assert.equal(s.result, s.expect, s.name);
    assert.deepEqual(doc.final.wots, { key: ws.wots.key(2).toString("hex"), nonce: 2, stx: "4000000", sbtc: "500000" });
    assert.deepEqual(doc.final.lamport, { key: ws.lamport.key(1).toString("hex"), nonce: 1, stx: "1000000", sbtc: "0" });
    // Two STX withdrawals and one of sBTC reached the recipient, who sent nothing.
    assert.equal(t.stx(who.recipient), 2_000_000n);
    assert.equal(t.sbtc(who.recipient), 500_000n);
    assert.ok(doc.steps.every((s) => s.by !== "recipient"));
  });

  test("the accounts that send gain nothing from a withdrawal", () => {
    // Simnet charges no fees, so each account holds what it was given, less its deposits.
    assert.equal(t.stx(who.submitter), 3_000_000n);
    assert.equal(t.stx(who.owner), 12_000_000n - 5_000_000n - 2_000_000n);
    assert.equal(t.sbtc(who.submitter), 0n);
    // Every refused and every paid withdrawal came from an account with no vault key.
    const sent = doc.steps.filter((s) => s.call?.startsWith("pq-vault.withdraw"));
    assert.deepEqual([...new Set(sent.map((s) => s.by))].sort(), ["owner", "submitter"]);
    assert.equal(sent.filter((s) => s.result === "(ok true)").length, 3);
    assert.equal(sent.filter((s) => s.result === "(err u205)").length, 5);
  });

  test("a published request can be checked against the contracts with no transaction", () => {
    // What the demo page does: the vault computes the digest, the verifier checks the signature.
    const check = (r, change = {}) => {
      const q = { ...r, ...change };
      const digest = read("pq-vault", "withdrawal-digest", [
        Cl.bufferFromHex(q.vault), Cl.uint(q.nonce), Cl.stringAscii(q.asset), Cl.uint(q.amount), Cl.principal(q.recipient), Cl.bufferFromHex(q.nextKey)]);
      return Cl.prettyPrint(read(r.scheme, "check", [Cl.bufferFromHex(r.key), digest, Cl.list(r.sig.map((w) => Cl.bufferFromHex(w)))]));
    };
    assert.deepEqual(Object.keys(doc.requests), ["first", "second", "lamport"]);
    for (const [name, r] of Object.entries(doc.requests)) {
      assert.equal(check(r), "true", name);
      assert.equal(check(r, { recipient: who.submitter }), "false", name);
      assert.equal(check(r, { amount: String(BigInt(r.amount) + 1n) }), "false", name);
      assert.equal(check(r, { nextKey: randomBytes(32).toString("hex") }), "false", name);
      assert.equal(check(r, { nonce: r.nonce + 1 }), "false", name);
    }
    // The key a request was signed under is the one the vault held then.
    assert.equal(doc.requests.first.key, doc.vaults.wots.firstKey);
    assert.equal(doc.requests.second.key, doc.requests.first.nextKey);
  });

  test("the run document holds no secret", () => {
    const text = JSON.stringify(doc);
    const secrets = [keys.master, ...ROLES.map((role) => keys[role].slice(0, 64))];
    for (const scheme of ["wots", "lamport"]) {
      for (let index = 0; index < 3; index++) {
        secrets.push(keySecret(Buffer.from(keys.master, "hex"), { chainId: CHAIN_ID, vault: `${who.deployer}.pq-vault`, scheme, account: 0, index }).toString("hex"));
      }
    }
    for (const secret of secrets) assert.equal(text.includes(secret), false);
    // A Lamport signature is made of revealed secrets, but only of the key that signed.
    assert.equal(doc.requests.lamport.sig.length, 512);
  });

  test("a step that returns something else stops the run there", async () => {
    const sent = [];
    const driver = { exec: async (s) => { sent.push(s.name); return { result: s.name === "open" ? "(err u206)" : s.expect }; } };
    await assert.rejects(play(plan.steps, driver), /open: expected .* got \(err u206\)/);
    assert.equal(sent.at(-1), "open");
    assert.equal(sent.includes("deposit-stx"), false);
  });

  test("an interrupted run picks up where it stopped and sends nothing twice", async () => {
    const done = {}, sent = [];
    const record = (s, rec) => { done[s.name] = rec; };
    // The first attempt is cut off after "withdraw" is accepted and before its result is known.
    const cutOff = {
      exec: async (s, pending, accepted) => {
        sent.push(s.name);
        if (s.name === "withdraw") { accepted({ txid: "0xabc" }); throw new Error("connection lost"); }
        return { result: s.expect };
      },
    };
    await assert.rejects(play(plan.steps, cutOff, { done, record }), /connection lost/);
    assert.deepEqual(done.withdraw, { txid: "0xabc" });

    const resumed = [];
    const second = { exec: async (s, pending) => { resumed.push([s.name, pending?.txid]); return { ...pending, result: s.expect }; } };
    await play(plan.steps, second, { done, record });
    // The run waits for the transaction it had sent, then goes on.
    assert.deepEqual(resumed[0], ["withdraw", "0xabc"]);
    assert.deepEqual(resumed.map(([name]) => name), ["withdraw", "replay", "withdraw-sbtc", "open-lamport", "deposit-stx-lamport", "withdraw-lamport"]);
    assert.equal(sent.filter((name) => name === "withdraw").length, 1);
  });

  test("the rehearsal builds every testnet transaction and sends none", async () => {
    const run = await rehearse(keys);
    assert.equal(run.rehearsal, true);
    for (const s of run.steps) {
      assert.equal(s.result, s.expect, s.name);
      assert.ok(s.bytes > 0 && BigInt(s.fee) >= 10n * BigInt(s.bytes), s.name);
      assert.equal(s.txid, undefined);
    }
    // Under the same keys the rehearsal signs exactly what the run signs.
    assert.deepEqual(run.requests, doc.requests);
    const size = (name) => run.steps.find((s) => s.name === name).bytes;
    assert.ok(size("withdraw") < 3_000 && size("withdraw-lamport") > 19_000);
  });

  test("the rehearsal kept in results/ is what the code produces", async () => {
    // The demo page is built against this file. Refresh it with: node testnet.mjs
    const kept = JSON.parse(readFileSync(new URL("../results/run.rehearsal.json", import.meta.url), "utf8"));
    assert.deepEqual(kept, JSON.parse(JSON.stringify(await rehearse(rehearsalKeys()))));
  });

  test("a rehearsal under real keys signs through the run's journal, and a changed story is refused", async () => {
    const journal = fileJournal(tempDir());
    await rehearse(keys, journal);
    assert.equal(wallets(keys, who, journal).wots.signed(0).digest, doc.requests.first.digest);
    // The same keys asked to sign a different first withdrawal.
    const w = wallets(keys, who, journal).wots;
    assert.throws(() => w.signWithdrawal({ nonce: 0, asset: "stx", amount: 2_000_000n, recipient: who.recipient }), /already signed 1000000 stx/);
  });
});
