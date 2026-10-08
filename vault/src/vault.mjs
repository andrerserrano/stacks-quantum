// What a wallet needs to use the vault: one-time keys derived from a master
// secret, the vault's id, and the digest a withdrawal signs.

import { createHash, createHmac } from "node:crypto";
import { Cl, serializeCV } from "@stacks/transactions";
import * as wots from "./wots.mjs";
import * as lamport from "./lamport.mjs";

export const SCHEMES = { wots, lamport };

const sha256 = (b) => createHash("sha256").update(b).digest();
const encode = (cv) => Buffer.from(serializeCV(cv), "hex");
const contractCV = (principal) => Cl.contractPrincipal(...principal.split("."));

// The secret behind one-time key number `index` of a vault.
//
// A one-time key must never sign for two vaults, so the secret is tied to the
// chain, the vault contract and an `account` number as well as the master
// secret. A wallet uses each account number for one vault. The contract
// backs this up: a key can open only one vault.
//
// The vault's on-chain nonce is the index of its current key, so a wallet
// restored from the master secret reads the nonce and knows which key is next.
export function keySecret(master, { chainId, vault, scheme, account, index }) {
  return createHmac("sha256", master).update(`pq-vault/v1/${chainId}/${vault}/${scheme}/${account}/${index}`).digest();
}

// The id the contract gives the vault opened under `key` and `verifier`.
// Both `vault-id` in the contract and this depend on nothing else, so a wallet
// knows where to deposit before the vault exists.
export function vaultId(key, verifier) {
  return sha256(encode(Cl.tuple({ key: Cl.buffer(key), verifier: contractCV(verifier) })));
}

// The digest the contract computes in `withdrawal-digest`. `vault` is the
// vault contract's principal, as "address.name".
export function withdrawalDigest({ vault, chainId, id, nonce, asset, amount, recipient, nextKey }) {
  return sha256(encode(Cl.tuple({
    vault: contractCV(vault),
    chain: Cl.uint(chainId),
    id: Cl.buffer(id),
    nonce: Cl.uint(nonce),
    asset: Cl.stringAscii(asset),
    amount: Cl.uint(amount),
    recipient: Cl.principal(recipient),
    "next-key": Cl.buffer(nextKey),
  })));
}

export const sigCV = (sig) => Cl.list(sig.map((w) => Cl.buffer(w)));

// A wallet's view of one vault: its keys, its id and its signatures.
// `verifier` is the verifier contract's principal, as "address.name".
export function wallet({ master, chainId, vault, verifier, scheme, account }) {
  const lib = SCHEMES[scheme];
  const secret = (index) => keySecret(master, { chainId, vault, scheme, account, index });
  const key = (index) => lib.publicKey(secret(index));
  const id = vaultId(key(0), verifier);

  // Sign a withdrawal with key `nonce` and name key `nonce + 1` as the next.
  // Signing a second, different request for the same nonce would let anyone
  // forge a third, and the wallet has to prevent that itself.
  function signWithdrawal({ nonce, asset, amount, recipient }) {
    if (recipient === vault) throw new Error("the vault cannot pay itself, and the request would use up a key");
    const nextKey = key(nonce + 1);
    const digest = withdrawalDigest({ vault, chainId, id, nonce, asset, amount, recipient, nextKey });
    return { id, nonce, asset, amount, recipient, digest, nextKey, sig: lib.sign(secret(nonce), digest) };
  }

  return { scheme, id, key, secret, signWithdrawal };
}
