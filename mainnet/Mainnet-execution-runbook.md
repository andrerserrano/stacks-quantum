# Mainnet sBTC Lamport demo execution runbook

Completed 15 October 2026. All seven mainnet transactions succeeded and passed six canonical Stacks confirmations. One Lamport authorization paid 1,000 sats of official sBTC to the prepared recipient. Fees totaled 4.114578 STX against the 20 STX cap. The vault is empty, at nonce 1 under the planned successor, and retired operationally. No further funding is needed. See `Mainnet-demo-result.md` and `evidence/mainnet-execution.json`.

The executed candidate hash remains `f20785dfe1a21e3f8098cfa2268352f5ed07ebf8074ebaa4dc0a161a831535b4`. `candidate/Mainnet-candidate-review.md` and its ZIP are archived pre-execution review snapshots, not current funding requests.

Leah reviewed the spec and deployed testnet contract code and supported proceeding with the scoped experimental mainnet demo, in a message supplied by Andre on 15 October. She also offered a deeper look at the final mainnet candidate. Andre plans to deploy. The prepared recipient account receives the demo withdrawal; returning its small sBTC balance to Andre afterward is optional. See `../decisions/2026-10-15-leah-review-and-funding.md` for the supplied review and its scope.

## Prepared accounts and custody

| Role | Mainnet Stacks address | Purpose |
| --- | --- | --- |
| Operator | `SP1BE4QPD9XK2A2TDJE7B40S00J9WZCW280ET3JBP` | Receives initial sBTC and STX; deploys, opens and deposits; funds submitter |
| Submitter | `SP366BJPDWZ8GRF0J3S7TR5C6TDD2P9N6JG14PM4P` | Pays the ordinary Stacks transaction fee for the Lamport-authorized withdrawal |
| Recipient | `SPTXG7A1RB8VZ0GM9SAQEKWHHYZ95MCNMGSM75P6` | Receives the demo sBTC; optional return to Andre afterward |

These are fresh SDK-controlled accounts, not an existing Leather/Xverse session. Keychain storage and an address-derivation round trip were verified. The local agent can retrieve the keys through the helper for authorized transaction construction on this Mac; no extension connection or seed-phrase sharing is required.

Private keys and the independent Lamport master are in macOS Keychain, service `com.andre.stacks-quantum.mainnet-demo`, account `lamport-sbtc-8d9cd223-c299-482f-905c-20c6173bad0c`. The entry is accessible while this Mac is unlocked and is marked this-device-only. No portable backup or mnemonic has been created. Do not use these accounts for general savings.

The public manifest is `/Users/andre/.local/share/pq-vault/mainnet/accounts.public.json` (mode 0600, parent directory 0700). The compiled helper is under that directory's `bin/`. The signer journal is `/Users/andre/.local/share/pq-vault/mainnet/journal`; it contains the initial key's one durable claim. Retain it consistently with the signed execution state and stored authorization. Do not delete or reset these files.

## Funding plan

The operator received 1,000 base units = 0.00001000 sBTC and 20 STX. The official mainnet sBTC was deposited through `deposit-sbtc` and then withdrawn successfully to the prepared recipient. No further funding is required. Do not send new tokens directly to the retired vault; plain transfers bypass its deposit ledger.

The initial STX reserve was 20 STX. The execution candidate enforced a cumulative 20 STX fee cap; actual fees were 4.114578 STX. The operator transferred 2 STX of the reserve to the submitter; that principal was not an additional fee. Exact-byte rebroadcasts count once and no additional replacement transactions were needed. Incoming funding fees were paid separately by the sending wallet. Unused STX remains in the dedicated operator and submitter accounts; returning the small sBTC balance to another Andre-controlled address remains optional.

A read-only quote refresh at 2026-10-15 16:39 ET put the three deployments at 1.560867 STX combined at low priority; medium-priority estimates exceeded 20 STX. That snapshot and the initial preflight are historical. During execution, excessive quotes stopped vault-deployment signing until a lower quote fit the remaining sequence. The actual transaction fees in `evidence/mainnet-execution.json` supersede planning estimates.

