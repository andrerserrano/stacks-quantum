# Quantum pilot: what we built, what to say, and what not to

For the session with product and engineering, and for Marketing's first read. Drafted on 9 October 2026. Marketing has not reviewed the wording.

## In one sentence

A vault on Stacks testnet releases STX and sBTC only on a hash-based signature, checked by a Clarity contract, with no change to Stacks.

## The numbers

| | |
| --- | --- |
| Testnet run, 9 October 2026 | 22 transactions: 6 requests refused, 3 paid |
| A WOTS+ withdrawal | 2,882 bytes, 1,209,004 runtime |
| Share of a tenure | 0.024% of runtime, 0.030% of reads, which is the tighter limit |
| A Lamport withdrawal | 19,313 bytes, 1,060,098 runtime |
| Against simnet | Every contract call within 1.5% |
| Contracts | About 250 lines of Clarity, no admin and no upgrade path |
| Tests | 105, including working forgeries against a reused key |

## What we can say

- Withdrawals from the vault are authorized by hash-based signatures. No elliptic curves and no lattices are involved in that check.
- It runs on Stacks as it is today. Mainnet is on the same version as testnet.
- An attacker who holds the owner's Stacks account key cannot move the vault's funds. We showed this on testnet.
- It is a proof of concept on testnet, unaudited.

## What we cannot say

| Claim | Why not |
| --- | --- |
| "Quantum-safe Stacks" or "quantum-resistant Stacks" | Transactions, blocks and signers still use secp256k1 |
| "Quantum-safe sBTC" | The Bitcoin behind sBTC sits behind a Taproot key. The demo used a test token |
| "Secure" or "proven", unqualified | No cryptographer has reviewed it. A demo shows it works, a review shows it is safe |
| "The standard" | NIST's primary signature standard is lattice-based. Hash-based is the conservative branch |
| "Ready for mainnet" | The contracts cannot be patched, and a key that signs twice can be forged against |

## Questions from engineering

**Does it actually stop a quantum attacker?** It stops one from forging the owner's authorization for funds in a vault. It does not stop one who can forge the signatures that approve Stacks blocks, and it does nothing for the sBTC reserve.

**Why WOTS+ and not Lamport?** Same assumption, SHA-256 alone. WOTS+ is 7.5 times smaller for about the same compute, and XMSS and SLH-DSA are built from it. BitVM2 made the same move for size. The cost is that WOTS+ does not survive a second signature and Lamport nearly does. Lamport is in the contracts as a baseline and ran on testnet too, so the choice is open to Engineering.

**What happens if a key signs twice?** The vault can be forged against, and cheaply. If the attacker can influence the second request, for example by asking to be paid at an address it picked, a forgery costs about 2^24 hashes for any key: 15 seconds on a laptop in our test, and the vault pays it. If the two requests are unrelated it is about 2^61 for a typical key. These count ordinary hashing, and a quantum search would roughly halve the exponents. Lamport is far more forgiving, at about 2^90 under the same attack.

**So how do you stop that?** The contract retires a key on every paid withdrawal. The signer records each signature before it releases it and refuses a second, different request, across processes and restarts. What is not covered: a wallet restored from its master secret without that record, with a request still pending.

**What if a payment fails?** The same signed request can be sent again, and only that one. It cannot be cancelled or replaced.

**Who pays the fee?** Whoever submits, in STX, signed with an ordinary key. A user who holds only a vault needs someone to submit for them. A relayer or a fee inside the signed request is follow-on work.

**What about recovery?** None. A lost master secret is a lost vault.

**Is it standard?** The construction follows the one-time signature inside SLH-DSA (FIPS 205), with our own encoding. It matches no standard byte for byte, and one-time keys are approved by NIST only inside XMSS and LMS.

**What would mainnet take?** Mechanically about a day: one address for the real sBTC token. What should hold it back is review. An automated review found five flaws in the first build, one of them a forgery.

**What would a product take?** Keys that sign many times, a wallet that holds them with backup and recovery, a way to pay fees, and a way to do more than hold: pay another vault, use an app.

## Questions from product

**Who would use this first?** Custodians and treasuries holding STX in cold storage. They withdraw rarely and handle keys carefully, so one-time keys are tolerable.

**How does this fit the "fast to upgrade" message?** It is the evidence for it: a new signature scheme in a contract, on testnet within days, with no fork. The limit is that it covers one layer.

**What is next?** Engineering's read of the contracts, a size for the next phase, and a name for the cryptography review.
