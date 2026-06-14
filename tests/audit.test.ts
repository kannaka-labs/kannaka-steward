import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuditLog,
  verifyAuditChain,
  GENESIS_HASH,
  computeRecordHash,
  type AuditRecord,
} from '../src/audit.js';
import type { Judgment, Verdict } from '../src/types.js';

const judgment: Judgment = {
  support: 'for',
  confidence: 0.9,
  rationale: 'r',
  appliedPrinciples: ['p'],
  concerns: [],
};
const verdict: Verdict = { decision: 'proceed', reasons: ['ok'] };

function tmpAuditPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'steward-audit-'));
  return join(dir, 'audit.jsonl');
}

describe('audit hash-chain', () => {
  it('appends a chained record and starts from genesis', () => {
    const log = new AuditLog(tmpAuditPath());
    const r = log.append({
      charterId: 'c',
      charterHash: 'h',
      surface: 'amor',
      actionId: '1',
      judgment,
      verdict,
      dryRun: null,
    });
    expect(r.seq).toBe(0);
    expect(r.prevHash).toBe(GENESIS_HASH);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('chains multiple records and verifies intact', () => {
    const log = new AuditLog(tmpAuditPath());
    for (let i = 0; i < 5; i++) {
      log.append({ charterId: 'c', charterHash: 'h', surface: 'amor', actionId: String(i), judgment, verdict, dryRun: null });
    }
    const res = log.verify();
    expect(res.ok).toBe(true);
    expect(res.count).toBe(5);
  });

  it('detects tampering (mutated past record)', () => {
    const log = new AuditLog(tmpAuditPath());
    log.append({ charterId: 'c', charterHash: 'h', surface: 'amor', actionId: '0', judgment, verdict, dryRun: null });
    log.append({ charterId: 'c', charterHash: 'h', surface: 'amor', actionId: '1', judgment, verdict, dryRun: null });
    const records = log.readAll();
    // Tamper: flip the verdict on record 0 without recomputing hashes.
    const tampered: AuditRecord[] = records.map((r, i) =>
      i === 0 ? { ...r, verdict: { decision: 'refuse', reasons: ['HACKED'] } } : r,
    );
    const res = verifyAuditChain(tampered);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(0);
  });

  it('detects a broken chain link (prevHash mismatch)', () => {
    const log = new AuditLog(tmpAuditPath());
    log.append({ charterId: 'c', charterHash: 'h', surface: 'amor', actionId: '0', judgment, verdict, dryRun: null });
    log.append({ charterId: 'c', charterHash: 'h', surface: 'amor', actionId: '1', judgment, verdict, dryRun: null });
    const records = log.readAll();
    // Re-hash record 1 with a corrupted prevHash so its own hash is internally
    // consistent but the chain link to record 0 is broken.
    const bad = { ...records[1]! } as AuditRecord;
    const { hash: _h, ...rest } = bad;
    const restBad = { ...rest, prevHash: 'f'.repeat(64) };
    const rehashed: AuditRecord = { ...restBad, hash: computeRecordHash(restBad) };
    const res = verifyAuditChain([records[0]!, rehashed]);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(1);
  });
});
