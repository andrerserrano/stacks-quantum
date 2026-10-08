# Review, 8 October 2026

An automated adversarial review read the first build of the contracts and the signing library and tried to break them with scripts on simnet. It found no forgery against a key that had signed once, and no mismatch between the JavaScript and Clarity verifiers over 266 digests. It found the flaws below. All are fixed. The exploit scripts were written against the first build and were not kept.

This is not a cryptographer's review. It is the reason to get one.

| # | Severity | Flaw in the first build | What it allowed | Fix | Covered by |
| --- | --- | --- | --- | --- | --- |
| 1 | High | The wallet derived one-time keys from the master secret, scheme, account and index only. Every vault opened from one master secret with the same account number shared keys | Each vault makes one honest signature, and together those are a reused key. With three such vaults the reviewer forged a withdrawal from a fourth in half a second, and with two in 46 seconds in a favourable case | The derivation now takes the chain and the vault contract as well. The contract refuses a second vault under the same key and verifier | `keys` tests; mutation "let a vault be opened twice" |
| 2 | Medium | Vault ids were a counter | An attacker opens first with the owner's key and a verifier that says yes, takes the id the owner expected and withdraws the deposit | A vault's id is the hash of its first key and its verifier | "a look-alike vault cannot take the id a depositor expects"; mutation "number vaults" |
| 3 | Low to medium | The verifier ran with the submitter as `tx-sender`. `restrict-assets?` stopped it moving assets and nothing else | A hostile verifier could act as the submitter in any contract that trusts `tx-sender`, which targets relayers | The verifier is called through `as-contract?` with no allowances, so it runs as the vault contract and can move none of its assets | `hostile verifiers` tests; mutation "run the verifier as the submitter" |
| 4 | Low | `spend` read the vault, called the verifier, then wrote the copy it had read | A verifier that deposited into the vault mid-withdrawal had its deposit erased from the vault's balance | The new state is written before the verifier runs. A refused signature fails the transaction and undoes the write | "a deposit made while a withdrawal is being checked is not lost"; mutation "write the vault's new state after the verifier runs" |
| 5 | Low | A request could name the current key as the next key, and the wallet would sign a payment to the vault contract itself, which can never succeed | Either leaves a signed-with key in place, so the next signature is a reuse | The contract refuses a next key equal to the current one. The library refuses to sign a payment to the vault | "a request that keeps the current key as the next key is refused"; "the wallet refuses to sign a payment to the vault contract" |

The review also corrected an estimate. The first version of the double-signing analysis put a WOTS+ forgery after two signatures at a median of 2^52 hashes. It had floored a term. Computed exactly, the median is about 2^61, and one case in ten is 2^36 or less. `analysis/double-sign.mjs` is the corrected version.

## Still true by design

- A wallet that signs two different requests for the same nonce, for example after a failed transaction or a restore with a request pending, exposes the vault to forgery.
- A signed request never expires. One that asks for more than the vault holds becomes payable when anyone tops the vault up.
- A wrong next key locks the vault. An empty vault cannot change its key, because a key changes only on a paid withdrawal.
- A verifier can cheat the vault that chose it.
- The chain id in the digest is not exercised, because simnet is one chain.
