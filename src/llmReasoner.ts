/**
 * LLM-backed reasoner behind the IntentReasoner seam.
 *
 * The DeterministicReasoner (reason.ts) emits confidence 1.0-ish signals from
 * keyword matches; a real model should instead report its HONEST uncertainty so
 * the charter's confidence floor can do its job. This module drops a model in
 * behind the same `judge(action, charter) => Judgment` contract WITHOUT touching
 * the rails: the rails remain the safety net regardless of how the judgment was
 * produced — an over-confident or captured model cannot bypass a hard constraint.
 *
 * Two pieces:
 *   1. `anthropicCompletion(opts)` — a CompletionFn that calls the Anthropic
 *      Messages API directly over fetch (no SDK dependency; the no-signing
 *      invariant keeps runtime deps to a tiny allowlist). The key comes from
 *      ANTHROPIC_API_KEY (or opts.apiKey) and is NEVER hardcoded.
 *   2. `LlmReasoner` — builds an intent-faithful prompt, calls the completion
 *      fn, and parses the reply DEFENSIVELY. Every failure mode (network error,
 *      no JSON, malformed JSON, out-of-range confidence, missing/invalid fields,
 *      a plain-text refusal) resolves to a low-confidence abstain judgment, so
 *      the rails ESCALATE. It never fails toward "proceed".
 */

import type { Charter } from './charter.js';
import type { ActionContext, Judgment } from './types.js';
import type { IntentReasoner } from './reason.js';

/** A minimal completion function the host wires to its provider of choice. */
export type CompletionFn = (prompt: string) => Promise<string>;

/** Default model. Configurable via AnthropicOptions.model. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-fable-5';

export interface AnthropicOptions {
  /** API key. Defaults to process.env.ANTHROPIC_API_KEY. NEVER hardcode a key. */
  apiKey?: string;
  /** Model id. Defaults to DEFAULT_ANTHROPIC_MODEL. */
  model?: string;
  /** Max output tokens. Default 1024 (a JSON verdict is small). */
  maxTokens?: number;
  /** API base URL. Default https://api.anthropic.com. */
  baseUrl?: string;
  /** Request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Injectable fetch (for tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Build a CompletionFn backed by the Anthropic Messages API (POST /v1/messages).
 * Sends the prompt as a single user message and returns the concatenated text
 * of the response's `text` content blocks.
 *
 * Note (Anthropic Fable-family behavior): a safety-classifier decline returns a
 * successful HTTP 200 with an EMPTY content array (stop_reason "refusal"). We
 * surface that as "no text content" → throw → the reasoner treats it as an
 * escalation. That is deliberate: for a conscience kernel a refusal is a safe
 * hand-off to a human, not something to paper over with a model fallback.
 */
export function anthropicCompletion(opts: AnthropicOptions = {}): CompletionFn {
  return async (prompt: string): Promise<string> => {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'anthropicCompletion requires an API key: set ANTHROPIC_API_KEY (never hardcode it) or pass opts.apiKey.',
      );
    }
    const model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    const maxTokens = opts.maxTokens ?? 1024;
    const baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const doFetch = opts.fetchImpl ?? fetch;

    const res = await withTimeout(
      doFetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
      }),
      opts.timeoutMs ?? 30_000,
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Anthropic API HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      );
    }

    const data = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = (data.content ?? [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    if (!text) {
      // Empty content = a pre-output refusal, or a response with no text blocks.
      throw new Error('Anthropic API returned no text content (possible refusal).');
    }
    return text;
  };
}

