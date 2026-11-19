// Fathom's launch model. Every figure comes from the sealed snapshot.
// Fees, revenue and user counts are not in the extract, so they are not invented:
// a comparable's market cap already capitalizes them.
//
// Implied FDV of a pre-token protocol:
//   TVL x shrunk category mcap/TVL x size factor x growth factor x tenure x breadth
//
// The category multiple is the winsorized median mcap/TVL of tokens that already
// trade in that category, shrunk toward the cross-market median. Size follows a
// damped log-log elasticity fit on those same tokens. Growth, tenure and breadth
// are launch adjustments on top of that comparable. No protocol name is special-cased.

import type { SnapshotProtocol } from './types.ts';

export type { Snapshot, SnapshotProtocol } from './types.ts';
export { parseSnapshot } from './types.ts';

/** Choices, not fits. The fits are computed from the snapshot each run. */
export const ASSUMPTIONS = {
  shrinkage_k: 6,
  winsor_p: 0.1,
  elasticity_damp: 0.55,
  growth_weight: 0.35,
  growth_lo: -40,
  growth_hi: 80,
  tenure_floor: 0.7,
  tenure_span: 0.45,
  tenure_cap_days: 1460,
  breadth_per_chain: 0.035,
  breadth_extra_cap: 10,
  size_lo: 0.4,
  size_hi: 2.2,
  ref_min_n: 4,
  position_bps: 0.25,
  position_lo: 150,
  position_hi: 4000,
};

export const MODEL_VERSION = 'fathom-1';

const BANNED_CATEGORY = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const DAY_MS = 86_400_000;

/** Stated gas assumptions in USD. The snapshot has no fee field. Unknown chains use 0.40. */
export const GAS_USD: Record<string, number> = {
  Ethereum: 4, Arbitrum: 0.25, Base: 0.12, Optimism: 0.2, Polygon: 0.05, Avalanche: 0.2,
  Binance: 0.08, Solana: 0.02, Bitcoin: 1.5, Tron: 0.3, 'Hyperliquid L1': 0.05, Scroll: 0.15,
  Linea: 0.12, Mantle: 0.08, Sonic: 0.05, Sui: 0.02, 'zkSync Era': 0.15, Monad: 0.1, Plasma: 0.08,
  Berachain: 0.12, Unichain: 0.12, Celo: 0.05, Fantom: 0.08, xDai: 0.04, TON: 0.05, Sei: 0.04,
  Cardano: 0.25, Ripple: 0.02, 'Robinhood Chain': 0.1, Algorand: 0.01, Ink: 0.1, Stable: 0.1,
  Morph: 0.1, Aptos: 0.02, Blast: 0.08, Gnosis: 0.04, Stellar: 0.01, Starknet: 0.12, Manta: 0.08,
  Kava: 0.05, 'World Chain': 0.1, Flare: 0.02, RSK: 0.08, Ronin: 0.02, Bittensor: 0.05,
  'Plume Mainnet': 0.1, Mezo: 0.1, Noble: 0.05, Stacks: 0.15, Provenance: 0.08, Canton: 0.1,
  Klaytn: 0.05, Tempo: 0.1, Arc: 0.1, RISE: 0.1, Bifrost: 0.05, 'Bifrost Network': 0.05,
};

const DEFAULT_GAS = 0.4;

export interface Comp {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

export interface LaunchInput {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  on_watchlist: boolean;
}

export interface ParentRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
}

export interface FitCategory {
  category: string;
  n: number;
  raw: number;
  shrunk: number;
  tvl_ref: number;
}

export interface Fit {
  comp_count: number;
  winsor_lo: number;
  winsor_hi: number;
  global_median: number;
  beta_hat: number;
  beta_used: number;
  elasticity_r2: number;
  tvl_ref: number;
  categories: FitCategory[];
  median_abs_log_error: number;
}

