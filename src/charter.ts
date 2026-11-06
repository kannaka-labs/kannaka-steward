/**
 * Intent Charter — a person's values made legible and machine-checkable.
 *
 * The charter is the kernel's notion of "faithfulness": principles (soft,
 * weighted preferences) and hardConstraints (non-negotiable rules) the agent
 * must act within. It carries NO personal data — only a label for the owner.
 *
 * A stable contentHash (sha256 of canonical JSON) is computed for the audit
 * trail so every decision can be tied to the exact intent in force at the time.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { resolveAsset } from './assets.js';

/** A machine-checkable rule attached to a hard constraint. */
export const HardRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('maxImpact'),
    /** Which ActionImpact field this bounds, or "magnitude" for the normalized scalar. */
    field: z.string().default('magnitude'),
    /** Upper bound on normalized impact magnitude (0..1) or native field. */
    limit: z.number(),
  }),
  z.object({
    kind: z.literal('requireHuman'),
    /** When to force human handoff: always | irreversible | onSupport. */
    when: z.enum(['always', 'irreversible', 'onSupport']).default('always'),
  }),
  z.object({
    kind: z.literal('forbidIrreversible'),
  }),
  // --- trade-surface constraint kinds (additive; governance is untouched) -----
  z.object({
    kind: z.literal('maxSlippage'),
    /** Upper bound on a proposed order's price slippage (0..1 fraction). */
    limit: z.number(),
  }),
  z.object({
    kind: z.literal('minLiquidity'),
    /** Floor on a market's liquidity parameter (b); thinner markets escalate. */
    floor: z.number(),
  }),
  z.object({
    kind: z.literal('maxPositionFraction'),
    /** Upper bound on (order cost / stated budget); larger positions escalate. */
    limit: z.number(),
  }),
  z.object({
    kind: z.literal('requireHumanAboveSize'),
    /** Order cost above this fraction of budget forces a human handoff. */
    fraction: z.number(),
  }),
]);
export type HardRule = z.infer<typeof HardRuleSchema>;

export const PrincipleSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  weight: z.number().min(0).max(1),
  polarity: z.enum(['favor', 'oppose']),
  /** Keywords used by the deterministic reasoner to detect relevance. */
  matchHints: z.array(z.string()).default([]),
});
export type Principle = z.infer<typeof PrincipleSchema>;

export const HardConstraintSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  rule: HardRuleSchema,
});
export type HardConstraint = z.infer<typeof HardConstraintSchema>;

export const AuthoritySchema = z.object({
  /** Max normalized impact (0..1) the kernel may ever propose to act on automatically. */
  maxAutoImpact: z.number().min(0).max(1),
  /** Optional per-window rate limits (advisory; enforced by an outer loop). */
  perWindow: z
    .object({
      window: z.string().default('24h'),
      maxActions: z.number().int().positive().default(1),
    })
    .optional(),
});
export type Authority = z.infer<typeof AuthoritySchema>;

export const CharterSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  /** Label only — NEVER personal data. */
  owner: z.string().min(1),
  principles: z.array(PrincipleSchema).min(1),
  hardConstraints: z.array(HardConstraintSchema).default([]),
  /** Minimum reasoner confidence for the rails to allow proceeding. */
  confidenceThreshold: z.number().min(0).max(1),
  authority: AuthoritySchema,
  /** If true, low-confidence judgments abstain (vs. defaulting to a direction). */
  abstainWhenUncertain: z.boolean().default(true),
});
export type Charter = z.infer<typeof CharterSchema>;

export interface LoadedCharter {
  charter: Charter;
  /** sha256 of canonical JSON of the validated charter. */
  contentHash: string;
}

/**
 * Canonicalize a JSON value: sort object keys recursively so the hash is
 * stable regardless of source key ordering.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

export function hashCharter(charter: Charter): string {
  return createHash('sha256').update(canonicalize(charter)).digest('hex');
}

/** Validate a parsed object into a Charter + content hash. */
export function validateCharter(raw: unknown): LoadedCharter {
  const charter = CharterSchema.parse(raw);
  return { charter, contentHash: hashCharter(charter) };
}

/** Load + validate a charter from a YAML file path. */
export function loadCharter(path: string): LoadedCharter {
  const text = readFileSync(resolveAsset(path), 'utf8');
  const raw = parseYaml(text);
  return validateCharter(raw);
}
