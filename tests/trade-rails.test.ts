import { describe, it, expect } from 'vitest';
import { loadCharter } from '../src/charter.js';
import { verify } from '../src/rails.js';
import type { ActionContext, CandidateOrder, Judgment } from '../src/types.js';

const charter = loadCharter('charters/markets.example.yaml').charter;

function candidate(over: Partial<CandidateOrder> = {}): CandidateOrder {
  return {
    outcomeId: 'out_yes',
    outcomeLabel: 'YES',
    type: 'buy',
    quantity: 100,
    cost: 280,
    avgPrice: 0.4,
    slippage: 0.01,
    positionFraction: 0.28,
    ...over,
  };
}

function action(over: Partial<ActionContext> = {}, cand: Partial<CandidateOrder> = {}): ActionContext {
  return {
    surface: 'ghostsignals',
    kind: 'market-trade',
    id: 'mkt_1',
    title: 'T',
    description: 'D',
    state: 'active',
    impact: { magnitude: 0.28, reversible: true, field: 'market-position' },
    source: 'fixture',
    market: {
      liquidityParameter: 5000,
      budget: 1000,
      outcomes: [
        { id: 'out_yes', label: 'YES', probability: 0.38 },
        { id: 'out_no', label: 'NO', probability: 0.62 },
      ],
      candidate: candidate(cand),
    },
    ...over,
  };
}

function judgment(over: Partial<Judgment> = {}): Judgment {
  return {
    support: 'for',
    confidence: 0.9,
    rationale: 'r',
    appliedPrinciples: ['p.hedge-real-exposure'],
    concerns: [],
    ...over,
  };
}

describe('trade rails', () => {
  it('PROCEEDS on a bounded, liquid, in-budget, low-slippage trade', () => {
    const v = verify(judgment(), action(), charter);
    expect(v.decision).toBe('proceed');
    expect(v.reasons.join(' ')).toMatch(/All rails satisfied/);
  });

  it('escalates when slippage breaches maxSlippage', () => {
    const v = verify(
      judgment(),
      action({ impact: { magnitude: 0.28, reversible: true } }, { slippage: 0.2 }),
      charter,
    );
    expect(v.decision).toBe('escalate');
    expect(v.reasons.join(' ')).toMatch(/slippage/i);
  });

  it('escalates when liquidity is below the minLiquidity floor', () => {
    const a = action();
    a.market!.liquidityParameter = 40;
    const v = verify(judgment(), a, charter);
    expect(v.decision).toBe('escalate');
    expect(v.reasons.join(' ')).toMatch(/liquidity/i);
  });

  it('escalates when position fraction exceeds maxPositionFraction', () => {
    const v = verify(
      judgment(),
      action({ impact: { magnitude: 0.6, reversible: true } }, { positionFraction: 0.6, cost: 600 }),
      charter,
    );
    expect(v.decision).toBe('escalate');
    expect(v.reasons.join(' ')).toMatch(/position fraction|maxAutoImpact|magnitude/i);
  });

  it('escalates (requireHumanAboveSize) when the position exceeds the human-review size', () => {
    const v = verify(
      judgment(),
      // 0.38 > requireHumanAboveSize(0.35) but ≤ maxPositionFraction(0.4) and
      // ≤ authority.maxAutoImpact(0.5): isolates the human-size rail.
      action({ impact: { magnitude: 0.38, reversible: true } }, { positionFraction: 0.38, cost: 380 }),
      charter,
    );
    expect(v.decision).toBe('escalate');
    expect(v.reasons.join(' ')).toMatch(/human-review size|human/i);
  });

  it('escalates when the market is not active/open', () => {
    const v = verify(judgment(), action({ state: 'resolved' }), charter);
    expect(v.decision).toBe('escalate');
    expect(v.reasons.join(' ')).toMatch(/state/i);
  });

  it('escalates on low reasoner confidence (independent of the reasoner)', () => {
    const v = verify(judgment({ confidence: 0.3 }), action(), charter);
    expect(v.decision).toBe('escalate');
    expect(v.reasons.join(' ')).toMatch(/confidence/i);
  });
});
