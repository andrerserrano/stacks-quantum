// Measure what the vault costs on simnet at Epoch 4.0, for both signature
// schemes, against the tenure budget and two familiar baselines.
//
// Run: npm run measure
// Writes results/costs.json and results/COSTS.md.

import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  Cl, PostConditionMode, makeContractCall, makeUnsignedSTXTokenTransfer, privateKeyToPublic,
  randomPrivateKey, serializeCV, signMessageHashRsv,
} from "@stacks/transactions";
import { boot, source, DEPLOYER, ALICE, BOB, MALLORY, TENURE_BUDGET, EPOCH, CLARITY_VERSION } from "./src/simnet.mjs";
import { SCHEMES, sigCV, wallet } from "./src/vault.mjs";
import * as wots from "./src/wots.mjs";

const SAMPLES = { wots: 300, lamport: 30 };
const BASELINE = `
(define-public (ecdsa (hash (buff 32)) (sig (buff 65)) (pk (buff 33)))
  (ok (secp256k1-verify hash sig pk)))
(define-public (send (amount uint) (to principal))
  (stx-transfer? amount tx-sender to))
`;

const t = await boot({ extra: [["baseline", BASELINE]] });
const verifierCV = (scheme) => Cl.contractPrincipal(DEPLOYER, scheme);
const ok = (r, what) => { if (Cl.prettyPrint(r.result) !== "(ok true)") throw new Error(`${what}: ${Cl.prettyPrint(r.result)}`); return r.costs.total; };
const expect = (r, want, what) => { if (Cl.prettyPrint(r.result) !== want) throw new Error(`${what}: ${Cl.prettyPrint(r.result)}`); return r.costs.total; };
const stats = (xs) => ({ min: Math.min(...xs), mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), max: Math.max(...xs) });
const bytes = (cv) => serializeCV(cv).length / 2;

// The size of the transaction a relayer would broadcast, signed with a
// throwaway key. Nothing is sent.
async function txBytes(fn, args) {
  const tx = await makeContractCall({
    contractAddress: DEPLOYER, contractName: "pq-vault", functionName: fn, functionArgs: args,
    senderKey: randomPrivateKey(), network: "testnet", fee: 1000n, nonce: 0n,
    postConditionMode: PostConditionMode.Deny, postConditions: [],
  });
  return tx.serializeBytes().length;
}

const out = {
  measured: new Date().toISOString().slice(0, 10),
  epoch: EPOCH, clarityVersion: CLARITY_VERSION, budget: TENURE_BUDGET,
  contracts: {}, schemes: {}, baseline: {},
};

for (const name of ["pq-verifier-trait", "wots", "lamport", "pq-vault"]) {
  out.contracts[name] = { sourceBytes: Buffer.byteLength(source(name)), deploy: t.deployCosts[name] };
}

