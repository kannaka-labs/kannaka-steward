/**
 * Warrant — the SECOND arbiter. The capstone of "conscience + delegation".
 *
 * The rails answer one half of faithful agency: "is this action faithful to the
 * owner's intent, and within the kernel's authority?" The WARRANT answers the
 * other half: "is this agent actually DELEGATED the scope by its human?" An
 * action is only ever emitted when BOTH say yes — the Steward must be both
 * faithful-to-intent (rails) AND permitted (warrant).
 *
 * Mirrors spacechild-auth/src/agent-warrant.ts decideWarrant; LIVE mode calls
 * that endpoint. Keep in sync.
 *
 * Two modes:
 *   LIVE    — POST a READ-ONLY introspect query to the spacechild-auth warrant
 *             layer (`POST /auth/agents/introspect`). Used once auth is deployed.
 *   OFFLINE — load a local grant FIXTURE (shaped like the agent_grants row) and
 *             apply a faithful port of decideWarrant's conservative checks, so
 *             the demo is runnable with no server.
 *
 * SAFETY: this module performs ONLY a read-only introspect POST (a *query*, not
 * a mutation) or reads a local fixture file. It NEVER signs, executes, submits,
 * or spends. It only answers a yes/no permission question. Conservative by
 * construction: any doubt, any error, any missing data => DENY.
 */

import { readFileSync } from 'node:fs';
import type { WarrantVerdict } from './types.js';
import { resolveAsset } from './assets.js';

/** Agent scope strings the warrant layer recognizes (mirror of spacechild-auth). */
export const AGENT_SCOPES = {
  governVote: 'agent:govern:vote:bounded',
  marketTrade: 'agent:market:trade:bounded',
  treasuryRead: 'agent:treasury:read',
  curatePublish: 'agent:curate:publish',
} as const;

/**
 * Map an ActionContext.kind to the agent scope the warrant must delegate.
 *   governance-vote → agent:govern:vote:bounded
 *   market-trade    → agent:market:trade:bounded
 * Unknown kinds map to undefined → the caller treats that as "no scope" → deny.
 */
export function scopeForAction(kind: string): string | undefined {
  switch (kind) {
    case 'governance-vote':
      return AGENT_SCOPES.governVote;
    case 'market-trade':
      return AGENT_SCOPES.marketTrade;
    default:
      return undefined;
  }
}

/**
 * Shape of an agent_grants row (the OFFLINE fixture). Mirrors the columns the
 * spacechild-auth warrant layer reads in decideWarrant.
 */
export interface GrantFixture {
  id: string;
  scopes: string[];
  status: 'active' | 'revoked' | 'expired';
  /** ISO timestamp after which the grant is no longer live. */
  expiresAt: string;
  constraints?: {
    /** Cap on per-action impact the grant authorizes automatically (0..1). */
    maxAutoImpact?: number;
  };
  boundWalletAddress?: string;
}

/** Shape of the live `POST /auth/agents/introspect` response body. */
interface IntrospectResponse {
  authorized: boolean;
  userId?: string;
  agentClientId?: string;
  scopes?: string[];
  boundWallet?: string;
  reasons?: string[];
}

export interface CheckWarrantOptions {
  /** The scope being requested (e.g. agent:govern:vote:bounded). REQUIRED. */
  scope?: string;
  /** Surface-native action label, threaded to the live endpoint for its log. */
  action?: string;
  /** Normalized 0..1 impact magnitude; checked against the grant's cap. */
  impact?: number;

  // --- LIVE mode -----------------------------------------------------------
  /**
   * If set, query the live warrant layer at
   * `${introspectUrl}/auth/agents/introspect` (read-only). Otherwise OFFLINE.
   */
  introspectUrl?: string;
  /** Bearer token identifying the agent's delegation (live mode). */
  token?: string;
  /** Or the grant id to introspect directly (live mode). */
  grantId?: string;

  // --- OFFLINE mode --------------------------------------------------------
  /** Path to a grant fixture json (the agent_grants row). */
  fixturePath?: string;
  /** Or an already-loaded grant object (used by tests). */
  grant?: GrantFixture;

  /** Hook for printing live-vs-offline provenance notes. */
  log?: (msg: string) => void;
  /** Live-request timeout in ms. Default 5000. */
  timeoutMs?: number;
}

/**
 * Decide whether the agent is delegated `scope` for its human.
 *
 * LIVE if `introspectUrl` is set; OFFLINE otherwise. Either way: conservative —
 * authorized only if the grant is live, the scope is present, and (if an impact
 * is given) it is strictly below the grant's cap. Any error => deny.
 */
export async function checkWarrant(
  opts: CheckWarrantOptions,
): Promise<WarrantVerdict> {
  if (opts.introspectUrl) {
    return checkWarrantLive(opts);
  }
  return checkWarrantOffline(opts);
}

// ---------------------------------------------------------------------------
// OFFLINE — faithful port of decideWarrant over a local grant fixture.
// ---------------------------------------------------------------------------

