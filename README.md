# The Steward — Intent & Reliability Kernel

A **surface-agnostic** kernel for *faithful* agent action. The Steward is the
missing middle layer between an agent's capabilities and a person's intent:
it captures philosophical **intent** (an Intent Charter), verifies that a
proposed action **matches** that intent, keeps a durable **audit** trail, and
enforces **bounded authority**.

**Core principle: "conscience before wallet."** The kernel is *structurally
incapable* of executing, signing, or spending. It only **reads, reasons,
dry-runs**, and emits a **human-signable package** + a tamper-evident audit
record. A human (or a later, separately-reviewed signing layer) submits.

Demonstrated against the **live AMOR governance surface** (Neo X mainnet,
chainId 47763) in **READ-ONLY + DRY-RUN** mode.

## Safety (structural, not advisory)

- **No private keys. No signers. No transaction submission. Anywhere.**
  `ethers` is used read-only (`JsonRpcProvider` only; `Wallet` is never
  imported). "Dry-run" = build calldata + a static read-only estimate; it never
  sends.
- The kernel's **output** is the package; it cannot submit it.
- **Default to escalate-to-human** on any uncertainty. Bias toward refusing an
  action over taking a wrong one. The **rails** are the arbiter, not the reasoner.

## Module layout

| Module | File | Responsibility |
|---|---|---|
| Charter | `src/charter.ts`, `charters/governance.example.yaml` | Intent made legible: zod-validated principles + hard constraints; stable sha256 contentHash. |
| Adapter interface | `src/adapter.ts` | `SurfaceAdapter` — read / describeProposed / dryRun. Makes AMOR just the first surface. |
| AMOR adapter | `src/adapters/amor.ts` | Read-only OZ Governor reads; builds castVote calldata; **never sends**. Live-first, fixture fallback. |
| Reasoner | `src/reason.ts`, `src/llmReasoner.ts` | `IntentReasoner`; deterministic key-free baseline + documented LLM seam. |
| Rails | `src/rails.ts` | Safety core. Enforces confidence floor, hard constraints, authority bounds. Escalates on ambiguity. |
| Audit | `src/audit.ts` | Append-only, hash-chained JSONL; `verifyAuditChain()` for tamper-evidence. |
| Orchestrator | `src/steward.ts` | read → reason → rails → (dryRun) → package / escalation. Always audits. Emits nothing on-chain. |
| CLI | `src/cli.ts` | `steward govern --charter <yaml> --proposal <id\|fixture>`. |

## Usage

```bash
npm install
npm run build
npm test

# Run the demo (tries live AMOR, falls back to the fixture):
node dist/cli.js govern --charter charters/governance.example.yaml --proposal fixture
# or against a live proposal id:
node dist/cli.js govern --charter charters/governance.example.yaml --proposal <proposalId>
```

## How the rails enforce intent

The reasoner says what it *thinks*; the rails decide what the kernel is
*allowed* to do — independent of how the judgment was produced (so an
over-confident or captured LLM cannot bypass them):

1. **Confidence floor** — `confidence ≥ charter.confidenceThreshold`, else escalate.
2. **Hard constraints** — `requireHuman` (always/irreversible/onSupport) → escalate;
   `maxImpact` breach → escalate; `forbidIrreversible` + supporting an irreversible action → **refuse**.
3. **Authority bound** — impact within `authority.maxAutoImpact`.
4. **Actionability** — only propose acting on `Active` proposals.

When in doubt: **escalate**. A `proceed` verdict is only reached for a confident,
bounded, reversible-enough, in-authority action.

## Adapter roadmap

`SurfaceAdapter` is the seam. The cleanest next adapter is a **ghostsignals
trade** (intent: risk limits / position caps; same read→reason→rails→dry-run
shape; dry-run builds an unsigned order). **PFORK treasury** follows but should
start in pure-escalation mode (treasury moves are irreversible/high-impact and
should always route to a human under this charter).
