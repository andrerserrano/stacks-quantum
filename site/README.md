# Demo page

One static page for the vault proof of concept. No build step, no backend and no keys: it reads one data file and calls read-only functions on the deployed contracts.

Draft. The look follows stackslabs.com and the copy has not been through Marketing. A copy is hosted behind sign-in and nothing is public.

## See it

```bash
python3 -m http.server 4173 --directory site
```

Then open http://localhost:4173.

The page shows the latest run in `data/run.json`. Until a run has been sent to testnet that is the rehearsal, and the live checks are off.

## Hosted copy

A copy is on Vercel at https://pq-vault-demo-oo1b1vhoo-andre-serranos-projects.vercel.app, deployed on 9 October 2026. Only someone signed in to the Vercel account that owns the project can open it: anyone else is sent to Vercel's sign-in. The project's public address, `pq-vault-demo.vercel.app`, holds a placeholder that says nothing is published there.

To host a new copy, after `vercel login`:

```bash
node site/share.mjs
```

```bash
vercel deploy site/.share/pq-vault-demo --yes
```

Do not pass `--prod`. A deployment without it is a preview, which stays behind sign-in. With it, the page would replace the placeholder at the public address. Each deployment gets its own address, so update the one above.

Every visitor's browser calls the public Hiro API directly, and that API limits requests by network address.

## Data

```bash
node site/sync.mjs
```

writes `data/run.json` from `vault/results/run.json`, or from the rehearsal if there is no testnet run yet. Run it after `node testnet.mjs --send` in `vault/`.

## Files

```
index.html   the page and its fixed copy
share.mjs    builds the copy that gets hosted
styles.css   the Stacks Labs look
app.js       draws the run and makes the live checks
clarity.js   Clarity values and Stacks addresses on the wire, tested against @stacks/transactions
amounts.js   amounts as text and in smallest units
```

The live checks call `pq-vault.withdrawal-digest`, the verifier's `check` and `pq-vault.get-vault` through the Hiro API. All three are read-only. Each transaction's on-chain record is read from the same API when it is opened.
