# The demo run on testnet

`node testnet.mjs --send` ran on 2026-10-09 against Stacks testnet at Epoch 4.0, Clarity 6. `node testnet.mjs report` then ran the same steps on simnet under the same keys, to compare cost, and wrote this file.

Four throwaway accounts took part. None of them can move a vault's funds.

| Account | Address |
| --- | --- |
| deployer | `ST2MRQ993WBQQ82GVY7YQQMMH1GYKSG885Z79ZKFS` |
| owner | `STJTAB5C570DC2FWH6H277TQ7AVECT56DFB568PQ` |
| submitter | `ST2HK55AFYG2VZVWVN3PWQEEK72P9GC9V8NBC7JZ9` |
| recipient | `ST150DEB975GQEWM1CWBKNGY95CK5V9J01VT5N77W` |

## Steps

| Step | Sent by | Result | Runtime, testnet | Runtime, simnet | Difference | Bytes | Transaction |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Deploy pq-verifier-trait | deployer | `(ok true)` | 26,720 |  |  | 643 | [0xb5d1135f](https://explorer.hiro.so/txid/0xb5d1135fd18d99f4b1c58cc67134d8205e58bfff9e1abc97f2d231c6a383c328?chain=testnet) |
| Deploy wots | deployer | `(ok true)` | 177,143 |  |  | 3,417 | [0x54e74c6f](https://explorer.hiro.so/txid/0x54e74c6f834c5d598858055dd067d411e232f6c279e6e575c90e9c3eec949c17?chain=testnet) |
| Deploy lamport | deployer | `(ok true)` | 116,918 |  |  | 2,280 | [0xeecd3f89](https://explorer.hiro.so/txid/0xeecd3f896805aa40e6a0364ebed9d6399b21c5011f763ce9956a349cc4a6cbc7?chain=testnet) |
| Deploy sbtc-token | deployer | `(ok true)` | 46,574 |  |  | 969 | [0x62706fa5](https://explorer.hiro.so/txid/0x62706fa5b4f46134c66a24f1c05cfad6cd25782f2175b95ac8deed8638783e86?chain=testnet) |
| Deploy pq-vault | deployer | `(ok true)` | 360,634 |  |  | 5,896 | [0x64537677](https://explorer.hiro.so/txid/0x64537677ca6f9f17d3aac5ad5c8805529deb346b71b6dee9a55da1d60118d7ee?chain=testnet) |
| Fund the owner's account | deployer | `(ok true)` |  |  |  | 180 | [0xf35e9d94](https://explorer.hiro.so/txid/0xf35e9d94f70550c2f59deb6711cebc12b599ab6a99de9eb357bc62e96f8c8767?chain=testnet) |
| Fund the submitter's account | deployer | `(ok true)` |  |  |  | 180 | [0xe45ca972](https://explorer.hiro.so/txid/0xe45ca972a3d3bc52b0bee5fe615e694c4ee2d8035d875b41ac36bc16f24145f5?chain=testnet) |
| Mint mock sBTC to the owner | deployer | `(ok true)` | 2,826 | 2,809 | +0.61% | 196 | [0x90e67300](https://explorer.hiro.so/txid/0x90e673000c5c1deb139d45bd285f5a5d7977fd847fb3d5381445e5e97ddeb4f7?chain=testnet) |
| Open a vault under a WOTS+ key | owner | `(ok 0x8da32012bd0a69b787cd8f5a6d198c99225577e9f7f9ac28a12063188b086a3d)` | 48,886 | 48,767 | +0.24% | 219 | [0x539242a6](https://explorer.hiro.so/txid/0x539242a65171183185e4592afdf244cfc68c49fffefb15d739bb8cdadf85d87d?chain=testnet) |
| Deposit 5 STX | owner | `(ok true)` | 12,926 | 12,807 | +0.93% | 248 | [0x93c71060](https://explorer.hiro.so/txid/0x93c71060b438e07a2207aabf3e4a4c30b960dadc93eea7ebc08b290bc77cd5fe?chain=testnet) |
| Deposit 0.01 mock sBTC | owner | `(ok true)` | 11,449 | 11,313 | +1.20% | 286 | [0xd3ca3e78](https://explorer.hiro.so/txid/0xd3ca3e7812c3bcb433028f967ab2eaa77d4ac56c9a94c1372e9e415f989a4d67?chain=testnet) |
| Withdraw everything with no signature, from the owner's own account | owner | `(err u205)` | 37,786 | 37,239 | +1.47% | 366 | [0xb2ec082b](https://explorer.hiro.so/txid/0xb2ec082b97c0cd5bae05bac821ac01d3e7335bb5eedd3768d87ef50e7fdf2c48?chain=testnet) |
| The same, signed with a one-time key of the attacker's own | owner | `(err u205)` | 1,148,829 | 1,148,282 | +0.05% | 2,882 | [0xe63eecb6](https://explorer.hiro.so/txid/0xe63eecb6595317e146a27ae83dac034e5d6f4507bb4076c5a5af635a0ef2a2fa?chain=testnet) |
| The owner's signed request with the recipient changed | submitter | `(err u205)` | 1,274,313 | 1,273,766 | +0.04% | 2,882 | [0xe0d10de6](https://explorer.hiro.so/txid/0xe0d10de68174667b32741d17cf514f173944a7663833d79fc5784a1cb7ef4d31?chain=testnet) |
| The signed request with the amount raised to 5 STX | submitter | `(err u205)` | 1,220,545 | 1,219,998 | +0.04% | 2,882 | [0x92e288de](https://explorer.hiro.so/txid/0x92e288def9ed21589407398d8a0dbf1d988008b2d82bd83b5e7e4a8c819d06cb?chain=testnet) |
| The signed request with the next key swapped | submitter | `(err u205)` | 1,184,877 | 1,184,330 | +0.05% | 2,882 | [0xc8b36889](https://explorer.hiro.so/txid/0xc8b36889a35b04dc14952e8081e4013298c26bc1f352f017f18621de6f02f98c?chain=testnet) |
| The request as signed: 1 STX to the recipient | submitter | `(ok true)` | 1,209,004 | 1,208,457 | +0.05% | 2,882 | [0x817edc8e](https://explorer.hiro.so/txid/0x817edc8eb04687124a3bd9c75430eaad7c741e0ded64947fcefef41e6ff21acd?chain=testnet) |
| The same request again | submitter | `(err u203)` | 41,206 | 41,087 | +0.29% | 2,882 | [0x0cb16321](https://explorer.hiro.so/txid/0x0cb16321b1345e3001c18079a74b2d9b81bec1103cd53a365ab5a8284ce23b1f?chain=testnet) |
| A second withdrawal under the next key: 0.005 mock sBTC | submitter | `(ok true)` | 1,278,865 | 1,278,301 | +0.04% | 2,920 | [0xbffe298d](https://explorer.hiro.so/txid/0xbffe298de323c10f475510bcf7bb2eab6f38a99b7529356c904368b2a8da0587?chain=testnet) |
| Open a vault under a Lamport key | owner | `(ok 0x0e26261d6e01cc813471af825043c92c81958c601d1d6df0cb51817f628babd2)` | 48,886 | 48,767 | +0.24% | 222 | [0x0063c373](https://explorer.hiro.so/txid/0x0063c3735fed15ed199a6af2835a41eabafaaf948dfb7b91a7410dbd81936b3d?chain=testnet) |
| Deposit 2 STX | owner | `(ok true)` | 12,927 | 12,808 | +0.93% | 248 | [0x3e4743db](https://explorer.hiro.so/txid/0x3e4743dbf82f17484707d427180fc71940fa709733733dbd25bd6fe3dda30cc2?chain=testnet) |
| The same withdrawal with a Lamport signature: 1 STX to the recipient | submitter | `(ok true)` | 1,060,098 | 1,059,981 | +0.01% | 19,313 | [0x7234c2dc](https://explorer.hiro.so/txid/0x7234c2dc24074861dc63b48e2262cf8f028282d8d8646e4a2fe35b7988364b5c?chain=testnet) |

`(err u205)` is a signature that does not match, and `(err u203)` is a nonce that was already used.

Simnet does not charge the analysis of a new contract, so deployments have no simnet figure.

A WOTS+ withdrawal cost 1,209,004 runtime, 0.024% of a tenure's budget, in 2,882 bytes. A Lamport withdrawal cost 1,060,098 runtime, 0.021%, in 19,313 bytes.

## Vaults at the end of the run

- wots: `8da32012bd0a69b787cd8f5a6d198c99225577e9f7f9ac28a12063188b086a3d`, at nonce 2, holding 4 STX and 0.005 mock sBTC
- lamport: `0e26261d6e01cc813471af825043c92c81958c601d1d6df0cb51817f628babd2`, at nonce 1, holding 1 STX and 0 mock sBTC

## Checked against the chain

When this file was written, two things were read back from testnet. The source held for each contract is the source in `contracts/`, byte for byte. And each transaction's transfers are the ones the story says: a paid step moved exactly the amount, from and to the parties named, and a refused step moved nothing.

## Contracts

- `ST2MRQ993WBQQ82GVY7YQQMMH1GYKSG885Z79ZKFS.pq-verifier-trait`
- `ST2MRQ993WBQQ82GVY7YQQMMH1GYKSG885Z79ZKFS.wots`
- `ST2MRQ993WBQQ82GVY7YQQMMH1GYKSG885Z79ZKFS.lamport`
- `ST2MRQ993WBQQ82GVY7YQQMMH1GYKSG885Z79ZKFS.sbtc-token`
- `ST2MRQ993WBQQ82GVY7YQQMMH1GYKSG885Z79ZKFS.pq-vault`

## What it does not show

- Real sBTC. The token is a mock with the same transfer check as `sbtc-token`.
- Behaviour under load, or a realistic fee. Every transaction paid a fixed fee on a quiet network.
- A wallet or a relayer. The requests were signed by a script.
- A review. No engineer outside this work and no cryptographer has read the contracts.

## The keys

The accounts' keys and the vaults' master secret are in `~/.config/pq-vault/demo.json`, outside the repository and readable only by its owner, next to the journal of what each one-time key has signed. They hold faucet STX and control a mock token. Do not fund them on mainnet.