for (const scheme of ["wots", "lamport"]) {
  const lib = SCHEMES[scheme];
  // A fixed master secret, so the run gives the same figures every time.
  const master = createHash("sha256").update(`pq-vault/measure/${scheme}`).digest();
  const w0 = wallet({ master, chainId: t.chainId, vault: t.vault, verifier: t.id(scheme), scheme, account: 0 });
  const opened = t.call("pq-vault", "open", [Cl.buffer(w0.key(0)), verifierCV(scheme)], ALICE);
  if (opened.result.type !== "ok") throw new Error(`open: ${Cl.prettyPrint(opened.result)}`);
  const id = Cl.buffer(w0.id);
  const n = SAMPLES[scheme];
  ok(t.call("sbtc-token", "mint", [Cl.uint(1_000_000), Cl.principal(ALICE)], DEPLOYER), "mint");
  const depositStx = ok(t.call("pq-vault", "deposit-stx", [id, Cl.uint(n * 1000 + 1000)], ALICE), "deposit-stx");
  const depositSbtc = ok(t.call("pq-vault", "deposit-sbtc", [id, Cl.uint(1_000_000)], ALICE), "deposit-sbtc");

  const sign = (nonce, asset, amount) => w0.signWithdrawal({ nonce, asset, amount, recipient: BOB });
  const args = (nonce, amount, w) => [id, Cl.uint(nonce), Cl.uint(amount), Cl.principal(BOB), Cl.buffer(w.nextKey), verifierCV(scheme), sigCV(w.sig)];

  const runs = [];
  let last;
  for (let nonce = 0; nonce < n; nonce++) {
    const w = sign(nonce, "stx", 1000);
    const cost = ok(t.call("pq-vault", "withdraw-stx", args(nonce, 1000, w), MALLORY), `${scheme} withdraw ${nonce}`);
    runs.push({ cost, steps: scheme === "wots" ? wots.verifierSteps(w.digest) : 256 });
    last = { nonce, w };
  }
  const w = sign(n, "sbtc", 500);
  const withdrawSbtc = ok(t.call("pq-vault", "withdraw-sbtc", args(n, 500, w), MALLORY), "withdraw-sbtc");

  // What a refused request costs the network.
  const replay = expect(t.call("pq-vault", "withdraw-stx", args(last.nonce, 1000, last.w), MALLORY), "(err u203)", "replay");
  const next = sign(n + 1, "stx", 1000);
  const tampered = expect(t.call("pq-vault", "withdraw-stx",
    [id, Cl.uint(n + 1), Cl.uint(1000), Cl.principal(MALLORY), Cl.buffer(next.nextKey), verifierCV(scheme), sigCV(next.sig)], MALLORY),
    "(err u205)", "tampered");

  const sigArg = sigCV(next.sig);
  const mid = runs.map((r) => r.cost.runtime).sort((a, b) => a - b)[Math.floor(n / 2)];
  const typical = runs.find((r) => r.cost.runtime === mid).cost;
  out.schemes[scheme] = {
    samples: n,
    signatureWords: next.sig.length,
    signatureBytes: next.sig.length * 32,
    signatureArgBytes: bytes(sigArg),
    txBytes: await txBytes("withdraw-stx", args(n + 1, 1000, next)),
    open: opened.costs.total, depositStx, depositSbtc,
    withdrawStx: { runtime: stats(runs.map((r) => r.cost.runtime)), typical, verifierHashes: stats(runs.map((r) => r.steps)) },
    withdrawSbtc, replay, tampered,
  };
}

// The verifier alone, at its extremes. WOTS+ work depends on the digest.
{
  const run = (scheme, digest) => {
    const secret = randomBytes(32);
    const r = t.call(scheme, "verify", [Cl.buffer(SCHEMES[scheme].publicKey(secret)), Cl.buffer(digest), sigCV(SCHEMES[scheme].sign(secret, digest))]);
    return ok(r, `${scheme} verify`).runtime;
  };
  out.schemes.wots.verifyOnly = {
    leastWork: { hashes: wots.verifierSteps(Buffer.alloc(32, 0xff)), runtime: run("wots", Buffer.alloc(32, 0xff)) },
    mostWork: { hashes: wots.verifierSteps(Buffer.alloc(32, 0x00)), runtime: run("wots", Buffer.alloc(32, 0x00)) },
  };
  out.schemes.lamport.verifyOnly = { runtime: run("lamport", randomBytes(32)) };
}

// Baselines: one secp256k1 check in Clarity, and a contract call that moves STX.
{
  const key = randomPrivateKey();
  const hash = randomBytes(32);
  const sig = signMessageHashRsv({ messageHash: hash.toString("hex"), privateKey: key });
  const r = t.call("baseline", "ecdsa", [Cl.buffer(hash), Cl.bufferFromHex(sig), Cl.bufferFromHex(privateKeyToPublic(key))]);
  out.baseline.ecdsaCheck = ok(r, "ecdsa");
  out.baseline.stxTransferCall = ok(t.call("baseline", "send", [Cl.uint(1000), Cl.principal(BOB)], ALICE), "send");
  const transfer = await makeUnsignedSTXTokenTransfer({ recipient: BOB, amount: 1000n, publicKey: privateKeyToPublic(key), network: "testnet", fee: 180n, nonce: 0n });
  out.baseline.stxTransferTxBytes = transfer.serializeBytes().length;
}

// --- report -------------------------------------------------------------------

