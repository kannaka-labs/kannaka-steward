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
 *
 * The rails NEVER produce "proceed" unless the action is bounded, reversible
 * enough, confidently aligned, and within authority. When in doubt: escalate.
 */

import type { Charter, HardConstraint } from './charter.js';
import type { ActionContext, Judgment, Verdict } from './types.js';

export function verify(
  judgment: Judgment,
  action: ActionContext,
  charter: Charter,
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

  if (worst === 'proceed') {
    reasons.push('All rails satisfied: confident, within authority, no hard-constraint breach.');
  }

  return { decision: worst, reasons };
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
