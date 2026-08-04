# Handraise product roadmap

**Status:** execution plan for the full product vision

**Last reviewed:** 2026-08-03

**Progress source of truth:** `.handraise/fronts/*.md`

**Release gate source of truth:**
[RELEASE_0_DOGFOOD.md](./RELEASE_0_DOGFOOD.md) and subsequent vertical release
contracts.

This roadmap orders the target specified by
[PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md). It deliberately uses
dependency gates rather than calendar promises. A front changes state only when
its own Markdown checklist has verified evidence; this document summarizes but
does not replace those files.

## Delivery correction — vertical releases first

The capability milestones below remain useful as a dependency map, but they are
not the delivery order. Building intelligence, then design, then the integrated
experience leaves a wide but unusable product. Delivery now follows the
requirements and release contract in
[ENGINEERING_DELIVERY_CONTRACT.md](./ENGINEERING_DELIVERY_CONTRACT.md):

| Release | Complete usable outcome |
|---|---|
| R0 · Dogfood core | Run and verify one existing Handraise front in Handraise through the product. |
| R1 · Thin complete loop | Initialize a repo, perform bounded built-in read-only understanding, accept components, create/publish one front and run it. |
| R2 · Rich understanding | Add Graphify/richer maps, evidence navigation and large-repository behavior without weakening R1. |
| R3 · Product-led design | Add product intent, architecture alternatives, front portfolios and human-quality gates as one reviewable loop. |
| R4 · Reconcile | Turn changed code and run outcomes into reviewable drift and replanning, never silent mutation. |
| R5 · Remote and fleet hardening | Promote remote/tunnel/fleet operation only after its own security, load, reconnect and recovery gate. |
| R6 · Multi-repository product | Coordinate product outcomes across repos while preserving repository-local ownership and transactions. |

Every release reruns all prior gates. Capability already present in the codebase
but not selected and verified by the current release remains inventory or an
explicit experimental surface, not release-completion evidence.

## Starting point

The current repository already provides a substantial **Run** foundation:

- repository detection and native/Director portfolios;
- safe native component discovery preview and atomic acceptance;
- component/front lifecycle and editable contracts;
- Claude Code and Codex authentication/capability states;
- tmux sessions, typed permissions, attention and graceful wrap-up;
- worktree creation, branch safety, reconciliation and cleanup;
- local implicit client, remote pairing, private/Internet access paths;
- fleet verdicts, service/hooks diagnostics and PWA resilience.

Those verified baseline fronts remain `done`. The existing discovery flow is a
safe workflow skeleton and a bounded heuristic fallback. It is not yet the
semantic repository intelligence, product direction or work-design system in
the target vision.

## Dependency graph

```text
                                     ┌─ product-intent-and-goals ───────┐
                                     │                                  │
repository-intelligence-contract     ├─ work-contract-schema-v2 ────────┤
              │                      │                                  │
              ├─ readonly-analysis-runtime ── graphify-readonly-adapter │
              │                    │                    │                │
              │                    └──── semantic-system-map ───────────┤
              │                                                         │
              └─ planning-model-capabilities ───────────────────────────┤
                                                                        ▼
                                                     component-architecture-designer
                                                                        │
                                                                        ▼
                                                        front-planning-assistant
                                                                        │
                                                                        ▼
                                                   transactional-plan-publication
                                                        │
                                                        ▼
                                               release-planning-and-gates
                                                        │               │
                                     ad-hoc-session-lifecycle            ├─ understand-design-run-experience
                                                        ▼               │
                                              plan-driven-agent-orchestration
                                                        │
semantic-system-map ── continuous-architecture-reconciliation           │
                                  │                     │                │
                                  └─────────────────────┴─ outcome-learning-loop

product-intent-and-goals + semantic-system-map + publication
                                  └────────────────────── product-portfolio-map

planning-quality-evaluation starts with the contracts and gates every release.
```

## Front inventory and prerequisites

