# Demo page

One static page for the vault proof of concept. No build step, no backend and no keys: it reads one data file and calls read-only functions on the deployed contracts.

Draft. The look follows stackslabs.com and the copy has not been through Marketing. It is not deployed anywhere.

## See it

```bash
python3 -m http.server 4173 --directory site
```

Then open http://localhost:4173.

The page shows the latest run in `data/run.json`. Until a run has been sent to testnet that is the rehearsal, and the live checks are off.

## Data

```bash
node site/sync.mjs
```

writes `data/run.json` from `vault/results/run.json`, or from the rehearsal if there is no testnet run yet. Run it after `node testnet.mjs --send` in `vault/`.

## Files

```
index.html   the page and its fixed copy
styles.css   the Stacks Labs look
app.js       draws the run and makes the live checks
clarity.js   Clarity values and Stacks addresses on the wire, tested against @stacks/transactions
amounts.js   amounts as text and in smallest units
```

The live checks call `pq-vault.withdrawal-digest`, the verifier's `check` and `pq-vault.get-vault` through the Hiro API. All three are read-only. Each transaction's on-chain record is read from the same API when it is opened.
