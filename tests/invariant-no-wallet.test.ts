import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

/**
 * MECHANICAL no-signing invariant.
 *
 * The Steward's core promise is "conscience before wallet": it reads, reasons,
 * dry-runs, and emits a human-signable package — but it must be STRUCTURALLY
 * incapable of signing, spending, or broadcasting. ethers is imported READ-ONLY
 * (JsonRpcProvider only); an ethers `Wallet`/signer is deliberately never used.
 *
 * This test enforces that mechanically: it scans every source file under src/
 * and fails if any signing/wallet CONSTRUCT appears at a call site. It scans
 * code, not prose — line and block comments are stripped first, so the safety
 * documentation ("there is no Wallet", "conscience before wallet") is allowed.
 * String literals are kept (module specifiers like `from 'ethers'` live there),
 * and the patterns are construct-specific so incidental lowercase words such as
 * "wallet" in a UI string or a `boundWalletAddress` field name are NOT flagged.
 */

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG_PATH = fileURLToPath(new URL('../package.json', import.meta.url));

/**
 * Remove line and block comments while preserving string/template literals and
 * newlines. Prose in comments is dropped (so it can't false-positive); string
 * content is kept (so import specifiers survive and are still scannable). A tiny
 * character state machine handles strings so a `//` or `/*` inside a string is
 * not mistaken for a comment.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  let s: State = 'code';
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    switch (s) {
      case 'code':
        if (c === '/' && d === '/') { s = 'line'; i += 2; }
        else if (c === '/' && d === '*') { s = 'block'; i += 2; }
        else if (c === "'") { s = 'sq'; out += c; i++; }
        else if (c === '"') { s = 'dq'; out += c; i++; }
        else if (c === '`') { s = 'tpl'; out += c; i++; }
        else { out += c; i++; }
        break;
      case 'line':
        if (c === '\n') { s = 'code'; out += '\n'; }
        i++;
        break;
      case 'block':
        if (c === '*' && d === '/') { s = 'code'; i += 2; }
        else { if (c === '\n') out += '\n'; i++; }
        break;
      case 'sq':
      case 'dq':
      case 'tpl': {
        out += c;
        if (c === '\\') { if (i + 1 < n) out += src[i + 1]; i += 2; break; }
        if ((s === 'sq' && c === "'") || (s === 'dq' && c === '"') || (s === 'tpl' && c === '`')) s = 'code';
        i++;
        break;
      }
    }
  }
  return out;
}

interface Rule {
  name: string;
  re: RegExp;
}

/**
 * Each rule targets a specific mechanism by which ethers (v6) hands you signing
 * power, plus the raw secrets a signer needs. Construct-specific by design: they
 * match call sites / imports, not the words appearing in prose.
 */
