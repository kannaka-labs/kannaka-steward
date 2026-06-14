#!/usr/bin/env node
/**
 * Steward CLI.
 *
 *   steward govern --charter charters/governance.example.yaml --proposal <id|fixture>
 *
 * Runs read → reason → rails → dry-run → package (or escalation), pretty-prints
 * each stage, and is HONEST about live-vs-fixture provenance. Emits nothing
 * on-chain; the only side effect is appending one audit record.
 */

import { loadCharter } from './charter.js';
import { AmorAdapter } from './adapters/amor.js';
import { GhostsignalsAdapter } from './adapters/ghostsignals.js';
import { runSteward, type WarrantRunOptions } from './steward.js';
import { AuditLog } from './audit.js';
import type {
  HumanSignablePackage,
  EscalationNotice,
  WarrantBlockedNotice,
  WarrantVerdict,
  Verdict,
} from './types.js';

interface Args {
  command: string;
  charter: string;
  proposal: string;
  market: string;
  /** Warrant selector: granted | revoked | overscope | live:<URL>. */
  warrant: string;
  auditPath?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true';
      args[key] = val;
    } else {
      positional.push(a);
    }
  }
  const command = positional[0] ?? 'help';
  return {
    command,
    charter:
      args.charter ??
      (command === 'trade'
        ? 'charters/markets.example.yaml'
        : 'charters/governance.example.yaml'),
    proposal: args.proposal ?? 'fixture',
    market: args.market ?? 'fixture',
    // Default to the granted offline fixture so the happy path demos out of the
    // box (PROCEED + PERMITTED ⇒ a package is emitted with no server running).
    warrant: args.warrant ?? 'granted',
    auditPath: args.audit,
  };
}

/**
 * Resolve the --warrant selector into the warrant inputs threaded into the loop.
 *   granted   → fixtures/grant-granted.json   (offline, authorized happy path)
 *   revoked   → fixtures/grant-revoked.json   (offline, denied: grant revoked)
 *   overscope → fixtures/grant-overscope.json (offline, denied: missing scope)
 *   live:URL  → live introspect against the deployed warrant layer
 */
function resolveWarrant(sel: string, log: (m: string) => void): WarrantRunOptions {
  if (sel.startsWith('live:')) {
    return { introspectUrl: sel.slice('live:'.length), log };
  }
  const fixtures: Record<string, string> = {
    granted: 'fixtures/grant-granted.json',
    revoked: 'fixtures/grant-revoked.json',
    overscope: 'fixtures/grant-overscope.json',
  };
  const fixturePath = fixtures[sel] ?? fixtures.granted!;
  return { fixturePath, log };
}

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function hr(label = ''): void {
  const line = '─'.repeat(Math.max(2, 64 - label.length));
  console.log(c.dim(`── ${label} ${line}`));
}

function decisionColor(d: string): (s: string) => string {
  return d === 'proceed' ? c.green : d === 'refuse' ? c.red : c.yellow;
}

/**
 * Print the WARRANT (delegation) section between RAILS and the package/notice.
 * Only meaningful once the rails proceeded — the warrant is the second gate.
 * `report.warrant` is null when the warrant was never consulted (rails blocked).
 */
function printWarrant(report: { warrant: WarrantVerdict | null; verdict: Verdict }): void {
  hr('WARRANT (delegation verdict)');
  if (!report.warrant) {
    if (report.verdict.decision === 'proceed') {
      console.log(c.dim('  not consulted (no delegation source supplied).'));
    } else {
      console.log(c.dim('  not consulted — rails already blocked the action.'));
    }
    return;
  }
  const w = report.warrant;
  console.log(
    `  permitted : ${w.authorized ? c.green('YES — delegated by the human') : c.red('NO — not delegated for this human')}`,
  );
  console.log(`  source    : ${w.source === 'live' ? c.green('live introspect') : c.yellow('offline grant fixture')}`);
  if (w.grantId) console.log(`  grant     : ${c.cyan(w.grantId)}`);
  if (w.scopes && w.scopes.length) console.log(`  scopes    : ${w.scopes.join(', ')}`);
  w.reasons.forEach((r) => console.log(`    • ${r}`));
}

