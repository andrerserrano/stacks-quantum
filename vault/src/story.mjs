// The scripted run: what the demo sends, in order, and what each step has to
// return. The same list runs on simnet in the tests and the rehearsal and
// then on testnet, so the testnet run is checked before anything is sent.
//
// Four accounts take part, and none of them can move a vault's funds:
//   deployer   deploys the contracts and hands out test funds
//   owner      the owner's ordinary Stacks account. It opens and funds the
//              vaults, and it is the key an attacker is assumed to hold
//   submitter  an unrelated account. It plays the attacker who reads the
//              mempool, then submits the requests as signed
//   recipient  where the owner sends the funds. It signs nothing
// The vaults' own keys are hash-based and belong to no account.

import { createHash } from "node:crypto";
import { Cl, Pc } from "@stacks/transactions";
import { CHAIN_ID, CLARITY_VERSION, CONTRACTS, EPOCH } from "./simnet.mjs";
import { SCHEMES, sigCV, withdrawalDigest } from "./vault.mjs";

const STX = 1_000_000n;
const FUND = { owner: 12n * STX, submitter: 3n * STX };
const WOTS = { stx: 5n * STX, sbtc: 1_000_000n, first: 1n * STX, second: 500_000n };
const LAMPORT = { stx: 2n * STX, first: 1n * STX };

const hex = (b) => b.toString("hex");
const show = (cv) => Cl.prettyPrint(cv);

// The attacker's own one-time key. It is not a secret: anyone can make one.
const ATTACKER = createHash("sha256").update("pq-vault/demo/attacker").digest();

// Sign a request once the contract has agreed on its digest, then have the
// verifier contract check the signature. A one-time key cannot try again, so
// both checks are made against the chain before anything is sent.
// `read(contract, fn, args)` calls a read-only function.
export async function signChecked(read, w, request) {
  const u = w.withdrawal(request);
  const digest = await read("pq-vault", "withdrawal-digest", [
    Cl.buffer(u.id), Cl.uint(u.nonce), Cl.stringAscii(u.asset), Cl.uint(u.amount), Cl.principal(u.recipient), Cl.buffer(u.nextKey)]);
  if (show(digest) !== `0x${hex(u.digest)}`) throw new Error("the contract computes a different digest. Nothing was signed.");
  const r = w.signWithdrawal(request);
  const ok = await read(w.scheme, "check", [Cl.buffer(w.key(r.nonce)), Cl.buffer(r.digest), sigCV(r.sig)]);
  if (show(ok) !== "true") throw new Error("the verifier contract refuses the wallet's signature. Nothing was sent.");
  return r;
}

// A vault as the chain has it, or null.
export async function vaultState(read, w) {
  const v = await read("pq-vault", "get-vault", [Cl.buffer(w.id)]);
  if (v.type !== "some") return null;
  const s = v.value.value;
  return { key: s.key.value, nonce: Number(s.nonce.value), stx: String(s.stx.value), sbtc: String(s.sbtc.value) };
}

// A signed request as anyone can see it once it is sent. `key` is the key it
// was signed under, which the vault no longer holds after it is paid.
export const published = (w, r) => ({
  scheme: w.scheme, vault: hex(r.id), key: hex(w.key(r.nonce)), nonce: r.nonce, asset: r.asset, amount: String(r.amount),
  recipient: r.recipient, nextKey: hex(r.nextKey), digest: hex(r.digest), sig: r.sig.map(hex),
});

// The call that submits request `r` to the vault. `change` alters fields
// after signing, the way an attacker would. The post-condition lets the vault
// contract send exactly the amount asked for and nothing else.
export function withdrawCall(who, w, r, change = {}) {
  const q = { ...r, ...change };
  const vault = `${who.deployer}.pq-vault`;
  const sends = Pc.principal(vault).willSendEq(q.amount);
  return {
    contract: "pq-vault", fn: `withdraw-${q.asset}`,
    args: [Cl.buffer(q.id), Cl.uint(q.nonce), Cl.uint(q.amount), Cl.principal(q.recipient), Cl.buffer(q.nextKey),
           Cl.contractPrincipal(who.deployer, w.scheme), sigCV(q.sig)],
    pc: [q.asset === "stx" ? sends.ustx() : sends.ft(`${who.deployer}.sbtc-token`, "sbtc")],
  };
}

