# Hash-based signatures on Stacks

Bitcoin and Stacks rely on signatures that a sufficiently powerful quantum computer could break. Preparing for that risk starts with testing alternative ways to authorize spending.

This experiment tests whether a Clarity contract can verify hash-based signatures for vault withdrawals without protocol changes. The goal is to give Engineering a working example, measured costs, and clear limitations to assess before choosing the next approach.

**Experimental proof of concept.** On 15 October 2026, a mainnet Lamport withdrawal paid 1,000 sats of official sBTC. All seven demo transactions succeeded; fees totaled 4.114578 STX. The mainnet vault is empty and retired operationally. No independent cryptographic audit or production readiness is claimed.

Start with the [mainnet result](mainnet/Mainnet-demo-result.md) and [engineering review guide](mainnet/README.md). The original testnet implementation and results remain below for comparison.

## Review the work

| Resource | Purpose |
| --- | --- |
| [Mainnet result and evidence](mainnet/Mainnet-demo-result.md) | Seven confirmed transactions, official sBTC payout, fees and final vault state. |
| [Mainnet source and tests](mainnet/README.md) | Exact executed candidate, reproducible local tests and review instructions. |
| [Mainnet proposal](mainnet/Mainnet-sBTC-Lamport-technical-proposal.md) | Scoped design, execution update and Lamport format appendix. |
| [PRD](https://docs.google.com/document/d/1gDLMFcaVvd-T91cFN9qYM4vl3W83feWAF22VHPndSnI/edit) | Research, pilot scope, and proposed next steps. |
| [Technical spec](https://docs.google.com/document/d/1wi2fEe-3VggqgEIJ24HKG12myg7DU-RYRIxp9HmYgic/edit) | Design, risks, and open questions. |
| [Demo](https://pq-vault-demo-l4qz6ho3t-andre-serranos-projects.vercel.app/) | Transactions and a live signature check. Protected preview; reviewers need access. |
| [Testnet results](vault/results/RUN.md) | All 22 transactions, explorer links, and measured costs. |
| [Review record](vault/REVIEW.md) | Issues found, fixes, and remaining risks. |

## How it works

1. A script signs the amount, recipient, and next key using Lamport or a custom WOTS+ variant.
2. Any Stacks account submits the request and pays the transaction fee.
3. The vault checks the signature, pays the signed recipient, and replaces its key.

The 9 October 2026 testnet run paid three withdrawals and refused six requests: missing or incorrect signatures, changed payment details, and replay. The attack cases used WOTS+; Lamport also had a successful withdrawal. Both schemes are covered by local tests.

| STX withdrawal | WOTS+ | Lamport |
| --- | ---: | ---: |
| Transaction size | 2,882 bytes | 19,313 bytes |
| Runtime | 1,209,004 units | 1,060,098 units |

The WOTS+ withdrawal used 0.024% of the runtime budget and 0.03% of allowed reads per tenure. These measurements do not establish production fees or throughput.

## Limits

- The vault tests withdrawal authorization. Stacks transaction signing, block approval, and sBTC’s Bitcoin reserve remain unchanged.
- The original testnet sBTC path uses a test token. The separate mainnet candidate completed one withdrawal using the official deployed sBTC token; broader integration and recovery remain unproven.
- Each key must sign only one distinct request. The signer records signatures to prevent reuse; restoring the secret without that record can lose the safeguard.
- The custom signature construction has not had independent cryptographic review. Wallet integration and recovery remain open.

Lamport and WOTS+ are comparison cases. Their size and key-management constraints are findings for Engineering to assess; the long-term design remains open.

## Run locally

Requires Node.js 20 or later. From the repository root:

```bash
cd vault
npm ci
npm test
npm run demo
```

The suite contains 105 tests. The demo runs in a local Stacks simulation and sends no testnet transactions. Use `npm run demo -- lamport` to compare Lamport.

To view the page, run this from the repository root with Python 3:

```bash
python3 -m http.server 4173 --directory site
```

Open [localhost:4173](http://localhost:4173/). The page displays recorded transactions and makes live read-only calls to testnet. It holds no secret keys and sends no transactions.

More detail: [vault instructions](vault/README.md), [site instructions](site/README.md), and [simulation costs](vault/results/COSTS.md).

## Questions for Engineering

- What is wrong or missing in the verifier, key rotation, and signing safeguards?
- Which approach should we test next, considering size, verification cost, and wallet usability?
- What should the next milestone demonstrate, and what cryptography review does it need?
