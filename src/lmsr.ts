/**
 * LMSR math — a dependency-free, numerically-stabilized replica of the
 * ghostsignals cost function, so the Steward can dry-run a trade entirely
 * OFFLINE (on a fixture) and agree with the live API when one is reachable.
 *
 * This module computes ONLY. It never reads the network and never submits an
 * order. It mirrors `packages/core/src/lmsr.ts` from ghostsignals:
 *
 *   Cost function : C(q) = b · ln(Σ exp(qᵢ/b))
 *   Price         : P(i) = exp(qᵢ/b) / Σ exp(qⱼ/b)            (sums to 1)
 *   Buy cost      : C(q + Δq·eᵢ) − C(q)
 *   Sell payout   : C(q) − C(q − Δq·eᵢ)
 *
 * We compute log-sum-exp with the standard max-shift for numerical stability,
 * matching ghostsignals' decimal.js results to floating-point tolerance.
 */

/** Stable log(Σ exp(xᵢ)) via the max-shift trick. */
export function logSumExp(xs: number[]): number {
  if (xs.length === 0) return -Infinity;
  const max = Math.max(...xs);
  if (!isFinite(max)) return max;
  let sum = 0;
  for (const x of xs) sum += Math.exp(x - max);
  return max + Math.log(sum);
}

/** Cost function C(q) = b · ln(Σ exp(qᵢ/b)). */
export function costFunction(shares: number[], b: number): number {
  return b * logSumExp(shares.map((q) => q / b));
}

/** LMSR prices P(i), which always sum to 1. */
export function prices(shares: number[], b: number): number[] {
  const scaled = shares.map((q) => q / b);
  const lse = logSumExp(scaled);
  return scaled.map((x) => Math.exp(x - lse));
}

export interface LmsrQuote {
  /** LMSR cost (Δ cost function) for the order, quote units. Always ≥ 0 for buys. */
  cost: number;
  /** Average fill price = cost / quantity. */
  avgPrice: number;
  /** Marginal price of the outcome BEFORE the trade (== current probability). */
  marginalBefore: number;
  /** Marginal price of the outcome AFTER the trade. */
  marginalAfter: number;
  /** Slippage = |avgPrice − marginalBefore| (fraction). */
  slippage: number;
  /** Prices after the order fills. */
  newPrices: number[];
}

/**
 * Quote a buy/sell of `quantity` shares of outcome `index`. Returns the LMSR
 * cost delta, average price, and slippage vs. the pre-trade marginal price.
 *
 * For a SELL we return the payout as `cost` (a positive number) and price it
 * the same way; the spread fee is intentionally omitted here because the
 * Steward's slippage rail measures price impact, not the venue fee.
 */
export function quote(
  shares: number[],
  b: number,
  index: number,
  quantity: number,
  type: 'buy' | 'sell',
): LmsrQuote {
  const before = prices(shares, b);
  const marginalBefore = before[index] ?? 0;

  const newShares = shares.slice();
  if (type === 'buy') {
    newShares[index] = (newShares[index] ?? 0) + quantity;
  } else {
    // Don't drive shares below zero on a sell.
    const sellQty = Math.min(quantity, newShares[index] ?? 0);
    newShares[index] = (newShares[index] ?? 0) - sellQty;
  }

  const c0 = costFunction(shares, b);
  const c1 = costFunction(newShares, b);
  const cost = type === 'buy' ? c1 - c0 : c0 - c1;

  const after = prices(newShares, b);
  const marginalAfter = after[index] ?? 0;

  const avgPrice = quantity > 0 ? cost / quantity : marginalBefore;
  const slippage = Math.abs(avgPrice - marginalBefore);

  return { cost, avgPrice, marginalBefore, marginalAfter, slippage, newPrices: after };
}
