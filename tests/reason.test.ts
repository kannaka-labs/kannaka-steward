import { describe, it, expect } from 'vitest';
import { loadCharter } from '../src/charter.js';
import { DeterministicReasoner } from '../src/reason.js';
import { AmorAdapter } from '../src/adapters/amor.js';

const charter = loadCharter('charters/governance.example.yaml').charter;
const reasoner = new DeterministicReasoner();

describe('deterministic reasoner', () => {
  it('supports a favorable proposal with confidence above threshold', async () => {
    const adapter = new AmorAdapter({ fixturePath: 'fixtures/amor-proposal.json', forceFixture: true });
    const action = await adapter.readAction('fixture');
    const j = await reasoner.judge(action, charter);
    expect(j.support).toBe('for');
    expect(j.confidence).toBeGreaterThanOrEqual(charter.confidenceThreshold);
    expect(j.appliedPrinciples).toContain('p.transparency');
  });

  it('opposes a hostile treasury-drain proposal', async () => {
    const adapter = new AmorAdapter({ fixturePath: 'fixtures/amor-proposal-opposing.json', forceFixture: true });
    const action = await adapter.readAction('fixture');
    const j = await reasoner.judge(action, charter);
    expect(j.support).toBe('against');
    expect(j.concerns.length).toBeGreaterThan(0);
    expect(j.appliedPrinciples).toContain('p.oppose-large-drawdown');
  });

  it('abstains with zero confidence when no principle matches', async () => {
    const action = {
      surface: 'amor',
      kind: 'governance-vote',
      id: '1',
      title: 'Quux frobnicate the wibble',
      description: 'zzz xyzzy plugh nothing relevant here',
      state: 'Active',
      impact: { magnitude: 0.1, reversible: true },
      source: 'fixture' as const,
    };
    const j = await reasoner.judge(action, charter);
    expect(j.support).toBe('abstain');
    expect(j.confidence).toBe(0);
  });

  it('is deterministic (same input → same output)', async () => {
    const adapter = new AmorAdapter({ fixturePath: 'fixtures/amor-proposal.json', forceFixture: true });
    const action = await adapter.readAction('fixture');
    const a = await reasoner.judge(action, charter);
    const b = await reasoner.judge(action, charter);
    expect(a).toEqual(b);
  });
});
