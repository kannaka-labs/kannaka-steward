/**
 * LLM-backed reasoner SEAM (stub).
 *
 * This documents how an LLM reasoner drops in behind the same IntentReasoner
 * interface. It is intentionally NOT wired to any provider and requires NO key
 * to import. If constructed without a `complete` function it throws on use,
 * so the kernel never silently depends on a network LLM.
 *
 * The contract the rails rely on is unchanged: the reasoner returns a Judgment
 * (support/confidence/rationale/appliedPrinciples/concerns). The rails remain
 * the safety net no matter how that judgment was produced — an
 * over-confident or captured LLM cannot bypass the hard constraints.
 */

import type { Charter } from './charter.js';
import type { ActionContext, Judgment } from './types.js';
import type { IntentReasoner } from './reason.js';

/** A minimal completion function the host wires to its provider of choice. */
export type CompletionFn = (prompt: string) => Promise<string>;

export interface LlmReasonerOptions {
  complete?: CompletionFn;
  /** Hard cap the model is allowed to claim; the rails still re-check. */
  maxConfidence?: number;
}

export class LlmReasoner implements IntentReasoner {
  readonly name = 'llm-backed';
  private readonly complete?: CompletionFn;
  private readonly maxConfidence: number;

  constructor(opts: LlmReasonerOptions = {}) {
    this.complete = opts.complete;
    this.maxConfidence = opts.maxConfidence ?? 0.95;
  }

  async judge(action: ActionContext, charter: Charter): Promise<Judgment> {
    if (!this.complete) {
      throw new Error(
        'LlmReasoner requires a `complete` function. Use DeterministicReasoner for key-free operation, or wire a provider here.',
      );
    }
    const prompt = this.buildPrompt(action, charter);
    const raw = await this.complete(prompt);
    const parsed = this.parse(raw);
    // Defense-in-depth: clamp the model's self-reported confidence; the rails
    // re-verify against the charter regardless.
    parsed.confidence = Math.min(parsed.confidence, this.maxConfidence);
    return parsed;
  }

  /** Intent-faithful prompt: the model is asked to act AS the charter, not as itself. */
  private buildPrompt(action: ActionContext, charter: Charter): string {
    return [
      'You are a faithful steward acting strictly within the following Intent Charter.',
      'You do NOT have your own preferences; you reason only from the charter.',
      `CHARTER: ${JSON.stringify(charter)}`,
      `ACTION: ${JSON.stringify(action)}`,
      'Return JSON: {"support":"for|against|abstain","confidence":0..1,"rationale":"...","appliedPrinciples":[],"concerns":[]}.',
      'Abstain when uncertain. Never claim more confidence than the evidence supports.',
    ].join('\n');
  }

  private parse(raw: string): Judgment {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('LLM reasoner: no JSON object in completion.');
    const obj = JSON.parse(match[0]) as Partial<Judgment>;
    return {
      support: obj.support ?? 'abstain',
      confidence: typeof obj.confidence === 'number' ? obj.confidence : 0,
      rationale: obj.rationale ?? '',
      appliedPrinciples: obj.appliedPrinciples ?? [],
      concerns: obj.concerns ?? [],
    };
  }
}
