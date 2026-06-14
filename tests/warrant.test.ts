import { describe, it, expect } from 'vitest';
import {
  checkWarrant,
  decideWarrant,
  scopeForAction,
  AGENT_SCOPES,
  type GrantFixture,
} from '../src/warrant.js';

const FUTURE = '2099-12-31T23:59:59.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

function grant(over: Partial<GrantFixture> = {}): GrantFixture {
  return {
    id: 'grant_test',
    scopes: [AGENT_SCOPES.governVote, AGENT_SCOPES.marketTrade, AGENT_SCOPES.treasuryRead],
    status: 'active',
    expiresAt: FUTURE,
    constraints: { maxAutoImpact: 0.9 },
    boundWalletAddress: '0xabc',
    ...over,
  };
}

describe('scopeForAction mapper', () => {
  it('maps governance-vote → agent:govern:vote:bounded', () => {
    expect(scopeForAction('governance-vote')).toBe(AGENT_SCOPES.governVote);
  });
  it('maps market-trade → agent:market:trade:bounded', () => {
    expect(scopeForAction('market-trade')).toBe(AGENT_SCOPES.marketTrade);
  });
  it('returns undefined for an unmapped kind', () => {
    expect(scopeForAction('treasury-sweep')).toBeUndefined();
  });
});

describe('decideWarrant (conservative port of spacechild-auth)', () => {
  it('authorizes a live, scoped, in-cap grant', () => {
    const v = decideWarrant(grant(), AGENT_SCOPES.governVote, 0.15, 'offline');
    expect(v.authorized).toBe(true);
    expect(v.grantId).toBe('grant_test');
    expect(v.scopes).toContain(AGENT_SCOPES.governVote);
  });

  it('denies a revoked grant with reason "grant revoked"', () => {
    const v = decideWarrant(grant({ status: 'revoked' }), AGENT_SCOPES.governVote, 0.15, 'offline');
    expect(v.authorized).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/grant revoked/i);
  });

  it('denies an expired-by-status grant', () => {
    const v = decideWarrant(grant({ status: 'expired' }), AGENT_SCOPES.governVote, 0.15, 'offline');
    expect(v.authorized).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/expired/i);
  });

  it('denies a grant past its expiresAt', () => {
    const v = decideWarrant(grant({ expiresAt: PAST }), AGENT_SCOPES.governVote, 0.15, 'offline');
    expect(v.authorized).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/expired/i);
  });

  it('denies when the requested scope is missing', () => {
    const v = decideWarrant(
      grant({ scopes: [AGENT_SCOPES.treasuryRead] }),
      AGENT_SCOPES.marketTrade,
      0.2,
      'offline',
    );
    expect(v.authorized).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/not in grant scopes/i);
  });

  it('denies when impact is at/over the grant cap', () => {
    const v = decideWarrant(
      grant({ constraints: { maxAutoImpact: 0.3 } }),
      AGENT_SCOPES.marketTrade,
      0.3,
      'offline',
    );
    expect(v.authorized).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/not below grant cap/i);
  });

  it('denies when an impact is given but the grant declares no cap (deny on doubt)', () => {
    const v = decideWarrant(
      grant({ constraints: {} }),
      AGENT_SCOPES.governVote,
      0.1,
      'offline',
    );
    expect(v.authorized).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/no maxAutoImpact cap/i);
  });

  it('authorizes when no impact is supplied (cap check skipped)', () => {
    const v = decideWarrant(grant(), AGENT_SCOPES.governVote, undefined, 'offline');
    expect(v.authorized).toBe(true);
  });
});

describe('checkWarrant offline (fixture-driven)', () => {
  it('granted fixture → authorized', async () => {
    const v = await checkWarrant({
      scope: AGENT_SCOPES.governVote,
      impact: 0.15,
      fixturePath: 'fixtures/grant-granted.json',
    });
    expect(v.source).toBe('offline');
    expect(v.authorized).toBe(true);
    expect(v.grantId).toBe('grant_demo_granted');
  });

  it('revoked fixture → denied "grant revoked"', async () => {
    const v = await checkWarrant({
      scope: AGENT_SCOPES.governVote,
      impact: 0.15,
      fixturePath: 'fixtures/grant-revoked.json',
    });
    expect(v.authorized).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/grant revoked/i);
  });

  it('overscope fixture → denied (missing scope) for trade', async () => {
    const v = await checkWarrant({
      scope: AGENT_SCOPES.marketTrade,
      impact: 0.2,
      fixturePath: 'fixtures/grant-overscope.json',
    });
    expect(v.authorized).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/not in grant scopes/i);
  });

  it('denies when no scope is requested (unmapped action)', async () => {
    const v = await checkWarrant({
      fixturePath: 'fixtures/grant-granted.json',
      impact: 0.1,
    });
    expect(v.authorized).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/no scope/i);
  });

  it('denies when the fixture path is unloadable (deny on doubt)', async () => {
    const v = await checkWarrant({
      scope: AGENT_SCOPES.governVote,
      impact: 0.1,
      fixturePath: 'fixtures/does-not-exist.json',
    });
    expect(v.authorized).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/could not load grant fixture/i);
  });

  it('accepts an already-loaded grant object', async () => {
    const v = await checkWarrant({
      scope: AGENT_SCOPES.marketTrade,
      impact: 0.2,
      grant: grant(),
    });
    expect(v.authorized).toBe(true);
  });
});

describe('checkWarrant live (read-only introspect)', () => {
  it('denies (never throws) when the live endpoint is unreachable', async () => {
    const v = await checkWarrant({
      scope: AGENT_SCOPES.governVote,
      impact: 0.1,
      grantId: 'grant_x',
      introspectUrl: 'http://127.0.0.1:1/unreachable',
      timeoutMs: 250,
    });
    expect(v.source).toBe('live');
    expect(v.authorized).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/failed|timeout/i);
  });

  it('denies when neither token nor grantId is supplied', async () => {
    const v = await checkWarrant({
      scope: AGENT_SCOPES.governVote,
      introspectUrl: 'http://example.invalid',
    });
    expect(v.authorized).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/no token or grantId/i);
  });
});
