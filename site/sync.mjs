// Build the page's data file, site/data/run.json, from the vault's results.
//
// It takes the testnet run, vault/results/run.json, if there is one, and the
// rehearsal otherwise, and adds the measured costs the page compares against.
//
// Run: node site/sync.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const results = new URL("../vault/results/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, results), "utf8"));

// Figures from `npm run measure`, for the cost comparison.
export function measured() {
  const costs = read("costs.json");
  const scheme = (s) => ({ signatureBytes: s.signatureBytes, txBytes: s.txBytes, runtime: s.withdrawStx.typical.runtime });
  return {
    on: costs.measured, budget: costs.budget, callRuntime: costs.baseline.stxTransferCall.runtime,
    transferBytes: costs.baseline.stxTransferTxBytes, wots: scheme(costs.schemes.wots), lamport: scheme(costs.schemes.lamport),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const source = existsSync(new URL("run.json", results)) ? "run.json" : "run.rehearsal.json";
  mkdirSync(new URL("data/", import.meta.url), { recursive: true });
  writeFileSync(new URL("data/run.json", import.meta.url), JSON.stringify({ ...read(source), measured: measured() }, null, 1) + "\n");
  console.log(`site/data/run.json written from vault/results/${source}`);
}
