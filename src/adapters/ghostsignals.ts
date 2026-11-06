/**
 * ghostsignals trade adapter — READ-ONLY against an LMSR prediction market.
 *
 * SAFETY: this adapter performs ONLY HTTP GETs (markets / quote) against a
 * configurable, read-only base URL. There is NO POST to /api/trading anywhere
 * in this file — it is structurally impossible for the adapter to submit an
 * order. `dryRun` builds an UNSIGNED order package and prices it with a local
 * LMSR replica (or, if a live API is reachable, the read-only /quote endpoint).
 * The order package is an OUTPUT for a human/keyholder to submit.
 *
 * This is the second surface: unlike a governance vote, a market position is a
 * BOUNDED, REVERSIBLE action (you can sell the shares back), which is why the
 * kernel can legitimately reach PROCEED here and demonstrate the multiplier
 * ACTING — not merely refusing.
 *
 * ghostsignals API (read-only paths used here):
 *   GET /api/markets               · GET /api/markets/:id
 *   GET /api/markets/:id/quote?outcomeId=&quantity=&type=buy
 * The POST /api/trading path is deliberately never referenced.
 */

import { readFileSync } from 'node:fs';
import type { SurfaceAdapter } from '../adapter.js';
import { quote as lmsrQuote, prices as lmsrPrices } from '../lmsr.js';
import { resolveAsset } from '../assets.js';
import type {
  ActionContext,
  CandidateOrder,
  DryRunResult,
  Judgment,
  MarketContext,
  MarketOutcome,
  ProposedAction,
} from '../types.js';

export const GHOSTSIGNALS_SURFACE = 'ghostsignals';

export const GHOSTSIGNALS_CONFIG = {
  /** Read-only base URL. Override via GHOSTSIGNALS_API_URL. */
  defaultBaseUrl: 'http://localhost:3001',
} as const;

/** Shape of a market as returned by GET /api/markets/:id (strings for decimals). */
interface GhostsignalsMarketJson {
  source?: 'fixture';
  id: string;
  title: string;
  description: string;
  category?: string;
  region?: string;
  type?: string;
  state: string;
  liquidity: string;
  liquidityParameter: string;
  resolutionDate?: string;
  outcomes: Array<{
    id: string;
    name: string;
    probability: string;
    shares: string;
  }>;
  /** Fixture-only hint: which outcome the owner's hedge targets + the budget. */
  hedge?: { outcomeId: string; budget: number; note?: string };
}

export interface GhostsignalsAdapterOptions {
  /** Override the read-only base URL (else env GHOSTSIGNALS_API_URL, else default). */
  baseUrl?: string;
  /** Fixture file path used as fallback when the live read fails / API is down. */
  fixturePath?: string;
  /** Force fixture mode (skip the live attempt entirely). */
  forceFixture?: boolean;
  /**
   * Risk budget the position fraction is measured against (quote units). Falls
   * back to the fixture's hedge.budget, then a conservative default.
   */
  budget?: number;
  /** Which outcome the owner's hedge targets (else the fixture's hedge.outcomeId). */
  hedgeOutcomeId?: string;
  /**
   * Position cap as a fraction of budget used to size the CANDIDATE order the
   * rails inspect. The charter's maxPositionFraction is the hard bound; this is
   * the adapter's sizing target (kept at/below it). Default 0.4.
   */
  positionCapFraction?: number;
  /** Hook for printing live-vs-fixture notes. */
  log?: (msg: string) => void;
}

export class GhostsignalsAdapter implements SurfaceAdapter {
  readonly surface = GHOSTSIGNALS_SURFACE;
  private readonly opts: GhostsignalsAdapterOptions;

  constructor(opts: GhostsignalsAdapterOptions = {}) {
    this.opts = opts;
  }

  private log(msg: string): void {
    (this.opts.log ?? (() => {}))(msg);
  }

  private baseUrl(): string {
    return (
      this.opts.baseUrl ??
      process.env.GHOSTSIGNALS_API_URL ??
      GHOSTSIGNALS_CONFIG.defaultBaseUrl
    );
  }

  private loadFixture(): GhostsignalsMarketJson {
    const path = this.opts.fixturePath ?? 'fixtures/ghostsignals-market.json';
    return JSON.parse(readFileSync(resolveAsset(path), 'utf8')) as GhostsignalsMarketJson;
  }

  /** Read a market, normalized. Tries live first, falls back to fixture. */
  async readAction(ref: string): Promise<ActionContext> {
    if (ref === 'fixture' || this.opts.forceFixture) {
      this.log('[ghostsignals] using FIXTURE (forced).');
      return this.marketToContext(this.loadFixture(), 'fixture');
    }
    try {
      const market = await this.fetchMarket(ref);
      this.log(`[ghostsignals] LIVE read OK for market ${ref}.`);
      return this.marketToContext(market, 'live');
    } catch (e) {
      this.log(
        `[ghostsignals] LIVE read failed (${(e as Error).message}); falling back to FIXTURE.`,
      );
      return this.marketToContext(this.loadFixture(), 'fixture');
    }
  }

