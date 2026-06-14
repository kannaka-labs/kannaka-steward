import { describe, it, expect } from 'vitest';
import { loadCharter } from '../src/charter.js';
import { DeterministicReasoner } from '../src/reason.js';
import { GhostsignalsAdapter } from '../src/adapters/ghostsignals.js';

const charter = loadCharter('charters/markets.example.yaml').charter;
const reasoner = new DeterministicReasoner();

describe('trade reasoner', () => {
  it('takes a bounded position on a favorable, liquid hedge (support=for)', async () => {
    const adapter = new GhostsignalsAdapter({
      fixturePath: 'fixtures/ghostsignals-market.json',
      forceFixture: true,
    });
    const action = await adapter.readAction('fixture');
    const j = await reasoner.judge(action, charter);
    expect(j.support).toBe('for');
    expect(j.confidence).toBeGreaterThanOrEqual(charter.confidenceThreshold);
    expect(j.appliedPrinciples).toContain('p.hedge-real-exposure');
  });

  it('abstains (takes no position) on an illiquid / oversized market', async () => {
    const adapter = new GhostsignalsAdapter({
      fixturePath: 'fixtures/ghostsignals-market-illiquid.json',
      forceFixture: true,
    });
    const action = await adapter.readAction('fixture');
    const j = await reasoner.judge(action, charter);
    expect(j.support).toBe('abstain');
    expect(j.concerns.length).toBeGreaterThan(0);
    expect(j.concerns.join(' ')).toMatch(/liquidity|budget|slippage|oversized/i);
  });

  it('is deterministic (same market → same judgment)', async () => {
    const adapter = new GhostsignalsAdapter({
      fixturePath: 'fixtures/ghostsignals-market.json',
      forceFixture: true,
    });
    const action = await adapter.readAction('fixture');
    const a = await reasoner.judge(action, charter);
    const b = await reasoner.judge(action, charter);
    expect(a).toEqual(b);
  });
});
