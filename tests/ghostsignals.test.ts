import { describe, it, expect } from 'vitest';
import { GhostsignalsAdapter } from '../src/adapters/ghostsignals.js';
import { costFunction, prices, quote } from '../src/lmsr.js';
import type { Judgment } from '../src/types.js';

const FIXTURE = 'fixtures/ghostsignals-market.json';

function forAll(): Judgment {
  return { support: 'for', confidence: 0.9, rationale: '', appliedPrinciples: [], concerns: [] };
}

describe('lmsr math', () => {
  it('prices sum to 1', () => {
    const p = prices([1200, 3700], 5000);
    const sum = p.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it('a buy cost equals the cost-function delta C(q+Δ) − C(q)', () => {
    const shares = [1200, 3700];
    const b = 5000;
    const q = quote(shares, b, 0, 100, 'buy');
    const expected = costFunction([1300, 3700], b) - costFunction(shares, b);
    expect(Math.abs(q.cost - expected)).toBeLessThan(1e-6);
    // Average price is positive and below 1 for a sub-even outcome.
    expect(q.avgPrice).toBeGreaterThan(0);
    expect(q.avgPrice).toBeLessThan(1);
    // Slippage is the move from the marginal price.
    expect(q.slippage).toBeGreaterThanOrEqual(0);
  });

  it('a deeper book (larger b) yields lower slippage for the same order', () => {
    const thin = quote([10, 10], 40, 0, 100, 'buy');
    const deep = quote([1200, 3700], 5000, 0, 100, 'buy');
    expect(deep.slippage).toBeLessThan(thin.slippage);
  });
});

describe('ghostsignals adapter (fixture)', () => {
  it('reads the fixture into a normalized market-trade ActionContext', async () => {
    const adapter = new GhostsignalsAdapter({ fixturePath: FIXTURE, forceFixture: true });
    const ctx = await adapter.readAction('fixture');
    expect(ctx.surface).toBe('ghostsignals');
    expect(ctx.kind).toBe('market-trade');
    expect(ctx.source).toBe('fixture');
    expect(ctx.impact.reversible).toBe(true);
    expect(ctx.impact.field).toBe('market-position');
    expect(ctx.market).toBeDefined();
    expect(ctx.market!.outcomes.length).toBe(2);
    // LMSR-derived probabilities sum to ~1.
    const psum = ctx.market!.outcomes.reduce((a, o) => a + o.probability, 0);
    expect(Math.abs(psum - 1)).toBeLessThan(1e-3);
  });

  it('pre-prices a bounded candidate within the position cap', async () => {
    const adapter = new GhostsignalsAdapter({ fixturePath: FIXTURE, forceFixture: true });
    const ctx = await adapter.readAction('fixture');
    const cand = ctx.market!.candidate!;
    expect(cand).toBeDefined();
    expect(cand.type).toBe('buy');
    expect(cand.outcomeId).toBe('out_yes');
    // Sized at/below the default cap fraction (0.3) of the budget.
    expect(cand.positionFraction).toBeLessThanOrEqual(0.31);
    expect(cand.cost).toBeGreaterThan(0);
    expect(cand.quantity).toBeGreaterThan(0);
  });

  it('describeProposed builds an UNSIGNED order for a "for" judgment', async () => {
    const adapter = new GhostsignalsAdapter({ fixturePath: FIXTURE, forceFixture: true });
    const ctx = await adapter.readAction('fixture');
    const proposed = adapter.describeProposed(forAll(), ctx);
    expect(proposed.params.marketId).toBe(ctx.id);
    expect(proposed.params.outcomeId).toBe('out_yes');
    expect(proposed.params.type).toBe('buy');
    expect(Number(proposed.params.quantity)).toBeGreaterThan(0);
  });

  it('describeProposed yields a zero-quantity no-op for an "abstain" judgment', async () => {
    const adapter = new GhostsignalsAdapter({ fixturePath: FIXTURE, forceFixture: true });
    const ctx = await adapter.readAction('fixture');
    const j: Judgment = { support: 'abstain', confidence: 0.4, rationale: '', appliedPrinciples: [], concerns: [] };
    const proposed = adapter.describeProposed(j, ctx);
    expect(Number(proposed.params.quantity)).toBe(0);
  });

  it('dryRun computes LMSR cost/avgPrice/slippage offline and NEVER posts an order', async () => {
    const adapter = new GhostsignalsAdapter({ fixturePath: FIXTURE, forceFixture: true });
    const ctx = await adapter.readAction('fixture');
    const proposed = adapter.describeProposed(forAll(), ctx);
    const dr = await adapter.dryRun(proposed);
    expect(dr.ok).toBe(true);
    expect(dr.source).toBe('offline');
    // The "calldata" is the unsigned JSON order body; `to` is /api/trading.
    expect(dr.to).toMatch(/\/api\/trading$/);
    const order = JSON.parse(dr.calldata!);
    expect(order.marketId).toBe(ctx.id);
    expect(order.type).toBe('buy');
    expect(order.quantity).toBeGreaterThan(0);
    // The estimate matches the locally-priced candidate cost.
    const q = quote([1200, 3700], 5000, 0, order.quantity, 'buy');
    expect(dr.estimate).toContain(`cost=${Math.round(q.cost * 10000) / 10000}`);
  });

  it('dryRun on a zero-quantity order is a priced no-op', async () => {
    const adapter = new GhostsignalsAdapter({ fixturePath: FIXTURE, forceFixture: true });
    const ctx = await adapter.readAction('fixture');
    const j: Judgment = { support: 'abstain', confidence: 0.4, rationale: '', appliedPrinciples: [], concerns: [] };
    const proposed = adapter.describeProposed(j, ctx);
    const dr = await adapter.dryRun(proposed);
    expect(dr.ok).toBe(true);
    expect(dr.estimate).toMatch(/no-op/i);
  });
});
