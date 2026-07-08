import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify, parseWindowMs, type RateLimitContext } from '../src/rails.js';
import { validateCharter, type Charter } from '../src/charter.js';
import type { AuditRecord } from '../src/audit.js';
import { runSteward } from '../src/steward.js';
import { AuditLog } from '../src/audit.js';
import type { SurfaceAdapter } from '../src/adapter.js';
import type {
  ActionContext,
  DryRunResult,
  Judgment,
  ProposedAction,
} from '../src/types.js';
import type { IntentReasoner } from '../src/reason.js';

const NOW = Date.parse('2026-07-07T12:00:00.000Z');
const HOUR = 3_600_000;

/** A permissive charter that PROCEEDS on the action below, isolating the rate rail. */
function charter(perWindow?: { window: string; maxActions: number }, id = 'test.charter'): Charter {
  return validateCharter({
    id,
    version: '1.0.0',
    owner: 'test (label only)',
    principles: [{ id: 'p', statement: 's', weight: 0.5, polarity: 'favor', matchHints: [] }],
    confidenceThreshold: 0.5,
    authority: { maxAutoImpact: 0.9, ...(perWindow ? { perWindow } : {}) },
  }).charter;
}

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
  return { support: 'for', confidence: 0.9, rationale: 'r', appliedPrinciples: [], concerns: [], ...over };
}

/** Build a full AuditRecord; only charterId/verdict.decision/ts feed the counter. */
function rec(over: Partial<AuditRecord> = {}): AuditRecord {
  return {
    seq: 0,
    ts: new Date(NOW - HOUR).toISOString(),
    charterId: 'test.charter',
    charterHash: 'h',
    surface: 'amor',
    actionId: 'a',
    judgment: judgment(),
    verdict: { decision: 'proceed', reasons: [] },
    warrant: null,
    dryRun: null,
    prevHash: '0',
    hash: 'x',
    ...over,
  };
}

/** N proceed records for `test.charter`, all inside the window. */
function proceeds(n: number, over: Partial<AuditRecord> = {}): AuditRecord[] {
  return Array.from({ length: n }, () => rec(over));
}

describe('parseWindowMs', () => {
  it('parses valid specs', () => {
    expect(parseWindowMs('24h')).toBe(24 * HOUR);
    expect(parseWindowMs('1d')).toBe(86_400_000);
    expect(parseWindowMs('30m')).toBe(1_800_000);
    expect(parseWindowMs('10s')).toBe(10_000);
    expect(parseWindowMs(' 2h ')).toBe(2 * HOUR);
  });
  it('rejects malformed specs (returns undefined so callers fail safe)', () => {
    for (const bad of ['', '24', '24x', 'abc', '-5h', '0h', 'h', '1.5h', '1 hour']) {
      expect(parseWindowMs(bad), bad).toBeUndefined();
    }
  });
});

describe('rails rate limit (authority.perWindow)', () => {
  const rate = (over: Partial<RateLimitContext> = {}): RateLimitContext => ({ now: NOW, ...over });

  it('under limit → proceed', () => {
    const v = verify(judgment(), action(), charter({ window: '24h', maxActions: 3 }), rate({ priorRecords: proceeds(2) }));
    expect(v.decision).toBe('proceed');
  });

  it('at limit → escalate', () => {
    const v = verify(judgment(), action(), charter({ window: '24h', maxActions: 3 }), rate({ priorRecords: proceeds(3) }));
    expect(v.decision).toBe('escalate');
    expect(v.reasons.join(' ')).toMatch(/rate limit reached/i);
  });

  it('over limit → escalate', () => {
    const v = verify(judgment(), action(), charter({ window: '24h', maxActions: 3 }), rate({ priorRecords: proceeds(5) }));
    expect(v.decision).toBe('escalate');
  });

  it('window expiry resets: records older than the window are not counted', () => {
    const old = proceeds(5, { ts: new Date(NOW - 48 * HOUR).toISOString() }); // 48h ago, window 24h
    const v = verify(judgment(), action(), charter({ window: '24h', maxActions: 3 }), rate({ priorRecords: old }));
    expect(v.decision).toBe('proceed');
  });

  it('window is a rolling boundary: in-window count trips, out-of-window does not', () => {
    const mix = [
      ...proceeds(3, { ts: new Date(NOW - HOUR).toISOString() }), // in window
      ...proceeds(4, { ts: new Date(NOW - 48 * HOUR).toISOString() }), // out
    ];
    // maxActions 3, exactly 3 in window → escalate.
    expect(verify(judgment(), action(), charter({ window: '24h', maxActions: 3 }), rate({ priorRecords: mix })).decision).toBe('escalate');
    // maxActions 4, still only 3 in window → proceed.
    expect(verify(judgment(), action(), charter({ window: '24h', maxActions: 4 }), rate({ priorRecords: mix })).decision).toBe('proceed');
  });

  it('only PROCEED verdicts count — escalations/refusals are ignored', () => {
    const notActions = [
      ...proceeds(2), // count
      rec({ verdict: { decision: 'escalate', reasons: [] } }),
      rec({ verdict: { decision: 'refuse', reasons: [] } }),
      rec({ verdict: { decision: 'escalate', reasons: [] } }),
    ];
    // maxActions 3, only 2 proceeds → proceed.
    const v = verify(judgment(), action(), charter({ window: '24h', maxActions: 3 }), rate({ priorRecords: notActions }));
    expect(v.decision).toBe('proceed');
  });

  it('counts per charter — a different charter\'s proceeds do not count', () => {
    const other = proceeds(9, { charterId: 'someone.else' });
    const v = verify(judgment(), action(), charter({ window: '24h', maxActions: 1 }), rate({ priorRecords: other }));
    expect(v.decision).toBe('proceed');
  });

  it('fails safe when the audit log is unreadable → escalate', () => {
    const v = verify(judgment(), action(), charter({ window: '24h', maxActions: 3 }), rate({ unreadable: 'bad JSON at line 4' }));
    expect(v.decision).toBe('escalate');
    expect(v.reasons.join(' ')).toMatch(/unreadable/i);
  });

  it('fails safe when the window spec is malformed → escalate', () => {
    const v = verify(judgment(), action(), charter({ window: 'often', maxActions: 3 }), rate({ priorRecords: proceeds(0) }));
    expect(v.decision).toBe('escalate');
    expect(v.reasons.join(' ')).toMatch(/window .* unparseable/i);
  });

  it('counts a qualifying record with an unparseable timestamp (conservative)', () => {
    const v = verify(
      judgment(),
      action(),
      charter({ window: '24h', maxActions: 1 }),
      rate({ priorRecords: [rec({ ts: 'not-a-date' })] }),
    );
    expect(v.decision).toBe('escalate');
  });

  it('no perWindow on the charter → no rate escalation even with many records', () => {
    const v = verify(judgment(), action(), charter(undefined), rate({ priorRecords: proceeds(100) }));
    expect(v.decision).toBe('proceed');
  });

  it('rate context absent (4th arg omitted) → no enforcement even when perWindow is set', () => {
    const v = verify(judgment(), action(), charter({ window: '24h', maxActions: 1 }));
    expect(v.decision).toBe('proceed');
  });
});

