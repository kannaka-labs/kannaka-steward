import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditLog } from '../src/audit.js';

/**
 * END-TO-END: the ghostsignals trade surface, driven through the real CLI.
 *
 * Unlike the other suites (which call runSteward directly), this spawns the
 * built `dist/cli.js` as a child process and asserts the whole pipeline —
 * read → reason → rails → warrant → dry-run → emit — from the outside.
 *
 * The centerpiece is a LIVE read: a tiny read-only stub HTTP server serves the
 * ghostsignals market + quote endpoints, so the CLI exercises its genuine live
 * HTTP branch (not the fixture fallback). The stub ALSO exposes POST /api/trading
 * and records every hit; the defining assertion is that after a full, successful,
 * warrant-permitted run, that endpoint was hit ZERO times. The Steward proposes
 * an order for a human to submit; it never submits one itself.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(REPO, 'dist', 'cli.js');
const TSC = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
const MARKET_ID = 'mkt_energy_winter_2026';

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function tmpAudit(): string {
  return join(mkdtempSync(join(tmpdir(), 'steward-e2e-')), 'audit.jsonl');
}

interface CliRun {
  code: number;
  out: string;
}

/**
 * Run the CLI asynchronously. Must be async (not spawnSync): the live test's
 * stub server lives in THIS process, so blocking the event loop would starve
 * the server and the child's reads would time out and fall back to the fixture.
 */
