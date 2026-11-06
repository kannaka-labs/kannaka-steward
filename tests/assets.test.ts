import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAsset, PACKAGE_ROOT } from '../src/assets.js';

describe('resolveAsset', () => {
  it('finds bundled charters and fixtures from the package root', () => {
    // From the repo checkout the cwd may differ; the package root always has them.
    expect(resolveAsset('charters/governance.example.yaml', PACKAGE_ROOT)).toMatch(/governance\.example\.yaml$/);
  });

  it('falls back to the package root when the cwd lacks the file', () => {
    const root = mkdtempSync(join(tmpdir(), 'steward-root-'));
    mkdirSync(join(root, 'fixtures'));
    writeFileSync(join(root, 'fixtures', 'only-in-root.json'), '{}');
    expect(resolveAsset('fixtures/only-in-root.json', root)).toBe(join(root, 'fixtures', 'only-in-root.json'));
  });

  it('leaves absolute paths alone', () => {
    const abs = join(tmpdir(), 'nope-does-not-exist.yaml');
    expect(resolveAsset(abs, '/elsewhere')).toBe(abs);
  });

  it('returns the original path when nothing exists, so errors name what was asked', () => {
    expect(resolveAsset('charters/missing.yaml', mkdtempSync(join(tmpdir(), 'steward-empty-')))).toBe('charters/missing.yaml');
  });
});