// The steps. `who` maps each role to its address, `wallets` holds the WOTS+
// and Lamport wallets, and `read` calls a read-only function on the chain
// the steps run against. `requests()` returns what has been signed so far.
export function story({ who, wallets, read }) {
  const { wots, lamport } = wallets;
  const token = `${who.deployer}.sbtc-token`;
  const verifier = (w) => Cl.contractPrincipal(who.deployer, w.scheme);
  const signed = {};
  const sign = async (name, w, request) => (signed[name] ??= { w, r: await signChecked(read, w, request) }).r;
  const first = () => sign("first", wots, { nonce: 0, asset: "stx", amount: WOTS.first, recipient: who.recipient });
  const withdraw = (w, r, change) => withdrawCall(who, w, r, change);

  const call = (contract, fn, make) => ({ kind: "call", contract, fn, make });
  const deposit = (w, asset, amount) => call("pq-vault", `deposit-${asset}`, () => ({
    args: [Cl.buffer(w.id), Cl.uint(amount)],
    pc: [asset === "stx" ? Pc.principal(who.owner).willSendEq(amount).ustx() : Pc.principal(who.owner).willSendEq(amount).ft(token, "sbtc")],
  }));
  const open = (w) => call("pq-vault", "open", () => ({ args: [Cl.buffer(w.key(0)), verifier(w)] }));
  const attack = (make) => call("pq-vault", "withdraw-stx", make);
  const OK = "(ok true)", REFUSED = "(err u205)", SPENT = "(err u203)";

  // A request for everything in the vault, paid to the attacker, with his own
  // key named as the next one.
  const theft = { id: wots.id, nonce: 0, asset: "stx", amount: WOTS.stx, recipient: who.submitter, nextKey: SCHEMES.wots.publicKey(ATTACKER) };
  const theftDigest = () => withdrawalDigest({ vault: `${who.deployer}.pq-vault`, chainId: CHAIN_ID, ...theft });

  // What a step asks the chain to move: `from` and `to` are roles, or a vault
  // by its scheme. The demo page draws these and adds up the balances.
  const move = (asset, amount, from, to) => ({ asks: { asset, amount: String(amount), from, to } });
  // A request to a vault: which of its keys it is for, and whose signature it carries.
  const request = (key, signature, changed) => ({ key, signature, ...(changed && { changed }) });

  const steps = [
    ...CONTRACTS.map((contract) => (
      { name: `deploy-${contract}`, phase: "setup", by: "deployer", title: `Deploy ${contract}`, kind: "deploy", contract, expect: OK })),
    { name: "fund-owner", phase: "setup", by: "deployer", title: "Fund the owner's account", kind: "transfer",
      make: () => ({ to: who.owner, amount: FUND.owner }), expect: OK, ...move("stx", FUND.owner, "deployer", "owner") },
    { name: "fund-submitter", phase: "setup", by: "deployer", title: "Fund the submitter's account", kind: "transfer",
      make: () => ({ to: who.submitter, amount: FUND.submitter }), expect: OK, ...move("stx", FUND.submitter, "deployer", "submitter") },
    { name: "mint-sbtc", phase: "setup", by: "deployer", title: "Mint mock sBTC to the owner",
      ...call("sbtc-token", "mint", () => ({ args: [Cl.uint(WOTS.sbtc), Cl.principal(who.owner)] })), expect: OK, ...move("sbtc", WOTS.sbtc, "deployer", "owner") },

    { name: "open", phase: "vault", by: "owner", title: "Open a vault under a WOTS+ key", ...open(wots), expect: `(ok 0x${hex(wots.id)})` },
    { name: "deposit-stx", phase: "vault", by: "owner", title: "Deposit 5 STX", ...deposit(wots, "stx", WOTS.stx), expect: OK, ...move("stx", WOTS.stx, "owner", "wots") },
    { name: "deposit-sbtc", phase: "vault", by: "owner", title: "Deposit 0.01 mock sBTC", ...deposit(wots, "sbtc", WOTS.sbtc), expect: OK, ...move("sbtc", WOTS.sbtc, "owner", "wots") },

    // An attacker who holds the owner's account key sends from her account.
    { name: "no-signature", phase: "account-key", by: "owner", title: "Withdraw everything with no signature, from the owner's own account",
      ...attack(() => withdraw(wots, { ...theft, sig: [] })), expect: REFUSED, ...move("stx", WOTS.stx, "wots", "submitter"), ...request(0, "none") },
    { name: "own-key", phase: "account-key", by: "owner", title: "The same, signed with a one-time key of the attacker's own",
      ...attack(() => withdraw(wots, { ...theft, sig: SCHEMES.wots.sign(ATTACKER, theftDigest()) })), expect: REFUSED,
      ...move("stx", WOTS.stx, "wots", "submitter"), ...request(0, "attacker") },

    // The owner signs a withdrawal. An attacker sees it before it confirms.
    { name: "altered-recipient", phase: "mempool", by: "submitter", title: "The owner's signed request with the recipient changed",
      ...attack(async () => withdraw(wots, await first(), { recipient: who.submitter })), expect: REFUSED,
      ...move("stx", WOTS.first, "wots", "submitter"), ...request(0, "owner", "recipient") },
    { name: "altered-amount", phase: "mempool", by: "submitter", title: "The signed request with the amount raised to 5 STX",
      ...attack(async () => withdraw(wots, await first(), { amount: WOTS.stx })), expect: REFUSED,
      ...move("stx", WOTS.stx, "wots", "recipient"), ...request(0, "owner", "amount") },
    { name: "altered-next-key", phase: "mempool", by: "submitter", title: "The signed request with the next key swapped",
      ...attack(async () => withdraw(wots, await first(), { nextKey: theft.nextKey })), expect: REFUSED,
      ...move("stx", WOTS.first, "wots", "recipient"), ...request(0, "owner", "next key") },

    { name: "withdraw", phase: "withdraw", by: "submitter", title: "The request as signed: 1 STX to the recipient",
      ...call("pq-vault", "withdraw-stx", async () => withdraw(wots, await first())), expect: OK,
      ...move("stx", WOTS.first, "wots", "recipient"), ...request(0, "owner") },
    { name: "replay", phase: "withdraw", by: "submitter", title: "The same request again",
      ...call("pq-vault", "withdraw-stx", async () => withdraw(wots, await first())), expect: SPENT,
      ...move("stx", WOTS.first, "wots", "recipient"), ...request(0, "owner") },
    { name: "withdraw-sbtc", phase: "rotate", by: "submitter", title: "A second withdrawal under the next key: 0.005 mock sBTC",
      ...call("pq-vault", "withdraw-sbtc", async () => withdraw(wots,
        await sign("second", wots, { nonce: 1, asset: "sbtc", amount: WOTS.second, recipient: who.recipient }))), expect: OK,
      ...move("sbtc", WOTS.second, "wots", "recipient"), ...request(1, "owner") },

    { name: "open-lamport", phase: "lamport", by: "owner", title: "Open a vault under a Lamport key", ...open(lamport), expect: `(ok 0x${hex(lamport.id)})` },
    { name: "deposit-stx-lamport", phase: "lamport", by: "owner", title: "Deposit 2 STX", ...deposit(lamport, "stx", LAMPORT.stx), expect: OK, ...move("stx", LAMPORT.stx, "owner", "lamport") },
    { name: "withdraw-lamport", phase: "lamport", by: "submitter", title: "The same withdrawal with a Lamport signature: 1 STX to the recipient",
      ...call("pq-vault", "withdraw-stx", async () => withdraw(lamport,
        await sign("lamport", lamport, { nonce: 0, asset: "stx", amount: LAMPORT.first, recipient: who.recipient }))), expect: OK,
      ...move("stx", LAMPORT.first, "lamport", "recipient"), ...request(0, "owner") },
  ];

  const requests = () => Object.fromEntries(Object.entries(signed).map(([name, { w, r }]) => [name, published(w, r)]));
  // Where the vaults have to stand when every step has run.
  const ends = {
    wots: { key: hex(wots.key(2)), nonce: 2, stx: String(WOTS.stx - WOTS.first), sbtc: String(WOTS.sbtc - WOTS.second) },
    lamport: { key: hex(lamport.key(1)), nonce: 1, stx: String(LAMPORT.stx - LAMPORT.first), sbtc: "0" },
  };
  return { steps, requests, ends };
}

