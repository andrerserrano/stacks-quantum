# Mainnet demonstration: engineering audit

Audited 15 October 2026 against sections 2-6 and Appendix A of the [technical proposal](Mainnet-sBTC-Lamport-technical-proposal.md), the [execution runbook](Mainnet-execution-runbook.md), the frozen executed source and the public mainnet transactions.

The scoped one-withdrawal demonstration is implemented and its on-chain result independently rechecked. The audit closed gaps in the public evidence checker, reproducible review tooling and failure-case coverage. **304 tests pass locally: 105 original, 48 frozen candidate and 151 added audit tests.** No deployed contract, sealed execution file, signing key, journal or live transaction was changed.

This is not a claim that every possible input, operating-system failure or adversary has been proved safe. Leah's approval of the approach after reviewing the spec and deployed testnet code is recorded; completion of her deeper final-mainnet-candidate review is **unverified**. That human review remains open. Production cryptographic review, portable recovery and repeated public use remain outside the approved demo scope.

## Rollout phases

| Proposal phase | Implementation and evidence | Status |
| --- | --- | --- |
| 1. Review the sealed candidate | Exact contracts, signer/tooling pins, format, tests and execution policy are available in the [snapshot](snapshot/mainnet/candidate/manifest.json). Public verifier checks deployed bytes against it. | Review packet complete; deeper human candidate review unverified. |
| 2. Fund the operator | Historical operator funding checks preceded deployment signing. Local tests refuse insufficient STX/sBTC before custody access. Seven mainnet receipts and official-token deposit/withdrawal events confirm the funded flow ran. | Completed for the demo. |
| 3. Deploy and verify three contracts | Three canonical deployment receipts; raw deployment payloads and fetched contract sources match the sealed candidate. | Independently rechecked. |
| 4. Open and fund the vault; fund submitter | Open binds the expected commitment/verifier/ID. Official-token deposit moves 1,000 sats. Separate submitter receives 2 STX. Raw payloads, exact post-conditions and transfer/contract events agree. | Independently rechecked. |
| 5. Sign and submit one withdrawal | Public raw transaction carries a valid Lamport authorization for the mainnet digest. Ordinary origin signature, distinct submitter, all signed fields and deny-mode exact-asset post-condition match the plan. | Independently rechecked. |
| 6. Verify, publish and retire | All seven canonical successes; 1,000-sat payout; 4.114578 STX fees; vault ledger/token balance zero, nonce 1 and successor installed. Private state/claim retained. Result and review artifacts are in PR #2. | Completed; PR remains unmerged. |

The public recheck at **2026-10-15T22:13:56.428Z** observed at least **238 canonical Stacks confirmations**. It verified every transaction's origin signature, ID, exact payload, fee, account nonce, post-condition, block, result, transfer/contract events and measured costs. It also re-read the deployed digest, final vault state and available token balance. See [full observations and results](evidence/independent-mainnet-audit.json). Later transactions can change current state or balances; a future mismatch must be investigated rather than overriding the historical record.

## Requirements and failure scenarios

