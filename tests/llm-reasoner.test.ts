import { describe, it, expect, vi } from 'vitest';
import {
  LlmReasoner,
  anthropicCompletion,
  DEFAULT_ANTHROPIC_MODEL,
  type CompletionFn,
} from '../src/llmReasoner.js';
import { verify } from '../src/rails.js';
import { loadCharter } from '../src/charter.js';
import type { ActionContext, Judgment } from '../src/types.js';

const charter = loadCharter('charters/governance.example.yaml').charter; // confidenceThreshold 0.7

function action(over: Partial<ActionContext> = {}): ActionContext {
  return {
    surface: 'amor',
    kind: 'governance-vote',
    id: '1',
    title: 'Increase transparency reporting',
    description: 'Publish a public audit disclosure each quarter.',
    state: 'Active',
    impact: { magnitude: 0.1, reversible: true },
    source: 'fixture',
    ...over,
  };
}

/** A completion fn that returns a fixed string, ignoring the prompt. */
function fixed(reply: string): CompletionFn {
  return async () => reply;
}

async function judgeWith(reply: string, maxConfidence?: number): Promise<Judgment> {
  const reasoner = new LlmReasoner({ complete: fixed(reply), maxConfidence });
  return reasoner.judge(action(), charter);
}

describe('LlmReasoner — happy path', () => {
  it('parses a well-formed verdict and preserves honest confidence', async () => {
    const j = await judgeWith(
      JSON.stringify({ support: 'for', confidence: 0.82, rationale: 'aligned with transparency', appliedPrinciples: ['p.transparency'], concerns: [] }),
    );
    expect(j.support).toBe('for');
    expect(j.confidence).toBe(0.82);
    expect(j.appliedPrinciples).toContain('p.transparency');
  });

  it('extracts the JSON object even amid surrounding prose', async () => {
    const j = await judgeWith('Here is my verdict:\n{"support":"against","confidence":0.71,"rationale":"x"}\nDone.');
    expect(j.support).toBe('against');
    expect(j.confidence).toBe(0.71);
  });

  it('accepts "action" as an alias for "support"', async () => {
    const j = await judgeWith(JSON.stringify({ action: 'against', confidence: 0.7, rationale: 'opposed' }));
    expect(j.support).toBe('against');
    expect(j.confidence).toBe(0.7);
  });

  it('clamps an over-the-cap (but in-range) confidence DOWN to maxConfidence', async () => {
    const j = await judgeWith(JSON.stringify({ support: 'for', confidence: 0.99, rationale: 'x' }));
    expect(j.confidence).toBe(0.95); // default cap
  });
});

describe('LlmReasoner — fail-safe parsing (never toward proceed)', () => {
  const expectFailSafe = (j: Judgment) => {
    expect(j.support).toBe('abstain');
    expect(j.confidence).toBe(0);
    expect(j.concerns.length).toBeGreaterThan(0);
  };

  it('no JSON object at all (a plain refusal) → abstain@0', async () => {
    expectFailSafe(await judgeWith("I'm sorry, but I can't help with that request."));
  });

  it('malformed JSON → abstain@0', async () => {
    expectFailSafe(await judgeWith('{"support":"for","confidence":0.8,'));
  });

  it('out-of-range confidence (>1) fails safe — NOT clamped up toward proceed', async () => {
    const j = await judgeWith(JSON.stringify({ support: 'for', confidence: 1.5, rationale: 'x' }));
    expect(j.support).toBe('abstain');
    expect(j.confidence).toBe(0); // critically NOT 0.95
  });

  it('negative confidence fails safe', async () => {
    expectFailSafe(await judgeWith(JSON.stringify({ support: 'for', confidence: -0.2, rationale: 'x' })));
  });

  it('non-numeric confidence fails safe', async () => {
    expectFailSafe(await judgeWith(JSON.stringify({ support: 'for', confidence: 'high', rationale: 'x' })));
  });

  it('missing confidence fails safe', async () => {
    expectFailSafe(await judgeWith(JSON.stringify({ support: 'for', rationale: 'x' })));
  });

  it('missing support fails safe', async () => {
    expectFailSafe(await judgeWith(JSON.stringify({ confidence: 0.8, rationale: 'x' })));
  });

  it('invalid support value fails safe', async () => {
    expectFailSafe(await judgeWith(JSON.stringify({ support: 'buy', confidence: 0.8, rationale: 'x' })));
  });

  it('JSON that is an array, not an object, fails safe', async () => {
    expectFailSafe(await judgeWith('[1,2,3]'));
  });

  it('a completion fn that throws (network/HTTP/refusal) fails safe', async () => {
    const reasoner = new LlmReasoner({ complete: async () => { throw new Error('ECONNREFUSED'); } });
    expectFailSafe(await reasoner.judge(action(), charter));
  });
});