/** Print a WarrantBlockedNotice (moved but not permitted). */
function printWarrantBlocked(notice: WarrantBlockedNotice): void {
  hr('WARRANT-BLOCKED NOTICE');
  console.log(c.red(`  ▶ ${notice.summary}`));
  console.log(c.dim('  ▶ The action was faithful and within rails, but no delegation permits it.'));
  console.log(c.dim('  ▶ No calldata / order is produced. The human must (re)delegate the scope.'));
}

async function govern(args: Args): Promise<void> {
  console.log(c.bold('\n🛡  THE STEWARD — Intent & Reliability Kernel'));
  console.log(c.dim('   conscience before wallet · read-only · dry-run only · cannot sign or send\n'));

  const loaded = loadCharter(args.charter);
  hr('CHARTER');
  console.log(`  id        : ${c.cyan(loaded.charter.id)} v${loaded.charter.version}`);
  console.log(`  owner     : ${loaded.charter.owner}`);
  console.log(`  threshold : confidence ≥ ${loaded.charter.confidenceThreshold}, maxAutoImpact ${loaded.charter.authority.maxAutoImpact}`);
  console.log(`  hash      : ${c.dim(loaded.contentHash)}`);

  const adapter = new AmorAdapter({
    fixturePath:
      args.proposal === 'opposing'
        ? 'fixtures/amor-proposal-opposing.json'
        : 'fixtures/amor-proposal.json',
    forceFixture: args.proposal === 'fixture' || args.proposal === 'opposing',
    log: (m) => console.log(c.dim(`  ${m}`)),
  });
  // Translate the convenience alias into the adapter ref.
  const proposalRef = args.proposal === 'opposing' ? 'fixture' : args.proposal;

  const warrantOpts = resolveWarrant(args.warrant, (m) => console.log(c.dim(`  ${m}`)));

  hr('READ');
  const report = await runSteward(loaded, adapter, proposalRef, {
    auditPath: args.auditPath,
    warrant: warrantOpts,
  });
  const a = report.action;
  const prov = a.source === 'live' ? c.green('LIVE on-chain') : c.yellow('FIXTURE (deterministic fallback)');
  console.log(`  source    : ${prov}`);
  console.log(`  surface   : ${a.surface}  kind: ${a.kind}`);
  console.log(`  proposal  : ${c.cyan(a.id.length > 20 ? a.id.slice(0, 18) + '…' : a.id)}`);
  console.log(`  title     : ${c.bold(a.title)}`);
  console.log(`  state     : ${a.state}`);
  if (a.tally) console.log(`  tally     : for=${a.tally.for} against=${a.tally.against} abstain=${a.tally.abstain}`);
  console.log(`  impact    : magnitude ${a.impact.magnitude}, ${a.impact.reversible ? c.green('reversible') : c.red('IRREVERSIBLE')}${a.impact.field ? ` (${a.impact.field})` : ''}`);
  if (a.deadline) console.log(`  deadline  : ${a.deadline}`);

  hr('JUDGMENT (reasoner)');
  const j = report.judgment;
  const supColor = j.support === 'for' ? c.green : j.support === 'against' ? c.red : c.yellow;
  console.log(`  support   : ${supColor(j.support.toUpperCase())}  confidence ${j.confidence}`);
  console.log(`  principles: ${j.appliedPrinciples.join(', ') || '(none)'}`);
  console.log(`  rationale : ${j.rationale}`);
  if (j.concerns.length) {
    console.log('  concerns  :');
    j.concerns.forEach((x) => console.log(`    - ${x}`));
  }

  hr('RAILS (safety verdict)');
  const v = report.verdict;
  console.log(`  decision  : ${decisionColor(v.decision)(v.decision.toUpperCase())}`);
  v.reasons.forEach((r) => console.log(`    • ${r}`));

  printWarrant(report);

  if (report.result.kind === 'human-signable-package') {
    const pkg = report.result as HumanSignablePackage;
    hr('DRY-RUN (simulation only — NOT submitted)');
    console.log(`  ok        : ${pkg.dryRun.ok}`);
    console.log(`  to        : ${pkg.dryRun.to}`);
    console.log(`  source    : ${pkg.dryRun.source === 'live' ? c.green('live static estimate') : c.yellow('offline')}`);
    console.log(`  estimate  : ${pkg.dryRun.estimate}`);
    pkg.dryRun.warnings.forEach((w) => console.log(`  ${c.yellow('warn')}      : ${w}`));

    hr('HUMAN-SIGNABLE PACKAGE');
    console.log(c.green('  ▶ The Steward proposes the following for a HUMAN to sign + submit.'));
    console.log(c.green('  ▶ The kernel itself cannot and will not send it.\n'));
    console.log(`  summary   : ${pkg.summary}`);
    console.log(`  action    : ${pkg.proposedAction.summary}`);
    console.log(`  params    : ${JSON.stringify(pkg.proposedAction.params)}`);
    console.log(`  to        : ${pkg.to}`);
    console.log(`  calldata  : ${c.cyan(pkg.calldata ?? '(none)')}`);
    if (pkg.warrant) {
      console.log(`  warrant   : ${c.green('PERMITTED')} grant=${pkg.warrant.grantId ?? '(n/a)'} source=${pkg.warrant.source}`);
    }
  } else if (report.result.kind === 'warrant-blocked-notice') {
    printWarrantBlocked(report.result as WarrantBlockedNotice);
  } else {
    const notice = report.result as EscalationNotice;
    hr('ESCALATION NOTICE');
    const col = notice.verdict.decision === 'refuse' ? c.red : c.yellow;
    console.log(col(`  ▶ ${notice.summary}`));
    console.log(c.dim('  ▶ No calldata is produced. A human decides from here.'));
  }

  hr('AUDIT');
  console.log(`  record id : ${c.cyan(report.auditId)}`);
  const verifyResult = new AuditLog(args.auditPath).verify();
  console.log(
    `  chain     : ${verifyResult.ok ? c.green('VERIFIED') : c.red('BROKEN')} (${verifyResult.count} records)${verifyResult.reason ? ' — ' + verifyResult.reason : ''}`,
  );
  console.log('');
}

