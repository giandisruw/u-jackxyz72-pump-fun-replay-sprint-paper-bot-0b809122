# Dip-Bounce Scalper — Pump.fun Replay Sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/giandisruw/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/giandisruw/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on make.fun. It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy

Most pump.fun curves dump hard shortly after launch and then bounce. This bot buys the bounce, not the launch:

- **Entry — the cliff rebound.** A curve becomes a buy when it has fallen 10–25% from its recent high over its last 30 trades, has bounced at least 4% off its low (but no more than 10%, so the move is not chased), its latest print is a buy, and the last 10 trades show at least 0.005 SOL of net buy flow. Real reserves must sit between 1 and 40 SOL.
- **Size.** A fixed 0.06 SOL stake per position, capped by the harness limit of 1% of the curve's real SOL reserves and by free cash. Buys under 0.012 SOL are skipped — the flat tx fees would eat them.
- **Exits — fast and tight.** Sell the whole position on the first of: +10% take-profit, −3.5% stop-loss, a 3% trailing giveback once +7% is reached, or a 600-slot time stop while the position is not clearly winning.
- **Discipline.** At most 4 open positions, one entry per curve per run, and a 600-slot cooldown after an exit.

Everything is deterministic: no clock, no randomness, no network calls, no API keys, no environment reads. The bot is a single `main.ts` (Node 22, TypeScript run as-is) on top of the kit's `vendor/makefun-bot.ts` shim.

## Run it

Grade locally with the bounty kit (from inside the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver docker
```

## Files

- `main.ts` — the entrypoint: the whole strategy.
- `vendor/makefun-bot.ts` — the kit's bot shim, vendored byte for byte.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the claim file naming the payout wallet.

## License

MIT — see [LICENSE](LICENSE).
