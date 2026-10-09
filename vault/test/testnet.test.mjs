// testnet.mjs with --send, end to end, against a stand-in for the testnet
// API (fake-node.mjs). The commands run as they would at a terminal, with
// their own home directory, so the real demo keys are never touched.
//
// Run: npm test

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeNode } from "./fake-node.mjs";

const SCRIPT = fileURLToPath(new URL("../testnet.mjs", import.meta.url));

// A machine of its own: a home directory for the keys and the journal, and a
// working directory for results/.
function machine(node) {
  const home = mkdtempSync(join(tmpdir(), "pq-vault-home-")), cwd = mkdtempSync(join(tmpdir(), "pq-vault-run-"));
  const run = (...args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: tmpdir(),
      env: { ...process.env, HOME: home, PQ_VAULT_API: node.url, PQ_VAULT_RESULTS: join(cwd, "results"), PQ_VAULT_POLL_MS: "20" } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (status) => resolve({ status, out }));
  });
  const doc = () => JSON.parse(readFileSync(join(cwd, "results", "run.json"), "utf8"));
  const keys = () => JSON.parse(readFileSync(join(home, ".config", "pq-vault", "demo.json"), "utf8"));
  const journal = () => readdirSync(join(home, ".config", "pq-vault", "demo-journal"));
  return { run, doc, keys, journal, runFile: join(cwd, "results", "run.json") };
}

