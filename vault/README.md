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
- A one-time key must sign once. If a wallet signs two different requests with the same key, or uses one key for two vaults, the vault can be forged against. The library derives a separate key for every chain, contract, account and nonce, and the contract refuses a second vault under the same key. Nothing here handles failed payments, lost keys or recovery.

## Run it

Needs Node 20 or later. No Clarinet install: the simnet comes from `@stacks/clarinet-sdk`.

```bash
npm install
```

```bash
npm test
```

38 tests at Epoch 4.0, Clarity 6: a paid withdrawal, and unauthorized, altered and replayed requests, for both schemes. Also key separation between vaults, look-alike vaults and hostile verifiers.

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

`testnet.mjs` ran on 8 October 2026. It deployed the contracts to Stacks testnet under a throwaway key, opened a WOTS+ vault, funded it, and sent three withdrawals.

| Request | Result | Runtime on testnet | Same request on simnet |
| --- | --- | --- | --- |
| Recipient changed | Refused, `(err u205)` | 1,328,119 | 1,327,572 |
| As signed, 1 STX | Paid, `(ok true)` | 1,226,990 | 1,226,443 |
| The same again | Refused, `(err u203)` | 41,206 | 41,087 |

Contracts are under `STYYMGK95AP90AM43C2PXKXD1RM1HWH3Y8X02AFS`. Transaction links and the rest are in [results/TESTNET.md](results/TESTNET.md).

```bash
node testnet-compare.mjs
```

replays the testnet requests on simnet under the same address and keys and rewrites that file. It reads the key file below.

The key and the vault's master secret are in `~/.config/pq-vault/testnet.json`, outside the repository. They are throwaways that hold faucet STX. The vault's first key has signed its one request, so running `testnet.mjs` again signs nothing new. To start over, move that file and `results/testnet.json` aside.

```bash
node testnet.mjs --dry-run
```

builds every transaction with keys held in memory, prints its size and sends nothing.

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
  simnet.mjs               boots a simnet and deploys the contracts
test/vault.test.mjs
measure.mjs  mutate.mjs  demo.mjs  testnet.mjs  testnet-compare.mjs
analysis/double-sign.mjs  what a forgery costs after a key signs more than once
results/
```

## Review

An automated adversarial review of the first build found four flaws, all fixed. They are listed with the test that now covers each in [REVIEW.md](REVIEW.md). No cryptographer has reviewed the scheme.

## Not done

- Only WOTS+ was exercised on testnet, by one key, with a mock token.
- No review by a cryptographer. The WOTS+ construction follows the one inside SLH-DSA (FIPS 205) with an encoding of our own, so it matches no standard byte for byte.
- No wallet, no web page, no relayer.
- To point the vault at mainnet sBTC, change the two `.sbtc-token` references in `pq-vault.clar` to `'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`.
