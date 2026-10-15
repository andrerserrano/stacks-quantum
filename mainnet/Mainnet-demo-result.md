# Mainnet sBTC Lamport demo result

Verified 2026-10-15T21:46:50.436Z. One mainnet withdrawal paid 1000 sats of official sBTC to the signed recipient.

- Withdrawal: [0xb983fa37d30d5ece2c2d3d539885cf5d6f2394245a733d76820a6fa9ca6a5b97](https://explorer.hiro.so/txid/0xb983fa37d30d5ece2c2d3d539885cf5d6f2394245a733d76820a6fa9ca6a5b97?chain=mainnet)
- Vault: `SP1BE4QPD9XK2A2TDJE7B40S00J9WZCW280ET3JBP.pq-vault`
- Verifier: `SP1BE4QPD9XK2A2TDJE7B40S00J9WZCW280ET3JBP.lamport`
- Actual fees: 4.114578 STX across seven transactions (20 STX cap).
- Vault: 0 sBTC, nonce 1, planned successor installed. One durable initial-key claim.
- Each transaction has at least 6 canonical Stacks block confirmations; canonicality was rechecked at collection.

| Step | Result | Fee (STX) | Transaction |
| --- | --- | --- | --- |
| deploy-pq-verifier-trait | success | 0.51996 | [0x8cf1e01c64...](https://explorer.hiro.so/txid/0x8cf1e01c644e319b5459d4309882b34e835f6e1f22451370d923147e1e11be66?chain=mainnet) |
| deploy-lamport | success | 0.52017 | [0x3f49752268...](https://explorer.hiro.so/txid/0x3f49752268c826b47c0f1fbf542a246e3d967734bc57ef91c2537d972b72b5fd?chain=mainnet) |
| deploy-pq-vault | success | 0.824268 | [0xa5f90934b1...](https://explorer.hiro.so/txid/0xa5f90934b13f34a8b0c42398285b1583e082772c6f69b6788b5cb2d89370915f?chain=mainnet) |
| open-vault | success | 0.25 | [0xaf60c7c6e1...](https://explorer.hiro.so/txid/0xaf60c7c6e1a7dd9b3f4bbb25b656438428bd400208e00be20c7e5b947fda2dd8?chain=mainnet) |
| deposit-sbtc | success | 0.5 | [0x36ccaa6d96...](https://explorer.hiro.so/txid/0x36ccaa6d962ea8e799d5767d555dd44418796748d5b40c962f81318b0cf6aea3?chain=mainnet) |
| fund-submitter | success | 0.00018 | [0x8b931358ce...](https://explorer.hiro.so/txid/0x8b931358ce861b88dae2df57833a3de28b742825e048ee3c9ee92a5888ab223c?chain=mainnet) |
| withdraw-sbtc | success | 1.5 | [0xb983fa37d3...](https://explorer.hiro.so/txid/0xb983fa37d30d5ece2c2d3d539885cf5d6f2394245a733d76820a6fa9ca6a5b97?chain=mainnet) |

Measured withdrawal: 19,357 bytes, 1,062,385 runtime units, 13 reads and 3 writes. These measurements describe this transaction, not a production fee or throughput guarantee.

Full source hashes, block identifiers, transfer events, balances and fee evidence are in `evidence/mainnet-execution.json`. The journal and signed bytes remain in private local custody. The vault is retired operationally; do not deposit more funds.

One experimental withdrawal; no production audit, protocol change, many-time signing, consensus or Bitcoin reserve protection.
