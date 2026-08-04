# Handraise component requirements ownership

**Status:** canonical ownership index

**Effective:** 2026-08-04

Requirement statements remain canonical in
[`FUNCTIONAL_REQUIREMENTS.md`](./FUNCTIONAL_REQUIREMENTS.md) and
[`PRODUCT_REQUIREMENTS.md`](./PRODUCT_REQUIREMENTS.md). This index assigns each
functional requirement to exactly one component. Collaboration does not split
accountability.

## Local Platform & Trust

**Component:** `local-platform-trust`

Owns:

- `SRV-01..08` — server lifecycle and readiness;
- `AUTH-01..14` — local trust, remote clients, pairing and tunnel authority;
- `REPO-01..05`, `REPO-09` — registration, identity, disconnect and missing-path recovery;
- `LIVE-01..02`, `LIVE-04..07`, `LIVE-10` — transport, connectivity and offline/PWA safety policy;
- `SAFE-01..03`, `SAFE-07`, `SAFE-10` — HTTP, origin, exposure and platform recovery boundaries;
- `CLI-01..04`, `CLI-06` — server, service, diagnostics and terminology commands.

Required test families: unit policy, authenticated API, browser auth/offline,
host/origin adversarial, persistence/restart, service diagnostics, load,
reconnect/soak and upgrade compatibility.

## Agent Integrations

**Component:** `agent-integrations`

Owns:

- `AGENT-01..11` — supported CLI detection, authentication, invocation and capability truth;
- `ATTN-01..02`, `ATTN-04..09` — lifecycle/attention adapters, notifications and hook repair;
- `PERM-01..08` — typed permission adapters and stale-request safety;
- `CLI-05` — version-aware agent-hook repair/uninstall;
- `MOD-01..08` — provider-neutral planning model capability and data boundary.

Required test families: adapter unit/contract, inert argv, real CLI detection and
setup, hook process integration, timeout/stale identity, permission adversarial,
capability degradation, restart and provider-version compatibility.

## Runtime & Worktree Control

**Component:** `runtime-worktree-control`

Owns:

- `SESSION-01..15` — managed process lifecycle and terminal control;
- `ATTN-03` — operational attention precedence;
- `SAFE-04..05`, `SAFE-09` — control target, process seal and destructive preflight safety;
- `RUN-20..30` — accepted-plan preflight, isolated execution, evidence, handoff and completion;
- `ADH-01..08` — explicitly unplanned runs, safety, provenance and promotion boundary.

Required test families: state-machine unit, API integration, real tmux, real Git
worktree, concurrency/race, crash/restart, terminal escaping/input adversarial,
process failure, resource/load and real-agent dogfood acceptance.

## Repository Planning

**Component:** `repository-planning`

Owns:

- `REPO-06..08`, `REPO-10..11` — planning adapter, metadata and live portfolio semantics;
- `COMP-01..13` — component contracts, lifecycle, discovery and atomic acceptance;
- `FRONT-01..12` — front contracts, lifecycle, dependencies and run association;
- `SAFE-08` — adapter-specific mutation boundaries;
- `CMP-20..30` — component architecture proposal and review;
- `FRO-20..30` — front portfolio proposal and review;
- `PUB-01..10` — isolated drafts and transactional publication;
- `RLS-01..10` — first-class release assembly, gates, lifecycle and evidence.

Required test families: parser/renderer round trip, schema/property and malformed
input, API/browser review, zero-mutation sentinels, lock/concurrency, atomic
rollback, crash recovery, migration/backward compatibility, plan invariants,
planning quality and portfolio-scale performance.

## Client Experience

**Component:** `client-experience`

Owns:

- `LIVE-03`, `LIVE-08..09` — installable responsive client, visible live refresh and theme continuity;
- `SAFE-06` — visible destructive confirmation;
- `UX-20..35` — the coherent, progressively disclosed and mobile-first Understand → Design → Run user journey.

Required test families: browser journey, accessibility tree/keyboard/focus,
responsive desktop/mobile, offline/PWA upgrade, error/retry/reconnect, local and
remote authority parity, rendering performance and bounded large-list behavior.

## Repository Intelligence

**Component:** `repository-intelligence`

Owns:

- `INT-01..18` — analyzer-neutral read-only snapshots, evidence and queries;
- `GRA-01..09` — Graphify adapter isolation, compatibility and degradation;
- `MAP-01..08` — semantic map, provenance, bounded queries and comparison;
- `REC-01..08` — snapshot drift, reconciliation and evidence-linked learning inputs.

Required test families: normalized contract, repository mutation sentinels,
adversarial filesystem/repository, adapter compatibility, cancellation and
process-tree cleanup, crash recovery, evidence integrity, large snapshot/query
performance, scale limits and deterministic comparison.

## Product Direction

**Component:** `product-direction`

Owns:

- `DIR-01..10` — product brief, goals, sources, conflicts and manual parity;
- `MUL-01..06` — product-level multi-repository context and portfolio.

Required test families: Markdown/schema round trip, provenance/conflict/lock,
draft isolation, atomic acceptance, API/browser authoring, partial/offline
repository behavior, multi-repository consistency and bounded aggregation.

## Cross-cutting non-functional ownership

The measurable requirements live in
[`NON_FUNCTIONAL_REQUIREMENTS.md`](./NON_FUNCTIONAL_REQUIREMENTS.md). Every NFR
has one accountable component and can name all affected components. The legacy
aliases map as follows:

| Legacy ID | Accountable component |
|---|---|
| `QOS-01..02` | `repository-intelligence` |
| `QOS-03..04` | `repository-planning` |
| `QOS-05..09` | `local-platform-trust` |
| `QOS-10` | `product-direction` |

## Non-requirement catalog entries

- `GAP-01..06` are historical aliases for requirements above.
- `TEST-01..12` are old suite reminders and are replaced by requirement-linked
  case IDs and release gates.
- `DEC-01..07` are accepted design decisions; they constrain requirements but
  are not independently counted as delivered behavior.

This assignment covers every current functional requirement family. It does
not certify implementation or tests; certification is release-specific.
