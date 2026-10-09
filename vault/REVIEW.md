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

That estimate holds for two requests the forger had no say in, and for a classical search. A review on 9 October showed it is far too kind when the forger can influence the second request. See below.

## Still true by design

- A wallet that signs two different requests for the same nonce exposes the vault to forgery. Since 9 October 2026 the signer keeps a journal of what each key has signed and refuses the second request, which covers a failed transaction. A wallet restored from its master secret without that journal, with a request still pending, is not covered.
- A signed request never expires. One that asks for more than the vault holds becomes payable when anyone tops the vault up.
- A wrong next key locks the vault. An empty vault cannot change its key, because a key changes only on a paid withdrawal.
- The contract keeps the current key only, so a request can name a retired key as the next one. A wallet that did so would sign with that key a second time. The reference wallet derives each key from the vault's nonce and never does. A test shows the contract accepting it.
- A verifier can cheat the vault that chose it.
- The chain id in the digest is not exercised, because simnet is one chain. Testnet, devnet and simnet all report the same id, so a request signed on one is valid on another deployment under the same addresses.
- The mock token lets anyone mint.
- The message hash carries no random salt, so a request chosen by an attacker to collide with another is stopped only by SHA-256's collision resistance.

# Two further reviews, 9 October 2026

Two automated reviews read the work added that day: one of the signer, the testnet script and the demo page, and one of the cryptography. Neither found a forgery against a key that has signed once, a flaw in either Clarity verifier, or a path in which the signer lets a key sign twice. They found the following, all acted on.

| # | Severity | Finding | What was done | Covered by |
| --- | --- | --- | --- | --- |
| 1 | High, within key reuse | The stated cost of a forgery after two WOTS+ signatures, about 2^61, assumed two unrelated requests. If the forger chooses the address it is paid at in the second, it is about 2^24 for any key. Confirmed by forging a withdrawal on simnet in seconds | The figures are corrected everywhere they appear. `analysis/forge-chosen.mjs` reproduces it | "if the attacker chooses what is signed second, any key falls in about 2^24 hashes" |
| 2 | Medium | The verifier was not in the key derivation. One owner's keys under two verifier contracts were identical, and the vault's one-vault-per-key check did not see it, because a vault's id covers its verifier | Any verifier other than the usual one is now written into the derivation path. Keys already in use are unchanged | "the same owner under another verifier gets other keys" |
| 3 | Medium | A mistyped option to `testnet.mjs withdraw` was dropped silently, so the command signed and sent a different request under a one-time key | The command line is read strictly and stops on anything it does not know | "a mistyped option stops the command before anything is signed" |
| 4 | Medium | A step could be sent twice if the node took a transaction and the reply was lost | Each step is one transaction, fixed by its nonce and recorded before it is sent. A live withdrawal with no recorded result is settled from the chain before anything new is signed | "a reply lost after the node took the transaction does not run the step twice", "a live withdrawal whose reply is lost..." |
| 5 | Medium | Results were found relative to the working directory. Run from elsewhere, the script would resend its first steps | Results sit beside the script. Keys that have sent transactions with no record are refused | "keys that have sent transactions and no record of them are not run again" |
| 6 | Medium | Every cost figure was for a classical search, and none said so | Stated where the figures appear. A quantum search roughly halves the exponents | |
| 7 | Low | The wallet would sign requests the contract can never pay: a wrong asset name, a zero amount, the vault's own address spelled with O for 0. The key was then claimed for nothing | The wallet refuses them before signing | "the wallet will not sign a request the contract can never pay" |
| 8 | Low | The journal did not sync its directory when a key was already claimed | Synced in both cases | |
| 9 | Low | Post-conditions allowed "at most" the amount, and the run did not check where the vaults ended | Exact amounts, and the end state is checked. The stand-in node now enforces post-conditions | "each post-condition names who may send, what and exactly how much" |
| 10 | Low | A transaction rolled back by a post-condition could be read as paid | The run stops on it | "a transaction rolled back by a post-condition is not taken for a payment" |
| 11 | Low | About ten statements on the demo page were inaccurate or claimed more than the run showed | Corrected. The page's sums are tested against the chain's final state, and `testnet.mjs report` checks each transfer against the chain | `test/site.test.mjs`, "the report reads the chain back..." |

Left as they are, with the reason:

- A step whose result on chain is not the expected one stops every later run. That is right: the chain's answer will not change. Anyone can cause it during a public run by submitting the owner's signed request first. The script now says what to move aside.
- `wallet()` keeps its journal in memory unless given one, and exposes each key's secret. The command-line signer always uses the journal on disk.

What the second review could not establish, and a cryptographer would need to:

- A reduction of this WOTS+ variant to properties of SHA-256, with its tightness and its bounds against attacks on many keys at once.
- The security of building the public key as a running hash.
- Quantum cost models beyond the square-root rule.
- Behaviour on real Epoch 4.0 nodes, as opposed to simnet, of `as-contract?` allowances and `slice?`. The testnet run is evidence for the paths it took.
- The mainnet sBTC token's other paths under a call with no allowances.
- Side channels and the handling of secrets in the JavaScript signer.
- The journal's durability across filesystems.