  /** Live read of GET /api/markets/:id (READ-ONLY). */
  private async fetchMarket(id: string): Promise<GhostsignalsMarketJson> {
    const url = `${this.baseUrl()}/api/markets/${encodeURIComponent(id)}`;
    const res = await withTimeout(fetch(url), 5000);
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return (await res.json()) as GhostsignalsMarketJson;
  }

  /**
   * Normalize a market into an ActionContext, pre-pricing the charter-bounded
   * CANDIDATE order so the rails can enforce trade hard-constraints WITHOUT
   * depending on the reasoner.
   */
  private marketToContext(
    m: GhostsignalsMarketJson,
    source: 'live' | 'fixture',
  ): ActionContext {
    const b = num(m.liquidityParameter);
    const shares = m.outcomes.map((o) => num(o.shares));
    const computed = lmsrPrices(shares, b);

    const outcomes: MarketOutcome[] = m.outcomes.map((o, i) => ({
      id: o.id,
      label: o.name,
      // Prefer the LMSR-computed price; fall back to the stored probability.
      probability: round4(isFinite(computed[i]!) ? computed[i]! : num(o.probability)),
    }));

    const budget = this.opts.budget ?? m.hedge?.budget ?? 1000;
    const hedgeOutcomeId = this.opts.hedgeOutcomeId ?? m.hedge?.outcomeId;

    const candidate = this.priceCandidate(m, b, shares, hedgeOutcomeId, budget);

    const market: MarketContext = {
      liquidityParameter: b,
      outcomes,
      budget,
      candidate,
    };

    return {
      surface: this.surface,
      kind: 'market-trade',
      id: m.id,
      title: m.title,
      description: m.description,
      state: m.state,
      tally: outcomes.reduce<Record<string, string>>((acc, o) => {
        acc[o.label] = o.probability.toString();
        return acc;
      }, {}),
      impact: {
        // Normalized position magnitude = candidate cost / budget (0 if none).
        magnitude: candidate ? round4(candidate.positionFraction) : 0,
        // Market positions are reversible — shares can be sold back to the AMM.
        reversible: true,
        field: 'market-position',
        nativeMagnitude: candidate
          ? `${candidate.quantity} ${candidate.type} shares of "${candidate.outcomeLabel}" ≈ ${round4(candidate.cost)} cost`
          : 'no candidate order (no hedge target)',
      },
      deadline: m.resolutionDate,
      source,
      market,
    };
  }

  /**
   * Size + price the bounded candidate order for the hedge-target outcome.
   * Sizing: pick the largest integer-ish quantity whose LMSR cost stays at or
   * below positionCapFraction · budget. Pure/deterministic; no network.
   */
  private priceCandidate(
    m: GhostsignalsMarketJson,
    b: number,
    shares: number[],
    hedgeOutcomeId: string | undefined,
    budget: number,
  ): CandidateOrder | undefined {
    if (!hedgeOutcomeId) return undefined;
    const index = m.outcomes.findIndex((o) => o.id === hedgeOutcomeId);
    if (index < 0) return undefined;

    const capFraction = this.opts.positionCapFraction ?? 0.3;
    const costCap = capFraction * budget;

    // LMSR buy cost is monotone in quantity; bisect for the largest quantity
    // whose cost ≤ costCap. Bounded, deterministic, no I/O.
    const quantity = this.maxQuantityWithinCost(shares, b, index, costCap);
    const q = lmsrQuote(shares, b, index, quantity, 'buy');

    const out = m.outcomes[index]!;
    return {
      outcomeId: out.id,
      outcomeLabel: out.name,
      type: 'buy',
      quantity: round4(quantity),
      cost: round4(q.cost),
      avgPrice: round4(q.avgPrice),
      slippage: round4(q.slippage),
      positionFraction: budget > 0 ? round4(q.cost / budget) : Number.POSITIVE_INFINITY,
    };
  }

  /** Largest buy quantity whose LMSR cost stays ≤ costCap (bisection). */
  private maxQuantityWithinCost(
    shares: number[],
    b: number,
    index: number,
    costCap: number,
  ): number {
    const costOf = (qty: number) => lmsrQuote(shares, b, index, qty, 'buy').cost;
    // A single share already over budget → smallest meaningful order is itself
    // too big; surface that by returning 1 (rails will catch the breach).
    if (costOf(1) > costCap) return 1;
    let lo = 1;
    let hi = 2;
    // Expand until hi overshoots the cap (cost grows toward q for far-OOM buys).
    while (costOf(hi) <= costCap && hi < 1e9) hi *= 2;
    for (let iter = 0; iter < 60; iter++) {
      const mid = (lo + hi) / 2;
      if (costOf(mid) <= costCap) lo = mid;
      else hi = mid;
    }
    return Math.max(1, Math.floor(lo));
  }

