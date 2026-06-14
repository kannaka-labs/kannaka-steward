/**
 * AMOR governance adapter — READ-ONLY against Neo X mainnet.
 *
 * SAFETY: this adapter uses ethers `JsonRpcProvider` ONLY. There is no Wallet,
 * no signer, and no private key anywhere. `dryRun` builds the castVote calldata
 * and a static gas/validity estimate via `eth_estimateGas`/`eth_call`, but it
 * NEVER broadcasts a transaction. The calldata is an OUTPUT for a human to sign.
 *
 * AMOR is a standard OpenZeppelin Governor (verified on-chain: name
 * "AmorGovernor", COUNTING_MODE "support=bravo&quorum=for,abstain",
 * GovernorCountingSimple). Proposal *descriptions* are not stored on-chain by
 * OZ Governor, so we fetch them from `ProposalCreated` event logs when possible
 * and otherwise accept a description passed in (or from the fixture).
 */

import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import type { SurfaceAdapter } from '../adapter.js';
import type {
  ActionContext,
  DryRunResult,
  Judgment,
  ProposedAction,
} from '../types.js';

export const AMOR_SURFACE = 'amor';

export const AMOR_CONFIG = {
  chainId: 47763,
  rpcs: [
    'https://mainnet-1.rpc.banelabs.org',
    'https://mainnet-2.rpc.banelabs.org',
  ],
  governor: '0xaf596B738B57B6Ac939f453Ce2201349F3105146',
  stAMOR: '0x05fda76aa1e88e83EbB5f155Cd43BE2eb6718eAD',
} as const;

/** OZ Governor proposal states (uint8). */
export const PROPOSAL_STATES = [
  'Pending',
  'Active',
  'Canceled',
  'Defeated',
  'Succeeded',
  'Queued',
  'Expired',
  'Executed',
] as const;

/** OZ GovernorCountingSimple vote support values. */
export const VOTE_SUPPORT = { Against: 0, For: 1, Abstain: 2 } as const;

const GOVERNOR_ABI = [
  'function name() view returns (string)',
  'function state(uint256 proposalId) view returns (uint8)',
  'function proposalVotes(uint256 proposalId) view returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes)',
  'function proposalSnapshot(uint256 proposalId) view returns (uint256)',
  'function proposalDeadline(uint256 proposalId) view returns (uint256)',
  'function proposalProposer(uint256 proposalId) view returns (address)',
  'function castVote(uint256 proposalId, uint8 support) returns (uint256)',
  'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)',
];

export interface AmorProposalFixture {
  source: 'fixture';
  proposalId: string;
  title: string;
  description: string;
  state: string;
  proposer?: string;
  deadlineIso?: string;
  tally?: { against: string; for: string; abstain: string };
  /** Pre-classified impact for deterministic demos. */
  impact: { magnitude: number; reversible: boolean; field?: string; nativeMagnitude?: string };
}

export interface AmorAdapterOptions {
  /** Override RPC list (e.g. for tests). */
  rpcs?: string[];
  /** Fixture file path used as fallback when live read fails / proposal absent. */
  fixturePath?: string;
  /** Force fixture mode (skip live attempt entirely). */
  forceFixture?: boolean;
  /** Optional description override (since OZ Governor descriptions are off-chain). */
  descriptionOverride?: string;
  /** Hook for printing live-vs-fixture notes. */
  log?: (msg: string) => void;
}

export class AmorAdapter implements SurfaceAdapter {
  readonly surface = AMOR_SURFACE;
  private provider: ethers.JsonRpcProvider | undefined;
  private readonly opts: AmorAdapterOptions;

  constructor(opts: AmorAdapterOptions = {}) {
    this.opts = opts;
  }

  private log(msg: string): void {
    (this.opts.log ?? (() => {}))(msg);
  }

