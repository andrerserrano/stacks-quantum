# Measured cost

Simnet, Epoch 4.0, Clarity 6, measured 2026-10-08 with `npm run measure`.
300 WOTS+ withdrawals and 30 Lamport withdrawals, each under its own one-time key. The keys come from a fixed secret, so the figures repeat.

## One STX withdrawal

| | WOTS+ | Lamport |
| --- | --- | --- |
| Signature, words | 68 | 512 |
| Signature, bytes | 2,176 | 16,384 |
| Signature as a Clarity argument, bytes | 2,521 | 18,949 |
| Whole transaction, bytes | 2,841 | 19,272 |
| Runtime, typical | 1,226,367 | 1,059,981 |
| Runtime, lowest to highest seen | 1,100,921 to 1,351,889 | 1,059,981 to 1,059,981 |
| Share of a tenure's runtime | 0.025% | 0.021% |
| Hashes in the signature check | 405 to 615 | 256 to 256 |
| Reads | 9 (9,247 bytes) | 9 (8,110 bytes) |
| Writes | 2 (188 bytes) | 2 (191 bytes) |
| Withdrawals per tenure, by Clarity cost alone | 3,333 | 3,333 |

## Other calls, runtime

| | WOTS+ | Lamport |
| --- | --- | --- |
| Open a vault | 48,767 | 48,767 |
| Deposit STX | 12,807 | 12,808 |
| Deposit sBTC | 11,313 | 11,314 |
| Withdraw sBTC | 1,170,727 | 1,058,071 |
| Replayed request, refused on its nonce | 41,087 | 136,991 |
| Altered request, refused on its signature | 1,166,268 | 1,053,574 |
| Verifier alone, least and most work | 609,952 (45 hashes) and 1,740,714 (990 hashes) | 873,108 |

## Baselines

| | Runtime | Size |
| --- | --- | --- |
| One `secp256k1-verify` in Clarity | 767 | 65-byte signature |
| A contract call that moves STX | 5,334 | |
| A plain STX transfer | | 180 bytes |

## Contracts

| Contract | Source, bytes | Deploy runtime |
| --- | --- | --- |
| `pq-verifier-trait` | 504 | 28 |
| `wots` | 3,291 | 1,942 |
| `lamport` | 2,151 | 1,368 |
| `pq-vault` | 5,766 | 5,880 |

Tenure budget used for the shares: runtime 5,000,000,000, 30,000 reads, 200,000,000 read bytes, 15,000 writes, 15,000,000 write bytes.