const FORBIDDEN: Rule[] = [
  // `Wallet` (or any signing class) imported from ethers.
  { name: 'signing class imported from ethers', re: /import\b[^;]*\b(?:HDNodeWallet|BaseWallet|Wallet|SigningKey)\b[^;]*from\s*['"]ethers['"]/g },
  // `new Wallet(...)`, `new ethers.Wallet(...)`, `new HDNodeWallet(...)`, ...
  { name: 'new Wallet(...) construction', re: /\bnew\s+(?:ethers\.)?(?:HDNode|Base)?Wallet\b/g },
  // Wallet factory helpers that mint a signer from a key/phrase.
  { name: 'Wallet factory (createRandom/fromPhrase/...)', re: /\bWallet\.(?:createRandom|fromPhrase|fromMnemonic|fromEncryptedJson|fromEncryptedJsonSync)\b/g },
  // Signing a transaction.
  { name: 'signTransaction call', re: /\bsignTransaction\b/g },
  // Broadcasting a transaction (needs a signer/provider write path).
  { name: 'sendTransaction call', re: /\bsendTransaction\b/g },
  // Using a runtime signer object: `signer.<member>`.
  { name: 'signer.<member> usage', re: /\bsigner\s*\.\s*\w+/g },
  // Raw signing secrets.
  { name: 'privateKey reference', re: /\bprivateKey\b/g },
  { name: 'mnemonic reference', re: /\bmnemonic\b/g },
];

function lineOf(text: string, index: number): number {
  let line = 1;
  const stop = Math.min(index, text.length);
  for (let i = 0; i < stop; i++) if (text[i] === '\n') line++;
  return line;
}

interface Hit {
  rule: string;
  line: number;
  snippet: string;
}

function scan(code: string): Hit[] {
  const stripped = stripComments(code);
  const hits: Hit[] = [];
  for (const rule of FORBIDDEN) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(stripped)) !== null) {
      hits.push({ rule: rule.name, line: lineOf(stripped, m.index), snippet: m[0].trim() });
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++; // guard against zero-width matches
    }
  }
  return hits;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(p));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('invariant: the Steward is structurally incapable of signing/spending', () => {
  const files = tsFiles(SRC_DIR);

  it('finds a non-empty set of source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no source file references a signing/wallet construct (call sites, not prose)', () => {
    const violations: string[] = [];
    for (const f of files) {
      for (const h of scan(readFileSync(f, 'utf8'))) {
        violations.push(`${relative(REPO_ROOT, f).replace(/\\/g, '/')}:${h.line}  [${h.rule}]  ${h.snippet}`);
      }
    }
    expect(
      violations,
      `\nForbidden signing constructs found in src/. The Steward must never be able to sign or spend:\n${violations.join('\n')}\n`,
    ).toEqual([]);
  });

  it('positive control: the scanner actually detects every forbidden construct', () => {
    const malicious = [
      "import { Wallet } from 'ethers';",
      'const w = new ethers.Wallet(pk);',
      'const r = Wallet.createRandom();',
      'await signer.sendTransaction(tx);',
      'const raw = await wallet.signTransaction(tx);',
      'const k = account.privateKey;',
      'const phrase = wallet.mnemonic;',
    ].join('\n');
    const fired = new Set(scan(malicious).map((h) => h.rule));
    // Every rule must fire at least once, proving the scanner isn't vacuously green.
    expect(fired.size).toBe(FORBIDDEN.length);
  });

  it('negative control: the same words in comments/strings/identifiers are NOT flagged', () => {
    const prose = [
      '// The Steward never holds a Wallet, a signer, a privateKey, or a mnemonic.',
      '/* No signTransaction. No sendTransaction. Ever. conscience before wallet. */',
      "const note = 'conscience before wallet: cannot sign or send';",
      'interface Grant { boundWalletAddress?: string; boundWallet?: string; }',
      "const url = 'https://example.com/wallet'; // signer's address lives off-chain",
    ].join('\n');
    expect(scan(prose)).toEqual([]);
  });

  it('package.json declares no signing-capable dependencies', () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    // Runtime deps are the ones that could ever sign/spend: keep them to a tiny,
    // known-safe allowlist. Adding a runtime dep must be a deliberate, reviewed act.
    const ALLOWED_RUNTIME = new Set(['ethers', 'yaml', 'zod']);
    const runtime = Object.keys(pkg.dependencies ?? {});
    const unexpected = runtime.filter((d) => !ALLOWED_RUNTIME.has(d));
    expect(
      unexpected,
      `Unexpected runtime dependency: ${unexpected.join(', ')}. The Steward stays minimal and signing-incapable; ` +
        `if a new dep is genuinely needed AND cannot sign/spend, add it to ALLOWED_RUNTIME in this test.`,
    ).toEqual([]);

    // Defence in depth: no known signing library anywhere (deps or devDeps).
    const SIGNING_DENYLIST = [
      'web3', 'viem', 'ethereumjs-wallet', 'ethereumjs-tx', 'ethereumjs-util',
      '@metamask', 'bip39', '@scure/bip39', 'hdkey', 'micro-eth-signer',
      '@solana/web3.js', 'bitcoinjs-lib', 'eth-crypto',
      '@ethersproject/wallet', '@ethersproject/signing-key',
    ];
    const all = [...runtime, ...Object.keys(pkg.devDependencies ?? {})];
    const banned = all.filter((d) => SIGNING_DENYLIST.some((b) => d === b || d.startsWith(`${b}/`)));
    expect(banned, `Signing-capable dependency present: ${banned.join(', ')}`).toEqual([]);
  });
});