async function trade(args: Args): Promise<void> {
  console.log(c.bold('\n🛡  THE STEWARD — Intent & Reliability Kernel · ghostsignals TRADE surface'));
  console.log(c.dim('   conscience before wallet · read-only · dry-run only · cannot sign or submit\n'));

  const loaded = loadCharter(args.charter);
  hr('CHARTER');
  console.log(`  id        : ${c.cyan(loaded.charter.id)} v${loaded.charter.version}`);
  console.log(`  owner     : ${loaded.charter.owner}`);
  console.log(`  threshold : confidence ≥ ${loaded.charter.confidenceThreshold}, maxAutoImpact ${loaded.charter.authority.maxAutoImpact}`);
  console.log(`  hash      : ${c.dim(loaded.contentHash)}`);

  const adapter = new GhostsignalsAdapter({
    fixturePath: args.market === 'illiquid'
      ? 'fixtures/ghostsignals-market-illiquid.json'
      : 'fixtures/ghostsignals-market.json',
    forceFixture: args.market === 'fixture' || args.market === 'illiquid',
    log: (m) => console.log(c.dim(`  ${m}`)),
  });
  // Translate the convenience aliases into the adapter ref.
  const ref = args.market === 'illiquid' ? 'fixture' : args.market;
  const warrantOpts = resolveWarrant(args.warrant, (m) => console.log(c.dim(`  ${m}`)));

  hr('READ');
  const report = await runSteward(loaded, adapter, ref, {
    auditPath: args.auditPath,
    warrant: warrantOpts,
  });
  const a = report.action;
  const prov = a.source === 'live' ? c.green('LIVE API') : c.yellow('FIXTURE (deterministic fallback)');
  console.log(`  source    : ${prov}`);
  console.log(`  surface   : ${a.surface}  kind: ${a.kind}`);
  console.log(`  market    : ${c.cyan(a.id)}`);
  console.log(`  title     : ${c.bold(a.title)}`);
  console.log(`  state     : ${a.state}`);
  if (a.market) {
    console.log(`  liquidity : b=${a.market.liquidityParameter}  budget=${a.market.budget}`);
    a.market.outcomes.forEach((o) => console.log(`    outcome : ${o.id} "${o.label}" p=${o.probability}`));
    if (a.market.candidate) {
      const cd = a.market.candidate;
      console.log(`  candidate : ${cd.quantity} ${cd.type} "${cd.outcomeLabel}" cost=${cd.cost} avgPx=${cd.avgPrice} slip=${cd.slippage} frac=${cd.positionFraction}`);
    }
  }
  console.log(`  impact    : magnitude ${a.impact.magnitude}, ${a.impact.reversible ? c.green('reversible') : c.red('IRREVERSIBLE')}${a.impact.field ? ` (${a.impact.field})` : ''}`);
  if (a.deadline) console.log(`  resolves  : ${a.deadline}`);

  hr('JUDGMENT (reasoner)');
  const j = report.judgment;
  const supColor = j.support === 'for' ? c.green : j.support === 'against' ? c.red : c.yellow;
  console.log(`  support   : ${supColor(j.support.toUpperCase())}  confidence ${j.confidence}`);
  console.log(`  ${c.dim('(for = take the bounded position · abstain = take no position)')}`);
  console.log(`  principles: ${j.appliedPrinciples.join(', ') || '(none)'}`);
  console.log(`  rationale : ${j.rationale}`);
  if (j.concerns.length) {
    console.log('  concerns  :');
    j.concerns.forEach((x) => console.log(`    - ${x}`));
  }

  hr('RAILS (safety verdict)');
  const v = report.verdict;
  console.log(`  decision  : ${decisionColor(v.decision)(v.decision.toUpperCase())}`);
  v.reasons.forEach((r) => console.log(`    • ${r}`));

  printWarrant(report);

  if (report.result.kind === 'human-signable-package') {
    const pkg = report.result as HumanSignablePackage;
    hr('DRY-RUN (LMSR simulation only — NOT submitted)');
    console.log(`  ok        : ${pkg.dryRun.ok}`);
    console.log(`  endpoint  : ${pkg.dryRun.to}`);
    console.log(`  source    : ${pkg.dryRun.source === 'live' ? c.green('live LMSR cross-check') : c.yellow('offline LMSR replica')}`);
    console.log(`  estimate  : ${pkg.dryRun.estimate}`);
    pkg.dryRun.warnings.forEach((w) => console.log(`  ${c.yellow('warn')}      : ${w}`));

    hr('UNSIGNED ORDER PACKAGE');
    console.log(c.green('  ▶ The Steward proposes the following BOUNDED, REVERSIBLE order for a HUMAN/keyholder to submit.'));
    console.log(c.green('  ▶ The kernel itself cannot and will not POST it.\n'));
    console.log(`  summary   : ${pkg.summary}`);
    console.log(`  action    : ${pkg.proposedAction.summary}`);
    console.log(`  POST to   : ${pkg.to}`);
    console.log(`  order     : ${c.cyan(pkg.calldata ?? '(none)')}`);
    if (pkg.warrant) {
      console.log(`  warrant   : ${c.green('PERMITTED')} grant=${pkg.warrant.grantId ?? '(n/a)'} source=${pkg.warrant.source}`);
    }
  } else if (report.result.kind === 'warrant-blocked-notice') {
    printWarrantBlocked(report.result as WarrantBlockedNotice);
  } else {
    const notice = report.result as EscalationNotice;
    hr('ESCALATION NOTICE');
    const col = notice.verdict.decision === 'refuse' ? c.red : c.yellow;
    console.log(col(`  ▶ ${notice.summary}`));
    console.log(c.dim('  ▶ No order package is produced. A human decides from here.'));
  }

  hr('AUDIT');
  console.log(`  record id : ${c.cyan(report.auditId)}`);
  const verifyResult = new AuditLog(args.auditPath).verify();
  console.log(
    `  chain     : ${verifyResult.ok ? c.green('VERIFIED') : c.red('BROKEN')} (${verifyResult.count} records)${verifyResult.reason ? ' — ' + verifyResult.reason : ''}`,
  );
  console.log('');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'govern') {
    await govern(args);
  } else if (args.command === 'trade') {
    await trade(args);
  } else {
    console.log('Usage:');
    console.log('  steward govern --charter <path.yaml> --proposal <id|fixture> --warrant <granted|revoked|overscope|live:URL>');
    console.log('  steward trade  --charter <path.yaml> --market <id|fixture|illiquid> --warrant <granted|revoked|overscope|live:URL>');
    console.log('  Reads, reasons, checks rails (faithful?) AND warrant (delegated?), dry-runs,');
    console.log('  and emits a human-signable package ONLY if both gates pass. Else escalation /');
    console.log('  warrant-blocked notice. Never signs, never submits. conscience before wallet.');
  }
}

main().catch((e) => {
  console.error('\x1b[31mSteward error:\x1b[0m', e);
  process.exit(1);
});
