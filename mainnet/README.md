# Mainnet Lamport sBTC demonstration

On 15 October 2026, one Lamport authorization withdrew **1,000 sats of official mainnet sBTC** to the signed recipient. All seven transactions succeeded and passed six canonical Stacks block confirmations. Total fees were **4.114578 STX** against the 20 STX cap.

The vault is empty and retired operationally. Do not fund it again. This is a completed, limited experiment; it does not establish production readiness or change Stacks transaction signing, consensus, or sBTC's Bitcoin reserve security.

## Review the result

| Resource | Purpose |
| --- | --- |
| [Result](Mainnet-demo-result.md) | Transaction links, measured costs and final state. |
| [Execution evidence](evidence/mainnet-execution.json) | Dated canonical blocks, transfer events, balances, fees and source hashes. |
| [Technical proposal](Mainnet-sBTC-Lamport-technical-proposal.md) | Design and completed execution update, including Leah's requested validation and format details. |
| [Lamport format](Lamport-format-appendix.md) | Commitment construction, pair ordering, digest bit order, lengths and derivation. |
| [Mainnet contracts](snapshot/mainnet/contracts/) | Exact deployed source; the vault's two token calls bind to the official sBTC principal. |
| [Vault diff](candidate/pq-vault.diff) | Changes from the original testnet vault: two token bindings and two comments. |
| [Sealed candidate](snapshot/mainnet/candidate/manifest.json) | Public accounts, parameters, contract source and tooling/library hashes. |
| [Simnet rejection evidence](evidence/integration-results.json) | Contract responses, unchanged state/balances and absent events for rejected requests. |
| [Engineering audit](AUDIT.md) | Plan coverage, added failure tests, public chain verification and remaining review limits. |

The withdrawal is [0xb983fa37d30d5ece2c2d3d539885cf5d6f2394245a733d76820a6fa9ca6a5b97](https://explorer.hiro.so/txid/0xb983fa37d30d5ece2c2d3d539885cf5d6f2394245a733d76820a6fa9ca6a5b97?chain=mainnet). The vault is `SP1BE4QPD9XK2A2TDJE7B40S00J9WZCW280ET3JBP.pq-vault`. The asset is `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token`.

Evidence describes the observation time in each file. Later account activity may change balances. The retirement is an operating decision; the deployed contract has no closure switch.

## Exact execution snapshot

`snapshot/mainnet/` preserves the executed scripts and contracts byte for byte. Its sibling `snapshot/source/vault/` preserves the signer libraries and dependency lock they imported. This layout retains the original relative imports without changing the executed tooling or its recorded hashes. The original testnet project remains in the repository's top-level `vault/`.

The candidate SHA-256 is `f20785dfe1a21e3f8098cfa2268352f5ed07ebf8074ebaa4dc0a161a831535b4`. Run `node mainnet/verify-snapshot.mjs` from the repository root to check the sealed source, tooling, signer libraries and token snapshots against the manifest, and reconcile the dated result evidence. This check uses no network or wallet.

After installing the snapshot dependencies, run `node mainnet/verify-mainnet.mjs` to independently read the seven public transactions, origin signatures, Lamport authorization, payloads, post-conditions, deployed sources, canonical blocks, events, costs, digest and current empty vault state. It has no signing or broadcast entry point and needs no wallet files. [Recorded responses](evidence/independent-mainnet-audit.json) support offline regression tests. They include public raw transactions and the completed Lamport authorization already visible on-chain. This is verification through a trusted RPC/indexer, not a trustless chain proof.

Historical comments such as "no deployment has occurred" are intentionally retained in the exact deployed source. The [runbook](Mainnet-execution-runbook.md) records the original operator environment and commands. The candidate generator and custody/execution entry points are archived for inspection, not instructions to initialize, reseal or repeat this completed run. The unsigned preparation plan and private local custody required by those entry points are not included.

`collect-evidence.mjs` is a separate post-execution read-only collector. It is not among the manifest's sealed execution files and requires the original operator's retained local execution state. Public report hashes and a count of journal claims are evidence from that collection, not a public copy of the private journal.

## Run the local tests

Requires Node.js 20 or later. From the repository root:

```bash
node mainnet/verify-snapshot.mjs
npm ci --prefix mainnet/snapshot/source/vault
node --test mainnet/snapshot/mainnet/*.test.mjs
node --test mainnet/test/*.test.mjs
```

The 48 candidate tests use synthetic secrets, mocked HTTP transport and local Clarity simulation. They neither read macOS Keychain nor send mainnet transactions. Four simnet tests cover 13 scenarios using the recorded official sBTC token/registry sources. They assert the vault itself rejects changed recipients, amounts and successor keys, invalid signatures and replay. A verifier's `(ok false)` and `(err u777)` both yield vault `(err u205)` with no balance, state or event effects. Failed token transfers also roll back key and nonce changes. Rejection cases were tested locally, not submitted on mainnet.

The integration suite writes a new, ignored report to `snapshot/mainnet/evidence/integration-results.json`. The dated report under `evidence/` remains the historical record. Archived [candidate](evidence/candidate-tests.tap) and [prototype](evidence/prototype-tests.tap) logs record 48 and 105 passing tests respectively. Run the original 105-test suite separately:

```bash
npm ci --prefix vault
npm test --prefix vault
```

The audit adds 151 tests for malformed inputs, crash windows, concurrent execution and journal claims, exact fee boundaries, Appendix A conformance, transport failures and corrupted evidence. Together with the original suites, 304 tests pass locally. [CI](../.github/workflows/quantum-tests.yml) runs the offline checks and all tests on Linux with Node 20/22 and macOS with Node 22; it never calls the live verifier or accesses custody.

## Review limits and key handling

Lamport keeps verification simple enough to inspect and explain. The larger signature was acceptable for this single-withdrawal demo. A key must authorize only one distinct digest. An exact retry may reuse the already stored authorization and transaction bytes; changing any signed field requires a fresh key and a newly reviewed plan.

The executor reserves the key in a durable journal before signing, persists authorization and transaction bytes before broadcast, waits for canonical prerequisites and caps total fees. The completed run's private claim and signing state must not be reset. Account private keys, the Lamport master and the operator's authorization/state files and private journal are excluded. Public transaction bytes contain the already published signature. Wallet recovery and safe repeated public use remain outside this demonstration.

The [native Google Doc](https://docs.google.com/document/d/1LEdjx977F4YUViitCvrQYp3R-gaVJXIM4FBQMlv0pY8) remains the proposal's source of truth. The Markdown here is the synced completion snapshot. Read the latest Doc before future proposal edits and reconcile both copies; do not overwrite Andre's changes from a stale Markdown copy.
