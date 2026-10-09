# pq-vault

A Clarity vault for STX and sBTC whose withdrawals need a hash-based one-time signature. Proof of concept on simnet and testnet, unaudited. Do not put real funds behind it.

The design, the reasoning and the open questions are in the tech spec: https://claude.ai/code/artifact/f2775991-0cff-4527-bb10-fc2258232029

## What it shows

A vault stores a 32-byte key, under an id that is the hash of its first key and its verifier. To withdraw, the owner signs the amount, the recipient and the next key with a one-time signature built from SHA-256 alone. Anyone can submit the signed request. The contract checks the signature, pays the recipient and installs the next key.

The account that submits the transaction has no authority. An attacker who holds the owner's Stacks account key cannot move the funds, change a signed request or replay one.

## What it does not show

- The transaction that carries a withdrawal is an ordinary Stacks transaction, signed with secp256k1 by whoever submits it.
- Stacks blocks, signers and miners still rely on secp256k1.
- The Bitcoin backing sBTC sits behind a Taproot key. A vault holding sBTC does nothing for it.
- A one-time key must sign once. If a wallet signs two different requests with the same key, or uses one key for two vaults, the vault can be forged against. The library derives a separate key for every chain, contract, account and nonce, and the contract refuses a second vault under the same key. The signer keeps a journal of what each key has signed and refuses a second, different request, so a failed payment can only be sent again as it was. A wallet restored from its master secret without that journal has lost the guard. Nothing here handles lost keys or recovery.

## Run it

Needs Node 20 or later. No Clarinet install: the simnet comes from `@stacks/clarinet-sdk`.

```bash
npm install
```

```bash
npm test
```

105 tests at Epoch 4.0, Clarity 6, in five files:

| File | What it covers |
| --- | --- |
| `test/vault.test.mjs` | The contracts: a paid withdrawal, and unauthorized, altered and replayed requests, for both schemes. Key separation, look-alike vaults, hostile verifiers |
| `test/crypto.test.mjs` | The schemes themselves: the wallet and the contract agree on random and spoiled inputs, outputs have not drifted from fixed vectors, the key derivation path cannot be read two ways, and what a second signature costs, shown as working forgeries |
| `test/signer.test.mjs` | The sign-once guard, including several processes claiming one key at the same instant, and the scripted run on simnet |
| `test/testnet.test.mjs` | `testnet.mjs --send`, `withdraw` and `report`, end to end against `test/fake-node.mjs`, a stand-in for the testnet API that enforces nonces and post-conditions. Lost replies, refused, dropped and rolled-back transactions, mistyped options |
| `test/site.test.mjs` | The demo page's own encoding of contract arguments against `@stacks/transactions`, and its sums against the chain's final state |

```bash
npm run demo
```

A scripted run: an attacker with the owner's account key tries to empty the vault and to tamper with a signed request. Pass `lamport` to use the other verifier. The transcript is saved to `results/`.

```bash
npm run measure
```

Costs for both schemes against the tenure budget. Writes `results/COSTS.md`. The keys come from a fixed secret, so the figures repeat.

```bash
npm run mutate
```

Removes each of 26 checks from the contracts in turn and runs 21 attacks against the result. Reports which attack each removal lets through, and why the rest are safe to remove.

## Testnet

### The demo run

`testnet.mjs` holds the run the demo shows. It ran on Stacks testnet on 9 October 2026, and every step returned what the story expects. The transactions, their cost beside the same steps on simnet, and the addresses are in [results/RUN.md](results/RUN.md).

Four throwaway accounts take part, and none of them can move a vault's funds.

| Account | What it does |
| --- | --- |
| deployer | Deploys the contracts and hands out test funds |
| owner | The owner's ordinary Stacks account. Opens and funds the vaults. The attacker is assumed to hold its key |
| submitter | An unrelated account. Sends the altered requests, then the signed ones |
| recipient | Receives the withdrawals. Signs nothing |

The run opens a WOTS+ vault and a Lamport vault. It sends two forged requests from the owner's own account and three altered ones from the submitter, pays three signed withdrawals and replays one. Each step names the result it has to return, in `src/story.mjs`, and the run stops at the first that differs.

```bash
npm run rehearse
```

runs it on a simnet, builds every testnet transaction and sends nothing. It writes `results/run.rehearsal.json`, the document the demo page reads.

```bash
node testnet.mjs --send
```

sends it to testnet. It makes fresh keys in `~/.config/pq-vault/demo.json`, rehearses under those keys first, and writes `results/run.json`. Each step is one transaction, fixed by the nonce it was first given and written down before it is sent. Stopped and run again, the script picks up where it stopped, and a step sent again is the same transaction, so no step can run twice.

```bash
node testnet.mjs withdraw 1 stx
```

checks a new withdrawal against the chain: the vault's balance, any request its current key has already signed, and the digest the contract computes. Add `--send` to sign it and send it. `--scheme lamport` and `--to ADDRESS` pick the vault and the recipient. A mistyped option stops the command, and a withdrawal that was sent and never confirmed is settled before anything new is signed.

```bash
node testnet.mjs status
```

shows the vaults and the accounts as testnet has them.

```bash
node testnet.mjs report
```

rewrites `results/RUN.md`. It runs the same steps on simnet under the same keys to compare cost. It also reads two things back from testnet: that the source held for each contract is the source in `contracts/`, and that each transaction moved exactly what the story says it asked for, or nothing if it was refused.

