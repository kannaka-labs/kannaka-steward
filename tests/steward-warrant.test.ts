import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCharter } from '../src/charter.js';
import { AmorAdapter } from '../src/adapters/amor.js';
import { GhostsignalsAdapter } from '../src/adapters/ghostsignals.js';
import { runSteward } from '../src/steward.js';
import { AuditLog } from '../src/audit.js';
import type { HumanSignablePackage, WarrantBlockedNotice } from '../src/types.js';

function tmpAuditPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'steward-warrant-'));
  return join(dir, 'audit.jsonl');
}

const GRANTED = { fixturePath: 'fixtures/grant-granted.json' };
const REVOKED = { fixturePath: 'fixtures/grant-revoked.json' };
const OVERSCOPE = { fixturePath: 'fixtures/grant-overscope.json' };

function tradeAdapter(): GhostsignalsAdapter {
  return new GhostsignalsAdapter({
    fixturePath: 'fixtures/ghostsignals-market.json',
    forceFixture: true,
  });
}

function governAdapter(fixture: string): AmorAdapter {
  return new AmorAdapter({ fixturePath: fixture, forceFixture: true });
}

describe('joined Steward loop — rails AND warrant', () => {
  it('proceed + granted ⇒ order package emitted WITH warrant annotation', async () => {
    const auditPath = tmpAuditPath();
    const loaded = loadCharter('charters/markets.example.yaml');
    const report = await runSteward(loaded, tradeAdapter(), 'fixture', {
      auditPath,
      warrant: GRANTED,
    });

    expect(report.verdict.decision).toBe('proceed');
    expect(report.warrant).not.toBeNull();
    expect(report.warrant!.authorized).toBe(true);
    expect(report.result.kind).toBe('human-signable-package');

    const pkg = report.result as HumanSignablePackage;
    // The order IS emitted...
    expect(pkg.calldata).toBeTruthy();
    expect(pkg.to).toMatch(/\/api\/trading$/);
    // ...and annotated with the warrant.
    expect(pkg.warrant).toBeDefined();
    expect(pkg.warrant!.authorized).toBe(true);
    expect(pkg.warrant!.grantId).toBe('grant_demo_granted');
    expect(pkg.warrant!.source).toBe('offline');
    expect(pkg.warrant!.scopes).toContain('agent:market:trade:bounded');
  });

  it('proceed + revoked ⇒ WarrantBlockedNotice and NO calldata/order', async () => {
    const auditPath = tmpAuditPath();
    const loaded = loadCharter('charters/markets.example.yaml');
    const report = await runSteward(loaded, tradeAdapter(), 'fixture', {
      auditPath,
      warrant: REVOKED,
    });

    // Rails still PROCEED (the action is faithful + within authority)...
    expect(report.verdict.decision).toBe('proceed');
    // ...but the warrant DENIES, so nothing is emitted.
    expect(report.warrant).not.toBeNull();
    expect(report.warrant!.authorized).toBe(false);
    expect(report.result.kind).toBe('warrant-blocked-notice');

    const notice = report.result as WarrantBlockedNotice;
    expect(notice.summary).toMatch(/MOVED but NOT PERMITTED/);
    expect(notice.summary).toMatch(/grant revoked/i);
    // The defining safety property: no order is produced.
    expect((notice as unknown as { calldata?: string }).calldata).toBeUndefined();
    expect((notice as unknown as { to?: string }).to).toBeUndefined();
  });

  it('proceed + overscope ⇒ WarrantBlockedNotice (missing scope), no order', async () => {
    const auditPath = tmpAuditPath();
    const loaded = loadCharter('charters/markets.example.yaml');
    const report = await runSteward(loaded, tradeAdapter(), 'fixture', {
      auditPath,
      warrant: OVERSCOPE,
    });
    expect(report.verdict.decision).toBe('proceed');
    expect(report.warrant!.authorized).toBe(false);
    expect(report.result.kind).toBe('warrant-blocked-notice');
    const notice = report.result as WarrantBlockedNotice;
    expect(notice.summary).toMatch(/not in grant scopes/i);
  });

  it('governance proceed + granted ⇒ vote package emitted with warrant', async () => {
    const auditPath = tmpAuditPath();
    const loaded = loadCharter('charters/governance.example.yaml');
    const report = await runSteward(
      loaded,
      governAdapter('fixtures/amor-proposal.json'),
      'fixture',
      { auditPath, warrant: GRANTED },
    );
    // The transparency proposal is reversible + low-impact → rails proceed.
    expect(report.verdict.decision).toBe('proceed');
    expect(report.result.kind).toBe('human-signable-package');
    const pkg = report.result as HumanSignablePackage;
    expect(pkg.warrant!.authorized).toBe(true);
    expect(pkg.warrant!.scopes).toContain('agent:govern:vote:bounded');
  });

  it('rails-escalate/refuse case ⇒ warrant NOT consulted, no package', async () => {
    const auditPath = tmpAuditPath();
    const loaded = loadCharter('charters/governance.example.yaml');
    const report = await runSteward(
      loaded,
      governAdapter('fixtures/amor-proposal-opposing.json'),
      'fixture',
      { auditPath, warrant: GRANTED },
    );
    // The irreversible unlimited-drawdown proposal must NOT proceed.
    expect(report.verdict.decision).not.toBe('proceed');
    // The warrant was never asked — rails already blocked the action.
    expect(report.warrant).toBeNull();
    expect(report.result.kind).toBe('escalation-notice');
  });

  it('audit chain captures BOTH rails + warrant verdicts and still verifies', async () => {
    const auditPath = tmpAuditPath();
    const loadedTrade = loadCharter('charters/markets.example.yaml');
    const loadedGov = loadCharter('charters/governance.example.yaml');

    // A mix: permitted trade, blocked trade, escalated governance.
    await runSteward(loadedTrade, tradeAdapter(), 'fixture', { auditPath, warrant: GRANTED });
    await runSteward(loadedTrade, tradeAdapter(), 'fixture', { auditPath, warrant: REVOKED });
    await runSteward(
      loadedGov,
      governAdapter('fixtures/amor-proposal-opposing.json'),
      'fixture',
      { auditPath, warrant: GRANTED },
    );

    const log = new AuditLog(auditPath);
    const res = log.verify();
    expect(res.ok).toBe(true);
    expect(res.count).toBe(3);

    const records = log.readAll();
    // Record 0: permitted trade — warrant present + authorized.
    expect(records[0]!.warrant).not.toBeNull();
    expect(records[0]!.warrant!.authorized).toBe(true);
    expect(records[0]!.verdict.decision).toBe('proceed');
    // Record 1: blocked trade — rails proceeded, warrant denied.
    expect(records[1]!.verdict.decision).toBe('proceed');
    expect(records[1]!.warrant!.authorized).toBe(false);
    // Record 2: escalated governance — warrant null (never consulted).
    expect(records[2]!.verdict.decision).not.toBe('proceed');
    expect(records[2]!.warrant).toBeNull();
  });
});
