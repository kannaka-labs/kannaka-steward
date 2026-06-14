/**
 * IntentReasoner — judges whether an action aligns with the charter's intent.
 *
 * The DeterministicReasoner needs NO API key: it scores the action text against
 * each principle's matchHints, weights by the principle weight and polarity,
 * and maps the aggregate into a support direction + confidence. This makes the
 * whole kernel runnable and testable offline and deterministically.
 *
 * The interface is the seam: an LLM-backed reasoner (see llmReasoner.ts) can
 * implement the same `judge` and drop in, while the rails remain the safety net
 * regardless of how the judgment was produced.
 */

import type { Charter, Principle } from './charter.js';
import type { ActionContext, Judgment } from './types.js';

export interface IntentReasoner {
  readonly name: string;
  judge(action: ActionContext, charter: Charter): Promise<Judgment>;
}

/** Count how many of a principle's hints appear in the action text. */
function hintHits(text: string, principle: Principle): number {
  if (principle.matchHints.length === 0) return 0;
  const hay = text.toLowerCase();
  let hits = 0;
  for (const hint of principle.matchHints) {
    if (hay.includes(hint.toLowerCase())) hits += 1;
  }
  return hits;
}

export class DeterministicReasoner implements IntentReasoner {
  readonly name = 'deterministic-baseline';

  async judge(action: ActionContext, charter: Charter): Promise<Judgment> {
    if (action.kind === 'market-trade') {
      return this.judgeTrade(action, charter);
    }
    const text = `${action.title}\n${action.description}`;
    const applied: string[] = [];
    const concerns: string[] = [];

    // Accumulate signed evidence. `favor` principles push toward FOR; `oppose`
    // principles, when their content is present, push toward AGAINST.
    let forScore = 0;
    let againstScore = 0;
    let totalWeightSeen = 0;

    for (const p of charter.principles) {
      const hits = hintHits(text, p);
      if (hits === 0) continue;
      applied.push(p.id);
      // Saturating evidence: more hits => stronger, but capped.
      const evidence = Math.min(1, hits / 2) * p.weight;
      totalWeightSeen += p.weight;
      if (p.polarity === 'favor') {
        forScore += evidence;
      } else {
        // The presence of an "oppose" principle's subject is a reason to vote
        // AGAINST the proposal.
        againstScore += evidence;
        concerns.push(`Matches opposed principle "${p.id}": ${p.statement}`);
      }
    }

    // Reversibility / impact are first-class concerns surfaced to rails too.
    if (!action.impact.reversible) {
      concerns.push('Action is irreversible.');
      againstScore += 0.3; // irreversibility is itself a reason for caution
    }
    if (action.impact.magnitude > charter.authority.maxAutoImpact) {
      concerns.push(
        `Impact magnitude ${action.impact.magnitude} exceeds authority.maxAutoImpact ${charter.authority.maxAutoImpact}.`,
      );
    }

    const net = forScore - againstScore;
    const evidenceMass = forScore + againstScore;

    let support: Judgment['support'];
    let confidence: number;

    if (evidenceMass < 1e-9) {
      // No principle fired at all — we have no basis to act faithfully.
      support = 'abstain';
      confidence = 0.0;
      concerns.push('No charter principle matched; no basis for a confident judgment.');
    } else {
      support = net > 0 ? 'for' : net < 0 ? 'against' : 'abstain';
      // Confidence = how lopsided the evidence is, scaled by how much of the
      // charter's weight participated. Clear, one-sided signals on heavily
      // weighted principles produce high confidence.
      const decisiveness = Math.abs(net) / evidenceMass; // 0..1
      const coverage = Math.min(1, totalWeightSeen / 1.5); // saturate
      confidence = clamp01(0.2 + 0.8 * decisiveness * coverage);
      if (support === 'abstain') confidence = Math.min(confidence, 0.5);
    }

    const rationale = buildRationale(support, confidence, forScore, againstScore, applied, action);

    return {
      support,
      confidence: round3(confidence),
      rationale,
      appliedPrinciples: applied,
      concerns,
    };
  }

