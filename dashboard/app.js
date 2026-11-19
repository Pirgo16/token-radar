// Implied FDV = TVL x shrunk category mcap/TVL x size x growth x tenure x breadth.
// fitComparables winsorizes mcap/TVL at p10-p90, takes the category median, and
// shrinks it toward the market median with k = 6. Size is TVL^(beta-1) against
// the category reference TVL. Beta is the log-log elasticity of market cap on
// TVL, damped 55% toward 1 because the raw fit is weak. Growth is one clamped
// week at weight 0.35. Tenure runs from 0.70 to 1.15 across four years listed
// with no token. Breadth adds 0.035 per extra chain, capped at ten.
// No protocol name is special-cased. Fees, revenue and users are not in the
// sealed snapshot, so none are invented: a comparable's market cap already
// capitalizes them. farmSteps prices a position from TVL and a stated gas table.
var ASSUMPTIONS = {
  shrinkage_k: 6, winsor_p: 0.1, elasticity_damp: 0.55,
  growth_weight: 0.35, growth_lo: -40, growth_hi: 80,
  tenure_floor: 0.7, tenure_span: 0.45, tenure_cap_days: 1460,
  breadth_per_chain: 0.035, breadth_extra_cap: 10,
  size_lo: 0.4, size_hi: 2.2, ref_min_n: 4,
  position_bps: 0.25, position_lo: 150, position_hi: 4000
};
var GAS_USD = {
  Ethereum: 4, Arbitrum: 0.25, Base: 0.12, Optimism: 0.2, Polygon: 0.05, Avalanche: 0.2,
  Binance: 0.08, Solana: 0.02, Bitcoin: 1.5, Tron: 0.3, "Hyperliquid L1": 0.05, Scroll: 0.15,
  Linea: 0.12, Mantle: 0.08, Sonic: 0.05, Sui: 0.02, "zkSync Era": 0.15, Monad: 0.1, Plasma: 0.08,
  Berachain: 0.12, Unichain: 0.12, Celo: 0.05, Fantom: 0.08, xDai: 0.04, TON: 0.05, Sei: 0.04,
  Cardano: 0.25, Ripple: 0.02, "Robinhood Chain": 0.1, Algorand: 0.01, Ink: 0.1, Stable: 0.1,
  Morph: 0.1, Aptos: 0.02, Blast: 0.08, Gnosis: 0.04, Stellar: 0.01, Starknet: 0.12, Manta: 0.08,
  Kava: 0.05, "World Chain": 0.1, Flare: 0.02, RSK: 0.08, Ronin: 0.02, Bittensor: 0.05,
  "Plume Mainnet": 0.1, Mezo: 0.1, Noble: 0.05, Stacks: 0.15, Provenance: 0.08, Canton: 0.1,
  Klaytn: 0.05, Tempo: 0.1, Arc: 0.1, RISE: 0.1, Bifrost: 0.05, "Bifrost Network": 0.05
};
var DEFAULT_GAS = 0.4;

function ageDays(asOf, listedAt) {
  if (listedAt === null || listedAt === undefined) return null;
  var a = Date.parse(asOf + "T00:00:00Z");
  var b = Date.parse(listedAt + "T00:00:00Z");
  if (!isFinite(a) || !isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / 86400000));
}
function median(sorted) {
  var n = sorted.length;
  if (n === 0) return 0;
  var m = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}