export interface LlmReasonerOptions {
  complete?: CompletionFn;
  /** Hard cap the model is allowed to claim; the rails still re-check. Default 0.95. */
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
      // A wiring error (chose the LLM reasoner but supplied no provider), not a
      // runtime uncertainty — surface it loudly rather than silently escalating.
      throw new Error(
        'LlmReasoner requires a `complete` function. Use DeterministicReasoner for key-free operation, or wire a provider (e.g. anthropicCompletion()).',
      );
    }
    const prompt = this.buildPrompt(action, charter);
    let raw: string;
    try {
      raw = await this.complete(prompt);
    } catch (e) {
      // ANY failure of the model call (network, HTTP, timeout, refusal) fails
      // toward escalation — never toward proceed.
      return failSafe(`LLM call failed: ${(e as Error).message}`);
    }
    const parsed = this.parse(raw);
    // Defense-in-depth: clamp the model's self-reported confidence DOWNWARD only;
    // the rails re-verify against the charter regardless.
    parsed.confidence = Math.min(parsed.confidence, this.maxConfidence);
    return parsed;
  }

  /**
   * Intent-faithful prompt: the model reasons AS the charter, not as itself, and
   * must return its honest uncertainty. Presents the charter, the observed state,
   * and the proposed action, and pins the required JSON verdict shape.
   */
  private buildPrompt(action: ActionContext, charter: Charter): string {
    return [
      'You are a faithful steward acting strictly within the following Intent Charter.',
      'You have NO preferences of your own; reason ONLY from the charter below.',
      '',
      `INTENT CHARTER (principles, hard constraints, thresholds, authority):`,
      JSON.stringify(charter),
      '',
      `OBSERVED STATE + PROPOSED ACTION under consideration:`,
      JSON.stringify(action),
      '',
      'Decide how the charter would have you vote on this action, and report your',
      'HONEST uncertainty. Return ONLY a JSON object of exactly this shape:',
      '{"support":"for"|"against"|"abstain","confidence":<number 0..1>,"rationale":"<why>","appliedPrinciples":["<principle id>"],"concerns":["<concern>"]}',
      '',
      'Rules:',
      '- "confidence" is your genuine calibrated probability that this vote is what',
      '  the charter\'s owner would want. Do NOT inflate it. If the evidence is thin',
      '  or the charter is silent on this action, use a LOW confidence and abstain.',
      '- Abstain when uncertain. Never claim more confidence than the evidence supports.',
      '- Output the JSON object and nothing else.',
    ].join('\n');
  }

  /**
   * Parse the model reply into a Judgment, DEFENSIVELY. Never throws. The two
   * safety-critical fields (support, confidence) are validated hard: anything
   * missing, malformed, or out of range yields a fail-safe abstain@0 judgment so
   * the rails escalate. Informational fields default without failing.
   */
  private parse(raw: string): Judgment {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return failSafe('no JSON object in completion (possible refusal or truncated output)');
    }

    let obj: unknown;
    try {
      obj = JSON.parse(match[0]);
    } catch (e) {
      return failSafe(`malformed JSON in completion: ${(e as Error).message}`);
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      return failSafe('completion JSON is not an object');
    }
    const o = obj as Record<string, unknown>;

    // support: exactly one of the three. Accept "action" as an alias (some models
    // echo the field name from the schema differently). Anything else → abstain.
    const rawSupport = o.support ?? o.action;
    if (rawSupport !== 'for' && rawSupport !== 'against' && rawSupport !== 'abstain') {
      return failSafe(`invalid or missing "support" (${JSON.stringify(rawSupport)})`);
    }
    const support = rawSupport;

    // confidence: a finite number in [0,1]. Out-of-range is treated as invalid —
    // clamping 1.5 -> maxConfidence would push TOWARD proceed, which is exactly
    // what we must never do, so an out-of-range value fails safe instead.
    const confidence = o.confidence;
    if (
      typeof confidence !== 'number' ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      return failSafe(`invalid or missing "confidence" (${JSON.stringify(confidence)})`);
    }

    const rationale = typeof o.rationale === 'string' ? o.rationale : '';
    const appliedPrinciples = Array.isArray(o.appliedPrinciples)
      ? o.appliedPrinciples.filter((x): x is string => typeof x === 'string')
      : [];
    const concerns = Array.isArray(o.concerns)
      ? o.concerns.filter((x): x is string => typeof x === 'string')
      : [];

    return { support, confidence, rationale, appliedPrinciples, concerns };
  }
}

/** A judgment that forces the rails to escalate: no direction, zero confidence. */
function failSafe(reason: string): Judgment {
  return {
    support: 'abstain',
    confidence: 0,
    rationale: `LLM verdict rejected: ${reason}. Failing toward escalation (abstain, confidence 0).`,
    appliedPrinciples: [],
    concerns: [reason],
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms);
  });
  // Clear the timer once the request settles so a resolved call leaves no
  // dangling 30s timer keeping the event loop (or a test run) alive.
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