describe('LlmReasoner — seam contract', () => {
  it('throws (config error) when constructed without a complete fn', async () => {
    const reasoner = new LlmReasoner();
    await expect(reasoner.judge(action(), charter)).rejects.toThrow(/requires a `complete` function/);
  });

  it('passes the charter and action into the prompt', async () => {
    let seen = '';
    const reasoner = new LlmReasoner({
      complete: async (p) => {
        seen = p;
        return JSON.stringify({ support: 'abstain', confidence: 0.3, rationale: 'x' });
      },
    });
    await reasoner.judge(action(), charter);
    expect(seen).toContain('INTENT CHARTER');
    expect(seen).toContain(charter.id);
    expect(seen).toContain('Increase transparency reporting');
  });
});

describe('LlmReasoner + rails integration (the rails re-check regardless)', () => {
  it('a low-confidence LLM verdict trips the charter confidence floor → escalate', async () => {
    const j = await judgeWith(JSON.stringify({ support: 'for', confidence: 0.4, rationale: 'unsure' }));
    expect(j.confidence).toBe(0.4);
    const v = verify(j, action(), charter); // threshold 0.7
    expect(v.decision).toBe('escalate');
    expect(v.reasons.join(' ')).toMatch(/confidence/i);
  });

  it('a malformed LLM output escalates end-to-end (abstain@0 → below floor)', async () => {
    const j = await judgeWith('garbage, no json here');
    const v = verify(j, action(), charter);
    expect(v.decision).toBe('escalate');
  });

  it('a well-formed, confident, aligned verdict is allowed to proceed', async () => {
    const j = await judgeWith(JSON.stringify({ support: 'for', confidence: 0.9, rationale: 'clearly aligned', appliedPrinciples: ['p.transparency'] }));
    const v = verify(j, action(), charter);
    expect(v.decision).toBe('proceed');
  });
});

describe('anthropicCompletion (mocked fetch — no network)', () => {
  const OK = (text: string) =>
    new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('throws when no API key is available', async () => {
    const complete = anthropicCompletion({ fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(complete('hi')).rejects.toThrow(/API key/i);
  });

  it('sends a correct request and returns the concatenated text', async () => {
    const fetchImpl = vi.fn(async () => OK('{"support":"for","confidence":0.8}')) as unknown as typeof fetch;
    const complete = anthropicCompletion({ apiKey: 'sk-test-123', fetchImpl });
    const out = await complete('PROMPT-BODY');

    expect(out).toBe('{"support":"for","confidence":0.8}');
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test-123');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(body.messages).toEqual([{ role: 'user', content: 'PROMPT-BODY' }]);
  });

  it('uses a configurable model id', async () => {
    const fetchImpl = vi.fn(async () => OK('{}')) as unknown as typeof fetch;
    const complete = anthropicCompletion({ apiKey: 'k', model: 'claude-opus-4-8', fetchImpl });
    await complete('x');
    const body = JSON.parse(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('claude-opus-4-8');
  });

  it('throws on a non-2xx HTTP response', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch;
    const complete = anthropicCompletion({ apiKey: 'k', fetchImpl });
    await expect(complete('x')).rejects.toThrow(/HTTP 401/);
  });

  it('throws when the response carries no text content (empty = refusal)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ content: [] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const complete = anthropicCompletion({ apiKey: 'k', fetchImpl });
    await expect(complete('x')).rejects.toThrow(/no text content/i);
  });
});
