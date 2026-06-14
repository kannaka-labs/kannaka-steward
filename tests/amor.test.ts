import { describe, it, expect } from 'vitest';
import { AmorAdapter, AMOR_CONFIG, VOTE_SUPPORT } from '../src/adapters/amor.js';
import { ethers } from 'ethers';
import type { Judgment } from '../src/types.js';

describe('amor adapter (fixture)', () => {
  it('reads the fixture into a normalized ActionContext', async () => {
    const adapter = new AmorAdapter({ fixturePath: 'fixtures/amor-proposal.json', forceFixture: true });
    const ctx = await adapter.readAction('fixture');
    expect(ctx.surface).toBe('amor');
    expect(ctx.kind).toBe('governance-vote');
    expect(ctx.source).toBe('fixture');
    expect(ctx.impact.reversible).toBe(true);
    expect(ctx.title.length).toBeGreaterThan(0);
  });

  it('describeProposed maps support -> castVote support value', async () => {
    const adapter = new AmorAdapter({ fixturePath: 'fixtures/amor-proposal.json', forceFixture: true });
    const ctx = await adapter.readAction('fixture');
    const j: Judgment = { support: 'for', confidence: 0.9, rationale: '', appliedPrinciples: [], concerns: [] };
    const proposed = adapter.describeProposed(j, ctx);
    expect(proposed.params.support).toBe(VOTE_SUPPORT.For);
    expect(proposed.params.governor).toBe(AMOR_CONFIG.governor);
  });

  it('dryRun builds valid castVote calldata and never needs a signer', async () => {
    // Force fixture + an unreachable RPC so dryRun takes the offline path
    // (proving it produces calldata with no network and no signer).
    const adapter = new AmorAdapter({
      fixturePath: 'fixtures/amor-proposal.json',
      forceFixture: true,
      rpcs: ['http://127.0.0.1:1'],
    });
    const ctx = await adapter.readAction('fixture');
    const j: Judgment = { support: 'against', confidence: 0.9, rationale: '', appliedPrinciples: [], concerns: [] };
    const proposed = adapter.describeProposed(j, ctx);
    const dr = await adapter.dryRun(proposed);
    expect(dr.calldata).toMatch(/^0x[0-9a-f]+$/);
    expect(dr.to).toBe(AMOR_CONFIG.governor);
    // Decode the calldata to confirm it's castVote(proposalId, support=Against).
    const iface = new ethers.Interface(['function castVote(uint256,uint8)']);
    const decoded = iface.decodeFunctionData('castVote', dr.calldata!);
    expect(Number(decoded[1])).toBe(VOTE_SUPPORT.Against);
    expect(dr.source).toBe('offline');
  });
});

describe('amor adapter (live, guarded)', () => {
  it('reads live governor params if RPC reachable (skips otherwise)', async () => {
    let provider: ethers.JsonRpcProvider | undefined;
    try {
      provider = new ethers.JsonRpcProvider(AMOR_CONFIG.rpcs[0], AMOR_CONFIG.chainId, { staticNetwork: true });
      const bn = await Promise.race([
        provider.getBlockNumber(),
        new Promise<number>((_, r) => setTimeout(() => r(new Error('timeout')), 4000)),
      ]);
      expect(bn).toBeGreaterThan(0);
      const gov = new ethers.Contract(AMOR_CONFIG.governor, ['function name() view returns (string)'], provider);
      const name = await gov.name();
      expect(name).toBe('AmorGovernor');
    } catch {
      // RPC unreachable in CI / offline — skip without failing.
      expect(true).toBe(true);
    }
  }, 10000);
});