function quantile(sorted, p) {
  if (sorted.length === 0) return 0;
  var i = Math.round(p * (sorted.length - 1));
  return sorted[Math.min(sorted.length - 1, Math.max(0, i))];
}
function ols(xs, ys) {
  var n = xs.length, sx = 0, sy = 0, sxx = 0, sxy = 0, i;
  for (i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  var b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  var a = (sy - b * sx) / n;
  var ss = 0, sst = 0, my = sy / n;
  for (i = 0; i < n; i++) {
    var e = ys[i] - (a + b * xs[i]);
    ss += e * e;
    sst += (ys[i] - my) * (ys[i] - my);
  }
  return { a: a, b: b, r2: sst === 0 ? 0 : 1 - ss / sst };
}
function geoMedian(values) {
  return Math.exp(median(values.map(function (v) { return Math.log(v); }).sort(function (a, b) { return a - b; })));
}
function round6(n) { return Math.round(n * 1e6) / 1e6; }

function fitComparables(comps) {
  var A = ASSUMPTIONS;
  var ratios = comps.map(function (c) { return c.mcap_usd / c.tvl_usd; }).sort(function (a, b) { return a - b; });
  var lo = quantile(ratios, A.winsor_p);
  var hi = quantile(ratios, 1 - A.winsor_p);
  function clip(r) { return Math.min(hi, Math.max(lo, r)); }
  var globalMedian = median(comps.map(function (c) { return clip(c.mcap_usd / c.tvl_usd); }).sort(function (a, b) { return a - b; }));
  var fit = ols(comps.map(function (c) { return Math.log(c.tvl_usd); }), comps.map(function (c) { return Math.log(c.mcap_usd); }));
  var betaUsed = 1 + (fit.b - 1) * A.elasticity_damp;
  var tvlRef = geoMedian(comps.map(function (c) { return c.tvl_usd; }));
  var groups = new Map();
  comps.forEach(function (c) {
    var key = c.category || "Uncategorized";
    var list = groups.get(key);
    if (list) list.push(c); else groups.set(key, [c]);
  });
  var categories = Array.from(groups.keys()).sort().map(function (category) {
    var rows = groups.get(category);
    var raw = median(rows.map(function (r) { return clip(r.mcap_usd / r.tvl_usd); }).sort(function (a, b) { return a - b; }));
    var shrunk = (rows.length * raw + A.shrinkage_k * globalMedian) / (rows.length + A.shrinkage_k);
    var ref = rows.length >= A.ref_min_n ? geoMedian(rows.map(function (r) { return r.tvl_usd; })) : tvlRef;
    return { category: category, n: rows.length, raw: round6(raw), shrunk: round6(shrunk), tvl_ref: ref };
  });
  var byName = new Map(categories.map(function (c) { return [c.category, c]; }));
  var errors = [];
  comps.forEach(function (c) {
    var cat = byName.get(c.category || "Uncategorized");
    var multiple = cat ? cat.shrunk : globalMedian;
    var ref = cat ? cat.tvl_ref : tvlRef;
    var size = Math.pow(c.tvl_usd / ref, betaUsed - 1);
    size = Math.min(A.size_hi, Math.max(A.size_lo, size));
    var structural = c.tvl_usd * multiple * size;
    if (structural > 0 && c.mcap_usd > 0) errors.push(Math.abs(Math.log(structural / c.mcap_usd)));
  });
  errors.sort(function (a, b) { return a - b; });
  return {
    comp_count: comps.length, winsor_lo: lo, winsor_hi: hi,
    global_median: round6(globalMedian), beta_hat: round6(fit.b), beta_used: round6(betaUsed),
    elasticity_r2: round6(fit.r2), tvl_ref: tvlRef, categories: categories,
    median_abs_log_error: errors.length ? median(errors) : 0
  };
}

function scoreLaunch(p, fit, agePrior, asOf) {
  var A = ASSUMPTIONS;
  var key = p.category || "Uncategorized";
  var cat = null;
  for (var i = 0; i < fit.categories.length; i++) if (fit.categories[i].category === key) cat = fit.categories[i];
  var multiple = cat ? cat.shrunk : fit.global_median;
  var ref = cat ? cat.tvl_ref : fit.tvl_ref;
  var size = Math.pow(p.tvl_usd / ref, fit.beta_used - 1);
  size = Math.min(A.size_hi, Math.max(A.size_lo, size));
  var gRaw = p.change_7d === null || p.change_7d === undefined ? 0 : p.change_7d;
  var g = Math.min(A.growth_hi, Math.max(A.growth_lo, gRaw));
  var growth = 1 + (g / 100) * A.growth_weight;
  var age = ageDays(asOf, p.listed_at);
  var usedAge = age === null ? agePrior : age;
  var tenure = A.tenure_floor + (A.tenure_span * Math.min(Math.max(usedAge, 0), A.tenure_cap_days)) / A.tenure_cap_days;
  var extra = Math.min(Math.max(p.chains.length, 1) - 1, A.breadth_extra_cap);
  var breadth = 1 + A.breadth_per_chain * extra;
  var factors = { multiple: round6(multiple), size: round6(size), growth: round6(growth), tenure: round6(tenure), breadth: round6(breadth) };
  var implied = Math.max(1, Math.round(p.tvl_usd * factors.multiple * factors.size * factors.growth * factors.tenure * factors.breadth));
  return { implied: implied, factors: factors, age: age, comp_n: cat ? cat.n : 0 };
}

function agePriorOf(launches, asOf) {
  var ages = [];
  for (var i = 0; i < launches.length; i++) {
    var age = ageDays(asOf, launches[i].listed_at);
    if (age !== null) ages.push(age);
  }
  ages.sort(function (a, b) { return a - b; });
  return ages.length ? median(ages) : 365;
}

function rankLaunches(launches, fit, asOf) {
  var prior = agePriorOf(launches, asOf);
  var scored = launches.map(function (p) {
    var s = scoreLaunch(p, fit, prior, asOf);
    return { p: p, implied: s.implied, factors: s.factors, age: s.age, comp_n: s.comp_n };
  });
  scored.sort(function (a, b) { return b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0); });
  return scored.map(function (s, i) {
    return {
      rank: i + 1, slug: s.p.slug, name: s.p.name, category: s.p.category, chains: s.p.chains,
      tvl_usd: s.p.tvl_usd, change_7d: s.p.change_7d, listed_at: s.p.listed_at, on_watchlist: s.p.on_watchlist,
      age_days: s.age, implied_value_usd: s.implied, factors: s.factors, comp_n: s.comp_n,
      farm_steps: farmSteps(s.p, s.age)
    };
  });
}