export interface Factors {
  multiple: number;
  size: number;
  growth: number;
  tenure: number;
  breadth: number;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  token_status: 'pre-token';
  implied_value_usd: number;
  factors: Factors;
  comp_n: number;
  farm_steps: string[];
}

export interface RadarPayload {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  protocols: number;
  watchlist_size: number;
  token_unpriced: number;
  zero_mcap: number;
  assumptions: typeof ASSUMPTIONS;
  launches: LaunchInput[];
  comps: Comp[];
  parents: ParentRow[];
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const m = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
}

export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.round(p * (sorted.length - 1));
  return sorted[Math.min(sorted.length - 1, Math.max(0, i))]!;
}

export function ols(xs: number[], ys: number[]): { a: number; b: number; r2: number } {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
    sxx += xs[i]! * xs[i]!;
    sxy += xs[i]! * ys[i]!;
  }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const a = (sy - b * sx) / n;
  let ss = 0, sst = 0;
  const my = sy / n;
  for (let i = 0; i < n; i++) {
    const e = ys[i]! - (a + b * xs[i]!);
    ss += e * e;
    sst += (ys[i]! - my) ** 2;
  }
  return { a, b, r2: sst === 0 ? 0 : 1 - ss / sst };
}

function geoMedian(values: number[]): number {
  return Math.exp(median(values.map((v) => Math.log(v)).sort((a, b) => a - b)));
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Why a pre-token protocol fails a screen we can run from the ten snapshot fields. */
export function visibleExclusion(p: SnapshotProtocol): string | null {
  if (p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null) return 'token';
  if (p.category !== null && BANNED_CATEGORY.has(p.category)) return 'category';
  if (VERSIONED.test(p.name)) return 'version';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped';
  if (EXCHANGES.some((e) => p.name === e || p.name.startsWith(`${e} `))) return 'exchange';
  return null;
}

export function isComp(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX';
}

export function fitComparables(comps: Comp[]): Fit {
  const A = ASSUMPTIONS;
  const ratios = comps.map((c) => c.mcap_usd / c.tvl_usd).sort((a, b) => a - b);
  const lo = quantile(ratios, A.winsor_p);
  const hi = quantile(ratios, 1 - A.winsor_p);
  const clip = (r: number): number => Math.min(hi, Math.max(lo, r));
  const globalMedian = median(comps.map((c) => clip(c.mcap_usd / c.tvl_usd)).sort((a, b) => a - b));
  const xs = comps.map((c) => Math.log(c.tvl_usd));
  const ys = comps.map((c) => Math.log(c.mcap_usd));
  const fit = ols(xs, ys);
  const betaUsed = 1 + (fit.b - 1) * A.elasticity_damp;
  const tvlRef = geoMedian(comps.map((c) => c.tvl_usd));
  const groups = new Map<string, Comp[]>();
  for (const c of comps) {
    const key = c.category ?? 'Uncategorized';
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  const categories: FitCategory[] = [...groups.keys()].sort().map((category) => {
    const rows = groups.get(category)!;
    const raw = median(rows.map((r) => clip(r.mcap_usd / r.tvl_usd)).sort((a, b) => a - b));
    const shrunk = (rows.length * raw + A.shrinkage_k * globalMedian) / (rows.length + A.shrinkage_k);
    const ref = rows.length >= A.ref_min_n ? geoMedian(rows.map((r) => r.tvl_usd)) : tvlRef;
    return { category, n: rows.length, raw: round6(raw), shrunk: round6(shrunk), tvl_ref: ref };
  });
  const byName = new Map(categories.map((c) => [c.category, c]));
  const errors: number[] = [];
  for (const c of comps) {
    const cat = byName.get(c.category ?? 'Uncategorized');
    const multiple = cat ? cat.shrunk : globalMedian;
    const ref = cat ? cat.tvl_ref : tvlRef;
    let size = Math.pow(c.tvl_usd / ref, betaUsed - 1);
    size = Math.min(A.size_hi, Math.max(A.size_lo, size));
    const structural = c.tvl_usd * multiple * size;
    if (structural > 0 && c.mcap_usd > 0) errors.push(Math.abs(Math.log(structural / c.mcap_usd)));
  }
  errors.sort((a, b) => a - b);
  return {
    comp_count: comps.length,
    winsor_lo: lo,
    winsor_hi: hi,
    global_median: round6(globalMedian),
    beta_hat: round6(fit.b),
    beta_used: round6(betaUsed),
    elasticity_r2: round6(fit.r2),
    tvl_ref: tvlRef,
    categories,
    median_abs_log_error: errors.length ? median(errors) : 0,
  };
}

export function scoreLaunch(p: LaunchInput, fit: Fit, agePrior: number, asOf: string): { implied: number; factors: Factors; age: number | null; comp_n: number } {
  const A = ASSUMPTIONS;
  const key = p.category ?? 'Uncategorized';
  const cat = fit.categories.find((c) => c.category === key);
  const multiple = cat ? cat.shrunk : fit.global_median;
  const ref = cat ? cat.tvl_ref : fit.tvl_ref;
  let size = Math.pow(p.tvl_usd / ref, fit.beta_used - 1);
  size = Math.min(A.size_hi, Math.max(A.size_lo, size));
  const gRaw = p.change_7d === null ? 0 : p.change_7d;
  const g = Math.min(A.growth_hi, Math.max(A.growth_lo, gRaw));
  const growth = 1 + (g / 100) * A.growth_weight;
  const age = ageDays(asOf, p.listed_at);
  const usedAge = age === null ? agePrior : age;
  const tenure = A.tenure_floor + (A.tenure_span * Math.min(Math.max(usedAge, 0), A.tenure_cap_days)) / A.tenure_cap_days;
  const extra = Math.min(Math.max(p.chains.length, 1) - 1, A.breadth_extra_cap);
  const breadth = 1 + A.breadth_per_chain * extra;
  const factors: Factors = {
    multiple: round6(multiple),
    size: round6(size),
    growth: round6(growth),
    tenure: round6(tenure),
    breadth: round6(breadth),
  };
  const implied = Math.max(1, Math.round(p.tvl_usd * factors.multiple * factors.size * factors.growth * factors.tenure * factors.breadth));
  return { implied, factors, age, comp_n: cat ? cat.n : 0 };
}

export function positionUsd(tvl: number): number {
  const A = ASSUMPTIONS;
  const raw = tvl * (A.position_bps / 10_000);
  let cap = Math.round(raw / 10) * 10;
  if (cap < A.position_lo) cap = A.position_lo;
  if (cap > A.position_hi) cap = A.position_hi;
  return cap;
}

export function kindOf(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('curator') || c.includes('allocator') || c.includes('index')) return 'vault';
  if (c.includes('leverag')) return 'lev';
  if (c.includes('basis')) return 'basis';
  if (c.includes('prediction')) return 'predict';
  if (c.includes('insurance') || c.includes('cover')) return 'cover';
  if (c.includes('payment') || c.includes('card')) return 'pay';
  if (c.includes('govern')) return 'gov';
  if (c.includes('rwa') || c.includes('cedefi')) return 'rwa';
  if (c.includes('cdp')) return 'cdp';
  if (c.includes('lend') || c.includes('collateral')) return 'lend';
  if (c.includes('dex') || c.includes('liquidity')) return 'dex';
  if (c.includes('deriv') || c.includes('perpet') || c.includes('option')) return 'perps';
  if (c.includes('stak') || c.includes('restak')) return 'stake';
  if (c.includes('stable') || c.includes('wrapper')) return 'stable';
  if (c.includes('btc')) return 'btc';
  if (c.includes('chain')) return 'chain';
  if (c.includes('yield') || c.includes('farm')) return 'yield';
  return 'deposit';
}

function money0(n: number): string {
  return `$${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function fmtUsd(n: number): string {
  const v = Math.abs(n);
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return money0(v);
}

function fmtPct(n: number): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function fmtGas(usd: number): string {
  if (usd < 0.01) return 'under $0.01';
  return `$${usd.toFixed(2)}`;
}

function gasFor(chain: string): { usd: number; known: boolean } {
  if (Object.prototype.hasOwnProperty.call(GAS_USD, chain)) return { usd: GAS_USD[chain]!, known: true };
  return { usd: DEFAULT_GAS, known: false };
}

function sizeClause(cap: number, tvl: number): string {
  const bp = (cap / tvl) * 10_000;
  const bpText = bp >= 0.1 ? bp.toFixed(2) : bp.toFixed(3);
  if (cap >= ASSUMPTIONS.position_hi) return `${money0(cap)} is the $4,000 cap (${bpText} bp of ${fmtUsd(tvl)} TVL)`;
  if (cap <= ASSUMPTIONS.position_lo && tvl * (ASSUMPTIONS.position_bps / 10_000) < ASSUMPTIONS.position_lo) {
    return `${money0(cap)} is the $150 floor (${bpText} bp of ${fmtUsd(tvl)} TVL)`;
  }
  return `${money0(cap)} is 0.25 bp of ${fmtUsd(tvl)} TVL`;
}

function holdDays(age: number | null, change: number | null): { days: number; why: string } {
  if (age !== null && age < 120) return { days: 45, why: `it was listed ${age} days ago, so 45 days covers more than one likely snapshot` };
  if (change !== null && change >= 15) return { days: 21, why: `TVL is up ${fmtPct(change)} on the week, so the hold is 21 days instead of adding a second deposit` };
  if (age !== null && age >= 730) return { days: 28, why: `it has been listed ${Math.round(age / 365)} years, and 28 days is enough to be a repeat user` };
  return { days: 35, why: '35 days is five weekly actions on a protocol with an ordinary record' };
}

interface Play {
  open: string;
  weekly: string;
  risk: string;
  drag: number;
  dragWhy: string;
}

function play(kind: string, name: string, chain: string, cap: number, tvl: number, hold: number): Play {
  const sized = sizeClause(cap, tvl);
  if (kind === 'vault') {
    return {
      open: `Deposit ${money0(cap)} of USDC into ${name}'s primary vault on ${chain}. ${sized}, so the wallet is a real depositor and the trade does not move the vault.`,
      weekly: `Once a week, claim points or rewards ${name} shows in the app, or move $25 between the vault and the wallet if nothing is claimable.`,
      risk: `Curators allocate onward. Read ${name}'s current asset list before the deposit, and stop if the vault is gated.`,
      drag: cap * 0.0015,
      dragWhy: '0.15% of capital as a placeholder vault fee, because the snapshot has no fee field',
    };
  }
  if (kind === 'lend') {
    const borrow = Math.max(10, Math.round(cap * 0.15));
    const interest = cap * 0.15 * 0.08 * (hold / 365);
    return {
      open: `Supply ${money0(cap)} of USDC on ${name} on ${chain}, then borrow ${money0(borrow)} of USDC (15% of the deposit) so the wallet is on both sides. ${sized}.`,
      weekly: `Once a week, adjust the ${name} borrow by $10 so the position changes without raising loan-to-value.`,
      risk: `Keep loan-to-value under 20% so liquidation is not the risk. If the borrow rate in the app spikes above 25% APR, repay.`,
      drag: interest,
      dragWhy: `8% APR on the 15% borrowed slice for ${hold} days (a stated rate; the snapshot has no borrow market)`,
    };
  }
  if (kind === 'cdp') {
    const mint = Math.max(10, Math.round(cap * 0.1));
    return {
      open: `Lock ${money0(cap)} of collateral on ${name} on ${chain} and mint ${money0(mint)} of its stable (10% of collateral) so liquidation distance stays wide. ${sized}.`,
      weekly: `Once a week, repay $10 of the ${name} mint or add $10 of collateral, whichever the app makes cheaper.`,
      risk: `If ${name} shows a max loan-to-value, stay under a quarter of it. Unwind if the collateral price feed in the app stalls.`,
      drag: mint * 0.005 * (hold / 30),
      dragWhy: '0.5% of the minted amount per 30 days as a placeholder stability fee',
    };
  }
  if (kind === 'dex') {
    return {
      open: `Add ${money0(cap)} of liquidity to ${name}'s deepest stable pool on ${chain}, half USDC and half the pool's other asset. ${sized}.`,
      weekly: `Once a week, swap $25 through that ${name} pool so the address has volume as well as liquidity.`,
      risk: `Impermanent loss is the risk, not liquidation. Leave if the pool in the app is no longer the deepest stable pool.`,
      drag: cap * 0.01,
      dragWhy: '1% of capital as a working impermanent-loss budget, not a quote',
    };
  }
  if (kind === 'yield' || kind === 'lev') {
    const lev = kind === 'lev' ? ` Use ${name}'s lowest leverage setting, not the default if the default is above 2x.` : '';
    return {
      open: `Deposit ${money0(cap)} of USDC into ${name}'s primary yield vault on ${chain}.${lev} ${sized}.`,
      weekly: `Once a week, harvest ${name} if the app pays a reward, otherwise top up $10 so the position is touched.`,
      risk: kind === 'lev'
        ? `Leverage can liquidate. Stay on the lowest setting and unwind if health in the app drops under 1.5.`
        : `The vault can change strategy. Unwind if ${name} adds an asset you did not read on the deposit screen.`,
      drag: cap * (kind === 'lev' ? 0.004 : 0.002),
      dragWhy: kind === 'lev' ? '0.4% of capital as a placeholder for leverage funding' : '0.2% of capital as a placeholder vault fee',
    };
  }
  if (kind === 'perps') {
    return {
      open: `Deposit ${money0(cap)} of USDC as margin on ${name} on ${chain} and open a 1x hedge, notional equal to the deposit, not a directional punt. ${sized}.`,
      weekly: `Once a week, place one reduce-only order on ${name} for about 10% of the position so the account shows volume, then restore 1x.`,
      risk: `Do not raise leverage above 1x. Unwind if margin health in the app drops under 50%.`,
      drag: cap * 0.0005 * Math.max(1, Math.round(hold / 7)),
      dragWhy: '5 bps taker on one full-notional trade each week, a stated fee schedule',
    };
  }
  if (kind === 'basis') {
    return {
      open: `Open ${name}'s delta-neutral basis position on ${chain} with ${money0(cap)}, not a directional leg. ${sized}.`,
      weekly: `Once a week, check funding on ${name} and roll or rebalance if the app requires it; otherwise record the funding print.`,
      risk: `A basis book loses money if funding flips and you do not roll. Unwind if the app shows seven days of funding against the position.`,
      drag: cap * 0.002,
      dragWhy: '0.2% of capital as a placeholder for fees and adverse funding',
    };
  }
  if (kind === 'rwa') {
    return {
      open: `After eligibility clears, subscribe ${money0(cap)} to ${name} on ${chain} at the app's minimum if the minimum is lower, otherwise this size. ${sized}.`,
      weekly: `Once a week, open ${name}'s position page and record the NAV. Do not churn a subscription that charges a round trip.`,
      risk: `Redemption can be gated. Do not farm an RWA you cannot exit inside the hold, and do not pay a broker who is not the issuer's own page.`,
      drag: 0,
      dragWhy: 'no fee is assumed, because an RWA subscription fee has to come from the issuer page',
    };
  }
  if (kind === 'stake') {
    return {
      open: `Stake ${money0(cap)} worth of the asset ${name} accepts on ${chain} (the gas asset or the LST the deposit screen names). ${sized}.`,
      weekly: `Once a week, claim or restake the receipt ${name} issued, or compound if the app has a compound button.`,
      risk: `The receipt can depeg from the asset you staked. Unwind if the app shows the receipt more than 2% off the asset.`,
      drag: cap * 0.001,
      dragWhy: '0.1% of capital as a placeholder for a staking commission',
    };
  }
  if (kind === 'predict') {
    return {
      open: `On ${name}, buy ${money0(cap)} of shares in the highest-volume market, split across both outcomes if the app allows a hedged ticket. This is activity, not a view. ${sized}.`,
      weekly: `Once a week, trade $20 on ${name} in that same market so the address stays active.`,
      risk: `You can lose the stake. Do not add capital if the market resolves inside the hold; the $20 trades are the cap on extra risk.`,
      drag: cap * 0.02,
      dragWhy: '2% of capital as a placeholder for spread and a small unhedged residual',
    };
  }
  if (kind === 'pay') {
    return {
      open: `Fund ${name} on ${chain} with ${money0(cap)} of USDC from the fresh wallet. ${sized}.`,
      weekly: `Once a week, send $50 through ${name} to a second wallet you control, then send it back if the app allows, so the flow is a loop not a gift.`,
      risk: `A payment farm should not strand funds. Unwind if a transfer is still pending the next day.`,
      drag: 6 * 0.5,
      dragWhy: 'a $0.50 placeholder per weekly transfer for six weeks at most, because the snapshot has no fee',
    };
  }
  if (kind === 'cover') {
    return {
      open: `Buy ${money0(cap)} of cover from ${name} on ${chain} for the hold, on a market the app already lists. ${sized}.`,
      weekly: `Once a week, open the ${name} policy page and confirm it is still active. Renew only inside the app.`,
      risk: `Cover that excludes the hold's dates is wasted. Read the exclusion list before paying.`,
      drag: cap * 0.01,
      dragWhy: '1% of covered amount as a placeholder premium',
    };
  }
  if (kind === 'gov') {
    return {
      open: `Deposit ${money0(cap)} into ${name} on ${chain} if the app takes a deposit, and cast one vote on the live proposal if one is open. ${sized}.`,
      weekly: `Once a week, check ${name} for a new proposal and vote, or refresh the lock if there is nothing to vote.`,
      risk: `A lock you cannot exit inside the hold is a bigger cost than the farm. Skip the lock if the unlock is longer than the hold.`,
      drag: 0,
      dragWhy: 'no fee is assumed for a vote',
    };
  }
  if (kind === 'stable') {
    return {
      open: `Mint or deposit ${money0(cap)} of the stable asset through ${name} on ${chain}. ${sized}.`,
      weekly: `Once a week, transfer $25 of that stable through ${name} and back so the address has more than a mint.`,
      risk: `Depeg is the risk. Unwind if the app or the pool shows the asset more than 1% off a dollar.`,
      drag: cap * 0.001,
      dragWhy: '0.1% of capital as a placeholder mint fee',
    };
  }
  if (kind === 'btc') {
    return {
      open: `Mint or deposit ${money0(cap)} worth of the bitcoin receipt ${name} issues on ${chain}, using the asset the deposit screen names. ${sized}.`,
      weekly: `Once a week, open the ${name} position and record the receipt's price against bitcoin. Do not churn if a round trip is costly.`,
      risk: `The receipt is a claim on bitcoin, not a new business, unless the app says otherwise. Unwind if it trades more than 1.5% off bitcoin.`,
      drag: cap * 0.002,
      dragWhy: '0.2% of capital as a placeholder mint and redeem cost',
    };
  }
  if (kind === 'chain') {
    return {
      open: `Move ${money0(cap)} of USDC onto ${chain} through ${name}'s own deposit and hold it in the app's wallet. ${sized}.`,
      weekly: `Once a week, make one transfer of $25 on ${chain} inside ${name} so the address is a user of the chain, not only a depositor.`,
      risk: `Bridge delays strand capital. Unwind only by the app's own exit, and stop if a withdrawal is unpaid the next day.`,
      drag: cap * 0.001,
      dragWhy: '0.1% of capital as a placeholder for the move onto the chain',
    };
  }
  return {
    open: `Deposit ${money0(cap)} of USDC into ${name} on ${chain} through the primary action on the app's first screen. ${sized}.`,
    weekly: `Once a week, touch the ${name} position with a $25 action (claim, top-up or a small second deposit) so two snapshots can see it.`,
    risk: `If the app's only action is a lock longer than the hold, do not enter. Unwind if the position cannot be read back the next day.`,
    drag: cap * 0.001,
    dragWhy: '0.1% of capital as a placeholder fee',
  };
}

