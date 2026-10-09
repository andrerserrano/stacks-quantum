# Demo walkthrough

A script for showing the pilot to product and engineering. About 15 minutes. Present from the page running locally, or from the hosted copy at https://pq-vault-demo-oo1b1vhoo-andre-serranos-projects.vercel.app while signed in to the Vercel account that owns it. Nobody else can open that copy.

## Before the meeting

Ten minutes ahead, on the machine you will present from.

1. Serve the page and open http://localhost:4173.

```bash
python3 -m http.server 4173 --directory site
```

2. Check the vaults are where you expect. The WOTS+ vault should be at nonce 2 with 4 STX unless you have made live withdrawals since.

```bash
cd vault && node testnet.mjs status
```

3. Rehearse the live withdrawal without sending it. It should end "Not signed, not sent".

```bash
cd vault && node testnet.mjs withdraw 0.5 stx
```

4. Keep a terminal open in `vault/` beside the browser.

If testnet or the Hiro API is down, the page still shows the whole run from its own file. Skip the live withdrawal and the "Try it" panel, and say so.

## The 15 minutes

### 1. The claim and its limits (1 minute)

Top of the page. Say: "Funds in this vault move only on a signature built from SHA-256. No elliptic curves, no lattices. It is an ordinary contract, so it needed no change to Stacks."

Then read the right-hand card out loud. The limits are the credibility: the carrying transaction, the signers and the Bitcoin behind sBTC are not covered, and nobody outside has reviewed it.

### 2. How it works (1 minute)

The four boxes. The one point to land: the account that submits the transaction has no say. The owner signs off-chain, anyone carries it, the contract checks.

### 3. Where the money is (2 minutes)

The four cards. The vault holds 4 STX and is on its third key. The recipient holds 2 STX and has never sent a transaction. The attacker took nothing. The two dark cards and the recipient's balance are read from testnet as you watch.

### 4. The attacks (3 minutes)

Scroll through "Every transaction, in order".

- **The owner's account key.** Two requests sent from the owner's own account, one with no signature and one signed with the attacker's own key. Both refused. Say: "This is what breaking today's signatures gives an attacker. It opens nothing."
- **The altered request.** Three copies of the owner's signed request with one field changed. All refused.
- **The request as signed.** Paid, by an unrelated account. Open **On-chain record** on this row and read down it: who sent it, which vault, which key, the 68-value signature, and "Moved: 1 STX, the vault contract to the recipient's account".
- **The same request again.** Refused, because the vault moved to its next key.

### 5. A live withdrawal (2 minutes)

In the terminal:

```bash
node testnet.mjs withdraw 0.5 stx --send
```

It reads the vault, checks the digest against the contract, signs with the next one-time key, has the verifier check the signature and then sends. It confirms in a few seconds. Go back to the page: within 15 seconds the vault card drops by 0.5 STX and moves to its next key, and the recipient's balance rises.

If it fails, run the same command again. Do not change the amount: the key has signed, and the script will refuse anything else and print the command to resend.

### 6. Try to alter it (2 minutes)

"Change what the owner signed". Click **Ask the contract** as it stands: the signature matches. Click **Pay the attacker instead**, ask again: it does not. Point at the two hashes. Say: "That answer came from the contract on testnet, read-only. Nothing in this page holds a key."

Let someone in the room type their own amount.

### 7. What it costs (2 minutes)

The two charts. 2.9 KB against 180 bytes for a plain transfer. 0.03% of a tenure on the tightest limit, so about 3,300 withdrawals fit in one. Then why WOTS+ and not Lamport: same assumption, 7.5 times smaller, and it is what the many-time schemes are built from.

### 8. The path, and the asks (2 minutes)

The four rows. Be plain that only the first is shown. Then the asks: a dev lead to read the contracts, Engineering's size for the next phase, and a name for the cryptography review.

## Questions you will get

They are answered in [TALKING-POINTS.md](TALKING-POINTS.md).
