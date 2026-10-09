# Note for Adriano: quantum pilot

A draft for Andre to send. Not sent. Alexis asked on 6 October for the pilot to go to Adriano, for a dev lead to evaluate it and size it, and for Rick to be looped in on how we talk about it.

---

Hey Adriano! Quantum pilot update: the vault I mentioned in the watercooler post is running on testnet, and I'd love a dev lead to take a look.

It's a Clarity contract that only releases STX and sBTC against a hash-based signature. No hard fork and no new Clarity function. On testnet it refused six forged or altered requests and paid three signed ones, and there's a small demo page that walks through it.

My read: it proves one layer. Funds in a vault are covered, but transactions, signers and the BTC behind sBTC are not. Each key can only sign once, and automated reviews have already caught real issues, so I don't want it near mainnet or anything public yet.

Could you point me to a dev lead to read the contracts (about 250 lines) and give a rough size for a next phase? Happy to walk them through it in 15 min.

- Spec: https://claude.ai/code/artifact/f2775991-0cff-4527-bb10-fc2258232029
- Code and the testnet run: `andrerserrano/stacks-quantum`, private. Tell me who needs access.

---

Before sending:

- The channel and who to cc are yours to choose. Rick comes in on wording once Engineering has had a look.
- The spec link opens only for you until you share it.
- The repository is under a personal account, and the latest work is not committed.
- For the conversation that follows, the answers are in [TALKING-POINTS.md](TALKING-POINTS.md). The one to have ready: if an attacker can influence the second thing a key signs, a forgery takes seconds. The signer prevents that second signature. `vault/REVIEW.md` has the full record.