function checkWarrantOffline(opts: CheckWarrantOptions): WarrantVerdict {
  const source = 'offline' as const;
  const scope = opts.scope;

  if (!scope) {
    return {
      authorized: false,
      source,
      reasons: ['no scope requested (unmapped action kind); deny on doubt'],
    };
  }

  let grant: GrantFixture;
  try {
    grant = opts.grant ?? loadGrantFixture(opts.fixturePath);
  } catch (e) {
    return {
      authorized: false,
      source,
      reasons: [`could not load grant fixture: ${(e as Error).message}; deny`],
    };
  }

  return decideWarrant(grant, scope, opts.impact, source);
}

function loadGrantFixture(path?: string): GrantFixture {
  if (!path) throw new Error('no fixturePath provided');
  const raw = JSON.parse(readFileSync(resolveAsset(path), 'utf8')) as GrantFixture;
  return raw;
}

/**
 * The conservative authorization decision. A FAITHFUL port of
 * spacechild-auth/src/agent-warrant.ts decideWarrant. Keep in sync.
 *
 * Authorized only if ALL hold:
 *   1. grant.status === 'active' (not revoked, not expired-by-status),
 *   2. now < grant.expiresAt (live),
 *   3. scope ∈ grant.scopes,
 *   4. if an impact is given: a cap exists AND impact < cap.
 *      (impact given with NO cap => DENY — we don't authorize unbounded impact.)
 * Deny on any doubt.
 */
export function decideWarrant(
  grant: GrantFixture,
  scope: string,
  impact: number | undefined,
  source: 'live' | 'offline',
): WarrantVerdict {
  const reasons: string[] = [];
  const scopes = Array.isArray(grant.scopes) ? grant.scopes : [];
  const base = { source, grantId: grant.id, scopes };

  // 1. status must be active.
  if (grant.status === 'revoked') {
    reasons.push('grant revoked');
    return { authorized: false, reasons, ...base };
  }
  if (grant.status === 'expired') {
    reasons.push('grant expired (status)');
    return { authorized: false, reasons, ...base };
  }
  if (grant.status !== 'active') {
    reasons.push(`grant status "${grant.status}" is not active; deny`);
    return { authorized: false, reasons, ...base };
  }

  // 2. must not be past expiry.
  const expiresAtMs = Date.parse(grant.expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    reasons.push('grant expiresAt is unparseable; deny on doubt');
    return { authorized: false, reasons, ...base };
  }
  if (Date.now() >= expiresAtMs) {
    reasons.push(`grant expired at ${grant.expiresAt}`);
    return { authorized: false, reasons, ...base };
  }

  // 3. requested scope must be present.
  if (!scopes.includes(scope)) {
    reasons.push(
      `scope "${scope}" not in grant scopes [${scopes.join(', ') || 'none'}]`,
    );
    return { authorized: false, reasons, ...base };
  }

  // 4. impact, if given, must be strictly below the grant's cap.
  if (impact !== undefined) {
    const cap = grant.constraints?.maxAutoImpact;
    if (cap === undefined) {
      reasons.push(
        `impact ${impact} given but grant declares no maxAutoImpact cap; deny on doubt`,
      );
      return { authorized: false, reasons, ...base };
    }
    if (!(impact < cap)) {
      reasons.push(
        `impact ${impact} not below grant cap maxAutoImpact ${cap}`,
      );
      return { authorized: false, reasons, ...base };
    }
  }

  reasons.push(
    `grant live, scope "${scope}" delegated${impact !== undefined ? `, impact ${impact} within cap` : ''}`,
  );
  return { authorized: true, reasons, ...base };
}

// ---------------------------------------------------------------------------
// LIVE — read-only introspect query against the deployed warrant layer.
// ---------------------------------------------------------------------------

async function checkWarrantLive(
  opts: CheckWarrantOptions,
): Promise<WarrantVerdict> {
  const source = 'live' as const;
  const url = `${opts.introspectUrl!.replace(/\/$/, '')}/auth/agents/introspect`;

  if (!opts.scope) {
    return {
      authorized: false,
      source,
      reasons: ['no scope requested (unmapped action kind); deny on doubt'],
    };
  }
  if (!opts.token && !opts.grantId) {
    return {
      authorized: false,
      source,
      reasons: ['no token or grantId supplied for live introspect; deny'],
    };
  }

  const body = {
    token: opts.token,
    grantId: opts.grantId,
    scope: opts.scope,
    action: opts.action,
    impact: opts.impact,
  };

  opts.log?.(`warrant: live introspect (read-only POST) → ${url}`);

  try {
    const res = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      opts.timeoutMs ?? 5000,
    );
    if (!res.ok) {
      return {
        authorized: false,
        source,
        grantId: opts.grantId,
        reasons: [`introspect returned HTTP ${res.status}; deny`],
      };
    }
    const data = (await res.json()) as IntrospectResponse;
    const reasons =
      Array.isArray(data.reasons) && data.reasons.length > 0
        ? data.reasons
        : [data.authorized ? 'authorized by warrant layer' : 'denied by warrant layer'];
    return {
      authorized: Boolean(data.authorized),
      source,
      grantId: opts.grantId,
      scopes: data.scopes,
      reasons,
    };
  } catch (e) {
    // Conservative: an unreachable / failing warrant layer is a DENY, never a
    // permissive fallback. We do not silently drop to offline here.
    return {
      authorized: false,
      source,
      grantId: opts.grantId,
      reasons: [`live introspect failed: ${(e as Error).message}; deny`],
    };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}
