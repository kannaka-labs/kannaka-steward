/**
 * SurfaceAdapter — the seam that makes the Steward surface-agnostic.
 *
 * AMOR governance is the first implementation; ghostsignals markets and
 * PFORK treasury are intended to drop in behind this same interface. An
 * adapter normalizes a native action into an ActionContext, describes the
 * concrete bounded action the kernel would take, and SIMULATES it.
 *
 * Adapters MUST NOT submit, sign, or broadcast anything. `dryRun` is a
 * simulation only — it may build calldata and a static estimate, never send.
 */

import type {
  ActionContext,
  DryRunResult,
  Judgment,
  ProposedAction,
} from './types.js';

export interface SurfaceAdapter {
  /** Unique surface id this adapter serves (e.g. "amor"). */
  readonly surface: string;

  /** Read + normalize an action by its surface-native reference. */
  readAction(ref: string): Promise<ActionContext>;

  /**
   * Given a reasoning judgment + the action, produce the concrete bounded
   * action the kernel would propose. Pure/deterministic; no I/O, no submit.
   */
  describeProposed(judgment: Judgment, action: ActionContext): ProposedAction;

  /**
   * SIMULATE the proposed action. Build calldata + a static validity/cost
   * estimate. Never submits. Returns provenance so the demo is honest about
   * live vs. offline estimation.
   */
  dryRun(proposed: ProposedAction): Promise<DryRunResult>;
}