// --- Full-loop integration: the steward loop reads the audit log itself -------

class ConfidentReasoner implements IntentReasoner {
  readonly name = 'test-confident';
  async judge(): Promise<Judgment> {
    return { support: 'for', confidence: 0.99, rationale: 'confident', appliedPrinciples: ['p'], concerns: [] };
  }
}

class TrivialAdapter implements SurfaceAdapter {
  readonly surface = 'amor';
  async readAction(): Promise<ActionContext> {
    return action({ id: 'prop-1' });
  }
  describeProposed(_j: Judgment, a: ActionContext): ProposedAction {
    return { surface: this.surface, kind: a.kind, summary: 'cast vote', params: { proposalId: a.id } };
  }
  async dryRun(): Promise<DryRunResult> {
    return { ok: true, estimate: 'offline', warnings: [], source: 'offline' };
  }
}

function tmpAuditPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'steward-rate-')), 'audit.jsonl');
}

describe('rate limit end-to-end through the steward loop', () => {
  it('trips after maxActions proceeds accumulate in the same audit log', async () => {
    const auditPath = tmpAuditPath();
    const loaded = { charter: charter({ window: '24h', maxActions: 2 }), contentHash: 'hash' };
    const opts = { auditPath, reasoner: new ConfidentReasoner() };

    const r1 = await runSteward(loaded, new TrivialAdapter(), 'x', opts);
    const r2 = await runSteward(loaded, new TrivialAdapter(), 'x', opts);
    const r3 = await runSteward(loaded, new TrivialAdapter(), 'x', opts);

    expect(r1.verdict.decision).toBe('proceed');
    expect(r2.verdict.decision).toBe('proceed');
    expect(r3.verdict.decision).toBe('escalate');
    expect(r3.result.kind).toBe('escalation-notice');
    expect(r3.verdict.reasons.join(' ')).toMatch(/rate limit reached/i);

    // The audit chain still verifies (three records: proceed, proceed, escalate).
    const log = new AuditLog(auditPath);
    expect(log.verify().ok).toBe(true);
    expect(log.readAll().map((r) => r.verdict.decision)).toEqual(['proceed', 'proceed', 'escalate']);
  });

  it('fails safe when the audit log on disk is corrupt → blocks (never emits a package)', async () => {
    const auditPath = tmpAuditPath();
    writeFileSync(auditPath, '{ this is not valid json\n', 'utf8');
    const loaded = { charter: charter({ window: '24h', maxActions: 5 }), contentHash: 'hash' };

    // The rails read the log fail-safe (rate.unreadable → escalate), and the
    // hash-chained append then refuses to write onto a corrupt chain — so the
    // whole run rejects. Either way: no human-signable package is ever emitted.
    await expect(
      runSteward(loaded, new TrivialAdapter(), 'x', { auditPath, reasoner: new ConfidentReasoner() }),
    ).rejects.toThrow();
  });
});
