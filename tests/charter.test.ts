import { describe, it, expect } from 'vitest';
import {
  loadCharter,
  validateCharter,
  hashCharter,
  canonicalize,
} from '../src/charter.js';

describe('charter', () => {
  it('loads + validates the example governance charter', () => {
    const loaded = loadCharter('charters/governance.example.yaml');
    expect(loaded.charter.id).toBe('gov.steward.virtue');
    expect(loaded.charter.principles.length).toBeGreaterThanOrEqual(5);
    expect(loaded.charter.confidenceThreshold).toBeGreaterThan(0);
    expect(loaded.charter.hardConstraints.some((h) => h.rule.kind === 'requireHuman')).toBe(true);
  });

  it('produces a stable content hash (canonical, order-independent)', () => {
    const loaded = loadCharter('charters/governance.example.yaml');
    const again = hashCharter(loaded.charter);
    expect(again).toBe(loaded.contentHash);
    expect(loaded.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('canonicalize sorts keys so hash is independent of input ordering', () => {
    const a = canonicalize({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalize({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it('rejects an invalid charter (missing principles)', () => {
    expect(() =>
      validateCharter({ id: 'x', version: '1', owner: 'o', confidenceThreshold: 0.5, authority: { maxAutoImpact: 0.5 }, principles: [] }),
    ).toThrow();
  });

  it('rejects out-of-range confidence threshold', () => {
    expect(() =>
      validateCharter({
        id: 'x',
        version: '1',
        owner: 'o',
        confidenceThreshold: 2,
        authority: { maxAutoImpact: 0.5 },
        principles: [{ id: 'p', statement: 's', weight: 0.5, polarity: 'favor' }],
      }),
    ).toThrow();
  });
});