Nothing is signed with a vault key and nothing is sent without `--send`.

### Signing once

A one-time key may sign one request. The signer records each signature in a journal before it releases it, in `~/.config/pq-vault/demo-journal/`, one file per key. A key that has signed is refused for any other request, and the same request signs again to the same signature. If a payment fails, the only thing to do is send it again, and the withdraw command prints how.

The journal is part of the wallet's state. Back it up with the master secret.

What the guard prevents is not theoretical. The scripts in `analysis/` search for a forgery against a WOTS+ key that has signed more than once, and `test/crypto.test.mjs` submits each result to the vault, which pays it.

| What the key signed | Hashes to forge a theft | On a laptop |
| --- | --- | --- |
| Two requests, the second at an address the attacker chose from a million | 17,084,908 and 3,027,093, for two ordinary keys | 15 and 4 seconds |
| Two requests the attacker had no say in | 71,774,325 for the cheapest of 40,000 sampled keys. About 2^61 for a typical one | 1 minute for that key |
| Three such requests | 31,342 for a favourable key. About 2^31 for a typical one | Under a second |

The first row is the one that matters. An attacker who can influence what is signed second, for example by asking to be paid, needs about 2^24 hashes whatever the key. Lamport holds up far better under the same attack, at about 2^90. All of these count ordinary hashing. A quantum search would roughly halve the exponents.

```bash
node analysis/forge-chosen.mjs 1
```

### The first run, 8 October 2026

An earlier version of `testnet.mjs` deployed the contracts to Stacks testnet under one throwaway key, opened a WOTS+ vault, funded it, and sent three withdrawals.

| Request | Result | Runtime on testnet | Same request on simnet |
| --- | --- | --- | --- |
| Recipient changed | Refused, `(err u205)` | 1,328,119 | 1,327,572 |
| As signed, 1 STX | Paid, `(ok true)` | 1,226,990 | 1,226,443 |
| The same again | Refused, `(err u203)` | 41,206 | 41,087 |

Contracts are under `STYYMGK95AP90AM43C2PXKXD1RM1HWH3Y8X02AFS`. Transaction links and the rest are in [results/TESTNET.md](results/TESTNET.md).

```bash
node testnet-compare.mjs
```

replays those requests on simnet under the same address and keys and rewrites that file. It reads that run's key file, `~/.config/pq-vault/testnet.json`, which is outside the repository. The keys are throwaways that hold faucet STX, and the vault's first key has signed its one request.

## Results, 8 October 2026

| One STX withdrawal | WOTS+ | Lamport |
| --- | --- | --- |
| Signature | 2,176 bytes | 16,384 bytes |
| Transaction | 2,841 bytes | 19,272 bytes |
| Runtime | 1,226,367 | 1,059,981 |
| Share of a tenure's runtime | 0.025% | 0.021% |

A `secp256k1-verify` costs 767 runtime with a 65-byte signature. Full tables are in `results/COSTS.md`.

## Layout

```
contracts/
  pq-vault.clar            the vault: open, deposit, withdraw
  pq-verifier-trait.clar   what a signature verifier looks like to the vault
  wots.clar                WOTS+ verifier, 68-word signatures
  lamport.clar             Lamport verifier, 512-word signatures
  sbtc-token.clar          mock of mainnet sbtc-token, same transfer check
src/
  wots.mjs, lamport.mjs    key generation, signing and verification
  vault.mjs                one-time keys from a master secret, the vault id and the digest
  journal.mjs              what each one-time key has signed, in memory or on disk
  story.mjs                the scripted run: its steps and what each has to return
  testnet.mjs              the demo's keys, a testnet driver and the rehearsal
  simnet.mjs               boots a simnet and deploys the contracts
test/vault.test.mjs      the contracts
test/signer.test.mjs     the sign-once guard and the scripted run, on simnet
test/testnet.test.mjs    testnet.mjs --send against test/fake-node.mjs, a stand-in for the testnet API
test/site.test.mjs       the demo page's encoding and sums, in ../site
test/crypto.test.mjs     the schemes, the key derivation and working forgeries after key reuse
measure.mjs  mutate.mjs  demo.mjs  testnet.mjs  testnet-compare.mjs
analysis/double-sign.mjs  what a forgery costs after a key signs more than once
analysis/forge.mjs        finds such a forgery, for the tests to submit
analysis/forge-chosen.mjs the cheaper one, where the attacker chooses what is signed second
results/
```

## Review

An automated adversarial review of the first build found five flaws, one of which allowed a forgery. All are fixed. They are listed with the test that now covers each in [REVIEW.md](REVIEW.md). No cryptographer has reviewed the scheme.

## Not done

- Both schemes have run on testnet under separate accounts, once each, with a mock token and at a fixed fee on a quiet network.
- The mock token lets anyone mint, so on a public testnet its balances mean nothing beyond the demo.
- No review by a cryptographer. The WOTS+ construction follows the one inside SLH-DSA (FIPS 205) with an encoding of our own, so it matches no standard byte for byte.
- No wallet and no relayer. A draft demo page is in `../site`, hosted behind sign-in and not public.
- To point the vault at mainnet sBTC, change the two `.sbtc-token` references in `pq-vault.clar` to `'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`.
