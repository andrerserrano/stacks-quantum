// What a wallet needs to use the vault: one-time keys derived from a master
// secret, the vault's id, and the digest a withdrawal signs.

import { createHash, createHmac } from "node:crypto";
import { Cl, serializeCV } from "@stacks/transactions";
import * as wots from "./wots.mjs";
import * as lamport from "./lamport.mjs";
import { memoryJournal } from "./journal.mjs";

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
//
// The path is text with "/" between its parts, so each part is checked: a
// part that could hold a "/" would let two different paths read the same.
//
// `verifier` is the contract that will check this key's signatures. A vault's
// id covers its verifier, so the same key under two verifiers would open two
// vaults and sign once for each, which is a key used twice. The usual
// verifier, the contract named after the scheme beside the vault, is left
// out of the path so that keys made before this was noticed stay the same.
// Any other verifier is written into it.
const CONTRACT = /^S[0-9A-Z]{20,}\.[a-zA-Z][a-zA-Z0-9_-]{0,127}$/;
export function keySecret(master, { chainId, vault, scheme, verifier, account, index }) {
  if (!Buffer.isBuffer(master) || master.length !== 32) throw new Error("the master secret is 32 bytes");
  for (const [name, n] of Object.entries({ chainId, account, index })) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a whole number, zero or more`);
  }
  if (!Object.hasOwn(SCHEMES, scheme)) throw new Error(`unknown scheme ${scheme}`);
  if (!CONTRACT.test(vault)) throw new Error("the vault is a contract, as address.name");
  const usual = `${vault.split(".")[0]}.${scheme}`;
  if (verifier !== undefined && !CONTRACT.test(verifier)) throw new Error("the verifier is a contract, as address.name");
  const under = verifier === undefined || verifier === usual ? scheme : `${scheme}@${verifier}`;
  return createHmac("sha256", master).update(`pq-vault/v1/${chainId}/${vault}/${under}/${account}/${index}`).digest();
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
//
// `journal` records what each key has signed (see journal.mjs). The default
// lasts as long as this wallet object. A wallet that outlives its process
// needs one on disk.
export function wallet({ master, chainId, vault, verifier, scheme, account, journal = memoryJournal() }) {
  const lib = SCHEMES[scheme];
  const secret = (index) => keySecret(master, { chainId, vault, scheme, verifier, account, index });
  const key = (index) => lib.publicKey(secret(index));
  const id = vaultId(key(0), verifier);
  const principalBytes = (text) => serializeCV(Cl.principal(text));

  // The request key `nonce` would sign, naming key `nonce + 1` as the next.
  // Nothing is signed, so it is safe to build, check against the contract and
  // throw away.
  //
  // A request the contract can never pay is refused here. Signed, it would
  // claim the key for nothing: the vault's key never advances, and the wallet
  // will not sign anything else with it.
  function withdrawal({ nonce, asset, amount, recipient }) {
    if (asset !== "stx" && asset !== "sbtc") throw new Error(`the asset is "stx" or "sbtc", not ${JSON.stringify(asset)}`);
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("the nonce must be a whole number, zero or more");
    let units;
    try { units = BigInt(amount); } catch { throw new Error("the amount must be a whole number of the smallest unit"); }
    if (units <= 0n || units >= 1n << 128n) throw new Error("the amount must be more than zero and fit in 128 bits");
    let to;
    try { to = principalBytes(recipient); } catch { throw new Error(`${JSON.stringify(recipient)} is not a Stacks address`); }
    // Compared as the chain reads them: an address can be spelled with O for 0 or L for 1.
    if (to === principalBytes(vault)) throw new Error("the vault cannot pay itself, and the request would use up a key");
    const nextKey = key(nonce + 1);
    const digest = withdrawalDigest({ vault, chainId, id, nonce, asset, amount, recipient, nextKey });
    return { id, nonce, asset, amount, recipient, digest, nextKey };
  }

  // What key `nonce` has signed, or null.
  const signed = (nonce) => journal.get(key(nonce).toString("hex"));

  // Sign a withdrawal with key `nonce`. A second, different request under the
  // same key would let anyone forge a third, so the key is claimed for this
  // digest before the signature exists, and a key claimed for another digest
  // is refused. The same request signs again to the same signature.
  function signWithdrawal(request) {
    const r = withdrawal(request);
    const digest = r.digest.toString("hex");
    const held = journal.claim(key(r.nonce).toString("hex"), {
      digest, vault: id.toString("hex"), nonce: r.nonce, asset: r.asset, amount: String(r.amount),
      recipient: r.recipient, signed: new Date().toISOString(),
    });
    if (held.digest !== digest) {
      throw new Error(`key ${r.nonce} of this vault has already signed ${held.amount} ${held.asset} to ${held.recipient}. ` +
        "Send that request again or wait for it to confirm. A second signature would let anyone forge a third.");
    }
    return { ...r, sig: lib.sign(secret(r.nonce), r.digest) };
  }

  return { scheme, id, key, secret, withdrawal, signed, signWithdrawal };
}