function step(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Record the transaction in the farm log.`;
  return s;
}

/** Seven concrete steps. Cost and time are on every step. Names come from the row, never a hand list. */
export function farmSteps(p: LaunchInput, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const gas = gasFor(chain);
  const cap = positionUsd(p.tvl_usd);
  const hold = holdDays(age, p.change_7d);
  const kind = kindOf(p.category);
  const plan = play(kind, p.name, chain, cap, p.tvl_usd, hold.days);
  const weeks = Math.max(1, Math.round(hold.days / 7));
  const gasKnown = gas.known ? `${fmtGas(gas.usd)} assumed gas on ${chain}` : `${fmtGas(gas.usd)} default gas, because ${chain} has no row in the gas table`;
  const chainsNote = p.chains.length > 1 ? ` DefiLlama lists ${p.chains.length} chains, starting with ${chain}; do the whole position there and do not split.` : '';
  const band = Math.max(15, Math.min(40, Math.round(Math.abs(p.change_7d === null ? 0 : p.change_7d) + 10)));
  const weekPrint = p.change_7d === null ? '7-day TVL change was not reported' : `the last 7-day TVL move was ${fmtPct(p.change_7d)}`;
  const cash = gas.usd * (2 + weeks) + plan.drag;
  const kyc = kind === 'rwa' || kind === 'pay';
  return [
    step(
      `Create a fresh wallet used only for ${p.name} and fund it on ${chain} with ${money0(cap)} of USDC plus gas for the hold.${chainsNote}`,
      `${money0(cap)} of capital and ${gasKnown} to fund`,
      '15 minutes',
    ),
    kyc
      ? step(
          `Complete ${p.name}'s own eligibility check before any deposit. If a page that is not the app asks for a fee, stop.`,
          '$0 unless the protocol\'s own page states a fee, which you pay only there',
          '1 to 2 days',
        )
      : step(
          `Open ${p.name} from an address you type yourself. Read the deposit screen and any points page, and confirm the chain is ${chain}, before you sign.`,
          'no transaction',
          '10 minutes',
        ),
    step(plan.open, `${money0(cap)} already funded in step 1, plus ${gasKnown} to open`, '20 minutes'),
    step(plan.weekly, `${gasKnown} each week`, '10 minutes a week'),
    step(
      `Unwind ${p.name} if its TVL falls more than ${band}% from the snapshot print of ${fmtUsd(p.tvl_usd)} (${weekPrint}). ${plan.risk}`,
      'no fee to set the limit',
      '5 minutes',
    ),
    step(
      `Hold for ${hold.days} days because ${hold.why}. Cash besides the principal is about ${money0(Math.max(1, Math.round(cash)))}: gas for the fund, the open and ${weeks} weekly actions, plus ${money0(Math.round(plan.drag))} for ${plan.dragWhy}.`,
      `about ${money0(Math.max(1, Math.round(cash)))} of fees and gas; the ${money0(cap)} principal stays in the position and is not a fee`,
      `${hold.days} days`,
    ),
    step(
      `Log the wallet, the open date, each weekly transaction and the unwind date. Withdraw inside ${p.name} and claim only there. Do not pay anyone else to claim.`,
      `${gasKnown} to withdraw, and nothing to claim`,
      '15 minutes at the end',
    ),
  ];
}