| Order | Front | Lead component | Hard prerequisites |
|---:|---|---|---|
| 1 | `repository-intelligence-contract` | repository-intelligence | — |
| 2 | `product-intent-and-goals` | product-direction | — |
| 3 | `work-contract-schema-v2` | repository-planning | product vision |
| 4 | `readonly-analysis-runtime` | repository-intelligence | intelligence contract |
| 5 | `planning-model-capabilities` | agent-integrations | intelligence contract |
| 6 | `graphify-readonly-adapter` | repository-intelligence | intelligence contract, analysis runtime |
| 7 | `planning-quality-evaluation` | repository-planning | intelligence contract, v2 work contract |
| 8 | `semantic-system-map` | repository-intelligence | analysis runtime, Graphify adapter/fallback |
| 9 | `component-architecture-designer` | repository-planning | intent, map, v2 schema, planning model/manual path |
| 10 | `front-planning-assistant` | repository-planning | selected component design, intent, v2 schema, planning model/manual path |
| 11 | `transactional-plan-publication` | repository-planning | component/front drafts, v2 schema |
| 12 | `release-planning-and-gates` | repository-planning | accepted requirements/fronts, publication |
| 13 | `ad-hoc-session-lifecycle` | runtime-worktree-control | operational runtime foundation |
| 14 | `understand-design-run-experience` | client-experience | stable APIs from fronts 1–13 |
| 15 | `plan-driven-agent-orchestration` | runtime-worktree-control | accepted v2 fronts, publication, release authority |
| 16 | `continuous-architecture-reconciliation` | repository-intelligence | system map, accepted contracts, snapshot diff |
| 17 | `outcome-learning-loop` | repository-planning | orchestration, reconciliation, evaluation |
| 18 | `product-portfolio-map` | product-direction | intent, per-repo maps/plans, publication |

The experience front is an integration/hardening front, not permission to defer
all UI. Every preceding front ships the smallest reviewable client slice needed
to verify its contract. The final experience front unifies navigation,
accessibility, responsive behavior and end-to-end recovery.

## Milestone 0 — Operational foundation (current)

**Outcome:** Handraise can safely connect repositories and clients and run a
fleet of Claude Code/Codex sessions against repository-scoped fronts.

**Exit evidence:** the seven existing fronts are `done`, their requirements are
checked in `FUNCTIONAL_REQUIREMENTS.md`, and tests cover their stated safety
paths.

This milestone remains regression-protected throughout the roadmap.

## Milestone 1 — Intelligence foundations

**Fronts:**

- `repository-intelligence-contract`
- `readonly-analysis-runtime`
- `graphify-readonly-adapter`
- initial slice of `planning-quality-evaluation`

**Outcome:** Handraise can run a bounded analyzer job over an exact repository
snapshot, normalize evidence and clean up without touching the target.

**Gate A — trustworthy observation:**

- zero target-repository mutation across success, failure, cancellation and
  hostile fixtures;
- 100% emitted evidence references either resolve against the snapshot or carry
  an explicit stale/missing state;
- capabilities, exclusions, dirty-tree scope and data boundary are visible;
- Graphify absence/incompatibility has an honest fallback and diagnostics;
- no model/source transfer happens without a separate explicit action.

## Milestone 2 — Understand

**Fronts:**

- `semantic-system-map`
- `product-intent-and-goals` (can begin in Milestone 1)

**Outcome:** the user can inspect both what the code appears to be and what the
product is intended to become, without conflating them.

**Gate B — useful system understanding:**

- supported first-party code is mapped or explicitly classified as uncovered;
- responsibility clusters and critical relations have navigable evidence and
  provenance;
- unsupported languages, exclusions, ambiguity and staleness remain visible;
- a no-change repeat produces a materially stable normalized map;
- a human can correct product intent without editing generated graph data.

This is the first **Understand** alpha.

## Milestone 3 — Design components

**Fronts:**

- `work-contract-schema-v2`
- `planning-model-capabilities`
- `component-architecture-designer`
- continuing `planning-quality-evaluation`

**Outcome:** Handraise proposes complete, evidence-backed component architecture
alternatives using both system evidence and product intent.

**Gate C — useful decomposition:**

- each responsibility is owned once, deliberately shared, or visibly uncovered;
- boundaries, interfaces, dependencies and uncertainty are explainable;
- users can split, merge, edit, lock, compare, regenerate or author manually;
- no proposal writes repository state;
- on the benchmark corpus, blind repository owners rate at least 80% of proposals
  as a useful starting point, and the median proposal does not require replacing
  the entire decomposition;