function positionUsd(tvl) {
  var A = ASSUMPTIONS;
  var cap = Math.round((tvl * (A.position_bps / 10000)) / 10) * 10;
  if (cap < A.position_lo) cap = A.position_lo;
  if (cap > A.position_hi) cap = A.position_hi;
  return cap;
}
function kindOf(category) {
  var c = (category || "").toLowerCase();
  if (c.indexOf("curator") >= 0 || c.indexOf("allocator") >= 0 || c.indexOf("index") >= 0) return "vault";
  if (c.indexOf("leverag") >= 0) return "lev";
  if (c.indexOf("basis") >= 0) return "basis";
  if (c.indexOf("prediction") >= 0) return "predict";
  if (c.indexOf("insurance") >= 0 || c.indexOf("cover") >= 0) return "cover";
  if (c.indexOf("payment") >= 0 || c.indexOf("card") >= 0) return "pay";
  if (c.indexOf("govern") >= 0) return "gov";
  if (c.indexOf("rwa") >= 0 || c.indexOf("cedefi") >= 0) return "rwa";
  if (c.indexOf("cdp") >= 0) return "cdp";
  if (c.indexOf("lend") >= 0 || c.indexOf("collateral") >= 0) return "lend";
  if (c.indexOf("dex") >= 0 || c.indexOf("liquidity") >= 0) return "dex";
  if (c.indexOf("deriv") >= 0 || c.indexOf("perpet") >= 0 || c.indexOf("option") >= 0) return "perps";
  if (c.indexOf("stak") >= 0 || c.indexOf("restak") >= 0) return "stake";
  if (c.indexOf("stable") >= 0 || c.indexOf("wrapper") >= 0) return "stable";
  if (c.indexOf("btc") >= 0) return "btc";
  if (c.indexOf("chain") >= 0) return "chain";
  if (c.indexOf("yield") >= 0 || c.indexOf("farm") >= 0) return "yield";
  return "deposit";
}
function money0(n) { return "$" + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function fmtUsd(n) {
  if (n === null || n === undefined || !isFinite(n)) return "n/a";
  var v = Math.abs(n), sign = n < 0 ? "-" : "";
  if (v >= 1e9) return sign + "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return sign + "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return sign + "$" + (v / 1e3).toFixed(1) + "K";
  return sign + money0(v);
}
function fmtFull(n) { return money0(n); }
function fmtPct(n) {
  if (n === null || n === undefined || !isFinite(n)) return "n/a";
  return (n > 0 ? "+" : "") + n.toFixed(1) + "%";
}
function fmtAge(days) {
  if (days === null || days === undefined) return "unlisted";
  if (days >= 365) return (days / 365).toFixed(1) + "y";
  return Math.round(days) + "d";
}
function fmtGas(usd) { return usd < 0.01 ? "under $0.01" : "$" + usd.toFixed(2); }
function gasFor(chain) {
  if (Object.prototype.hasOwnProperty.call(GAS_USD, chain)) return { usd: GAS_USD[chain], known: true };
  return { usd: DEFAULT_GAS, known: false };
}
function sizeClause(cap, tvl) {
  var bp = (cap / tvl) * 10000;
  var bpText = bp >= 0.1 ? bp.toFixed(2) : bp.toFixed(3);
  if (cap >= ASSUMPTIONS.position_hi) return money0(cap) + " is the $4,000 cap (" + bpText + " bp of " + fmtUsd(tvl) + " TVL)";
  if (cap <= ASSUMPTIONS.position_lo && tvl * (ASSUMPTIONS.position_bps / 10000) < ASSUMPTIONS.position_lo) {
    return money0(cap) + " is the $150 floor (" + bpText + " bp of " + fmtUsd(tvl) + " TVL)";
  }
  return money0(cap) + " is 0.25 bp of " + fmtUsd(tvl) + " TVL";
}
function holdDays(age, change) {
  if (age !== null && age < 120) return { days: 45, why: "it was listed " + age + " days ago, so 45 days covers more than one likely snapshot" };
  if (change !== null && change >= 15) return { days: 21, why: "TVL is up " + fmtPct(change) + " on the week, so the hold is 21 days instead of adding a second deposit" };
  if (age !== null && age >= 730) return { days: 28, why: "it has been listed " + Math.round(age / 365) + " years, and 28 days is enough to be a repeat user" };
  return { days: 35, why: "35 days is five weekly actions on a protocol with an ordinary record" };
}
function play(kind, name, chain, cap, tvl, hold) {
  var sized = sizeClause(cap, tvl);
  if (kind === "vault") return {
    open: "Deposit " + money0(cap) + " of USDC into " + name + "'s primary vault on " + chain + ". " + sized + ", so the wallet is a real depositor and the trade does not move the vault.",
    weekly: "Once a week, claim points or rewards " + name + " shows in the app, or move $25 between the vault and the wallet if nothing is claimable.",
    risk: "Curators allocate onward. Read " + name + "'s current asset list before the deposit, and stop if the vault is gated.",
    drag: cap * 0.0015, dragWhy: "0.15% of capital as a placeholder vault fee, because the snapshot has no fee field"
  };
  if (kind === "lend") {
    var borrow = Math.max(10, Math.round(cap * 0.15));
    return {
      open: "Supply " + money0(cap) + " of USDC on " + name + " on " + chain + ", then borrow " + money0(borrow) + " of USDC (15% of the deposit) so the wallet is on both sides. " + sized + ".",
      weekly: "Once a week, adjust the " + name + " borrow by $10 so the position changes without raising loan-to-value.",
      risk: "Keep loan-to-value under 20% so liquidation is not the risk. If the borrow rate in the app spikes above 25% APR, repay.",
      drag: cap * 0.15 * 0.08 * (hold / 365),
      dragWhy: "8% APR on the 15% borrowed slice for " + hold + " days (a stated rate; the snapshot has no borrow market)"
    };
  }
  if (kind === "cdp") {
    var mint = Math.max(10, Math.round(cap * 0.1));
    return {
      open: "Lock " + money0(cap) + " of collateral on " + name + " on " + chain + " and mint " + money0(mint) + " of its stable (10% of collateral) so liquidation distance stays wide. " + sized + ".",
      weekly: "Once a week, repay $10 of the " + name + " mint or add $10 of collateral, whichever the app makes cheaper.",
      risk: "If " + name + " shows a max loan-to-value, stay under a quarter of it. Unwind if the collateral price feed in the app stalls.",
      drag: mint * 0.005 * (hold / 30), dragWhy: "0.5% of the minted amount per 30 days as a placeholder stability fee"
    };
  }
  if (kind === "dex") return {
    open: "Add " + money0(cap) + " of liquidity to " + name + "'s deepest stable pool on " + chain + ", half USDC and half the pool's other asset. " + sized + ".",
    weekly: "Once a week, swap $25 through that " + name + " pool so the address has volume as well as liquidity.",
    risk: "Impermanent loss is the risk, not liquidation. Leave if the pool in the app is no longer the deepest stable pool.",
    drag: cap * 0.01, dragWhy: "1% of capital as a working impermanent-loss budget, not a quote"
  };
  if (kind === "yield" || kind === "lev") {
    var lev = kind === "lev" ? " Use " + name + "'s lowest leverage setting, not the default if the default is above 2x." : "";
    return {
      open: "Deposit " + money0(cap) + " of USDC into " + name + "'s primary yield vault on " + chain + "." + lev + " " + sized + ".",
      weekly: "Once a week, harvest " + name + " if the app pays a reward, otherwise top up $10 so the position is touched.",
      risk: kind === "lev" ? "Leverage can liquidate. Stay on the lowest setting and unwind if health in the app drops under 1.5." : "The vault can change strategy. Unwind if " + name + " adds an asset you did not read on the deposit screen.",
      drag: cap * (kind === "lev" ? 0.004 : 0.002),
      dragWhy: kind === "lev" ? "0.4% of capital as a placeholder for leverage funding" : "0.2% of capital as a placeholder vault fee"
    };
  }
  if (kind === "perps") return {
    open: "Deposit " + money0(cap) + " of USDC as margin on " + name + " on " + chain + " and open a 1x hedge, notional equal to the deposit, not a directional punt. " + sized + ".",
    weekly: "Once a week, place one reduce-only order on " + name + " for about 10% of the position so the account shows volume, then restore 1x.",
    risk: "Do not raise leverage above 1x. Unwind if margin health in the app drops under 50%.",
    drag: cap * 0.0005 * Math.max(1, Math.round(hold / 7)), dragWhy: "5 bps taker on one full-notional trade each week, a stated fee schedule"
  };
  if (kind === "basis") return {
    open: "Open " + name + "'s delta-neutral basis position on " + chain + " with " + money0(cap) + ", not a directional leg. " + sized + ".",
    weekly: "Once a week, check funding on " + name + " and roll or rebalance if the app requires it; otherwise record the funding print.",
    risk: "A basis book loses money if funding flips and you do not roll. Unwind if the app shows seven days of funding against the position.",
    drag: cap * 0.002, dragWhy: "0.2% of capital as a placeholder for fees and adverse funding"
  };
  if (kind === "rwa") return {
    open: "After eligibility clears, subscribe " + money0(cap) + " to " + name + " on " + chain + " at the app's minimum if the minimum is lower, otherwise this size. " + sized + ".",
    weekly: "Once a week, open " + name + "'s position page and record the NAV. Do not churn a subscription that charges a round trip.",
    risk: "Redemption can be gated. Do not farm an RWA you cannot exit inside the hold, and do not pay a broker who is not the issuer's own page.",
    drag: 0, dragWhy: "no fee is assumed, because an RWA subscription fee has to come from the issuer page"
  };
  if (kind === "stake") return {
    open: "Stake " + money0(cap) + " worth of the asset " + name + " accepts on " + chain + " (the gas asset or the LST the deposit screen names). " + sized + ".",
    weekly: "Once a week, claim or restake the receipt " + name + " issued, or compound if the app has a compound button.",
    risk: "The receipt can depeg from the asset you staked. Unwind if the app shows the receipt more than 2% off the asset.",
    drag: cap * 0.001, dragWhy: "0.1% of capital as a placeholder for a staking commission"
  };
  if (kind === "predict") return {
    open: "On " + name + ", buy " + money0(cap) + " of shares in the highest-volume market, split across both outcomes if the app allows a hedged ticket. This is activity, not a view. " + sized + ".",
    weekly: "Once a week, trade $20 on " + name + " in that same market so the address stays active.",
    risk: "You can lose the stake. Do not add capital if the market resolves inside the hold; the $20 trades are the cap on extra risk.",
    drag: cap * 0.02, dragWhy: "2% of capital as a placeholder for spread and a small unhedged residual"
  };
  if (kind === "pay") return {
    open: "Fund " + name + " on " + chain + " with " + money0(cap) + " of USDC from the fresh wallet. " + sized + ".",
    weekly: "Once a week, send $50 through " + name + " to a second wallet you control, then send it back if the app allows, so the flow is a loop not a gift.",
    risk: "A payment farm should not strand funds. Unwind if a transfer is still pending the next day.",
    drag: 6 * 0.5, dragWhy: "a $0.50 placeholder per weekly transfer for six weeks at most, because the snapshot has no fee"
  };
  if (kind === "cover") return {
    open: "Buy " + money0(cap) + " of cover from " + name + " on " + chain + " for the hold, on a market the app already lists. " + sized + ".",
    weekly: "Once a week, open the " + name + " policy page and confirm it is still active. Renew only inside the app.",
    risk: "Cover that excludes the hold's dates is wasted. Read the exclusion list before paying.",
    drag: cap * 0.01, dragWhy: "1% of covered amount as a placeholder premium"
  };
  if (kind === "gov") return {
    open: "Deposit " + money0(cap) + " into " + name + " on " + chain + " if the app takes a deposit, and cast one vote on the live proposal if one is open. " + sized + ".",
    weekly: "Once a week, check " + name + " for a new proposal and vote, or refresh the lock if there is nothing to vote.",
    risk: "A lock you cannot exit inside the hold is a bigger cost than the farm. Skip the lock if the unlock is longer than the hold.",
    drag: 0, dragWhy: "no fee is assumed for a vote"
  };
  if (kind === "stable") return {
    open: "Mint or deposit " + money0(cap) + " of the stable asset through " + name + " on " + chain + ". " + sized + ".",
    weekly: "Once a week, transfer $25 of that stable through " + name + " and back so the address has more than a mint.",
    risk: "Depeg is the risk. Unwind if the app or the pool shows the asset more than 1% off a dollar.",
    drag: cap * 0.001, dragWhy: "0.1% of capital as a placeholder mint fee"
  };
  if (kind === "btc") return {
    open: "Mint or deposit " + money0(cap) + " worth of the bitcoin receipt " + name + " issues on " + chain + ", using the asset the deposit screen names. " + sized + ".",
    weekly: "Once a week, open the " + name + " position and record the receipt's price against bitcoin. Do not churn if a round trip is costly.",
    risk: "The receipt is a claim on bitcoin, not a new business, unless the app says otherwise. Unwind if it trades more than 1.5% off bitcoin.",
    drag: cap * 0.002, dragWhy: "0.2% of capital as a placeholder mint and redeem cost"
  };
  if (kind === "chain") return {
    open: "Move " + money0(cap) + " of USDC onto " + chain + " through " + name + "'s own deposit and hold it in the app's wallet. " + sized + ".",
    weekly: "Once a week, make one transfer of $25 on " + chain + " inside " + name + " so the address is a user of the chain, not only a depositor.",
    risk: "Bridge delays strand capital. Unwind only by the app's own exit, and stop if a withdrawal is unpaid the next day.",
    drag: cap * 0.001, dragWhy: "0.1% of capital as a placeholder for the move onto the chain"
  };
  return {
    open: "Deposit " + money0(cap) + " of USDC into " + name + " on " + chain + " through the primary action on the app's first screen. " + sized + ".",
    weekly: "Once a week, touch the " + name + " position with a $25 action (claim, top-up or a small second deposit) so two snapshots can see it.",
    risk: "If the app's only action is a lock longer than the hold, do not enter. Unwind if the position cannot be read back the next day.",
    drag: cap * 0.001, dragWhy: "0.1% of capital as a placeholder fee"
  };
}
function stepLine(text, cost, time) {
  var s = text + " Cost: " + cost + ". Time: " + time + ".";
  if (s.length > 600) s = s.slice(0, 596) + "...";
  if (s.length < 20) s = s + " Record the transaction in the farm log.";
  return s;
}
function farmSteps(p, age) {
  var chain = p.chains && p.chains.length > 0 ? p.chains[0] : "its main chain";
  var gas = gasFor(chain);
  var cap = positionUsd(p.tvl_usd);
  var hold = holdDays(age, p.change_7d);
  var kind = kindOf(p.category);
  var plan = play(kind, p.name, chain, cap, p.tvl_usd, hold.days);
  var weeks = Math.max(1, Math.round(hold.days / 7));
  var gasKnown = gas.known ? fmtGas(gas.usd) + " assumed gas on " + chain : fmtGas(gas.usd) + " default gas, because " + chain + " has no row in the gas table";
  var chainsNote = p.chains.length > 1 ? " DefiLlama lists " + p.chains.length + " chains, starting with " + chain + "; do the whole position there and do not split." : "";
  var band = Math.max(15, Math.min(40, Math.round(Math.abs(p.change_7d === null || p.change_7d === undefined ? 0 : p.change_7d) + 10)));
  var weekPrint = p.change_7d === null || p.change_7d === undefined ? "7-day TVL change was not reported" : "the last 7-day TVL move was " + fmtPct(p.change_7d);
  var cash = gas.usd * (2 + weeks) + plan.drag;
  var kyc = kind === "rwa" || kind === "pay";
  return [
    stepLine("Create a fresh wallet used only for " + p.name + " and fund it on " + chain + " with " + money0(cap) + " of USDC plus gas for the hold." + chainsNote, money0(cap) + " of capital and " + gasKnown + " to fund", "15 minutes"),
    kyc
      ? stepLine("Complete " + p.name + "'s own eligibility check before any deposit. If a page that is not the app asks for a fee, stop.", "$0 unless the protocol's own page states a fee, which you pay only there", "1 to 2 days")
      : stepLine("Open " + p.name + " from an address you type yourself. Read the deposit screen and any points page, and confirm the chain is " + chain + ", before you sign.", "no transaction", "10 minutes"),
    stepLine(plan.open, money0(cap) + " already funded in step 1, plus " + gasKnown + " to open", "20 minutes"),
    stepLine(plan.weekly, gasKnown + " each week", "10 minutes a week"),
    stepLine("Unwind " + p.name + " if its TVL falls more than " + band + "% from the snapshot print of " + fmtUsd(p.tvl_usd) + " (" + weekPrint + "). " + plan.risk, "no fee to set the limit", "5 minutes"),
    stepLine("Hold for " + hold.days + " days because " + hold.why + ". Cash besides the principal is about " + money0(Math.max(1, Math.round(cash))) + ": gas for the fund, the open and " + weeks + " weekly actions, plus " + money0(Math.round(plan.drag)) + " for " + plan.dragWhy + ".", "about " + money0(Math.max(1, Math.round(cash))) + " of fees and gas; the " + money0(cap) + " principal stays in the position and is not a fee", hold.days + " days"),
    stepLine("Log the wallet, the open date, each weekly transaction and the unwind date. Withdraw inside " + p.name + " and claim only there. Do not pay anyone else to claim.", gasKnown + " to withdraw, and nothing to claim", "15 minutes at the end")
  ];
}
function structuralUsd(c, fit) {
  var A = ASSUMPTIONS;
  var key = c.category || "Uncategorized";
  var cat = null;
  for (var i = 0; i < fit.categories.length; i++) if (fit.categories[i].category === key) cat = fit.categories[i];
  var multiple = cat ? cat.shrunk : fit.global_median;
  var ref = cat ? cat.tvl_ref : fit.tvl_ref;
  var size = Math.pow(c.tvl_usd / ref, fit.beta_used - 1);
  size = Math.min(A.size_hi, Math.max(A.size_lo, size));
  return c.tvl_usd * multiple * size;
}

(function () {
  if (typeof document === "undefined") return;
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById("app");
  var FIT = fitComparables(DATA.comps);
  var ROWS = rankLaunches(DATA.launches, FIT, DATA.as_of);
  var state = { q: "", cat: "all", chain: "all", scope: "all", sort: "implied", dir: -1, view: "launches", selected: null };

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined) return;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, String(v));
    });
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); return; }
    if (typeof child === "string" || typeof child === "number") { node.appendChild(document.createTextNode(String(child))); return; }
    node.appendChild(child);
  }
  function readHash() {
    var params = new URLSearchParams((location.hash || "").replace(/^#/, ""));
    if (params.get("q")) state.q = params.get("q");
    if (params.get("cat")) state.cat = params.get("cat");
    if (params.get("chain")) state.chain = params.get("chain");
    if (params.get("scope")) state.scope = params.get("scope");
    if (params.get("sort")) state.sort = params.get("sort");
    if (params.get("dir")) state.dir = Number(params.get("dir")) || -1;
    if (params.get("view")) state.view = params.get("view");
    if (params.get("p")) state.selected = params.get("p");
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set("q", state.q);
    if (state.cat !== "all") params.set("cat", state.cat);
    if (state.chain !== "all") params.set("chain", state.chain);
    if (state.scope !== "all") params.set("scope", state.scope);
    if (state.sort !== "implied") params.set("sort", state.sort);
    if (state.dir !== -1) params.set("dir", String(state.dir));
    if (state.view !== "launches") params.set("view", state.view);
    if (state.selected) params.set("p", state.selected);
    var next = params.toString();
    if ((location.hash || "").replace(/^#/, "") !== next) history.replaceState(null, "", next ? "#" + next : location.pathname);
  }
  function catOf(r) { return r.category || "Uncategorized"; }
  function filtered() {
    var q = state.q.trim().toLowerCase();
    return ROWS.filter(function (r) {
      if (state.cat !== "all" && catOf(r) !== state.cat) return false;
      if (state.chain !== "all" && r.chains.indexOf(state.chain) < 0) return false;
      if (state.scope === "floor" && !r.on_watchlist) return false;
      if (state.scope === "early" && r.on_watchlist) return false;
      if (!q) return true;
      return (r.name + " " + r.slug + " " + catOf(r) + " " + r.chains.join(" ")).toLowerCase().indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var key = state.sort, dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === "name") { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === "tvl") { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === "growth") { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === "age") { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === "multiple") { av = a.implied_value_usd / a.tvl_usd; bv = b.implied_value_usd / b.tvl_usd; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.slug < b.slug ? -1 : 1;
    });
  }
  function th(key, label) {
    var mark = state.sort === key ? (state.dir < 0 ? " v" : " ^") : "";
    return el("th", { scope: "col" }, el("button", { type: "button", text: label + mark, onclick: function () {
      if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === "name" ? 1 : -1; }
      render();
    } }));
  }
  function mast() {
    var floor = ROWS.filter(function (r) { return r.on_watchlist; }).length;
    return el("header", { class: "mast" },
      el("div", { class: "brand" },
        el("div", { class: "word" }, el("i", { text: "Fathom" })),
        el("p", { class: "lede", text: "What a token would be worth if this record stayed as it is. " + floor + " of " + DATA.watchlist_size + " watchlist protocols, plus " + (ROWS.length - floor) + " earlier ones below the $" + Math.round(DATA.floor_usd / 1e6) + "M floor." })
      ),
      el("div", { class: "mast-meta" },
        el("div", { text: "As of " + DATA.as_of }),
        el("div", { text: DATA.protocols + " protocols in the extract" }),
        el("div", { text: FIT.comp_count + " tokens already trade" })
      )
    );
  }
  function formula() {
    return el("div", { class: "formula" },
      "Implied FDV = TVL × ",
      el("b", { text: "shrunk category mcap/TVL" }),
      " × ",
      el("b", { text: "size^(" + FIT.beta_used.toFixed(2) + "−1)" }),
      " × ",
      el("b", { text: "growth" }),
      " × ",
      el("b", { text: "tenure" }),
      " × ",
      el("b", { text: "breadth" }),
      ". Category medians are winsorized at p10–p90 and shrunk toward the market (k=6). Beta hat " + FIT.beta_hat.toFixed(2) + " (R² " + FIT.elasticity_r2.toFixed(2) + "), damped 55% toward 1."
    );
  }
  function stats() {
    var floor = ROWS.filter(function (r) { return r.on_watchlist; }).length;
    var miss = Math.exp(FIT.median_abs_log_error);
    return el("section", { class: "stats" },
      stat("Launches ranked", String(ROWS.length), "no token on record"),
      stat("Watchlist covered", floor + " / " + DATA.watchlist_size, "the floor, not the ceiling"),
      stat("Market mcap / TVL", FIT.global_median.toFixed(3) + "×", "median of " + FIT.comp_count + " comps"),
      stat("Typical miss", miss.toFixed(1) + "×", "model versus live market cap")
    );
  }
  function stat(label, value, sub) {
    return el("div", { class: "stat" }, el("span", { text: label }), el("b", { text: value }), el("small", { text: sub }));
  }
  function options(values, current, allLabel) {
    var nodes = [el("option", { value: "all", text: allLabel, selected: current === "all" ? "selected" : null })];
    values.forEach(function (v) { nodes.push(el("option", { value: v, text: v, selected: v === current ? "selected" : null })); });
    return nodes;
  }
  function controls() {
    var cats = Array.from(new Set(ROWS.map(catOf))).sort();
    var chains = Array.from(new Set(ROWS.flatMap(function (r) { return r.chains; }))).sort();
    var search = el("input", { id: "q", type: "search", value: state.q, placeholder: "Name, slug, chain", "aria-label": "Search launches" });
    search.addEventListener("input", function () {
      state.q = search.value;
      var pos = search.selectionStart;
      render();
      var again = document.getElementById("q");
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    });
    function select(id, label, values, current, on) {
      var node = el("select", { id: id, "aria-label": label }, options(values, current, label));
      node.addEventListener("change", function () { on(node.value); render(); });
      return el("div", { class: "field" }, el("label", { for: id, text: label }), node);
    }
    var tabs = el("div", { class: "tabs", role: "tablist" },
      tab("launches", "Launches"), tab("traded", "Tokens that trade"), tab("screened", "Parent screen")
    );
    var list = state.view === "launches" ? filtered() : state.view === "traded" ? DATA.comps : DATA.parents;
    return el("div", { class: "controls" },
      el("div", { class: "field" }, el("label", { for: "q", text: "Search" }), search),
      state.view === "launches" ? select("cat", "All categories", cats, state.cat, function (v) { state.cat = v; }) : null,
      state.view === "launches" ? select("chain", "All chains", chains, state.chain, function (v) { state.chain = v; }) : null,
      state.view === "launches" ? select("scope", "All sizes", ["Watchlist floor", "Below the floor"], scopeLabel(state.scope), function (v) { state.scope = v === "Watchlist floor" ? "floor" : v === "Below the floor" ? "early" : "all"; }) : null,
      tabs,
      el("span", { class: "count", text: list.length + " shown" })
    );
  }
  function scopeLabel(scope) { return scope === "floor" ? "Watchlist floor" : scope === "early" ? "Below the floor" : "all"; }
  function tab(view, label) {
    return el("button", { type: "button", role: "tab", "aria-pressed": state.view === view && !state.selected ? "true" : "false", text: label, onclick: function () {
      state.view = view; state.selected = null; render();
    } });
  }
  function chip() {
    if (state.view !== "launches") return null;
    var parts = [];
    if (state.q) parts.push('"' + state.q.trim() + '"');
    if (state.cat !== "all") parts.push(state.cat);
    if (state.chain !== "all") parts.push(state.chain);
    if (state.scope === "floor") parts.push("watchlist floor");
    if (state.scope === "early") parts.push("below the floor");
    if (!parts.length) return null;
    return el("div", { class: "chip" },
      el("span", { text: "Filtered · " + parts.join(" · ") + " · " + filtered().length + " of " + ROWS.length }),
      el("button", { type: "button", text: "Clear", onclick: function () { state.q = ""; state.cat = "all"; state.chain = "all"; state.scope = "all"; render(); } })
    );
  }
  function boardTable() {
    var list = sorted(filtered());
    if (!list.length) {
      return el("div", { class: "panel" }, el("div", { class: "empty" },
        el("h2", { text: "Nothing matches" }),
        el("p", { text: "Clear the search or pick another category." }),
        el("button", { type: "button", text: "Clear filters", onclick: function () { state.q = ""; state.cat = "all"; state.chain = "all"; state.scope = "all"; render(); } })
      ));
    }
    var max = list[0].implied_value_usd;
    var body = el("tbody");
    list.forEach(function (r) {
      var ratio = r.implied_value_usd / r.tvl_usd;
      body.appendChild(el("tr", { onclick: function () { state.selected = r.slug; render(); } },
        el("td", { class: "num", text: String(r.rank) }),
        el("td", null, el("span", { class: "name", text: r.name }), el("span", { class: "sub", text: catOf(r) + " · " + (r.chains[0] || "—") + (r.chains.length > 1 ? " +" + (r.chains.length - 1) : "") })),
        el("td", null, el("span", { class: r.on_watchlist ? "pill floor" : "pill", text: r.on_watchlist ? "Floor" : "Early" })),
        el("td", { class: "num", text: fmtUsd(r.tvl_usd) }),
        el("td", { class: "num " + (r.change_7d === null ? "" : r.change_7d >= 0 ? "pos" : "neg"), text: fmtPct(r.change_7d) }),
        el("td", { class: "num", text: fmtAge(r.age_days) }),
        el("td", { class: "num", text: ratio.toFixed(2) + "×" }),
        el("td", { class: "implied" }, fmtUsd(r.implied_value_usd), el("div", { class: "bar", "aria-hidden": "true" }, el("i", { style: "width:" + Math.max(4, Math.round(r.implied_value_usd / max * 100)) + "%" })))
      ));
    });
    return el("div", { class: "panel" }, el("div", { class: "scroll" },
      el("table", null,
        el("caption", { text: "Pre-token protocols. Rank is the model's order. Select a row for the comparable and the farm." }),
        el("thead", null, el("tr", null, th("implied", "Rank"), th("name", "Protocol"), el("th", { text: "Scope" }), th("tvl", "TVL"), th("growth", "7d"), th("age", "Listed"), th("multiple", "FDV/TVL"), th("implied", "Implied FDV"))),
        body
      )
    ));
  }
  function rail() {
    var present = {};
    ROWS.forEach(function (r) { present[catOf(r)] = true; });
    var cats = FIT.categories.filter(function (c) { return present[c.category]; }).sort(function (a, b) { return b.shrunk - a.shrunk; });
    if (state.cat !== "all") {
      var hit = cats.filter(function (c) { return c.category === state.cat; });
      var rest = cats.filter(function (c) { return c.category !== state.cat; });
      cats = hit.concat(rest);
    }
    cats = cats.slice(0, 9);
    var max = cats.reduce(function (m, c) { return Math.max(m, c.shrunk); }, 0.01);
    var miss = Math.exp(FIT.median_abs_log_error);
    return el("aside", { class: "panel rail" },
      el("h2", { text: "Comparables" }),
      el("p", { class: "note", text: "Tokens that already trade, by category. A thin sample is pulled toward the market median of " + FIT.global_median.toFixed(3) + "×." }),
      cats.map(function (c) {
        return el("div", { class: state.cat === c.category ? "cat on" : "cat" },
          el("b", { text: c.category }),
          el("em", { text: c.n + " · " + c.shrunk.toFixed(2) + "×" }),
          el("div", { class: "track" }, el("i", { style: "width:" + Math.max(4, Math.round(c.shrunk / max * 100)) + "%" }))
        );
      }),
      el("p", { class: "fine", text: "The structural value (TVL × multiple × size) misses a live market cap by a typical " + miss.toFixed(1) + "×. That dispersion is the market's. It is reported, not fitted away. Fees, revenue and users are absent from the extract." }),
      el("p", { class: "fine", text: DATA.parents.length + " protocols sit above the floor with no token and pass every screen this file can run, but they are not on the watchlist. parentProtocol is not in the extract, so they stay on the Parent screen and off this rank. " + DATA.token_unpriced + " more record a token id and no market cap; they are not launches." })
    );
  }
  function tradedTable() {
    var q = state.q.trim().toLowerCase();
    var list = DATA.comps.filter(function (c) {
      if (!q) return true;
      return (c.name + " " + (c.category || "") + " " + c.slug).toLowerCase().indexOf(q) >= 0;
    }).slice().sort(function (a, b) { return b.mcap_usd - a.mcap_usd; });
    var body = el("tbody");
    list.forEach(function (c) {
      var model = structuralUsd(c, FIT);
      var gap = c.mcap_usd / model;
      body.appendChild(el("tr", null,
        el("td", null, el("span", { class: "name", text: c.name }), el("span", { class: "sub", text: (c.category || "Uncategorized") })),
        el("td", { class: "num", text: fmtUsd(c.tvl_usd) }),
        el("td", { class: "num", text: fmtUsd(c.mcap_usd) }),
        el("td", { class: "num", text: (c.mcap_usd / c.tvl_usd).toFixed(2) + "×" }),
        el("td", { class: "num", text: fmtUsd(model) }),
        el("td", { class: "num", text: gap.toFixed(2) + "×" }),
        el("td", null, el("span", { class: "pill", text: "Trades" }))
      ));
    });
    return el("div", { class: "panel" }, el("div", { class: "scroll" },
      el("table", null,
        el("caption", { text: "These tokens already trade. Their market cap is a fact. They calibrate the multiples and are not ranked as launches. CEX tokens are left out of the fit." }),
        el("thead", null, el("tr", null,
          el("th", { text: "Protocol" }), el("th", { text: "TVL" }), el("th", { text: "Market cap" }),
          el("th", { text: "Mcap/TVL" }), el("th", { text: "Structural" }), el("th", { text: "Market/model" }), el("th", { text: "Status" })
        )),
        body
      )
    ));
  }
  function screenedTable() {
    var list = DATA.parents.slice().sort(function (a, b) { return b.tvl_usd - a.tvl_usd; });
    var body = el("tbody");
    list.forEach(function (p) {
      body.appendChild(el("tr", null,
        el("td", null, el("span", { class: "name", text: p.name }), el("span", { class: "sub", text: catOf(p) })),
        el("td", { class: "num", text: fmtUsd(p.tvl_usd) }),
        el("td", { class: "num", text: String(p.chains.length) }),
        el("td", { text: "Above $" + Math.round(DATA.floor_usd / 1e6) + "M, no token on record, absent from the watchlist. The remaining house test is a parent protocol, which this extract does not carry." })
      ));
    });
    return el("div", { class: "panel" }, el("div", { class: "scroll" },
      el("table", null,
        el("caption", { text: "Not ranked. A launch value is not claimed for a product the house already screened out as someone else's." }),
        el("thead", null, el("tr", null, el("th", { text: "Protocol" }), el("th", { text: "TVL" }), el("th", { text: "Chains" }), el("th", { text: "Why it is off the board" }))),
        body
      )
    ));
  }
  function factor(label, value, sub) {
    return el("div", { class: "factor" }, el("span", { text: label }), el("b", { text: value }), el("small", { text: sub }));
  }
  function detail(row) {
    var f = row.factors;
    var cat = null;
    for (var i = 0; i < FIT.categories.length; i++) if (FIT.categories[i].category === catOf(row)) cat = FIT.categories[i];
    var comps = DATA.comps.filter(function (c) { return (c.category || "Uncategorized") === catOf(row); }).sort(function (a, b) { return b.mcap_usd - a.mcap_usd; });
    var sentence = cat
      ? catOf(row) + " has " + cat.n + " traded " + (cat.n === 1 ? "token" : "tokens") + " in this snapshot. The winsorized median mcap/TVL is " + cat.raw.toFixed(3) + "×. Shrinkage with k=6 pulls it to " + cat.shrunk.toFixed(3) + "×, toward the market median of " + FIT.global_median.toFixed(3) + "×. Size is measured against a reference TVL of " + fmtUsd(cat.tvl_ref) + (f.size <= 0.4 ? ", and the factor is on its 0.40 floor." : ".")
      : "No traded token in " + catOf(row) + " has a market cap here, so the multiple is the market median of " + FIT.global_median.toFixed(3) + "×.";
    var compBody = el("tbody");
    comps.slice(0, 4).forEach(function (c) {
      compBody.appendChild(el("tr", null,
        el("td", { text: c.name }),
        el("td", { class: "num", text: fmtUsd(c.tvl_usd) }),
        el("td", { class: "num", text: fmtUsd(c.mcap_usd) }),
        el("td", { class: "num", text: (c.mcap_usd / c.tvl_usd).toFixed(2) + "×" })
      ));
    });
    return el("div", { class: "detail" },
      el("section", { class: "card" },
        el("button", { class: "back", type: "button", text: "Back to the board", onclick: function () { state.selected = null; render(); } }),
        el("div", { class: "detail-head" },
          el("div", null,
            el("p", { class: "sub", text: "Rank " + row.rank + " of " + ROWS.length + " · " + (row.on_watchlist ? "Watchlist floor" : "Below the floor") + " · " + catOf(row) }),
            el("h1", { text: row.name }),
            el("p", { class: "sub", text: row.chains.length ? row.chains.join(", ") : "No chain listed" })
          ),
          el("div", { class: "fdv" }, el("b", { text: fmtFull(row.implied_value_usd) }), el("span", { text: "implied FDV · " + (row.implied_value_usd / row.tvl_usd).toFixed(3) + "× TVL" }))
        ),
        el("div", { class: "factors" },
          factor("TVL", fmtUsd(row.tvl_usd), "the base"),
          factor("Category ×", f.multiple.toFixed(3), cat ? cat.n + " comps" : "market prior"),
          factor("Size ×", f.size.toFixed(3), "elasticity " + FIT.beta_used.toFixed(2)),
          factor("Growth ×", f.growth.toFixed(3), "7d " + fmtPct(row.change_7d)),
          factor("Tenure ×", f.tenure.toFixed(3), fmtAge(row.age_days) + " listed"),
          factor("Breadth ×", f.breadth.toFixed(3), row.chains.length + " chains")
        ),
        el("p", { class: "prose", text: sentence }),
        el("p", { class: "prose", text: "The page multiplies these rounded factors by TVL and rounds to the dollar. Tenure is how long the protocol has been listed with no token; a missing listing date uses the median age of the launch set. This is a capitalization of the record, not a promise that a token is issued." }),
        comps.length ? el("table", { class: "comps" },
          el("thead", null, el("tr", null, el("th", { text: "Comparable" }), el("th", { text: "TVL" }), el("th", { text: "Market cap" }), el("th", { text: "Mcap/TVL" }))),
          compBody
        ) : null
      ),
      el("section", { class: "card" },
        el("h2", { text: "How to farm it" }),
        el("p", { class: "note", text: "Seven steps. Capital is 0.25 bp of TVL, floored at $150 and capped at $4,000. Gas is a stated table, not a snapshot field." }),
        el("ol", { class: "steps" }, row.farm_steps.map(function (s, i) {
          var at = s.indexOf(" Cost: ");
          return el("li", null,
            el("span", { class: "n", text: String(i + 1) }),
            el("div", null, el("p", { text: at >= 0 ? s.slice(0, at) : s }), el("span", { class: "cost", text: at >= 0 ? s.slice(at + 1) : "" }))
          );
        }))
      )
    );
  }
  function render() {
    writeHash();
    var focus = document.activeElement && document.activeElement.id === "q";
    var pos = focus ? document.activeElement.selectionStart : null;
    app.textContent = "";
    var shell = el("div", { class: "shell" });
    shell.appendChild(mast());
    shell.appendChild(formula());
    if (!state.selected) shell.appendChild(stats());
    if (!state.selected) shell.appendChild(controls());
    var banner = chip();
    if (banner) shell.appendChild(banner);
    if (state.selected) {
      var row = null;
      for (var i = 0; i < ROWS.length; i++) if (ROWS[i].slug === state.selected) row = ROWS[i];
      shell.appendChild(row ? detail(row) : el("p", { text: "That protocol is not on this board." }));
    } else if (state.view === "traded") {
      shell.appendChild(el("div", { class: "body solo" }, tradedTable()));
    } else if (state.view === "screened") {
      shell.appendChild(el("div", { class: "body solo" }, screenedTable()));
    } else {
      shell.appendChild(el("div", { class: "body" }, boardTable(), rail()));
    }
    app.appendChild(shell);
    app.setAttribute("aria-busy", "false");
    if (focus) {
      var again = document.getElementById("q");
      if (again) { again.focus(); if (pos !== null) again.setSelectionRange(pos, pos); }
    }
  }
  readHash();
  render();
})();