describe("the scripted run, sent", () => {
  let node, m, first;
  before(async () => {
    node = await fakeNode();
    m = machine(node);
    first = await m.run("--send");
  });
  after(() => node.close());

  test("every step is sent once, in order, and returns what the story expects", () => {
    assert.equal(first.status, 0, first.out);
    const doc = m.doc();
    assert.equal(doc.network, "testnet");
    assert.equal(doc.steps.length, 22);
    for (const s of doc.steps) assert.equal(s.result, s.expect, s.name);
    assert.deepEqual(doc.steps.map((s) => s.txid), node.sent.map((tx) => tx.txid));
    assert.deepEqual(doc.final.wots, { key: doc.requests.second.nextKey, nonce: 2, stx: "4000000", sbtc: "500000" });
    assert.deepEqual(doc.final.lamport, { key: doc.requests.lamport.nextKey, nonce: 1, stx: "1000000", sbtc: "0" });
    assert.equal(node.stx(doc.roles.recipient), 2_000_000n);
  });

  test("each account sends under its own key, with its nonces in order and a fee for its size", () => {
    const { roles, steps } = m.doc();
    node.sent.forEach((tx, i) => assert.equal(tx.sender, roles[steps[i].by], steps[i].name));
    for (const address of Object.values(roles)) {
      const mine = node.sent.filter((tx) => tx.sender === address);
      assert.deepEqual(mine.map((tx) => tx.nonce), mine.map((_, i) => i));
    }
    assert.equal(node.sent.some((tx) => tx.sender === roles.recipient), false);
    for (const tx of node.sent) assert.ok(tx.fee >= 10n * BigInt(tx.bytes), tx.call);
    // Contract calls and deployments refuse any transfer they did not declare.
    for (const tx of node.sent.filter((tx) => tx.kind !== "transfer")) assert.equal(tx.denies, true, tx.call);
    const moves = node.sent.filter((tx) => /deposit|withdraw/.test(tx.call ?? ""));
    assert.ok(moves.length === 12 && moves.every((tx) => tx.conditions.length === 1));
    assert.equal(node.sent.some((tx) => tx.failedConditions), false);
  });

  test("each post-condition names who may send, what and exactly how much", () => {
    const { roles, contracts, steps } = m.doc();
    const of = (name) => node.sent[steps.findIndex((s) => s.name === name)].conditions;
    const token = `${contracts["sbtc-token"]}::sbtc`, vault = contracts["pq-vault"];
    assert.deepEqual(of("deposit-stx"), [{ principal: roles.owner, asset: "STX", code: "eq", amount: 5_000_000n }]);
    assert.deepEqual(of("deposit-sbtc"), [{ principal: roles.owner, asset: token, code: "eq", amount: 1_000_000n }]);
    assert.deepEqual(of("withdraw"), [{ principal: vault, asset: "STX", code: "eq", amount: 1_000_000n }]);
    assert.deepEqual(of("withdraw-sbtc"), [{ principal: vault, asset: token, code: "eq", amount: 500_000n }]);
    assert.deepEqual(of("withdraw-lamport"), [{ principal: vault, asset: "STX", code: "eq", amount: 1_000_000n }]);
    // The stand-in enforces them: every paid step moved exactly what its condition allows.
    for (const name of ["open", "mint-sbtc"]) assert.deepEqual(of(name), []);
  });

  test("the keys and the journal stay out of the run document", () => {
    const text = JSON.stringify(m.doc()), keys = m.keys();
    for (const secret of [keys.master, keys.deployer, keys.owner, keys.submitter, keys.recipient]) {
      assert.equal(text.includes(secret.slice(0, 64)), false);
    }
    // One journal entry per key that signed: two WOTS+ keys and one Lamport key.
    assert.equal(m.journal().length, 3);
  });

  test("the report reads the chain back: the deployed source, and what each step moved", async () => {
    const { status, out } = await m.run("report");
    assert.equal(status, 0, out);
    assert.match(out, /the deployed source matches contracts\/, and every step moved what the story says/);
    const report = readFileSync(m.runFile.replace("run.json", "RUN.md"), "utf8");
    assert.equal((report.match(/explorer\.hiro\.so/g) ?? []).length, 22);
    assert.match(report, /\| The request as signed: 1 STX to the recipient \| submitter \| `\(ok true\)` \|/);
    // A story that claims a transfer the chain does not show is caught.
    const doc = m.doc(), step = doc.steps.find((s) => s.name === "altered-recipient");
    writeFileSync(m.runFile, JSON.stringify({ ...doc, steps: doc.steps.map((s) => (s === step ? { ...s, result: "(ok true)" } : s)) }));
    const wrong = await m.run("report");
    assert.equal(wrong.status, 1);
    assert.match(wrong.out, /altered-recipient: the chain shows \[\], the story says \[1000000 stx /);
    writeFileSync(m.runFile, JSON.stringify(doc, null, 1) + "\n");
  });

  test("sent again, it sends nothing", async () => {
    const before = node.sent.length, doc = m.doc();
    const again = await m.run("--send");
    assert.equal(again.status, 0, again.out);
    assert.equal(node.sent.length, before);
    assert.deepEqual(m.doc().steps, doc.steps);
    assert.deepEqual(m.doc().requests, doc.requests);
  });

  test("status reads the vaults back", async () => {
    const { status, out } = await m.run("status");
    assert.equal(status, 0, out);
    assert.match(out, /wots\s+vault [0-9a-f]{64}\n\s+nonce 2, key [0-9a-f]{16}\.\.\., 4 STX, 0\.005 sBTC\n\s+key 2 has signed nothing/);
    assert.match(out, /lamport\s+vault [0-9a-f]{64}\n\s+nonce 1, .* 1 STX, 0 sBTC/);
  });

  test("a withdrawal without --send signs nothing and sends nothing", async () => {
    const before = node.sent.length;
    const { status, out } = await m.run("withdraw", "1", "stx");
    assert.equal(status, 0, out);
    assert.match(out, /the contract agrees on the digest\. Not signed, not sent\./);
    assert.equal(node.sent.length, before);
    assert.equal(m.journal().length, 3);
  });

  test("a withdrawal the vault cannot pay is refused before anything is signed", async () => {
    for (const amount of ["4.000001", "0"]) {
      const { status, out } = await m.run("withdraw", amount, "stx", "--send");
      assert.equal(status, 1);
      assert.match(out, /(cannot pay|must be more than zero).* Nothing was signed\./);
    }
    // An address that is not one, and the vault's own, are refused the same way.
    for (const to of ["ST1NOTANADDRESS", m.doc().contracts["pq-vault"]]) {
      const { status, out } = await m.run("withdraw", "1", "stx", "--to", to, "--send");
      assert.equal(status, 1);
      assert.match(out, /(is not a Stacks address|cannot pay itself).* Nothing was signed\./);
    }
    assert.equal(m.journal().length, 3);
  });

  test("a live withdrawal is signed, checked, sent by the submitter and paid", async () => {
    const { roles } = m.doc(), held = node.stx(roles.recipient);
    const { status, out } = await m.run("withdraw", "1", "stx", "--send");
    assert.equal(status, 0, out);
    assert.match(out, /signed with key 2: 68 words, 2,176 bytes\. The verifier contract accepts it\./);
    assert.match(out, /\(ok true\)\. The vault is at nonce 3/);
    assert.equal(node.stx(roles.recipient) - held, 1_000_000n);
    assert.equal(node.sent.at(-1).sender, roles.submitter);
    const doc = m.doc();
    assert.equal(doc.live.length, 1);
    assert.equal(doc.live[0].request.nonce, 2);
    assert.deepEqual(doc.final.wots, { key: doc.live[0].request.nextKey, nonce: 3, stx: "3000000", sbtc: "500000" });
  });

  test("after a failed payment the key will send that request again and no other", async () => {
    const { roles } = m.doc(), held = node.stx(roles.recipient), sent = node.sent.length;
    // The node refuses the transaction. Key 3 has signed, and nothing is on chain.
    node.refuseAfter();
    const failed = await m.run("withdraw", "0.5", "stx", "--send");
    assert.equal(failed.status, 1);
    assert.match(failed.out, /was not accepted/);
    assert.equal(node.sent.length, sent);

    // A different request under the same key is refused, with the way out.
    for (const args of [["0.7", "stx"], ["0.5", "sbtc"], ["0.5", "stx", "--to", roles.submitter]]) {
      const other = await m.run("withdraw", ...args, "--send");
      assert.equal(other.status, 1, other.out);
      assert.match(other.out, /key 3 has already signed 0\.5 stx to \S+, and it has not confirmed\. Send it again with: node testnet\.mjs withdraw 0\.5 stx --scheme wots --to \S+ --send/);
    }
    assert.match((await m.run("status")).out, /key 3 has signed 0\.5 stx to \S+, not yet confirmed/);
    assert.equal(node.sent.length, sent);

    const again = await m.run("withdraw", "0.5", "stx", "--send");
    assert.equal(again.status, 0, again.out);
    assert.equal(node.stx(roles.recipient) - held, 500_000n);
    assert.equal(m.doc().final.wots.nonce, 4);
  });

  test("a mistyped option stops the command before anything is signed", async () => {
    const sent = node.sent.length, claims = m.journal().length;
    for (const args of [["1", "stx", "--shceme", "lamport"], ["1", "stx", "--scheme=lamport"], ["1", "stx", "--too", m.doc().roles.owner],
                        ["1", "stx", "extra"], ["1", "stx", "--scheme"], ["1", "stx", "--scheme", "wots", "--scheme", "lamport"], ["1", "stx", "-s"]]) {
      const { status, out } = await m.run("withdraw", ...args, "--send");
      assert.equal(status, 1, args.join(" "));
      assert.match(out, /unknown option|is not something withdraw understands|needs a value|is given twice/, args.join(" "));
    }
    assert.match((await m.run("status", "--send")).out, /--send does not apply to status/);
    assert.match((await m.run("--scheme", "wots", "--send")).out, /--scheme does not apply to the scripted run/);
    assert.equal(node.sent.length, sent);
    assert.equal(m.journal().length, claims);
  });

  test("a live withdrawal whose reply is lost is sent again as the same transaction", async () => {
    const { roles } = m.doc(), held = node.stx(roles.recipient), sent = node.sent.length;
    node.loseReplyAfter();
    const lost = await m.run("withdraw", "0.1", "stx", "--send");
    assert.equal(lost.status, 1, lost.out);
    assert.equal(node.sent.length, sent + 1);
    const pending = m.doc().live.at(-1);
    assert.deepEqual([pending.txid, pending.result], [node.sent.at(-1).txid, undefined]);

    // Asked again, even for something else, it settles the one in flight and signs nothing new.
    for (const amount of ["0.1", "0.2"]) {
      const again = await m.run("withdraw", amount, "stx", "--send");
      assert.equal(again.status, 0, again.out);
      if (amount === "0.1") assert.match(again.out, /an earlier withdrawal, 0\.1 stx to \S+, had been sent with no result recorded\. It is confirmed: \(ok true\)\. Nothing new was signed/);
      else assert.match(again.out, /\(ok true\)\. The vault is at nonce/);
    }
    // One payment for the lost one, found on chain and not sent twice, then the 0.2 that was asked for after it.
    assert.equal(node.sent.length, sent + 2);
    assert.equal(node.stx(roles.recipient) - held, 300_000n);
    assert.deepEqual(m.doc().live.map((l) => l.result), m.doc().live.map(() => "(ok true)"));
    assert.equal(new Set(m.doc().live.map((l) => l.txid)).size, m.doc().live.length);
  });

  test("a Lamport vault and another recipient can be named", async () => {
    const { roles } = m.doc(), held = node.stx(roles.owner);
    const { status, out } = await m.run("withdraw", "0.25", "stx", "--scheme", "lamport", "--to", roles.owner, "--send");
    assert.equal(status, 0, out);
    assert.match(out, /signed with key 1: 512 words/);
    assert.equal(node.stx(roles.owner) - held, 250_000n);
    assert.ok(node.sent.at(-1).bytes > 19_000);
  });
});

describe("the scripted run, interrupted", () => {
  test("a refused transaction stops the run, and running it again finishes it", async () => {
    const node = await fakeNode(), m = machine(node);
    // The 13th transaction is the first altered request. One of the owner's keys has signed by then.
    node.refuseAfter(13);
    const stopped = await m.run("--send");
    assert.equal(stopped.status, 1);
    assert.match(stopped.out, /altered-recipient was not accepted/);
    assert.equal(node.sent.length, 13);
    assert.equal(m.doc().steps.filter((s) => s.result).length, 13);

    const resumed = await m.run("--send");
    assert.equal(resumed.status, 0, resumed.out);
    assert.equal(node.sent.length, 22);
    // The refused transaction was sent again as the same transaction, and every step ran once.
    assert.equal(new Set(node.sent.map((tx) => tx.txid)).size, 22);
    assert.deepEqual(m.doc().steps.map((s) => s.txid), node.sent.map((tx) => tx.txid));
    for (const s of m.doc().steps) assert.equal(s.result, s.expect, s.name);
    assert.equal(m.doc().final.wots.nonce, 2);
    await node.close();
  });

  test("a reply lost after the node took the transaction does not run the step twice", async () => {
    const node = await fakeNode(), m = machine(node);
    // The sixth transaction funds the owner. The node runs it and the reply never arrives.
    node.loseReplyAfter(5);
    const stopped = await m.run("--send");
    assert.equal(stopped.status, 1, stopped.out);
    assert.equal(node.sent.length, 6);
    const funding = m.doc().steps.find((s) => s.name === "fund-owner");
    // The transaction was written down before it was sent.
    assert.deepEqual([funding.txid, funding.nonce, funding.result], [node.sent[5].txid, 5, undefined]);

    const resumed = await m.run("--send");
    assert.equal(resumed.status, 0, resumed.out);
    assert.equal(node.sent.length, 22);
    assert.equal(node.sent.filter((tx) => tx.kind === "transfer").length, 2);
    // Funded once with 12 STX, less the 5 and 2 it deposited. Simnet charges no fees.
    assert.equal(node.stx(m.doc().roles.owner), 5_000_000n);
    for (const s of m.doc().steps) assert.equal(s.result, s.expect, s.name);
    await node.close();
  });

  test("keys that have sent transactions and no record of them are not run again", async () => {
    const node = await fakeNode(), m = machine(node);
    assert.equal((await m.run("--send")).status, 0);
    renameSync(m.runFile, `${m.runFile}.aside`);
    const again = await m.run("--send");
    assert.equal(again.status, 1);
    assert.match(again.out, /have already sent transactions, and results\/run\.json is missing/);
    assert.equal(node.sent.length, 22);
    await node.close();
  });

  test("a transaction rolled back by a post-condition is not taken for a payment", async () => {
    const node = await fakeNode(), m = machine(node);
    node.rollBackAfter(16);   // the paid withdrawal reports (ok true) and moves nothing
    const { status, out } = await m.run("--send");
    assert.equal(status, 1);
    assert.match(out, /withdraw ended as abort_by_post_condition and changed nothing/);
    assert.equal(m.doc().steps.find((s) => s.name === "withdraw").result, undefined);
    assert.equal(node.stx(m.doc().roles.recipient), 0n);
    assert.equal(node.sent.length, 17);
    await node.close();
  });

  test("a dropped transaction is sent again", async () => {
    const node = await fakeNode(), m = machine(node);
    node.dropAfter(16);   // the paid withdrawal
    const { status, out } = await m.run("--send");
    assert.equal(status, 0, out);
    assert.match(out, /withdraw was dropped \(dropped_replace_by_fee\)\. Sending the same transaction again\./);
    assert.equal(node.sent.filter((tx) => tx.dropped).length, 1);
    assert.equal(node.sent.length, 23);
    // The same transaction, so the two sendings could never both be mined.
    assert.equal(node.sent[16].txid, node.sent[17].txid);
    assert.equal(node.stx(m.doc().roles.recipient), 2_000_000n);
    for (const s of m.doc().steps) assert.equal(s.result, s.expect, s.name);
    await node.close();
  });
});