- hard safety and evidence invariants have zero failures.

This is a private **Design** alpha. The human-quality threshold is versioned with
the benchmark and cannot be replaced by model self-confidence.

## Milestone 4 — Design executable work

**Fronts:**

- `front-planning-assistant`
- `transactional-plan-publication`
- continuing `planning-quality-evaluation`

**Outcome:** a product goal becomes a complete, dependency-aware portfolio of
fronts and accepted contracts through one reviewable publication flow.

**Gate D — executable plan:**

- every front has one lead component, an observable outcome, readiness,
  acceptance and verification;
- hard dependencies form a valid DAG and uncovered goals/duplicate outcomes are
  visible;
- alternative slicing/sequencing can be compared before acceptance;
- final publication is serialized, conflict-safe, no-overwrite and all-or-nothing;
- crash/cancel/stale-fingerprint tests leave accepted state unchanged;
- Director compatibility remains within advertised capabilities.

This is the **Design** beta.

## Milestone 5 — Run the designed work

**Fronts:**

- `plan-driven-agent-orchestration`
- `understand-design-run-experience`

**Outcome:** accepted ready fronts compile into safe, context-faithful agent runs
and the user can traverse the complete Understand → Design → Run loop.

**Gate E — single-repository V1:**

- one real product goal can travel from brief and analysis to accepted plan,
  isolated run, checks and completion;
- no agent/worktree/external operation starts during analysis or planning;
- dependency, stale-revision, capability and Git-safety checks gate start;
- completion distinguishes terminal activity, claimed tasks and verified outcome;
- local and paired remote clients have honest authority and recovery states;
- browser/API/accessibility/security suites cover the integrated journey;
- existing fleet operations have no material regression.

This gate delivers the complete slogan for one repository.

## Milestone 6 — Reconcile and improve

**Fronts:**

- `continuous-architecture-reconciliation`
- `outcome-learning-loop`

**Outcome:** code changes and run discoveries produce explainable drift and
reviewable plan/contract updates without erasing decisions.

**Gate F — closed loop:**

- incremental snapshots separate code changes from analyzer/inference changes;
- affected contracts/fronts become stale with a traceable reason;
- dismissed/deferred findings retain rationale and do not create unchanged noise;
- accepted updates reuse the same review and atomic publication guarantees;
- feedback improves measured ranking/quality without treating one user's
  acceptance as universal ground truth or uploading source implicitly.

## Milestone 7 — Product-level portfolio

**Front:** `product-portfolio-map`

**Outcome:** one product brief, map and goal graph can coordinate multiple
repositories while preserving each repository's ownership, adapter and locks.

**Gate G — full product scope:**

- cross-repository interfaces and missing context are explicit;
- each front remains in one repository with one lead component;
- readiness can cross repositories without cross-repository mutation tricks;
- product outcomes, critical path, runs and drift can be viewed globally and
  drilled down locally;
- the complete benchmark, privacy, crash-recovery and operational gates pass.

## Execution policy

1. Keep at most two implementation fronts active: one on the critical path and
   one independent contract/evaluation/experience slice.
2. Start `planning-quality-evaluation` early and keep it active through the
   Design beta; do not retrofit evaluation after prompts and UI are fixed.
3. Land vertical slices behind explicit capability states. Never label a
   heuristic cluster “semantic” simply because a model restated it.
4. Preserve manual and baseline paths at every milestone; rich analysis and
   model assistance are accelerators, not availability dependencies.
5. Re-run the full operational baseline at each gate because intelligence code
   shares authentication, storage, server and client surfaces with runtime.
6. Treat Graphify/model versions, normalized schemas and benchmark versions as
   independently pinned compatibility dimensions.
7. Mark a checklist item only after its observable result and negative paths are
   verified. Code existence, a happy-path demo or an agent report alone is not
   completion evidence.

## Product completion definition

“100%” means Gates A through G are satisfied and the end-to-end north-star
outcome in `PRODUCT_VISION.md` works on representative repositories. It does not
mean every conceivable analyzer, provider, SCM host or issue tracker exists.
Those are extensions behind stable contracts after the core loop is trustworthy.
