# The testnet run

`testnet.mjs` ran on 2026-10-08 against Stacks testnet at Epoch 4.0. It deployed the five contracts at Clarity 6, opened a WOTS+ vault, funded it, and sent three withdrawals. `testnet-compare.mjs` then replayed the same requests on simnet, under the same deployer address and keys, to compare cost.

Deployer: `STYYMGK95AP90AM43C2PXKXD1RM1HWH3Y8X02AFS`, a throwaway key made for this run. Vault: `3fb94591fd63a6e503560279da332017bd685fe006e32de5a2f39afc3859ad57`.

## Results

| Step | Result on testnet | Runtime, testnet | Runtime, simnet | Difference | Bytes | Transaction |
| --- | --- | --- | --- | --- | --- | --- |
| Open the vault | `(ok 0x3fb94591fd63a6e503560279da332017bd685fe006e32de5a2f39afc3859ad57)` | 48,886 | 48,767 | +0.24% | 219 | [0x5bd5a4f1](https://explorer.hiro.so/txid/0x5bd5a4f1ead9fa823ade99bbb37782abf89cbc92f2e96be66c7cf6949de9232b?chain=testnet) |
| Deposit 5 STX | `(ok true)` | 12,926 | 12,807 | +0.93% | 248 | [0x2679f378](https://explorer.hiro.so/txid/0x2679f3789b9b93e5e095f0dd9bd4a4d8f0bca4e02288e727bffbad70a6795df6?chain=testnet) |
| Deposit mock sBTC | `(ok true)` | 11,449 | 11,313 | +1.20% | 286 | [0x382543ff](https://explorer.hiro.so/txid/0x382543ffa4739d5500f58b9075e1e484e3a5c65ca2e0379c8de15e632436b670?chain=testnet) |
| Withdrawal with the recipient changed | `(err u205)` | 1,328,119 | 1,327,572 | +0.04% | 2,882 | [0xc8028440](https://explorer.hiro.so/txid/0xc8028440b3e9ec69d0c118c77be0a0b9009cedffaa01b76879e948206379546a?chain=testnet) |
| The signed withdrawal of 1 STX | `(ok true)` | 1,226,990 | 1,226,443 | +0.04% | 2,882 | [0x04d2a697](https://explorer.hiro.so/txid/0x04d2a6979098c2ad488624d6be779f823e34426e9a535f282db9e88e5a7458b9?chain=testnet) |
| The same withdrawal again | `(err u203)` | 41,206 | 41,087 | +0.29% | 2,882 | [0xd1ed0b0b](https://explorer.hiro.so/txid/0xd1ed0b0b8cf3c97fca6942fe55a11ed3a142291c0e9786303585524aeda4c9c2?chain=testnet) |

The signed withdrawal paid 1 STX to `ST1541NT5PPDCA6VE5T15MA3W0MJMR9DW8ZFJNN79` and cost 1,226,990 runtime, 0.025% of a tenure's budget, with 9 reads and 2 writes. The vault ended at nonce 1 holding 4 STX.

`(err u205)` is a signature that does not match, and `(err u203)` is a nonce that was already used.

## Contracts

- `STYYMGK95AP90AM43C2PXKXD1RM1HWH3Y8X02AFS.pq-verifier-trait`, [deploy](https://explorer.hiro.so/txid/0x0b76d082810aa618e879be7b922b3db18489937c000155e780f14bef826c767c?chain=testnet)
- `STYYMGK95AP90AM43C2PXKXD1RM1HWH3Y8X02AFS.wots`, [deploy](https://explorer.hiro.so/txid/0xbabbeff24c8986dac1b4f87bf5969652f091444815f34c3ac1a018178f600d35?chain=testnet)
- `STYYMGK95AP90AM43C2PXKXD1RM1HWH3Y8X02AFS.lamport`, [deploy](https://explorer.hiro.so/txid/0xe4d2d54d2c341e7b2c49d2220bc7f76b2eafac3518adeac1c288731e8c220400?chain=testnet)
- `STYYMGK95AP90AM43C2PXKXD1RM1HWH3Y8X02AFS.sbtc-token`, [deploy](https://explorer.hiro.so/txid/0x0447a81ef2dc345beadb7bfb4ef404ccc80d62b468942ab38a4bb203858ee616?chain=testnet)
- `STYYMGK95AP90AM43C2PXKXD1RM1HWH3Y8X02AFS.pq-vault`, [deploy](https://explorer.hiro.so/txid/0xa6250e3711a77e39e3d4666004e1e8047140c3500ef64819c9d9a2f1f1282ae4?chain=testnet)

## What it does not show

- A second scheme. Only the WOTS+ verifier was exercised on testnet.
- Real sBTC. The token is a mock with the same transfer check as `sbtc-token`.
- A separate submitter. One key deployed, deposited and submitted every request. The withdrawal's recipient is a different address.
- Behaviour under load, or a realistic fee. Every transaction paid a fixed fee on a quiet network.
- A wallet, a relayer or a web page.

## The key

The key and the vault's master secret are in `~/.config/pq-vault/testnet.json`, outside the repository and readable only by its owner. They hold faucet STX and control the mock token and this one vault. Do not fund them on mainnet.

The vault's first key has signed its one request. Running `testnet.mjs` again signs nothing new.
