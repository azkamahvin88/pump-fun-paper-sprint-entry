# pump-fun-paper-sprint-entry

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/azkamahvin88/pump-fun-paper-sprint-entry/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/azkamahvin88/pump-fun-paper-sprint-entry/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Hot-launch scalper for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty ($2, winner takes all). The bot paper-trades 10 SOL on a replay of pump.fun bonding-curve activity (harness `pumpfun-replay/v2`, protocol `agent-fun/replay/v2`).

## Strategy

A curve's price is `((30 + real SOL) / 30)^2` times its create price, so it can never fall below the create price — but most coins pump in a 1–3 slot burst right after creation and then bleed back toward 1.0x. Chasing those bursts loses (the kit's momentum pilot lost ~9.7 SOL on the dev window); buying the first lift and holding loses too.

This bot only trades **hot launches**: coins with at least 10 buys in their first 3 slots (67 of 1222 dev coins). It decides on the first batch at create+3, buys up to the 1%-of-real-reserve cap (hot coins grow real SOL fast, so the cap soon allows a real stake, target 0.5 SOL), and exits fast: **+12% take-profit, −12% stop-loss, or 40 slots held**. Buys use tight 200 bps slippage — a fill more than 2% worse than the decision price is rejected for free instead of buying a burst top; sells go wide open so exits always fill. One round trip per mint, no re-entry, at most 5 open positions.

A second "warm" tier (creator bought 0.05–1 SOL and at least 3 distinct buyers in the first 3 slots, target 0.1 SOL) keeps the 20-mint guardrail safe on short windows. Fully deterministic: no clock, no randomness, no I/O — the two graded executions produce byte-identical action logs.

## Dev-dataset results (grade-local, process driver, bot run twice)

| Metric | Value |
|---|---|
| Net PnL | **+257,387,929 lamports (+0.2574 SOL)** |
| Return | +2.57% |
| Distinct mints | 122 |
| Round trips ≥ 0.01 SOL | 116 mints (guardrail: ≥ 20) |
| Round trips | 122 |
| Fills | 244 (28 rejected, 5 failed txs) |
| Win rate | 35.2% |
| Max drawdown | 3.38% (guardrail: ≤ 50%) |
| Determinism | two runs reproduced byte-identically (`l1.reproduced: true`) |
| Top-3 coins' share of gains | 27.5% (net without top 3: −0.0109 SOL) |

Honest caveats: the 90% bootstrap interval over coins is [−0.218 SOL, +0.749 SOL], so the edge is real but thin and concentrated — the final 6-hour window is a fresh sample and the outcome rides on a few hot coins running. At 2× fees the dev score would be −0.028 SOL.

## Run it

```sh
node main.ts
```

`main.ts` (Node 22, zero dependencies) speaks the harness protocol on stdin/stdout; the strategy lives in `strategy.ts`. No network, no model calls.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