  /**
   * Map a judgment into a concrete UNSIGNED trade order (pure). 'for' = take the
   * candidate position; 'against'/'abstain' = a zero-quantity no-op order the
   * rails will never reach proceed on (the kernel escalates/abstains instead).
   */
  describeProposed(judgment: Judgment, action: ActionContext): ProposedAction {
    const cand = action.market?.candidate;
    if (judgment.support === 'for' && cand) {
      return {
        surface: this.surface,
        kind: 'market-trade',
        summary: `Take a bounded ${cand.type.toUpperCase()} position: ${cand.quantity} shares of "${cand.outcomeLabel}" on market ${shortId(action.id)} ("${action.title}")`,
        params: {
          // This is the UNSIGNED order package a human/keyholder would submit.
          marketId: action.id,
          outcomeId: cand.outcomeId,
          type: cand.type,
          quantity: cand.quantity,
          useAMM: true,
        },
      };
    }
    // Not taking a position: describe the no-op so the package/audit are explicit.
    return {
      surface: this.surface,
      kind: 'market-trade',
      summary: `Do NOT take a position on market ${shortId(action.id)} ("${action.title}") (reasoner: ${judgment.support}).`,
      params: {
        marketId: action.id,
        outcomeId: cand?.outcomeId ?? null,
        type: 'buy',
        quantity: 0,
        useAMM: true,
      },
    };
  }

  /**
   * SIMULATE the trade. Re-prices the proposed order locally via the LMSR
   * replica (so it works on the fixture); if a live API is reachable it MAY
   * cross-check against the read-only /quote endpoint. NEVER POSTs /trading.
   *
   * The returned object is the UNSIGNED order package — `to` is the trading
   * endpoint a human/keyholder would submit to, `calldata` is the JSON order
   * body. The Steward cannot and will not send it.
   */
  async dryRun(proposed: ProposedAction): Promise<DryRunResult> {
    const marketId = String(proposed.params.marketId);
    const outcomeId = proposed.params.outcomeId == null ? null : String(proposed.params.outcomeId);
    const type = String(proposed.params.type) as 'buy' | 'sell';
    const quantity = Number(proposed.params.quantity);

    const orderBody = JSON.stringify({
      marketId,
      outcomeId,
      type,
      quantity,
      useAMM: Boolean(proposed.params.useAMM),
    });
    // The "calldata" of a REST surface is the unsigned request body; `to` is the
    // endpoint a human would POST it to (the adapter never does).
    const to = `${this.baseUrl()}/api/trading`;
    const warnings: string[] = [];

    if (quantity <= 0) {
      return {
        ok: true,
        calldata: orderBody,
        to,
        estimate: 'no-op order (quantity 0): the Steward is not taking a position.',
        warnings,
        source: 'offline',
      };
    }

    // Local LMSR re-price from the proposed order against the market we read.
    // We re-read the market (fixture or live) to price exactly what we propose.
    const m = this.opts.forceFixture
      ? this.loadFixture()
      : await this.fetchMarket(marketId).catch(() => this.loadFixture());
    const b = num(m.liquidityParameter);
    const shares = m.outcomes.map((o) => num(o.shares));
    const index = outcomeId ? m.outcomes.findIndex((o) => o.id === outcomeId) : -1;
    if (index < 0) {
      warnings.push('outcome not found on market; cannot price.');
      return { ok: false, calldata: orderBody, to, estimate: 'outcome not found', warnings, source: 'offline' };
    }

    const q = lmsrQuote(shares, b, index, quantity, type);
    const local = {
      ok: true,
      cost: round4(q.cost),
      avgPrice: round4(q.avgPrice),
      slippage: round4(q.slippage),
    };

    // OPTIONAL live cross-check against the read-only /quote endpoint.
    let liveNote = '';
    let source: DryRunResult['source'] = 'offline';
    if (!this.opts.forceFixture) {
      try {
        const url =
          `${this.baseUrl()}/api/markets/${encodeURIComponent(marketId)}/quote` +
          `?outcomeId=${encodeURIComponent(outcomeId!)}&quantity=${quantity}&type=${type}`;
        const res = await withTimeout(fetch(url), 5000);
        if (res.ok) {
          const jq = (await res.json()) as { ammBuyPrice?: string; ammSellPrice?: string; spread?: string };
          const livePrice = num(type === 'buy' ? jq.ammBuyPrice ?? '0' : jq.ammSellPrice ?? '0');
          liveNote = ` live /quote ammPrice=${livePrice} spread=${jq.spread ?? '?'} (read-only cross-check)`;
          source = 'live';
        }
      } catch {
        /* live cross-check unavailable; local LMSR stands. */
      }
    }

    return {
      ok: local.ok,
      calldata: orderBody,
      to,
      estimate:
        `LMSR ${type}: cost=${local.cost}, avgPrice=${local.avgPrice}, slippage=${local.slippage} ` +
        `(${source === 'live' ? 'live-confirmed' : 'offline replica'}).${liveNote} ` +
        `UNSIGNED order body; a human/keyholder POSTs it — the Steward cannot.`,
      warnings,
      source,
    };
  }
}

// ---- helpers ----

function num(s: string | number): number {
  return typeof s === 'number' ? s : Number(s);
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function shortId(id: string): string {
  if (id.length <= 16) return id;
  return `${id.slice(0, 10)}…${id.slice(-4)}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}