| Requirement or risk | Evidence |
| --- | --- |
| Exact deployed code and official asset | [Offline checker](verify-snapshot.mjs) pins the candidate and dated execution evidence; [public verifier](verify-mainnet.mjs) compares deployed sources and public raw transaction payloads. No WOTS/mock token is deployed in the mainnet sequence. |
| Chain, contract, vault, nonce, asset, amount, recipient and successor are bound | Original digest/contract tests plus [official-token edge tests](test/clarity-edges.test.mjs). Wrong-chain, wrong-contract and wrong-asset signatures return vault `(err u205)`; wrong nonce returns `(err u203)`. |
| Contract rejection, not script or post-condition failure | Frozen real-token integration tests call Clarity directly, require exact errors, unchanged ledger/key/nonce and balances, and no events. Changed recipient/amount/successor, invalid signatures, replay, verifier `(ok false)` and `(err u777)` are included. |
| Malformed signatures and type boundaries | Official-token tests cover 0/1/255/256/511/513/1024 words; zero/short words at both ends of each half; short successor; zero/excess/max-uint amounts; missing vault; duplicate open; wrong verifier. Above-ABI inputs fail type checking, a separate expected outcome. |
| Appendix A can reconstruct the verifier | Independent HMAC/SHA-256 calculation matches the published seed, commitment and signature hash, JS signer and exact Clarity verifier. Clarity rejects all 256 single-bit digest changes, reversed bit order, interleaving, reversed pair order and a wrong fold starting value. |
| One distinct digest per key, including restarts/concurrency | Persistent journal tests, eight competing processes with exactly one winning digest, different-digest refusal and corrupt-claim refusal. Same-digest recovery is tested after the claim and after authorization persistence. |
| Crash windows and uncertain replies | [Executor audit tests](test/executor-edges.test.mjs) cover persisted claim without authorization, authorization without carrier transaction, ordinary-key failure after Lamport persistence, lost withdrawal reply after acceptance and wrong broadcast IDs. Frozen tests cover lost acceptance, dropped requests, missing files and exact-byte retries. |
| Single writer and private state | Concurrent executors cannot both acquire the lock. Private directory/file permissions and retained state/authorization/claim hashes were rechecked locally without retrieving private keys. Private journal/state files are excluded from GitHub. |
| Fee cap and funding | Quotes missing, invalid, excessive or insufficient for either account stop unsigned execution. Exact 20 STX cumulative boundary succeeds. First-call bids apply only to `NoEstimateAvailable`; other provider errors cannot enable them. Real fees are independently summed from all seven receipts. |
| Pending, failure, reorg and false evidence | Insufficient confirmations, failed/post-condition-aborted receipts, nonce conflicts, changed block hashes, noncanonical/unanchored transactions, wrong/missing/extra events, wrong asset/recipient, misleading result data, changed costs and changed final state are rejected. A reorg during public collection fails its final block recheck. |
| Network failures | Frozen and public transport tests cover throttling, bounded cooldowns, timeouts, unavailable/malformed responses, inconsistent account views and incomplete event pages. Public verification allows only named GET and read-only Clarity endpoints; it exposes no broadcast method. |
| Publication and reproduction | GitHub review guide, current completion snapshot, exact source/library pins, public observations and tests. CI installs dependencies from committed locks and runs the full offline suites. Native Doc revision was read again and still matches the local sync record and Markdown hash. |

## Gaps closed by this audit

1. The first checker established local consistency but relied on the private-state collector for chain validation. Added a wallet-free public verifier and recorded the actual provider responses for offline replay.
2. The first checker did not independently pin the historical evidence or fully validate account nonces, setup transfers, confirmation spacing and completion assertions. Added those checks and mutation tests, including rewriting both the evidence and its local audit hash.
3. Added explicit tests for crash windows, concurrent processes, malformed real-token calls, the published format vector and its byte/bit boundaries, fee boundaries and misleading RPC evidence. All are exercised against frozen executed code or the new read-only review tooling.
4. Added CI with read-only repository permissions and pinned official actions. Linux/Node 20, Linux/Node 22 and macOS/Node 22 execute the same offline tests; live RPC reads stay an explicit operator command.

## Reproduce

From the repository root:

```sh
node mainnet/verify-snapshot.mjs
npm ci --prefix vault
npm ci --prefix mainnet/snapshot/source/vault
npm test --prefix vault
node --test mainnet/snapshot/mainnet/*.test.mjs mainnet/test/*.test.mjs
node mainnet/verify-mainnet.mjs
```

The final command performs read-only network requests. The others require no real wallet, Keychain access or live chain. Network outages cause the public verifier to fail rather than certify a result. The recorded-response tests remain runnable offline after dependency installation.

The [audit test log](evidence/audit-tests.tap) records 199 passing mainnet/candidate/audit tests. The original suite also passed all 105 tests during this audit. V8 reports **100% line / 98.33% branch coverage for the frozen executor**. Coverage describes exercised code, not a proof of security. The archived original logs remain historical evidence and are not overwritten with later runs.

## Limits that remain explicit

- Deeper human review of the final candidate is unverified; this audit cannot substitute for Leah's review or a cryptographic security assessment.
- Retirement is operational. Tests confirm the contract can still receive deposits; direct transfers bypass its ledger. The demo is finished and must not be funded again.
- The contract does not maintain a global retired-key registry, provide expiry/cancellation, or offer admin recovery/upgrades. The approved one-withdrawal flow does not require those features.
- Missing or conflicting signing state, mined failures, unresolved nonce conflicts and reorgs stop for manual investigation. Automatic recovery or fee replacement is not implemented or claimed.
- RPC/indexer responses are trusted observations. This verifier is not a light client or a trustless inclusion/finality proof. Public data also cannot prove that a secret was never used in an unpublished signature; retained private state, reviewed signing logic and tests provide the operational evidence.
- Disk/power failures, hostile local software, memory compromise and all future network behaviors have not been exhaustively modeled. Recovery custody, public repeated use and production deployment require additional design and review.
