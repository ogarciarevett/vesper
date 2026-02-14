---
name: tradingroom-sdd-audit
description: Audit TradingRoom implementation against spec-driven design expectations for OpenClaw Village. Use when reviewing plan-vs-code parity, WebSocket contract drift, bot identity mapping, auth coverage, script/test health, and documentation drift before release.
---

# TradingRoom SDD Audit

## Overview

Run a repeatable, evidence-first review of TradingRoom implementation quality across backend, frontend, shared types, and docs.

Prioritize findings by release risk:
- `P0`: immediate breakage or security failure
- `P1`: wrong behavior with high business impact
- `P2`: correctness/reliability gaps with workarounds
- `P3`: docs/process drift

## Workflow

1. Collect evidence with `scripts/collect_evidence.sh`.
2. Validate required checks from `references/checklist.md`.
3. Compare expected contract vs actual code paths.
4. Produce findings ordered by severity with file references.
5. Propose concrete remediation grouped by phase.

## Required Checks

Load and execute all checks in:

`references/checklist.md`

Do not close the audit until every checklist item is marked as:
- `PASS` with proof, or
- `FAIL` with a finding and a remediation step.

## Evidence Rules

1. Treat running code and typed contracts as source of truth.
2. Prefer direct file references over broad summaries.
3. When evidence conflicts with docs, flag docs as stale.
4. Never infer auth coverage without checking middleware and client calls.
5. Validate identifier consistency (`agentId` slug vs DO id) across:
   - bot registration
   - WS payloads
   - dashboard mapping

## Output Template

Use this structure in audit reports:

```md
# TradingRoom Plan-vs-Code Audit

## Date
YYYY-MM-DD

## Scope
- backend
- frontend
- shared types
- scripts/tests
- docs

## Findings (Severity Ordered)
1. [P0] ...
   Evidence: <absolute-path>:<line>
2. [P1] ...

## Passed Checks
- ...

## Remediation Plan
### Phase 1 ...
### Phase 2 ...

## Regression Tests
- command + result
```

## Command

```bash
bash skills/tradingroom-sdd-audit/scripts/collect_evidence.sh
```
