/**
 * Audit — append-only, hash-chained JSONL trail.
 *
 * Every Steward decision (proceed/escalate/refuse) writes one record. Each
 * record's `hash` = sha256(canonical(record-without-hash) + prevHash), forming
 * a tamper-evident chain: altering any past record breaks every subsequent
 * hash. `verifyAuditChain()` re-walks the file and confirms integrity.
 *
 * This is the durable "the agent did X, for reason Y, within charter Z at time
 * T" record — the accountability half of faithfulness.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { canonicalize } from './charter.js';
import type {
  DryRunResult,
  Judgment,
  Verdict,
  WarrantVerdict,
} from './types.js';

export const DEFAULT_AUDIT_PATH = 'audit/steward-audit.jsonl';

export interface AuditRecord {
  seq: number;
  ts: string;
  charterId: string;
  charterHash: string;
  surface: string;
  actionId: string;
  judgment: Judgment;
  verdict: Verdict;
  /**
   * The warrant (delegation) decision, when the second gate was consulted.
   * `null` when no warrant gate ran (e.g. rails escalated/refused, or no
   * delegation source was supplied) — additive, so pre-warrant records and
   * tests that omit it remain valid in the chain.
   */
  warrant: WarrantSummary | null;
  dryRun: DryRunSummary | null;
  prevHash: string;
  hash: string;
}

export interface DryRunSummary {
  ok: boolean;
  to?: string;
  estimate: string;
  source: string;
  warnings: string[];
}

export interface WarrantSummary {
  authorized: boolean;
  source: string;
  grantId?: string;
  scopes?: string[];
  reasons: string[];
}

export const GENESIS_HASH = '0'.repeat(64);

export function summarizeDryRun(dr: DryRunResult | null): DryRunSummary | null {
  if (!dr) return null;
  return {
    ok: dr.ok,
    to: dr.to,
    estimate: dr.estimate,
    source: dr.source,
    warnings: dr.warnings,
  };
}

export function summarizeWarrant(
  w: WarrantVerdict | null | undefined,
): WarrantSummary | null {
  if (!w) return null;
  return {
    authorized: w.authorized,
    source: w.source,
    grantId: w.grantId,
    scopes: w.scopes,
    reasons: w.reasons,
  };
}

/** Compute the chain hash for a record (everything except its own `hash`). */
export function computeRecordHash(
  record: Omit<AuditRecord, 'hash'>,
): string {
  return createHash('sha256')
    .update(canonicalize(record) + record.prevHash)
    .digest('hex');
}

export interface AppendInput {
  charterId: string;
  charterHash: string;
  surface: string;
  actionId: string;
  judgment: Judgment;
  verdict: Verdict;
  /** Optional warrant decision; omitted/null when no warrant gate was consulted. */
  warrant?: WarrantVerdict | null;
  dryRun: DryRunResult | null;
}

export class AuditLog {
  constructor(private readonly path: string = DEFAULT_AUDIT_PATH) {}

  /** Read all records (empty array if file absent). */
  readAll(): AuditRecord[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as AuditRecord);
  }

  private lastHash(): { seq: number; hash: string } {
    const all = this.readAll();
    if (all.length === 0) return { seq: -1, hash: GENESIS_HASH };
    const last = all[all.length - 1]!;
    return { seq: last.seq, hash: last.hash };
  }

  /** Append a new record, chaining it to the previous one. Returns the record. */
  append(input: AppendInput): AuditRecord {
    const { seq: prevSeq, hash: prevHash } = this.lastHash();
    const withoutHash: Omit<AuditRecord, 'hash'> = {
      seq: prevSeq + 1,
      ts: new Date().toISOString(),
      charterId: input.charterId,
      charterHash: input.charterHash,
      surface: input.surface,
      actionId: input.actionId,
      judgment: input.judgment,
      verdict: input.verdict,
      warrant: summarizeWarrant(input.warrant),
      dryRun: summarizeDryRun(input.dryRun),
      prevHash,
    };
    const hash = computeRecordHash(withoutHash);
    const record: AuditRecord = { ...withoutHash, hash };

    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(record) + '\n', 'utf8');
    return record;
  }

  /** Re-walk the chain and confirm tamper-evidence. */
  verify(): AuditVerifyResult {
    return verifyAuditChain(this.readAll());
  }
}

export interface AuditVerifyResult {
  ok: boolean;
  count: number;
  /** Index of the first broken record, if any. */
  brokenAt?: number;
  reason?: string;
}

/** Pure verifier over an array of records (testable without the filesystem). */
export function verifyAuditChain(records: AuditRecord[]): AuditVerifyResult {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.seq !== i) {
      return { ok: false, count: records.length, brokenAt: i, reason: `seq mismatch: expected ${i}, got ${r.seq}` };
    }
    if (r.prevHash !== prevHash) {
      return { ok: false, count: records.length, brokenAt: i, reason: `prevHash mismatch at seq ${i}` };
    }
    const { hash, ...rest } = r;
    const expected = computeRecordHash(rest);
    if (expected !== hash) {
      return { ok: false, count: records.length, brokenAt: i, reason: `hash mismatch at seq ${i} (record was tampered)` };
    }
    prevHash = hash;
  }
  return { ok: true, count: records.length };
}