const fmt = (n) => n.toLocaleString("en-US");
const pct = (n, of) => `${((100 * n) / of).toFixed(of === TENURE_BUDGET.runtime ? 3 : 2)}%`;
const W = out.schemes.wots, L = out.schemes.lamport, B = TENURE_BUDGET;
const perTenure = (c) => Math.floor(Math.min(B.runtime / c.runtime, B.readCount / c.readCount, B.readLength / c.readLength, B.writeCount / c.writeCount, B.writeLength / c.writeLength));
out.schemes.wots.perTenure = perTenure(W.withdrawStx.typical);
out.schemes.lamport.perTenure = perTenure(L.withdrawStx.typical);

const row = (label, f) => `| ${label} | ${f(W)} | ${f(L)} |`;
const md = `# Measured cost

Simnet, Epoch ${EPOCH}, Clarity ${CLARITY_VERSION}, measured ${out.measured} with \`npm run measure\`.
${W.samples} WOTS+ withdrawals and ${L.samples} Lamport withdrawals, each under its own one-time key. The keys come from a fixed secret, so the figures repeat.

## One STX withdrawal

| | WOTS+ | Lamport |
| --- | --- | --- |
${row("Signature, words", (s) => fmt(s.signatureWords))}
${row("Signature, bytes", (s) => fmt(s.signatureBytes))}
${row("Signature as a Clarity argument, bytes", (s) => fmt(s.signatureArgBytes))}
${row("Whole transaction, bytes", (s) => fmt(s.txBytes))}
${row("Runtime, typical", (s) => fmt(s.withdrawStx.typical.runtime))}
${row("Runtime, lowest to highest seen", (s) => `${fmt(s.withdrawStx.runtime.min)} to ${fmt(s.withdrawStx.runtime.max)}`)}
${row("Share of a tenure's runtime", (s) => pct(s.withdrawStx.typical.runtime, B.runtime))}
${row("Hashes in the signature check", (s) => `${s.withdrawStx.verifierHashes.min} to ${s.withdrawStx.verifierHashes.max}`)}
${row("Reads", (s) => `${s.withdrawStx.typical.readCount} (${fmt(s.withdrawStx.typical.readLength)} bytes)`)}
${row("Writes", (s) => `${s.withdrawStx.typical.writeCount} (${fmt(s.withdrawStx.typical.writeLength)} bytes)`)}
${row("Withdrawals per tenure, by Clarity cost alone", (s) => fmt(s.perTenure))}

## Other calls, runtime

| | WOTS+ | Lamport |
| --- | --- | --- |
${row("Open a vault", (s) => fmt(s.open.runtime))}
${row("Deposit STX", (s) => fmt(s.depositStx.runtime))}
${row("Deposit sBTC", (s) => fmt(s.depositSbtc.runtime))}
${row("Withdraw sBTC", (s) => fmt(s.withdrawSbtc.runtime))}
${row("Replayed request, refused on its nonce", (s) => fmt(s.replay.runtime))}
${row("Altered request, refused on its signature", (s) => fmt(s.tampered.runtime))}
| Verifier alone, least and most work | ${fmt(W.verifyOnly.leastWork.runtime)} (${W.verifyOnly.leastWork.hashes} hashes) and ${fmt(W.verifyOnly.mostWork.runtime)} (${W.verifyOnly.mostWork.hashes} hashes) | ${fmt(L.verifyOnly.runtime)} |

## Baselines

| | Runtime | Size |
| --- | --- | --- |
| One \`secp256k1-verify\` in Clarity | ${fmt(out.baseline.ecdsaCheck.runtime)} | 65-byte signature |
| A contract call that moves STX | ${fmt(out.baseline.stxTransferCall.runtime)} | |
| A plain STX transfer | | ${out.baseline.stxTransferTxBytes} bytes |

## Contracts

| Contract | Source, bytes | Deploy runtime |
| --- | --- | --- |
${Object.entries(out.contracts).map(([name, c]) => `| \`${name}\` | ${fmt(c.sourceBytes)} | ${fmt(c.deploy.runtime)} |`).join("\n")}

Tenure budget used for the shares: runtime ${fmt(B.runtime)}, ${fmt(B.readCount)} reads, ${fmt(B.readLength)} read bytes, ${fmt(B.writeCount)} writes, ${fmt(B.writeLength)} write bytes.
`;

mkdirSync("results", { recursive: true });
writeFileSync("results/costs.json", JSON.stringify(out, null, 1) + "\n");
writeFileSync("results/COSTS.md", md);
console.log(md);
