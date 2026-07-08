/**
 * Rails — the safety core. This is where intent becomes enforcement.
 *
 * The reasoner says what it *thinks*; the rails decide what the kernel is
 * *allowed* to do. Rails are strict and explicit and default to escalate-to-
 * human on ANY ambiguity. They enforce, independent of the reasoner:
 *
 *   1. Confidence floor (charter.confidenceThreshold).
 *   2. Every hard constraint:
 *        - requireHuman (always | irreversible | onSupport) => escalate
 *        - maxImpact breach                                  => escalate
 *        - forbidIrreversible + supporting an irreversible   => refuse
 *   3. Authority bound (authority.maxAutoImpact).
 *   4. Abstain handling per charter.abstainWhenUncertain.
 *   5. Rate limit (authority.perWindow): at most maxActions PROCEED actions per
 *      charter per rolling window, counted from the audit log. See below.
 *
 * The rails NEVER produce "proceed" unless the action is bounded, reversible
 * enough, confidently aligned, within authority, AND within the rate budget.
 * When in doubt: escalate.
 */

import type { AuditRecord } from './audit.js';
import type { Charter, HardConstraint } from './charter.js';
import type { ActionContext, Judgment, Verdict } from './types.js';

/**
 * Audit-backed context the rails need to enforce authority.perWindow. It is the
 * caller's job (the steward loop, which owns the audit log) to supply this — the
 * rails cannot read the log themselves. Omit it entirely (or leave perWindow
 * undefined on the charter) to skip rate enforcement; that is why the ~existing
 * direct verify() callers keep working unchanged.
 */
export interface RateLimitContext {
  /**
   * PRIOR audit records (all of them). The counter filters by charterId, window,
   * and qualifying verdict itself — pass the whole log and let the rails decide.
   */
  priorRecords?: AuditRecord[];
  /**
   * Set to a reason string when the audit log could NOT be read/parsed. Forces a
   * fail-safe escalate: without a trustworthy count we must not assume we are
   * under the limit. A cleanly-absent log is NOT unreadable — it is zero prior
   * actions (a fresh system), and its first action is legitimately allowed.
   */
  unreadable?: string;
  /** Evaluation instant (epoch ms); defaults to Date.now(). Injectable for tests. */
  now?: number;
}

export function verify(
  judgment: Judgment,
  action: ActionContext,
  charter: Charter,
  rate?: RateLimitContext,
): Verdict {
  const reasons: string[] = [];
  let worst: Verdict['decision'] = 'proceed';

  const escalate = (reason: string) => {
    reasons.push(`ESCALATE: ${reason}`);
    if (worst === 'proceed') worst = 'escalate';
  };
  const refuse = (reason: string) => {
    reasons.push(`REFUSE: ${reason}`);
    worst = 'refuse';
  };

  // --- 0. Abstain short-circuit ---------------------------------------------
  if (judgment.support === 'abstain') {
    // Abstaining is itself an action choice. We allow proceeding with an
    // explicit abstain ONLY if it is confident AND the charter does not force
    // a human. Otherwise we escalate so a human decides.
    if (charter.abstainWhenUncertain && judgment.confidence < charter.confidenceThreshold) {
      escalate(
        `reasoner abstained with low confidence ${judgment.confidence} (< threshold ${charter.confidenceThreshold}); human should decide.`,
      );
    } else {
      reasons.push('NOTE: reasoner chose to abstain (a deliberate, low-impact vote).');
    }
  }

  // --- 1. Confidence floor ---------------------------------------------------
  if (judgment.confidence < charter.confidenceThreshold) {
    if (charter.abstainWhenUncertain) {
      escalate(
        `confidence ${judgment.confidence} below threshold ${charter.confidenceThreshold}; abstainWhenUncertain=true.`,
      );
    } else {
      escalate(
        `confidence ${judgment.confidence} below threshold ${charter.confidenceThreshold}.`,
      );
    }
  }

  // --- 2. Authority bound ----------------------------------------------------
  if (action.impact.magnitude > charter.authority.maxAutoImpact) {
    escalate(
      `impact magnitude ${action.impact.magnitude} exceeds authority.maxAutoImpact ${charter.authority.maxAutoImpact}.`,
    );
  }

  // --- 3. Hard constraints ---------------------------------------------------
  for (const hc of charter.hardConstraints) {
    applyHardConstraint(hc, judgment, action, escalate, refuse);
  }

  // --- 4. Active-state sanity ------------------------------------------------
  // Only ever propose acting on actions that are actually actionable.
  if (action.kind === 'governance-vote' && action.state !== 'Active') {
    escalate(`proposal state is "${action.state}", not Active; voting may be closed.`);
  }
  // A market must be open (not resolved/cancelled/paused) to trade into.
  if (
    action.kind === 'market-trade' &&
    action.state !== 'active' &&
    action.state !== 'open'
  ) {
    escalate(`market state is "${action.state}", not active/open; the market may be closed.`);
  }

  // --- 5. Rate limit (authority.perWindow) -----------------------------------
  // Enforced ONLY when the charter declares perWindow AND the caller supplied a
  // rate context (the steward loop always does; direct callers / tests opt in).
  if (charter.authority.perWindow && rate) {
    enforceRateLimit(charter.authority.perWindow, charter.id, rate, escalate);
  }

  if (worst === 'proceed') {
    reasons.push('All rails satisfied: confident, within authority, within rate budget, no hard-constraint breach.');
  }

  return { decision: worst, reasons };
}

