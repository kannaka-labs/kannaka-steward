import { describe, it, expect } from 'vitest';
import { loadCharter } from '../src/charter.js';
import { verify } from '../src/rails.js';
import type { ActionContext, Judgment } from '../src/types.js';

const charter = loadCharter('charters/governance.example.yaml').charter;

function action(over: Partial<ActionContext> = {}): ActionContext {
  return {
    surface: 'amor',
    kind: 'governance-vote',
    id: '1',
    title: 'T',
    description: 'D',
    state: 'Active',
    impact: { magnitude: 0.1, reversible: true },
    source: 'fixture',
    ...over,
  };
}

function judgment(over: Partial<Judgment> = {}): Judgment {
  return {
    support: 'for',
    confidence: 0.9,
    rationale: 'r',
    appliedPrinciples: ['p.transparency'],
    concerns: [],
    ...over,
  };
}

describe('rails', () => {
  it('proceeds when confident, bounded, reversible, no breach', () => {
    const v = verify(judgment(), action(), charter);
    expect(v.decision).toBe('proceed');
  });

  it('escalates on low confidence (abstainWhenUncertain)', () => {
    const v = verify(judgment({ confidence: 0.3 }), action(), charter);
    expect(v.decision).toBe('escalate');
    expect(v.reasons.join(' ')).toMatch(/confidence/i);
  });

  it('escalates when impact exceeds maxImpact hard constraint / authority', () => {
    const v = verify(judgment(), action({ impact: { magnitude: 0.7, reversible: true } }), charter);
    expect(v.decision).toBe('escalate');
    expect(v.reasons.join(' ')).toMatch(/maxImpact|maxAutoImpact|magnitude/i);
  });

  it('REFUSES to auto-support an irreversible action (forbidIrreversible)', () => {
    const v = verify(
      judgment({ support: 'for' }),
      action({ impact: { magnitude: 0.2, reversible: false } }),
      charter,
    );
    expect(v.decision).toBe('refuse');
    expect(v.reasons.join(' ')).toMatch(/irreversible/i);
  });

  it('escalates (requireHuman:irreversible) when opposing an irreversible action', () => {
    const v = verify(
      judgment({ support: 'against' }),
      action({ impact: { magnitude: 0.2, reversible: false } }),
      charter,
    );
    // Not a refuse (we're opposing, not supporting), but a human must review.
    expect(v.decision).toBe('escalate');
    expect(v.reasons.join(' ')).toMatch(/human|irreversible/i);
  });

  it('escalates when the proposal is not Active', () => {
    const v = verify(judgment(), action({ state: 'Succeeded' }), charter);
    expect(v.decision).toBe('escalate');
    expect(v.reasons.join(' ')).toMatch(/state/i);
  });
});