function bySlug<T extends { slug: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

export function classify(snapshot: { floor_usd: number; watchlist: string[]; protocols: SnapshotProtocol[] }): {
  launches: LaunchInput[];
  comps: Comp[];
  parents: ParentRow[];
  token_unpriced: number;
  zero_mcap: number;
} {
  const watch = new Set(snapshot.watchlist);
  const launches: LaunchInput[] = [];
  const parents: ParentRow[] = [];
  const comps: Comp[] = [];
  let tokenUnpriced = 0;
  let zeroMcap = 0;
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === 0) zeroMcap += 1;
    if (p.mcap_usd === null && (p.gecko_id !== null || p.symbol !== null)) tokenUnpriced += 1;
    if (isComp(p)) {
      comps.push({
        slug: p.slug,
        name: p.name,
        category: p.category,
        chains: p.chains,
        tvl_usd: p.tvl_usd,
        mcap_usd: p.mcap_usd!,
        change_7d: p.change_7d,
      });
    }
    const exclusion = visibleExclusion(p);
    if (exclusion !== null) continue;
    const row = {
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
    };
    if (watch.has(p.slug) || p.tvl_usd < snapshot.floor_usd) {
      launches.push({ ...row, listed_at: p.listed_at, on_watchlist: watch.has(p.slug) });
    } else {
      parents.push(row);
    }
  }
  return {
    launches: bySlug(launches),
    comps: bySlug(comps),
    parents: bySlug(parents),
    token_unpriced: tokenUnpriced,
    zero_mcap: zeroMcap,
  };
}