/**
 * Enforce authority.perWindow from the audit trail.
 *
 * What counts as an "action": a record whose rails verdict is `proceed`. That is
 * the kernel's authority-level decision to ACT; escalations and refusals are the
 * kernel declining to act (handing off to a human) and consume no budget. A
 * proceed that was later blocked by the warrant gate STILL counts here — the
 * rate limit lives under `authority`, alongside maxAutoImpact, and bounds the
 * rails' authority to propose action, which is decided before (and independent
 * of) the downstream warrant. Counting it can only trip the limit sooner, which
 * is the fail-safe direction.
 *
 * Fail-safe: if the audit log is unreadable, or the window spec is unparseable,
 * or a qualifying record carries an unparseable timestamp, we escalate / count
 * conservatively rather than silently allow.
 */
function enforceRateLimit(
  pw: { window: string; maxActions: number },
  charterId: string,
  rate: RateLimitContext,
  escalate: (r: string) => void,
): void {
  if (rate.unreadable) {
    escalate(
      `rate limit ${pw.maxActions}/${pw.window} cannot be verified: audit log unreadable (${rate.unreadable}); escalating rather than assuming zero prior actions.`,
    );
    return;
  }

  const windowMs = parseWindowMs(pw.window);
  if (windowMs === undefined) {
    escalate(
      `rate limit window "${pw.window}" is unparseable; cannot enforce authority.perWindow — escalating.`,
    );
    return;
  }

  const now = rate.now ?? Date.now();
  const cutoff = now - windowMs;
  let count = 0;
  for (const r of rate.priorRecords ?? []) {
    if (r.charterId !== charterId) continue;
    if (r.verdict.decision !== 'proceed') continue;
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) {
      // A qualifying record we cannot place in time — count it (err toward blocking).
      count += 1;
      continue;
    }
    if (t > cutoff && t <= now) count += 1;
  }

  if (count >= pw.maxActions) {
    escalate(
      `rate limit reached: ${count} prior proceed action(s) for charter "${charterId}" within ${pw.window} ≥ maxActions ${pw.maxActions}; a human should authorize further action.`,
    );
  }
}

/**
 * Parse a rolling-window spec ("24h", "30m", "1d", "10s") into milliseconds.
 * Returns undefined for anything malformed so the caller can fail safe.
 */
export function parseWindowMs(window: string): number | undefined {
  const m = /^(\d+)\s*([smhd])$/.exec(window.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return n * unit;
}

function applyHardConstraint(
  hc: HardConstraint,
  judgment: Judgment,
  action: ActionContext,
  escalate: (r: string) => void,
  refuse: (r: string) => void,
): void {
  const rule = hc.rule;
  switch (rule.kind) {
    case 'requireHuman': {
      if (rule.when === 'always') {
        escalate(`hardConstraint ${hc.id}: ${hc.statement}`);
      } else if (rule.when === 'irreversible' && !action.impact.reversible) {
        escalate(`hardConstraint ${hc.id}: irreversible action requires human. ${hc.statement}`);
      } else if (rule.when === 'onSupport' && judgment.support !== 'abstain') {
        escalate(`hardConstraint ${hc.id}: directional vote requires human. ${hc.statement}`);
      }
      break;
    }
    case 'maxImpact': {
      const value =
        rule.field === 'magnitude'
          ? action.impact.magnitude
          : // Unknown native field: be conservative and treat as a breach.
            Number.POSITIVE_INFINITY;
      if (value > rule.limit) {
        escalate(
          `hardConstraint ${hc.id}: ${rule.field}=${value} exceeds limit ${rule.limit}. ${hc.statement}`,
        );
      }
      break;
    }
    case 'forbidIrreversible': {
      // The kernel must never auto-propose SUPPORTING an irreversible action.
      if (!action.impact.reversible && judgment.support === 'for') {
        refuse(
          `hardConstraint ${hc.id}: cannot auto-support an irreversible action. ${hc.statement}`,
        );
      } else if (!action.impact.reversible) {
        // Opposing/abstaining on an irreversible action is fine, but still
        // worth a human's eyes.
        escalate(
          `hardConstraint ${hc.id}: irreversible action under consideration. ${hc.statement}`,
        );
      }
      break;
    }

    // --- trade-surface constraints (only bind on market-trade actions) --------
    case 'maxSlippage': {
      const cand = action.market?.candidate;
      // Only relevant when we'd actually take the position (support 'for').
      if (cand && judgment.support === 'for' && cand.slippage > rule.limit) {
        escalate(
          `hardConstraint ${hc.id}: slippage ${cand.slippage} exceeds limit ${rule.limit}. ${hc.statement}`,
        );
      }
      break;
    }
    case 'minLiquidity': {
      const b = action.market?.liquidityParameter;
      if (action.kind === 'market-trade' && (b === undefined || b < rule.floor)) {
        escalate(
          `hardConstraint ${hc.id}: liquidity ${b ?? 'unknown'} below floor ${rule.floor}. ${hc.statement}`,
        );
      }
      break;
    }
    case 'maxPositionFraction': {
      const cand = action.market?.candidate;
      if (cand && judgment.support === 'for' && cand.positionFraction > rule.limit) {
        escalate(
          `hardConstraint ${hc.id}: position fraction ${cand.positionFraction} exceeds limit ${rule.limit}. ${hc.statement}`,
        );
      }
      break;
    }
    case 'requireHumanAboveSize': {
      const cand = action.market?.candidate;
      if (cand && judgment.support === 'for' && cand.positionFraction > rule.fraction) {
        escalate(
          `hardConstraint ${hc.id}: position fraction ${cand.positionFraction} exceeds human-review size ${rule.fraction}. ${hc.statement}`,
        );
      }
      break;
    }
  }
}
