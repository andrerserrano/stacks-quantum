# Quantum

Work on post-quantum security for Stacks and sBTC. Status as of 9 October 2026: a first proof of concept runs on simnet and on Stacks testnet. Nothing is reviewed by a cryptographer or approved.

| What | Where |
| --- | --- |
| PRD, revised 8 October 2026 | https://docs.google.com/document/d/1gDLMFcaVvd-T91cFN9qYM4vl3W83feWAF22VHPndSnI |
| Tech spec | https://claude.ai/code/artifact/f2775991-0cff-4527-bb10-fc2258232029 |
| The vault PoC | [vault/](vault/README.md) |
| Demo page, draft. Hosted behind sign-in, not public | [site/](site/README.md) |
| Session pack: brief for Engineering, walkthrough, talking points | [session/](session/WALKTHROUGH.md) |
| Measured cost | [vault/results/COSTS.md](vault/results/COSTS.md) |
| Demo transcript | [vault/results/demo-wots.txt](vault/results/demo-wots.txt) |
| Testnet run, 9 October: separate accounts, WOTS+ and Lamport | [vault/results/RUN.md](vault/results/RUN.md) |
| First testnet run, 8 October | [vault/results/TESTNET.md](vault/results/TESTNET.md) |
| Review record | [vault/REVIEW.md](vault/REVIEW.md) |

To see it run:

```bash
cd vault && npm install && npm run demo
```

The PRD lives in Google Docs and is not in this repository.
