/**
 * ============================================================================
 *  THE STEWARD — Intent & Reliability Kernel
 * ============================================================================
 *
 *  HARD SAFETY RULES (structural, not advisory):
 *
 *   1. NO private keys. NO signers. NO transaction submission. ANYWHERE.
 *      ethers is used READ-ONLY (JsonRpcProvider only; Wallet is never
 *      imported or constructed). "Dry-run" means: build calldata + a static
 *      read-only estimate. It NEVER sends.
 *
 *   2. The kernel's OUTPUT is a HumanSignablePackage (or an EscalationNotice).
 *      A human — or a later, separately-reviewed signing layer — submits it.
 *      This module cannot. "Conscience before wallet."
 *
 *   3. DEFAULT TO ESCALATE-TO-HUMAN on uncertainty. Bias toward refusing an
 *      action over taking a wrong one. The rails are the arbiter, not the
 *      reasoner.
 *
 *  Flow:  read → reason → rails → (if proceed) dryRun → build package
 *         ELSE → escalation notice.  Either way: write the audit record.
 *         Emit NOTHING on-chain.
 * ============================================================================
 */

import type { SurfaceAdapter } from './adapter.js';
import type { LoadedCharter } from './charter.js';
import type { IntentReasoner } from './reason.js';
import { DeterministicReasoner } from './reason.js';
import { verify } from './rails.js';
import { checkWarrant, scopeForAction, type CheckWarrantOptions } from './warrant.js';
import { AuditLog, DEFAULT_AUDIT_PATH } from './audit.js';
import type {
  ActionContext,
  DryRunResult,
  EscalationNotice,
  HumanSignablePackage,
  Judgment,
  StewardResult,
  Verdict,
  WarrantBlockedNotice,
  WarrantVerdict,
} from './types.js';

/**
 * Warrant inputs threaded through the loop. The orchestrator supplies the
 * scope + action + impact itself (derived from the action); the caller supplies
 * only the SOURCE of the delegation (a fixture path / loaded grant, or a live
 * introspect URL + token/grantId). Omit entirely to skip the warrant gate
 * (legacy behavior — packages emit without a warrant annotation).
 */
export type WarrantRunOptions = Omit<
  CheckWarrantOptions,
  'scope' | 'action' | 'impact'
>;

export interface RunOptions {
  reasoner?: IntentReasoner;
  auditPath?: string;
  log?: (msg: string) => void;
  /**
   * Warrant (delegation) inputs. When present, the loop adds the SECOND gate:
   * after the rails proceed, the agent must also be delegated the scope for its
   * human, or NOTHING is emitted (a WarrantBlockedNotice is produced instead).
   */
  warrant?: WarrantRunOptions;
}

export interface RunReport {
  action: ActionContext;
  judgment: Judgment;
  verdict: Verdict;
  /** The warrant decision, present only when a warrant gate was consulted. */
  warrant: WarrantVerdict | null;
  dryRun: DryRunResult | null;
  result: StewardResult;
  auditId: string;
}

/**
 * Run the full kernel loop for one action reference on one surface.
 * Returns a structured report; writes exactly one audit record.
 */
export async function runSteward(
  loaded: LoadedCharter,
  adapter: SurfaceAdapter,
  ref: string,
  opts: RunOptions = {},
): Promise<RunReport> {
  const { charter, contentHash } = loaded;
  const reasoner = opts.reasoner ?? new DeterministicReasoner();
  const audit = new AuditLog(opts.auditPath ?? DEFAULT_AUDIT_PATH);

  // 1. READ (live first, fixture fallback — adapter decides + reports).
  const action = await adapter.readAction(ref);

  // 2. REASON.
  const judgment = await reasoner.judge(action, charter);

  // 3. RAILS — the safety arbiter.
  const verdict = verify(judgment, action, charter);

  // 4. DRY-RUN only if the rails permit proceeding. SIMULATION ONLY.
  let dryRun: DryRunResult | null = null;
  let warrant: WarrantVerdict | null = null;
  let result: StewardResult;

  if (verdict.decision === 'proceed') {
    // Rails said FAITHFUL. Build the bounded package (simulation only).
    const proposed = adapter.describeProposed(judgment, action);
    dryRun = await adapter.dryRun(proposed); // builds calldata; never sends

    // 4b. WARRANT — the SECOND gate. The rails proved the action faithful and
    //     within authority; the warrant must now prove the agent is DELEGATED
    //     the scope for this human. Consulted ONLY because rails proceeded —
    //     if rails had escalated/refused, the action is already blocked and the
    //     warrant is never asked. A read-only permission query; emits nothing.
    if (opts.warrant) {
      const scope = scopeForAction(action.kind);
      warrant = await checkWarrant({
        ...opts.warrant,
        scope,
        action: action.kind,
        impact: action.impact.magnitude,
      });
    }

    if (!opts.warrant || (warrant && warrant.authorized)) {
      // PERMITTED (or no warrant gate configured): emit the package as today,
      // annotated with the warrant decision when one was made.
      const pkg: HumanSignablePackage = {
        kind: 'human-signable-package',
        summary: `${proposed.summary}. Requires a human to sign + submit; the Steward cannot.`,
        proposedAction: proposed,
        calldata: dryRun.calldata,
        to: dryRun.to,
        dryRun,
        rationale: judgment.rationale,
        verdict,
        ...(warrant
          ? {
              warrant: {
                authorized: true as const,
                source: warrant.source,
                grantId: warrant.grantId,
                scopes: warrant.scopes,
              },
            }
          : {}),
        auditId: '', // filled after audit append
      };
      result = pkg;
    } else {
      // MOVED but NOT PERMITTED: faithful + within rails, but the agent is not
      // delegated the scope for this human. Emit NO calldata/order — produce a
      // distinct WarrantBlockedNotice (not an EscalationNotice).
      const w = warrant!;
      const scopeLabel = scopeForAction(action.kind) ?? `(unmapped:${action.kind})`;
      const notice: WarrantBlockedNotice = {
        kind: 'warrant-blocked-notice',
        summary:
          `MOVED but NOT PERMITTED: the Steward judged this action faithful and within ` +
          `rails, but the agent is not delegated ${scopeLabel} for this human — ` +
          `${w.reasons.join('; ')}. No action emitted.`,
        judgment,
        verdict,
        warrant: w,
        proposedAction: proposed,
        auditId: '',
      };
      result = notice;
    }
  } else {
    // escalate or refuse → produce an escalation notice (no calldata at all).
    // Rails already blocked the action; the warrant is NOT consulted.
    const notice: EscalationNotice = {
      kind: 'escalation-notice',
      summary:
        verdict.decision === 'refuse'
          ? 'The Steward REFUSES to propose this action (hard-constraint breach).'
          : 'The Steward ESCALATES to a human (uncertain or outside auto-authority).',
      judgment,
      verdict,
      auditId: '',
    };
    result = notice;
  }

  // 5. AUDIT — always, regardless of outcome. Tamper-evident, hash-chained.
  //    Captures BOTH the rails verdict AND the warrant verdict (additive).
  const record = audit.append({
    charterId: charter.id,
    charterHash: contentHash,
    surface: action.surface,
    actionId: action.id,
    judgment,
    verdict,
    warrant,
    dryRun,
  });
  const auditId = `${record.seq}:${record.hash.slice(0, 12)}`;
  result.auditId = auditId;

  return { action, judgment, verdict, warrant, dryRun, result, auditId };
}
