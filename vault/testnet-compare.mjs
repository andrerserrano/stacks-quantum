// Replay the first testnet run, of 8 October 2026, on simnet and compare what
// each charged. That run came from an earlier version of testnet.mjs, in
// which one key deployed, deposited and submitted.
//
// The contracts go under the same deployer address and the vault under the
// same keys, so every digest and signature is the one testnet saw. Reads that
// run's throwaway key file, ~/.config/pq-vault/testnet.json, and
// results/testnet.json.
//
// Run: node testnet-compare.mjs
// Writes results/TESTNET.md.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Cl, getAddressFromPrivateKey } from "@stacks/transactions";
import { boot, CHAIN_ID, TENURE_BUDGET } from "./src/simnet.mjs";
import { sigCV, wallet } from "./src/vault.mjs";

const keys = JSON.parse(readFileSync(join(homedir(), ".config", "pq-vault", "testnet.json"), "utf8"));
const run = JSON.parse(readFileSync("results/testnet.json", "utf8"));
const deployer = getAddressFromPrivateKey(keys.deployer, "testnet");
const recipient = getAddressFromPrivateKey(keys.recipient, "testnet");
if (deployer !== run.deployer) throw new Error("results/testnet.json belongs to another key");

const t = await boot({ deployer });
const owner = wallet({ master: Buffer.from(keys.master, "hex"), chainId: CHAIN_ID, vault: t.vault, verifier: t.id(run.scheme), scheme: run.scheme, account: 0 });
if (owner.id.toString("hex") !== run.vaultId) throw new Error("simnet gives the vault a different id");
const id = Cl.buffer(owner.id);
const verifier = Cl.contractPrincipal(deployer, run.scheme);
const cost = (r) => ({ result: Cl.prettyPrint(r.result), ...r.costs.total });

const sim = {};
sim.open = cost(t.call("pq-vault", "open", [Cl.buffer(owner.key(0)), verifier]));
sim["deposit STX"] = cost(t.call("pq-vault", "deposit-stx", [id, Cl.uint(5_000_000)]));
sim["mint mock sBTC"] = cost(t.call("sbtc-token", "mint", [Cl.uint(1_000_000), Cl.principal(deployer)]));
sim["deposit sBTC"] = cost(t.call("pq-vault", "deposit-sbtc", [id, Cl.uint(1_000_000)]));
const request = owner.signWithdrawal({ nonce: 0, asset: "stx", amount: 1_000_000, recipient });
const withdraw = (to) => cost(t.call("pq-vault", "withdraw-stx",
  [id, Cl.uint(0), Cl.uint(1_000_000), Cl.principal(to), Cl.buffer(request.nextKey), verifier, sigCV(request.sig)]));
sim.altered = withdraw(deployer);
sim.withdraw = withdraw(recipient);
sim.replay = withdraw(recipient);

const fmt = (n) => Number(n).toLocaleString("en-US");
const explorer = (txid) => `https://explorer.hiro.so/txid/${txid}?chain=testnet`;
const LABEL = { open: "Open the vault", "deposit STX": "Deposit 5 STX", "deposit sBTC": "Deposit mock sBTC",
                altered: "Withdrawal with the recipient changed", withdraw: "The signed withdrawal of 1 STX", replay: "The same withdrawal again" };
const rows = Object.keys(LABEL).map((name) => {
  const net = run.txs[name], s = sim[name];
  const diff = (100 * (net.cost.runtime - s.runtime)) / s.runtime;
  if (net.result !== s.result) throw new Error(`${name}: testnet ${net.result}, simnet ${s.result}`);
  return { name, net, s, diff };
});
const w = rows.find((r) => r.name === "withdraw");

const md = `# The testnet run

\`testnet.mjs\` ran on 2026-10-08 against Stacks testnet at Epoch 4.0. It deployed the five contracts at Clarity 6, opened a WOTS+ vault, funded it, and sent three withdrawals. \`testnet-compare.mjs\` then replayed the same requests on simnet, under the same deployer address and keys, to compare cost.

Deployer: \`${deployer}\`, a throwaway key made for this run. Vault: \`${run.vaultId}\`.

## Results

| Step | Result on testnet | Runtime, testnet | Runtime, simnet | Difference | Bytes | Transaction |
| --- | --- | --- | --- | --- | --- | --- |
${rows.map(({ name, net, s, diff }) => `| ${LABEL[name]} | \`${net.result}\` | ${fmt(net.cost.runtime)} | ${fmt(s.runtime)} | ${diff >= 0 ? "+" : ""}${diff.toFixed(2)}% | ${fmt(net.bytes)} | [${net.txid.slice(0, 10)}](${explorer(net.txid)}) |`).join("\n")}

The signed withdrawal paid 1 STX to \`${recipient}\` and cost ${fmt(w.net.cost.runtime)} runtime, ${((100 * w.net.cost.runtime) / TENURE_BUDGET.runtime).toFixed(3)}% of a tenure's budget, with ${w.net.cost.readCount} reads and ${w.net.cost.writeCount} writes. The vault ended at nonce ${run.vault.nonce} holding ${Number(run.vault.stx) / 1e6} STX.

\`(err u205)\` is a signature that does not match, and \`(err u203)\` is a nonce that was already used.

## Contracts

${["pq-verifier-trait", "wots", "lamport", "sbtc-token", "pq-vault"].map((c) => `- \`${deployer}.${c}\`, [deploy](${explorer(run.txs[`deploy ${c}`].txid)})`).join("\n")}

## What it does not show

- A second scheme. Only the WOTS+ verifier was exercised on testnet.
- Real sBTC. The token is a mock with the same transfer check as \`sbtc-token\`.
- A separate submitter. One key deployed, deposited and submitted every request. The withdrawal's recipient is a different address.
- Behaviour under load, or a realistic fee. Every transaction paid a fixed fee on a quiet network.
- A wallet, a relayer or a web page.

## The key

The key and the vault's master secret are in \`~/.config/pq-vault/testnet.json\`, outside the repository and readable only by its owner. They hold faucet STX and control the mock token and this one vault. Do not fund them on mainnet.

The vault's first key has signed its one request. Running \`testnet.mjs\` again signs nothing new.
`;
writeFileSync("results/TESTNET.md", md);
console.log(md);