  /** Lazily create a READ-ONLY provider, trying each RPC in order. */
  private async getProvider(): Promise<ethers.JsonRpcProvider> {
    if (this.provider) return this.provider;
    const rpcs = this.opts.rpcs ?? AMOR_CONFIG.rpcs;
    let lastErr: unknown;
    for (const url of rpcs) {
      try {
        const p = new ethers.JsonRpcProvider(url, AMOR_CONFIG.chainId, {
          staticNetwork: true,
        });
        // Probe connectivity with a short timeout.
        await withTimeout(p.getBlockNumber(), 5000);
        this.provider = p;
        return p;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(
      `No AMOR RPC reachable (${rpcs.join(', ')}): ${(lastErr as Error)?.message}`,
    );
  }

  private loadFixture(): AmorProposalFixture {
    const path = this.opts.fixturePath ?? 'fixtures/amor-proposal.json';
    const raw = JSON.parse(readFileSync(path, 'utf8')) as AmorProposalFixture;
    return raw;
  }

  /** Read a proposal, normalized. Tries live first, falls back to fixture. */
  async readAction(ref: string): Promise<ActionContext> {
    if (ref === 'fixture' || this.opts.forceFixture) {
      this.log('[amor] using FIXTURE (forced).');
      return this.fixtureToContext(this.loadFixture());
    }
    try {
      const ctx = await this.getProposal(ref);
      this.log(`[amor] LIVE read OK for proposal ${ref}.`);
      return ctx;
    } catch (e) {
      this.log(
        `[amor] LIVE read failed (${(e as Error).message}); falling back to FIXTURE.`,
      );
      return this.fixtureToContext(this.loadFixture());
    }
  }

  /** Live on-chain read of an OZ Governor proposal. */
  async getProposal(proposalId: string): Promise<ActionContext> {
    const provider = await this.getProvider();
    const gov = new ethers.Contract(AMOR_CONFIG.governor, GOVERNOR_ABI, provider);
    const id = BigInt(proposalId);

    const [stateNum, votes, deadline, proposer] = await Promise.all([
      gov.state(id) as Promise<bigint>,
      gov.proposalVotes(id) as Promise<[bigint, bigint, bigint]>,
      gov.proposalDeadline(id) as Promise<bigint>,
      gov.proposalProposer(id) as Promise<string>,
    ]);

    const stateName = PROPOSAL_STATES[Number(stateNum)] ?? `Unknown(${stateNum})`;
    const description = await this.fetchDescription(provider, gov, id);

    // Estimate the block deadline as an ISO time (~ Neo X block time).
    const deadlineIso = await blockToIso(provider, deadline).catch(() => undefined);

    return {
      surface: this.surface,
      kind: 'governance-vote',
      id: proposalId,
      title: firstLine(description) || `Proposal ${shortId(proposalId)}`,
      description,
      state: stateName,
      tally: {
        against: votes[0].toString(),
        for: votes[1].toString(),
        abstain: votes[2].toString(),
      },
      // Live reads have no pre-classified impact; default to a conservative,
      // reversible governance-vote impact. (A future on-chain action-decoder
      // could raise this for treasury-touching proposals.)
      impact: {
        magnitude: 0.2,
        reversible: true,
        field: 'governance-vote',
      },
      deadline: deadlineIso,
      source: 'live',
    };
  }

  /** Try to fetch the proposal description from ProposalCreated logs. */
  private async fetchDescription(
    provider: ethers.JsonRpcProvider,
    gov: ethers.Contract,
    id: bigint,
  ): Promise<string> {
    if (this.opts.descriptionOverride) return this.opts.descriptionOverride;
    try {
      const filter = gov.filters.ProposalCreated(id);
      // Bounded historical scan (most chains cap getLogs range).
      const latest = await provider.getBlockNumber();
      const from = Math.max(0, latest - 9000);
      const logs = await gov.queryFilter(filter, from, latest);
      const log = logs[0] as ethers.EventLog | undefined;
      if (log && log.args) {
        return String(log.args.description ?? '');
      }
    } catch {
      /* fall through */
    }
    return '(description not found on-chain — supply via charter context or fixture)';
  }

  private fixtureToContext(fx: AmorProposalFixture): ActionContext {
    return {
      surface: this.surface,
      kind: 'governance-vote',
      id: fx.proposalId,
      title: fx.title,
      description: fx.description,
      state: fx.state,
      tally: fx.tally
        ? { against: fx.tally.against, for: fx.tally.for, abstain: fx.tally.abstain }
        : undefined,
      impact: fx.impact,
      deadline: fx.deadlineIso,
      source: 'fixture',
    };
  }

  /** Map a judgment into a concrete castVote action (pure). */
  describeProposed(judgment: Judgment, action: ActionContext): ProposedAction {
    const support =
      judgment.support === 'for'
        ? VOTE_SUPPORT.For
        : judgment.support === 'against'
          ? VOTE_SUPPORT.Against
          : VOTE_SUPPORT.Abstain;
    const label =
      support === VOTE_SUPPORT.For
        ? 'For'
        : support === VOTE_SUPPORT.Against
          ? 'Against'
          : 'Abstain';
    return {
      surface: this.surface,
      kind: 'governance-vote',
      summary: `Cast vote "${label}" on AMOR proposal ${shortId(action.id)} ("${action.title}")`,
      params: {
        governor: AMOR_CONFIG.governor,
        proposalId: action.id,
        support,
        supportLabel: label,
      },
    };
  }

  /**
   * SIMULATE the castVote. Builds calldata always; attempts a live static
   * estimate (eth_estimateGas) but never sends. Falls back to an offline
   * note if no RPC is available. NO SIGNER, NO BROADCAST.
   */
  async dryRun(proposed: ProposedAction): Promise<DryRunResult> {
    const iface = new ethers.Interface(GOVERNOR_ABI);
    const proposalId = String(proposed.params.proposalId);
    const support = Number(proposed.params.support);
    const calldata = iface.encodeFunctionData('castVote', [
      BigInt(proposalId),
      support,
    ]);
    const to = AMOR_CONFIG.governor;

    const warnings: string[] = [];
    // Static, read-only validity probe. Even this never submits — eth_call /
    // estimateGas are non-state-changing JSON-RPC reads.
    try {
      const provider = await this.getProvider();
      // We have no signer; estimate from the zero address. This will typically
      // revert if the caller has no voting power, which is expected and useful
      // signal — we surface it as a warning, not a failure of the kernel.
      const gas = await withTimeout(
        provider.estimateGas({ to, data: calldata, from: ethers.ZeroAddress }),
        5000,
      );
      return {
        ok: true,
        calldata,
        to,
        estimate: `static gas estimate ~${gas.toString()} (from zero address; the human signer's address determines actual voting power)`,
        warnings,
        source: 'live',
      };
    } catch (e) {
      warnings.push(
        `live static estimate unavailable/reverted: ${(e as Error).message.slice(0, 140)}`,
      );
      return {
        ok: true,
        calldata,
        to,
        estimate:
          'offline: calldata built; submit cost depends on the human signer (estimate gas at signing time)',
        warnings,
        source: 'offline',
      };
    }
  }
}

// ---- helpers ----

function firstLine(s: string): string {
  const line = (s.split('\n')[0] ?? '').trim();
  return line.startsWith('#') ? line.replace(/^#+\s*/, '') : line;
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

async function blockToIso(
  provider: ethers.JsonRpcProvider,
  targetBlock: bigint,
): Promise<string> {
  const current = BigInt(await provider.getBlockNumber());
  const block = await provider.getBlock(Number(current));
  const now = BigInt(block?.timestamp ?? Math.floor(Date.now() / 1000));
  // Neo X ~1s blocks; approximate.
  const secsPerBlock = 1n;
  const delta = (targetBlock - current) * secsPerBlock;
  const ts = now + delta;
  return new Date(Number(ts) * 1000).toISOString();
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}