function runCli(args: string[], env: Record<string, string> = {}): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO, // the CLI resolves charters/ and fixtures/ relative to cwd
      env: { ...process.env, ...env },
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: steward ${args.join(' ')}`));
    }, 20_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: strip(out) });
    });
  });
}

interface Stub {
  url: string;
  submissions: string[];
  close: () => Promise<void>;
}

/**
 * A READ-ONLY ghostsignals stub. It answers the two GET endpoints the adapter
 * reads and, deliberately, also answers POST /api/trading so we can prove the
 * Steward never calls it. Any submission is recorded in `submissions`.
 */
function startStub(marketJson: string): Promise<Stub> {
  const submissions: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && /^\/api\/markets\/[^/]+\/quote/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ammBuyPrice: '0.40', ammSellPrice: '0.39', spread: '0.01' }));
    } else if (req.method === 'GET' && /^\/api\/markets\/[^/]+$/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(marketJson);
    } else if (req.method === 'POST' && url.startsWith('/api/trading')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        submissions.push(body); // if this ever fires, the invariant is broken
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        submissions,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('e2e: ghostsignals trade through the real CLI', () => {
  // Build once so the e2e always tests the current source, whether or not CI
  // ran `npm run build` first.
  beforeAll(() => {
    const built = spawnSync(process.execPath, [TSC], { cwd: REPO, encoding: 'utf8' });
    if (built.status !== 0) {
      throw new Error(`tsc build failed:\n${built.stdout}\n${built.stderr}`);
    }
    expect(existsSync(CLI)).toBe(true);
  }, 120_000);

  it('LIVE read → reason → dry-run → emits a warrant-permitted order, and NEVER submits it', async () => {
    const marketJson = readFileSync(join(REPO, 'fixtures', 'ghostsignals-market.json'), 'utf8');
    const stub = await startStub(marketJson);
    const auditPath = tmpAudit();
    try {
      const { code, out } = await runCli(
        ['trade', '--market', MARKET_ID, '--warrant', 'granted', '--audit', auditPath],
        { GHOSTSIGNALS_API_URL: stub.url },
      );

      expect(code).toBe(0);
      // Provenance: this went through the genuine LIVE HTTP path, not the fixture.
      expect(out).toContain('LIVE API');
      expect(out).not.toContain('FIXTURE (deterministic fallback)');
      // Pipeline stages.
      expect(out).toContain('PROCEED');
      expect(out).toContain('PERMITTED grant=grant_demo_granted');
      expect(out).toContain('live LMSR cross-check'); // the read-only /quote cross-check ran
      // The emitted, unsigned order package, marked explicitly human-action-required.
      expect(out).toContain('UNSIGNED ORDER PACKAGE');
      expect(out).toMatch(/HUMAN\/keyholder to submit/);
      expect(out).toContain('will not POST it');
      expect(out).toContain('/api/trading');
      expect(out).toMatch(/"marketId":"mkt_energy_winter_2026"/);
      expect(out).toMatch(/"type":"buy"/);
      // Audit chain verified.
      expect(out).toContain('VERIFIED');

      // THE invariant, proven end-to-end: a live, writable trading endpoint was
      // available for the entire run and the Steward never POSTed to it.
      expect(stub.submissions).toEqual([]);

      // The audit record persisted and reflects a permitted, proceeded trade.
      const records = new AuditLog(auditPath).readAll();
      expect(records.length).toBe(1);
      const rec = records[0]!;
      expect(rec.surface).toBe('ghostsignals');
      expect(rec.actionId).toBe(MARKET_ID);
      expect(rec.verdict.decision).toBe('proceed');
      expect(rec.warrant?.authorized).toBe(true);
      expect(rec.dryRun?.to).toMatch(/\/api\/trading$/);
      expect(new AuditLog(auditPath).verify().ok).toBe(true);
    } finally {
      await stub.close();
    }
  }, 30_000);

  it('FIXTURE read → emits a warrant-permitted order package (offline, no server)', async () => {
    const auditPath = tmpAudit();
    const { code, out } = await runCli(['trade', '--market', 'fixture', '--warrant', 'granted', '--audit', auditPath]);

    expect(code).toBe(0);
    expect(out).toContain('FIXTURE (deterministic fallback)');
    expect(out).toContain('PROCEED');
    expect(out).toContain('UNSIGNED ORDER PACKAGE');
    expect(out).toContain('offline LMSR replica');
    expect(out).toMatch(/"type":"buy"/);
    expect(out).toContain('VERIFIED');

    const records = new AuditLog(auditPath).readAll();
    expect(records.length).toBe(1);
    expect(records[0]!.verdict.decision).toBe('proceed');
    expect(records[0]!.warrant?.authorized).toBe(true);
  });

  it('warrant REVOKED ⇒ WARRANT-BLOCKED NOTICE, no order package emitted', async () => {
    const auditPath = tmpAudit();
    const { code, out } = await runCli(['trade', '--market', 'fixture', '--warrant', 'revoked', '--audit', auditPath]);

    expect(code).toBe(0);
    // Rails still proceed (the action is faithful + bounded)...
    expect(out).toContain('PROCEED');
    // ...but delegation denies, so the distinct blocked notice is shown and
    // NO order package / calldata is produced.
    expect(out).toContain('WARRANT-BLOCKED NOTICE');
    expect(out).toContain('MOVED but NOT PERMITTED');
    expect(out).not.toContain('UNSIGNED ORDER PACKAGE');

    const records = new AuditLog(auditPath).readAll();
    expect(records.length).toBe(1);
    expect(records[0]!.verdict.decision).toBe('proceed');
    expect(records[0]!.warrant?.authorized).toBe(false);
  });

  it('bounded authority: an out-of-bounds (illiquid, high-slippage) market ⇒ ESCALATE, no order', async () => {
    // The illiquid fixture sits far below the charter's liquidity floor (250)
    // and any fill blows past the slippage limit (0.05) — the rails must block
    // it BEFORE any warrant is consulted. Proves bounded authority is enforced.
    const auditPath = tmpAudit();
    const { code, out } = await runCli(['trade', '--market', 'illiquid', '--warrant', 'granted', '--audit', auditPath]);

    expect(code).toBe(0);
    // Rails escalate on the hard-constraint breach...
    expect(out).toContain('ESCALATE');
    expect(out).toContain('ESCALATION NOTICE');
    // ...naming the breached bounds (liquidity floor + slippage limit)...
    expect(out).toMatch(/liquidity 40 below floor 250/);
    expect(out).toMatch(/slippage 0\.\d+ exceeds limit 0\.05/);
    // ...the warrant is never consulted (rails already blocked)...
    expect(out).toContain('not consulted');
    // ...and NO order package / calldata is produced.
    expect(out).not.toContain('UNSIGNED ORDER PACKAGE');
    expect(out).toContain('No order package is produced');

    const records = new AuditLog(auditPath).readAll();
    expect(records.length).toBe(1);
    expect(records[0]!.verdict.decision).toBe('escalate');
    expect(records[0]!.warrant).toBeNull(); // never consulted
    expect(new AuditLog(auditPath).verify().ok).toBe(true);
  });
});
