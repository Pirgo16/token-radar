# Fathom

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/c/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Pirgo16/token-radar/rank.svg)](https://make.fun/c/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Pirgo16/token-radar/reward.svg)](https://make.fun/c/token-radar-01)

Token launch radar for the make.fun bounty. It reads the sealed DefiLlama snapshot, ranks protocols that record no token, and shows a concrete farm plan for each.

Implied FDV is TVL times a category mcap/TVL multiple taken from tokens that already trade, adjusted for size, seven-day TVL change, listing age, and chain count. Fees, revenue, and user counts are not in the snapshot and are not invented. Protocols whose token already trades calibrate the model and are kept off the launch ranking.

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

Open `out/dashboard/index.html`. The page loads `out/data.js` and does not use the network.
