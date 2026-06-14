/**
 * Shared domain types for the Steward kernel.
 *
 * These types form the contract between modules so each (adapter, reasoner,
 * rails, audit) stays separable and testable in isolation.
 */

/** Normalized, surface-agnostic view of an action under consideration. */
export interface ActionContext {
  /** Surface identifier, e.g. "amor", "ghostsignals", "pfork". */
  surface: string;
  /** Surface-native action kind, e.g. "governance-vote", "market-trade". */
  kind: string;
  /** Stable id of the action on its surface (proposalId, orderId, ...). */
  id: string;
  title: string;
  description: string;
  /** Free-form surface state, e.g. "Active", "Pending", "Succeeded". */
  state: string;
  /** Optional vote/market tally if applicable. */
  tally?: Record<string, string>;
  /** Normalized impact estimate used by the rails. */
  impact: ActionImpact;
  /** ISO deadline if the action is time-bounded. */
  deadline?: string;
  /** Provenance flag: did this come from a live read or a fixture fallback. */
  source: 'live' | 'fixture';
  /**
   * Optional market microstructure, present for kind:'market-trade'. Carries the
   * normalized outcomes and the liquidity parameter so the rails can enforce
   * trade hard-constraints (minLiquidity) and the reasoner can pick a direction.
   */
  market?: MarketContext;
}

/** Normalized prediction-market state for a market-trade action. */
export interface MarketContext {
  /** LMSR liquidity parameter b (higher = deeper, tighter spreads). */
  liquidityParameter: number;
  /** Outcomes with current probability (LMSR prices sum to 1). */
  outcomes: MarketOutcome[];
  /**
   * Pre-computed economics for the charter-bounded CANDIDATE order, so the rails
   * can enforce maxSlippage / maxPositionFraction / requireHumanAboveSize WITHOUT
   * depending on the reasoner. Populated by the adapter at read time.
   */
  candidate?: CandidateOrder;
  /** Stated risk budget the position fraction is measured against (quote units). */
  budget: number;
}

export interface MarketOutcome {
  id: string;
  label: string;
  /** Current LMSR probability/price in 0..1. */
  probability: number;
}

/** The bounded candidate order the adapter pre-priced for the rails to inspect. */
export interface CandidateOrder {
  outcomeId: string;
  outcomeLabel: string;
  type: 'buy' | 'sell';
  quantity: number;
  /** LMSR cost (Δ in the cost function) for this order, quote units. */
  cost: number;
  /** Average fill price = cost / quantity. */
  avgPrice: number;
  /** Slippage = avgPrice - marginalPriceBefore (fraction). */
  slippage: number;
  /** cost / budget. */
  positionFraction: number;
}

export interface ActionImpact {
  /**
   * Magnitude on a normalized 0..1 scale where 1 is "maximal authority /
   * irreversible treasury-scale impact". Adapters map native units into this.
   */
  magnitude: number;
  /** Whether the action's effect can be reversed by a subsequent action. */
  reversible: boolean;
  /** Optional native field this impact pertains to (e.g. "treasuryDrawdown"). */
  field?: string;
  /** Optional native magnitude for human readability (e.g. "12 ETH"). */
  nativeMagnitude?: string;
}

/** The reasoner's verdict on intent-alignment. */
export interface Judgment {
  support: 'for' | 'against' | 'abstain';
  /** 0..1 confidence in the support direction. */
  confidence: number;
  rationale: string;
  /** Charter principle ids that fired. */
  appliedPrinciples: string[];
  /** Concerns surfaced during reasoning (feeds rails + human review). */
  concerns: string[];
}

/** The concrete, bounded action the kernel would propose (never executes). */
export interface ProposedAction {
  surface: string;
  kind: string;
  /** Human summary of exactly what would be done. */
  summary: string;
  /** Surface-native parameters (e.g. {proposalId, support}). */
  params: Record<string, unknown>;
}

/** Result of a SIMULATION ONLY. No transaction is ever submitted. */
export interface DryRunResult {
  /** True if the simulation indicates the action would be valid/accepted. */
  ok: boolean;
  /** Hex calldata for the action, for the human-signable package. */
  calldata?: string;
  /** Target contract / endpoint the human would submit to. */
  to?: string;
  /** Static gas/cost estimate or validity notes. */
  estimate: string;
  /** Any simulation warnings. */
  warnings: string[];
  /** Provenance: was the estimate from a live static call or computed offline. */
  source: 'live' | 'offline';
}

/** The rails' safety decision. */
export interface Verdict {
  decision: 'proceed' | 'escalate' | 'refuse';
  reasons: string[];
}

/** The output for a human to (separately) sign and submit. */
export interface HumanSignablePackage {
  kind: 'human-signable-package';
  summary: string;
  proposedAction: ProposedAction;
  calldata?: string;
  to?: string;
  dryRun: DryRunResult;
  rationale: string;
  verdict: Verdict;
  /**
   * Set once the warrant layer has confirmed the agent IS delegated the scope
   * for this human. Present on every emitted package in the joined loop; absent
   * only if the package was built without the warrant gate.
   */
  warrant?: WarrantAnnotation;
  auditId: string;
}

/** The output when the kernel declines to act and hands off to a human. */
export interface EscalationNotice {
  kind: 'escalation-notice';
  summary: string;
  judgment: Judgment;
  verdict: Verdict;
  /** Optional proposed action context for the human to evaluate. */
  proposedAction?: ProposedAction;
  auditId: string;
}

/**
 * The warrant layer's authorization decision (the second arbiter, downstream of
 * the rails). The rails answer "is this faithful-to-intent?"; the warrant answers
 * "is this agent delegated the scope by its human?". An action is only emitted
 * when BOTH say yes. See warrant.ts.
 */
export interface WarrantVerdict {
  /** True only if the grant is live, scoped, and within its impact cap. */
  authorized: boolean;
  reasons: string[];
  /** Whether the decision came from the live introspect endpoint or a fixture. */
  source: 'live' | 'offline';
  /** The agent_grants row id the decision was made against, when known. */
  grantId?: string;
  /** The grant's scope set, for the audit trail + package annotation. */
  scopes?: string[];
}

/**
 * The output when the rails PROCEED (faithful + within authority) but the warrant
 * DENIES (the agent is not delegated the scope by its human). Distinct from an
 * EscalationNotice: the action was judged sound, but no delegation exists to act
 * on the human's behalf, so NOTHING is emitted. "Moved, but not permitted."
 */
export interface WarrantBlockedNotice {
  kind: 'warrant-blocked-notice';
  summary: string;
  judgment: Judgment;
  /** The rails verdict — which DID proceed (that's why warrant was consulted). */
  verdict: Verdict;
  /** The warrant verdict — which denied. */
  warrant: WarrantVerdict;
  /** The action the Steward WOULD have proposed, for the human to evaluate. */
  proposedAction?: ProposedAction;
  auditId: string;
}

/** Optional warrant annotation attached to an emitted package once permitted. */
export interface WarrantAnnotation {
  authorized: true;
  source: 'live' | 'offline';
  grantId?: string;
  scopes?: string[];
}

export type StewardResult =
  | HumanSignablePackage
  | EscalationNotice
  | WarrantBlockedNotice;
