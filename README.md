# Lamport sBTC vault on Stacks mainnet

On 15 October 2026, a Clarity vault verified a Lamport one-time signature and released **1,000 sats of official mainnet sBTC** to the signed recipient. A separate Stacks account submitted the withdrawal and paid its fee.

The seven-transaction demonstration completed successfully with **4.114578 STX in total fees**. The vault is empty and retired operationally. Do not send it more funds.

[View the mainnet withdrawal](https://explorer.hiro.so/txid/0xb983fa37d30d5ece2c2d3d539885cf5d6f2394245a733d76820a6fa9ca6a5b97?chain=mainnet) or read the [full result](mainnet/Mainnet-demo-result.md).

## How it works

1. The operator opens the vault with a Lamport key commitment and deposits sBTC through its accounting function.
2. An off-chain signer authorizes the chain, contract, vault, nonce, asset, amount, recipient and successor key. It durably records the instruction before releasing the signature.
3. A separate account submits the signed instruction and pays the ordinary Stacks transaction fee.
4. The vault verifies the authorization, transfers sBTC, increments its nonce and installs the successor key atomically.

The submitting account cannot change the signed payment details. Each Lamport key authorizes only one distinct instruction; retries reuse the stored authorization. Lamport's simple verifier makes the spending rule easy to inspect, with a larger signature accepted for this single-withdrawal experiment.

## Mainnet result

| Measure | Observed result |
| --- | ---: |
| sBTC withdrawn | 1,000 sats |
| Successful transactions | 7 |
| Total transaction fees | 4.114578 STX |
| Withdrawal transaction size | 19,357 bytes |
| Withdrawal runtime | 1,062,385 units |
| Withdrawal reads / writes | 13 / 3 |
| Final vault balance / nonce | 0 sBTC / 1 |

These are measurements from the completed run, not guarantees of production fees or throughput. All seven transactions passed six canonical Stacks block confirmations; a later public recheck observed at least 238 confirmations.

## Source and evidence

| Resource | Contents |
| --- | --- |
| [Mainnet review guide](mainnet/README.md) | Exact execution snapshot, verification instructions and key handling. |
| [Deployed contracts](mainnet/snapshot/mainnet/contracts/) | Trait, Lamport verifier and vault bound to the official sBTC token. |
| [Technical proposal](mainnet/Mainnet-sBTC-Lamport-technical-proposal.md) | Design, execution update and scope. |
| [Lamport format](mainnet/Lamport-format-appendix.md) | Key derivation, commitment, pair ordering, digest bits and signature encoding. |
| [Execution evidence](mainnet/evidence/mainnet-execution.json) | Transaction links, canonical blocks, transfers, fees and final state. |
| [Engineering audit](mainnet/AUDIT.md) | Requirements, failure scenarios, tests and verification limits. |

Vault: `SP1BE4QPD9XK2A2TDJE7B40S00J9WZCW280ET3JBP.pq-vault`

Token: `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`

## Verify locally

Requires Node.js 20 or later. From the repository root:

```bash
node mainnet/verify-snapshot.mjs
npm ci --prefix vault
npm ci --prefix mainnet/snapshot/source/vault
npm test --prefix vault
node --test mainnet/snapshot/mainnet/*.test.mjs mainnet/test/*.test.mjs
```

All **304 tests** passed locally and in [CI on Linux and macOS](https://github.com/andrerserrano/stacks-quantum/actions/runs/38816128410). Coverage includes signature tampering, replay, verifier failures, token-transfer rollback, one-time-key persistence, crash recovery, concurrent execution, fee limits and corrupted evidence. Rejection cases run locally on simnet; the mainnet run demonstrates the successful payout.

After installing dependencies, independently recheck the public mainnet transactions and current vault state:

```bash
node mainnet/verify-mainnet.mjs
```

This verifier makes read-only requests and needs no wallet, private keys or operator state. It checks public transaction signatures, payloads, post-conditions, deployed sources, canonical blocks, events, costs and vault state against the recorded plan. Verification relies on a trusted RPC/indexer. Later account or vault activity can change current balances and state.

## Scope and limits

This is an experimental demonstration of hash-based withdrawal authorization. It does not change Stacks transaction signing, consensus or the security of sBTC's Bitcoin reserve, and it is not an sBTC redemption into native Bitcoin.

The implementation has no production cryptographic audit, wallet recovery or general-purpose wallet integration. The contract has no admin recovery or upgrade path. Retirement is operational: it does not disable deposits, and direct token transfers bypass the vault ledger. Keys must never authorize a second distinct instruction.

The original testnet implementation and recorded site remain under [`vault/`](vault/README.md) and [`site/`](site/README.md) as historical supporting work. Mainnet source, tests and evidence are under [`mainnet/`](mainnet/README.md).