// Run the steps in order and stop at the first result that is not the
// expected one. `done` holds an earlier run's records by step name, so an
// interrupted run picks up where it stopped. `record(step, rec)` is called
// before a step is sent and again when its result is known.
export async function play(steps, driver, { done = {}, record = () => {} } = {}) {
  for (const step of steps) {
    let rec = done[step.name];
    if (!rec?.result) {
      const action = { ...step, ...(await step.make?.()) };
      rec = await driver.exec(action, rec, (sent) => record(step, sent));
      record(step, rec);
    }
    if (rec.result !== step.expect) throw new Error(`${step.name}: expected ${step.expect}, got ${rec.result}. Stopped here.`);
  }
}

// A simnet, as something `play` can run the steps on. `t` comes from boot().
export function simDriver(t, who) {
  return {
    read: async (contract, fn, args) => t.read(contract, fn, args),
    exec: async (s) => {
      if (s.kind === "deploy") return { result: "(ok true)", cost: t.deployCosts[s.contract] };
      if (s.kind === "transfer") return { result: show(t.simnet.transferSTX(s.amount, s.to, who[s.by]).result) };
      const r = t.simnet.callPublicFn(t.id(s.contract), s.fn, s.args, who[s.by]);
      return { result: show(r.result), cost: r.costs.total };
    },
  };
}

// The run as one document: what the demo page reads. Everything in it is
// public. No secret or private key belongs here.
export function assemble({ network, who, wallets, steps, records, requests, ...rest }) {
  return {
    network, epoch: EPOCH, clarity: CLARITY_VERSION, chainId: CHAIN_ID,
    roles: who,
    contracts: Object.fromEntries(CONTRACTS.map((c) => [c, `${who.deployer}.${c}`])),
    vaults: Object.fromEntries(Object.entries(wallets).map(([scheme, w]) => (
      [scheme, { id: hex(w.id), verifier: `${who.deployer}.${scheme}`, firstKey: hex(w.key(0)) }]))),
    steps: steps.map((s) => ({
      name: s.name, phase: s.phase, title: s.title, by: s.by, sender: who[s.by], kind: s.kind,
      ...(s.fn && { call: `${s.contract}.${s.fn}` }), expect: s.expect,
      ...(s.asks && { asks: s.asks }), ...(s.signature && { key: s.key, signature: s.signature }), ...(s.changed && { changed: s.changed }),
      ...records[s.name] })),
    requests,
    ...rest,
  };
}