The fee API can return `NoEstimateAvailable` for a contract function until the node has seen that function called, including after deployment. The sealed candidate therefore specifies explicit first-call bids: 0.25 STX for `open`, 0.5 STX for `deposit-sbtc`, and 1.5 STX for `withdraw-sbtc`. These are deliberate fee bids, not live estimates or confirmation guarantees. They apply only to that specific API response. Other API failures stop execution. When a live estimate exists, the executor uses its low-priority value and checks the cumulative cap again. If pricing or the 2 STX submitter reserve is insufficient, stop; no automatic fee increase or replacement occurs. See the [Stacks RPC fee documentation](https://docs.stacks.co/reference/api).

Before the first signature, preflight checks all seven fees or explicit bids, the whole 20 STX funded reserve, mainnet ID, token source hashes, account nonces and contract-name availability. Each later step refreshes its fee and checks actual available funds before signing.

## Transaction sequence

| Order | Sender | Operation | What must be verified before advancing |
| --- | --- | --- | --- |
| 1 | Operator | Deploy `pq-verifier-trait` | Canonical success; deployed source matches reviewed hash |
| 2 | Operator | Deploy `lamport` | Canonical success; verifier source matches reviewed hash |
| 3 | Operator | Deploy `pq-vault` | Canonical success; fixed official token and source hash match |
| 4 | Operator | `pq-vault.open` | ID, Lamport verifier, initial commitment and nonce 0 match plan |
| 5 | Operator | `pq-vault.deposit-sbtc` for 1,000 sats | Ledger and available sBTC balance both increase by 1,000; exact token post-condition |
| 6 | Operator | STX transfer to submitter | Confirmed balance covers the approved withdrawal fee |
| 7 | Submitter | `pq-vault.withdraw-sbtc` | Approved recipient receives 1,000 sats; vault ledger drains, nonce becomes 1 and key becomes planned successor |

The showcased transaction is step 7. There are seven planned transactions after initial external funding. The incoming funding transfers are additional. No mock minting, bridge deposit or native Bitcoin redemption is involved.

Ordinary account nonces are separate from the vault's nonce. The initial snapshot has operator and submitter at their next available nonce, and the six operator transactions are ordered accordingly. Recheck for incoming/outgoing activity and mempool conflicts before final construction. Incoming funding alone does not consume these accounts' outgoing nonces.

The six unsigned files in `prepared/` are historical planning samples, with stale fees. Do not sign or broadcast them. Execution builds fresh transactions from `candidate/manifest.json`, using its pinned nonces, source, amount, recipient, public commitments and fee policy. The old withdrawal sample contains a dummy signature for sizing only and has no withdrawal wire file.

`execute.mjs advance --candidate-sha256 HASH` signs and submits at most one new transaction per invocation. The next invocation first rechecks every predecessor's canonical status. Each step must reach six canonical Stacks block confirmations before another is signed. These are Stacks blocks, not six Bitcoin confirmations. The final check independently verifies token events, recipient balance, drained ledger, nonce 1 and successor commitment.

## Execution record

1. Prepared the exact contract diff, source/tooling hashes, Lamport format, token bindings, journal/error behavior and execution policy for review. Leah supported the scoped approach after reviewing the spec and testnet code; this does not claim she reviewed every new executor line. The unused STX interfaces were retained.
2. Fixed the account roles, local custody, 20 STX cumulative cap, explicit first-call bids, six-block confirmation policy, 1,000-sat amount and prepared recipient in the executed manifest.
3. Verified custody/public commitments and source pins. All 105 prototype and 48 candidate tests passed; the extracted review ZIP independently passed its 48 tests after fresh dependency installation.
4. Received 20 STX and 1,000 sats of official mainnet sBTC at the operator, checking available balances before any deployment fee was signed.
5. Deployed the trait, Lamport verifier and vault in order, comparing fetched deployed sources with the manifest hashes. Opened the expected vault and deposited exactly 1,000 sats. Each predecessor passed six canonical Stacks confirmations before the next transaction was signed.
6. Funded the separate submitter, read the deployed `withdrawal-digest`, and matched the chain-ID-1 digest, amount, recipient, nonce, key and ledger before signing.
7. Persisted the initial key's journal claim, exact authorization and signed carrying transaction before broadcast. Submitted one Lamport-authorized withdrawal. No different message was signed under that key.
8. Verified all seven canonical successes, exact official-token events, recipient increase, drained ledger/token balance, nonce 1 and successor commitment. Retired the vault operationally and retained private state. Returning the small recipient balance or unused STX to another Andre-controlled address is optional and separate from demo completion.

## Failure handling

- If a broadcast response is lost, query the locally calculated transaction ID and nonce. Do not generate a second withdrawal authorization.
- If a carrying transaction is pending or dropped, reconcile chain and mempool state. Rebroadcast the same signed bytes when appropriate. A fee replacement must preserve the Lamport instruction and respect the agreed cap.
- If a token transfer, signature check or post-condition aborts, verify that no ledger or key change committed. The fee may still have been spent. Correct the outer transaction or environmental condition without signing a different message with the same key.
- If journal/secret state is inconsistent or the on-chain digest differs, stop. Do not reset state or select another recipient under the same key.
- If a chain reorganization changes confirmation status, reconcile the pinned transaction and vault state before repeating any step. The prior signing claim is retained even if a transaction becomes non-canonical.
- A successful vault withdrawal signature is not a general cancellation/recovery mechanism. Keep balances small and avoid deposits after completion.

Execution state is private under `/Users/andre/.local/share/pq-vault/mainnet/execution/`. `execution.json` contains the signed bytes and IDs; `authorization.json` contains the exact Lamport authorization. The canonical mainnet journal remains `/Users/andre/.local/share/pq-vault/mainnet/journal/`. Keep these together. Missing or inconsistent state stops execution; the executor does not create a new signing history to recover an old run. A stale `executor.lock` requires checking its recorded process before any manual removal. Never delete the state, marker, authorization or journal to clear an error.

## Reproducing preparation and checks

Run from `/Users/andre/Documents/ChatGPT/Stacks-quantum`:

```sh
node review/mainnet/accounts.mjs public
node --test review/mainnet/*.test.mjs
node review/mainnet/execute.mjs status
node review/mainnet/collect-evidence.mjs
```

The commands above do not sign or broadcast. `collect-evidence.mjs` also disables broadcasting and private-key access explicitly. `verify-candidate.mjs` can separately check local custody without signing, but now reports the real authorization and journal claim as present. `preflight` was used only before execution began; use `status` for this completed run. Tests use synthetic keys and require neither the local custody manifest nor Keychain. Reviewers can install the pinned dependencies with `npm ci` in `review/source/vault` and run all candidate tests from the bundle root.

The exact live command used was:

```sh
node review/mainnet/execute.mjs advance --candidate-sha256 f20785dfe1a21e3f8098cfa2268352f5ed07ebf8074ebaa4dc0a161a831535b4
```

That command is the only live signing/broadcast entry point. The retained seven-record state now makes it revalidate completion rather than create another transaction. Never delete state to repeat the demo. `prepare.mjs` and `prepared/` remain historical preparation; resealing changes the review hash and is not part of this completed run. Evidence records balances at its verification time; later legitimate recipient transfers would need separate historical analysis.

The integration tests use synthetic public fixture secrets, not the mainnet Keychain master. The SDK runs at Epoch 4.0 with its simnet chain ID even though token/account addresses are mainnet-formatted. The local token and registry source are checked against mainnet snapshots. This is a transfer-semantics rehearsal, not a live-network withdrawal.

## Current validation

- Original prototype suite: 105 tests passed on 15 October.
- Mainnet-token integration: 4 tests passed, covering 13 scenarios recorded with source hashes and exact rejection responses in `evidence/integration-results.json`.
- Execution candidate: 35 synthetic-key executor tests and 9 mocked HTTP transport tests pass, including all seven signed transaction shapes, first-call fees, budget enforcement, uncertain replies, nonce conflicts, missing state, reorgs and false payout evidence. These are local tests, not mined mainnet transactions. Full results are in `evidence/candidate-tests.tap`.
- Direct Clarity calls reject a changed Lamport recipient or successor with `(err u205)` and completed-withdrawal replay with `(err u203)`. Test verifiers pinned at vault creation returning `(ok false)` or `(err u777)` each produce vault `(err u205)`. These checks use no transaction post-conditions and require unchanged vault state and sBTC balances, with no emitted events.
- Mainnet node reports network ID 1 and active Epoch 4.0; candidate uses Clarity 6.
- Token source/ABI and registry source were fetched from the mainnet API; ordinary token transfer allows the vault as `contract-caller`.
- Dedicated keys were stored/retrieved from Keychain and public addresses verified. The account balance snapshot is in `prepared/plan.json`.
- Mainnet execution completed with seven canonical successes, a 1,000-sat sBTC payout, 4.114578 STX in fees, drained vault, nonce 1 and the intended successor. The initial one-time key has one retained journal claim. Portable key recovery and production use remain outside this local experimental setup.