  /**
   * Trade-aware branch: 'for' = take the charter-bounded candidate position;
   * 'abstain' = don't (illiquid / over-budget / no candidate). The same
   * matchHints machinery scores the market text against the charter's trading
   * principles (favor hedging/liquidity/risk-budget, oppose oversize/illiquid),
   * then the candidate's economics gate the direction. The rails remain the
   * independent arbiter — this only proposes; it never bypasses a hard bound.
   */
  private async judgeTrade(action: ActionContext, charter: Charter): Promise<Judgment> {
    const text = `${action.title}\n${action.description}`;
    const applied: string[] = [];
    const concerns: string[] = [];

    let favorScore = 0;
    let opposeScore = 0;
    let totalWeightSeen = 0;

    for (const p of charter.principles) {
      const hits = hintHits(text, p);
      if (hits === 0) continue;
      applied.push(p.id);
      const evidence = Math.min(1, hits / 2) * p.weight;
      totalWeightSeen += p.weight;
      if (p.polarity === 'favor') favorScore += evidence;
      else {
        opposeScore += evidence;
        concerns.push(`Matches opposed principle "${p.id}": ${p.statement}`);
      }
    }

    const market = action.market;
    const cand = market?.candidate;

    // Structural gates from the candidate order economics (the rails re-check
    // these independently; here they only inform the proposed direction).
    let blocked = false;
    if (!market || !cand) {
      concerns.push('No candidate hedge order could be priced for this market.');
      blocked = true;
    }
    if (market) {
      // Liquidity floor: thin markets are uninvestable for the baseline.
      const minLiq = minLiquidityFloor(charter);
      if (minLiq !== undefined && market.liquidityParameter < minLiq) {
        concerns.push(
          `Market liquidity ${market.liquidityParameter} below charter floor ${minLiq}; too thin to take a position.`,
        );
        blocked = true;
      }
    }
    if (cand) {
      const maxFrac = maxPositionFractionLimit(charter) ?? charter.authority.maxAutoImpact;
      if (cand.positionFraction > maxFrac) {
        concerns.push(
          `Candidate position fraction ${cand.positionFraction} exceeds budget bound ${maxFrac}; oversized.`,
        );
        blocked = true;
      }
      const maxSlip = maxSlippageLimit(charter);
      if (maxSlip !== undefined && cand.slippage > maxSlip) {
        concerns.push(
          `Candidate slippage ${cand.slippage} exceeds limit ${maxSlip}; price impact too high.`,
        );
        blocked = true;
      }
    }

    const netFavor = favorScore - opposeScore;
    const evidenceMass = favorScore + opposeScore;

    let support: Judgment['support'];
    let confidence: number;

    if (blocked || netFavor <= 0 || evidenceMass < 1e-9) {
      // Don't take the position: illiquid, over-budget, high-slippage, or the
      // charter's hedge case isn't clearly favored by the principles.
      support = 'abstain';
      if (evidenceMass < 1e-9) {
        confidence = 0;
        concerns.push('No charter principle matched; no basis to take a position.');
      } else {
        const decisiveness = Math.abs(netFavor) / evidenceMass;
        const coverage = Math.min(1, totalWeightSeen / 1.5);
        confidence = Math.min(0.5, clamp01(0.2 + 0.8 * decisiveness * coverage));
      }
    } else {
      support = 'for';
      const decisiveness = netFavor / evidenceMass; // 0..1
      const coverage = Math.min(1, totalWeightSeen / 1.5);
      confidence = clamp01(0.2 + 0.8 * decisiveness * coverage);
    }

    const dir = support === 'for' ? 'takes' : 'declines';
    const candDesc = cand
      ? `${cand.quantity} ${cand.type} of "${cand.outcomeLabel}" (cost ${cand.cost}, slippage ${cand.slippage}, fraction ${cand.positionFraction})`
      : 'no priced candidate';
    const rationale = [
      `The steward ${dir} a bounded position on "${action.title}" with confidence ${round3(confidence)}.`,
      `Favor-evidence ${round3(favorScore)} vs oppose-evidence ${round3(opposeScore)}.`,
      applied.length ? `Principles engaged: ${applied.join(', ')}.` : 'No charter principles engaged.',
      `Candidate: ${candDesc}.`,
      market ? `Market liquidity ${market.liquidityParameter}; position is REVERSIBLE (sellable to the AMM).` : '',
    ]
      .filter(Boolean)
      .join(' ');

    return {
      support,
      confidence: round3(confidence),
      rationale,
      appliedPrinciples: applied,
      concerns,
    };
  }
}

/** Pull the maxSlippage hard-constraint limit, if the charter defines one. */
function maxSlippageLimit(charter: Charter): number | undefined {
  for (const hc of charter.hardConstraints) {
    if (hc.rule.kind === 'maxSlippage') return hc.rule.limit;
  }
  return undefined;
}

/** Pull the minLiquidity floor, if defined. */
function minLiquidityFloor(charter: Charter): number | undefined {
  for (const hc of charter.hardConstraints) {
    if (hc.rule.kind === 'minLiquidity') return hc.rule.floor;
  }
  return undefined;
}

/** Pull the maxPositionFraction limit, if defined. */
function maxPositionFractionLimit(charter: Charter): number | undefined {
  for (const hc of charter.hardConstraints) {
    if (hc.rule.kind === 'maxPositionFraction') return hc.rule.limit;
  }
  return undefined;
}

function buildRationale(
  support: Judgment['support'],
  confidence: number,
  forScore: number,
  againstScore: number,
  applied: string[],
  action: ActionContext,
): string {
  const dir =
    support === 'for'
      ? 'supports'
      : support === 'against'
        ? 'opposes'
        : 'abstains on';
  const parts = [
    `The steward ${dir} "${action.title}" with confidence ${round3(confidence)}.`,
    `Weighted favor-evidence ${round3(forScore)} vs oppose-evidence ${round3(againstScore)}.`,
    applied.length
      ? `Principles engaged: ${applied.join(', ')}.`
      : 'No charter principles engaged.',
    `Impact is ${action.impact.reversible ? 'reversible' : 'IRREVERSIBLE'} at normalized magnitude ${action.impact.magnitude}.`,
  ];
  return parts.join(' ');
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
