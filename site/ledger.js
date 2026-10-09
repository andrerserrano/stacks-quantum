// The run, added up: what each step asked for, what moved, and what the
// vaults held afterwards. No page and no network here, so the tests can check
// these sums against what the chain reported at the end of the run.

export const isVault = (role) => role === "wots" || role === "lamport";
export const paid = (s) => Boolean(s.result?.startsWith("(ok"));

// Walk the steps and keep the balances the story is about: each vault, what
// the recipient received and what the attacker took. Refused steps move nothing.
export function ledger(doc) {
  const held = {}, key = {};
  const of = (role) => (held[role] ??= { stx: 0n, sbtc: 0n });
  let taken = 0n;
  const steps = doc.steps.map((s) => {
    const a = s.asks;
    if (a && paid(s)) {
      const n = BigInt(a.amount);
      of(a.from)[a.asset] -= n;
      of(a.to)[a.asset] += n;
      if (s.signature) key[a.from] = s.key + 1;
      if (isVault(a.from) && a.to === "submitter") taken += n;
    }
    const vault = a && [a.from, a.to].find(isVault);
    return { ...s, vault, after: vault && { ...of(vault), key: key[vault] ?? 0 } };
  });
  const requests = steps.filter((s) => s.signature);
  return {
    steps, held, key, taken,
    attacks: requests.filter((s) => s.signature !== "owner" || s.changed),
    payments: requests.filter(paid),
    refused: requests.filter((s) => !paid(s)),
  };
}

// How much of a tenure one call uses: its largest share across the five
// limits, and which limit that is.
export function tenureShare(cost, budget) {
  const shares = Object.keys(budget).map((limit) => ({ limit, share: Number(cost[limit] ?? 0) / budget[limit] }));
  return shares.reduce((most, s) => (s.share > most.share ? s : most));
}