export function agePriorOf(launches: LaunchInput[], asOf: string): number {
  const ages = launches.map((p) => ageDays(asOf, p.listed_at)).filter((a): a is number => a !== null).sort((a, b) => a - b);
  return ages.length ? median(ages) : 365;
}

export function buildBoard(snapshot: { as_of: string; floor_usd: number; watchlist: string[]; protocols: SnapshotProtocol[] }): { board: BoardRow[]; fit: Fit; agePrior: number } {
  const { launches, comps } = classify(snapshot);
  const fit = fitComparables(comps);
  const agePrior = agePriorOf(launches, snapshot.as_of);
  const scored = launches.map((p) => {
    const s = scoreLaunch(p, fit, agePrior, snapshot.as_of);
    return { p, ...s };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.age,
    on_watchlist: s.p.on_watchlist,
    token_status: 'pre-token',
    implied_value_usd: s.implied,
    factors: s.factors,
    comp_n: s.comp_n,
    farm_steps: farmSteps(s.p, s.age),
  }));
  return { board, fit, agePrior };
}

export function buildPayload(snapshot: { as_of: string; source: string; floor_usd: number; watchlist: string[]; protocols: SnapshotProtocol[] }): RadarPayload {
  const classified = classify(snapshot);
  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    protocols: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    token_unpriced: classified.token_unpriced,
    zero_mcap: classified.zero_mcap,
    assumptions: ASSUMPTIONS,
    launches: classified.launches,
    comps: classified.comps,
    parents: classified.parents,
  };
}

export function boardIssue(board: BoardRow[], watchlist: string[]): string | null {
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'duplicate slug';
  const missing = watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `missing watchlist: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank gap at ${i + 1}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `rank order breaks at ${board[i]!.slug}`;
  }
  if (board.length >= 2 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) return 'implied values are all equal';
  for (const r of board) {
    if (!r.name) return `${r.slug} has an empty name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} implied ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} steps`;
    for (const stepText of r.farm_steps) {
      const t = stepText.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} step length ${t.length}`;
    }
  }
  return null;
}

export function dataScript(payload: RadarPayload): string {
  return `window.RADAR=${JSON.stringify(payload)};\n`;
}
