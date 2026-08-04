# Handraise end-state product requirements

**Status:** canonical target behavior catalog; release evidence under revalidation

**Last reviewed:** 2026-08-03

**Vision:** [PRODUCT_VISION.md](./PRODUCT_VISION.md)

**Architecture:** [PRODUCT_ARCHITECTURE.md](./PRODUCT_ARCHITECTURE.md)

This document specifies the remaining end-state product, on top of the verified
operational baseline in [FUNCTIONAL_REQUIREMENTS.md](./FUNCTIONAL_REQUIREMENTS.md).
A checked item means the complete end-state behavior and its failure modes have
been verified; partial infrastructure does not count. Progress is executed and
recorded in `.handraise/fronts/`.

> **Delivery correction (2026-08-04):** checked items are prior implementation
> audit claims until they are linked to executable cases and current evidence
> under [ENGINEERING_DELIVERY_CONTRACT.md](./ENGINEERING_DELIVERY_CONTRACT.md).
> They cannot independently promote a release. The first gate is
> [RELEASE_0_DOGFOOD.md](./RELEASE_0_DOGFOOD.md).

## A. Product direction

- [ ] **DIR-01 — Guided product brief.** A user can create a brief containing
  purpose, stage, users, jobs, desired outcomes, success signals, priorities,
  constraints, invariants, non-goals and glossary.
- [ ] **DIR-02 — Selective import.** The user can select local documentation or
  supported connected sources to propose brief content without implicitly
  importing the whole repository or external account.
- [ ] **DIR-03 — Source attribution.** Every imported or generated statement
  identifies its source, or is labeled as an assumption or unanswered question.
- [ ] **DIR-04 — Intent conflict handling.** Contradictory documents or answers
  are surfaced for resolution and are never silently merged.
- [ ] **DIR-05 — Partial-context honesty.** Planning can continue with missing
  intent, while showing which recommendations are limited by that absence.
- [ ] **DIR-06 — Human-readable acceptance.** Accepted intent is stored in a
  reviewable `.handraise/product.md`; drafts do not mutate repository state.
- [ ] **DIR-07 — Locked decisions.** Regeneration preserves user-locked
  statements and visibly diffs all proposed changes.
- [ ] **DIR-08 — Product goals.** Goals can carry priority, horizon, success
  signal, constraints and relationships to repositories/fronts.
- [ ] **DIR-09 — Product vocabulary.** The glossary feeds analysis and planning
  while preserving aliases and unresolved ambiguity.
- [ ] **DIR-10 — Manual path.** A user can author and maintain all product
  direction without invoking a model.

## B. Repository intelligence platform

- [ ] **INT-01 — Optional analysis.** Repository initialization and later
  planning can skip analysis entirely or start an explicitly selected analyzer.
- [ ] **INT-02 — Read-only invariant.** Analysis creates, modifies and deletes
  nothing in the target repository, including ignored files, hooks, Git config
  and metadata; automated mutation sentinels verify this.
- [ ] **INT-03 — Analyzer registry.** An analyzer-neutral registry reports each
  adapter's availability, version, capabilities, privacy boundary and limits.
- [ ] **INT-04 — Snapshot identity.** Every result identifies the exact included
  content, Git/dirty state, exclusions, analyzer version and configuration.
- [ ] **INT-05 — Mid-scan drift.** A repository changed during analysis is marked
  stale or retried; mixed-state output is never presented as coherent.
- [ ] **INT-06 — Bounded scope.** File count, byte, time, process, output and
  recursion limits have safe defaults and visible diagnostics.
- [ ] **INT-07 — Safe exclusions.** Secrets, VCS internals, ignored/generated
  content, dependency caches, binaries and symlink escapes are excluded by
  default with reviewable overrides.
- [ ] **INT-08 — Normalized graph.** Adapters produce validated entities,
  relations, evidence, provenance, coverage, findings and diagnostics through a
  stable Handraise contract.
- [ ] **INT-09 — Honest capabilities.** Unsupported languages and missing
  relation kinds appear as uncovered areas, not low-quality invented facts.
- [ ] **INT-10 — Evidence navigation.** A user can move from a claim or relation
  to the current source location and see stale/missing evidence states.
- [ ] **INT-11 — Provenance.** Extracted, inferred and human-declared facts are
  visually and programmatically distinguishable.
- [ ] **INT-12 — Cancellation and cleanup.** Analysis exposes progress and
  cancellation and cleans every temporary process/artifact on all terminal
  paths.
- [ ] **INT-13 — Private derived state.** Graphs, drafts and logs live in private
  local storage with visible retention/deletion controls, not in the repository
  by default.
- [ ] **INT-14 — Baseline fallback.** Bounded built-in inspection remains usable
  when no rich analyzer exists and labels its reduced semantic coverage.
- [ ] **INT-15 — Repeatable query API.** Planning and UI can issue bounded
  entity, dependency, path, neighborhood, evidence and diff queries against an
  immutable snapshot.
- [ ] **INT-16 — Change coupling.** When Git history is available, analysis can
  identify co-change evidence without treating correlation as ownership.
- [ ] **INT-17 — Runtime topology.** When detectable, the map distinguishes
  deployables, entry points, interfaces, data stores, tests and external systems.
- [ ] **INT-18 — Dirty-tree fidelity.** The selected current working-tree content,
  including explicitly included untracked files, is analyzed without requiring
  a commit or changing the index.

## C. Graphify adapter

- [x] **GRA-01 — Explicit detection.** Handraise detects a compatible Graphify
  installation/version and never installs or modifies it implicitly.
- [x] **GRA-02 — Isolated execution.** Graphify output is redirected to private
  Handraise storage or produced from an isolated mirror; no `graphify-out/` or
  equivalent reaches the target repository.
- [x] **GRA-03 — Compatibility validation.** Input and output schemas are pinned,
  validated and rejected with actionable diagnostics when incompatible.
- [x] **GRA-04 — Provenance preservation.** Extracted, inferred and ambiguous
  Graphify relationships retain their meaning after normalization.
- [x] **GRA-05 — Process safety.** Invocation avoids shell interpolation and
  enforces timeout, resource caps, cancellation and process-tree cleanup.
- [x] **GRA-06 — Local default.** Deterministic local parsing is the default;
  model-assisted semantic analysis is a separately consented capability.
- [ ] **GRA-07 — Explicit data boundary.** Before model-assisted analysis, the
  user sees provider, files/data in scope and retention implications.
- [x] **GRA-08 — Graceful degradation.** A Graphify failure can offer baseline
  analysis without mislabeling output or losing diagnostics.
- [ ] **GRA-09 — Incremental compatibility.** Supported Graphify updates can
  refresh a snapshot while preserving snapshot identity and change provenance.

## D. Semantic system map

- [x] **MAP-01 — Responsibility map.** Handraise groups structural evidence into
  candidate responsibilities without equating folders with components.
- [x] **MAP-02 — Multiple lenses.** Users can inspect domain, deployable,
  dependency, data-flow, test and change-coupling views where evidence supports
  them.
- [x] **MAP-03 — Coverage view.** Mapped, excluded, unsupported, ambiguous and
  stale portions of the repository are explicit.
- [x] **MAP-04 — Explainable grouping.** Every suggested cluster explains the
  evidence and trade-offs that formed it.
- [x] **MAP-05 — Query and search.** Users can find entities/responsibilities and
  trace dependencies without reading a raw graph dump.
- [x] **MAP-06 — Scale controls.** Progressive loading, aggregation and bounded
  queries keep large repositories usable.
- [x] **MAP-07 — Snapshot comparison.** Users can compare maps and distinguish
  code movement, analyzer changes and changed inference.
- [x] **MAP-08 — Export without authority.** A map/report can be exported for
  review while remaining explicitly derived rather than accepted truth.

## E. Component architecture design

- [x] **CMP-20 — Product-aware synthesis.** Component proposals combine current
  analysis with accepted/selected product intent and identify conflicts between
  the two.
- [x] **CMP-21 — Alternative decompositions.** When boundaries are genuinely
  ambiguous, Handraise offers meaningful alternatives and their trade-offs
  instead of one falsely certain answer.
- [x] **CMP-22 — Complete v2 contract.** Each proposal includes purpose,
  outcomes, responsibilities, limits, invariants, interfaces, dependencies,
  data, territory, verification, evidence, uncertainty and agent guidance.
- [x] **CMP-23 — Boundary questions.** The planner asks focused human questions
  when a product decision—not more code scanning—would resolve an architecture
  ambiguity.
- [x] **CMP-24 — Quality critique.** Proposals report responsibility coverage,
  overlap, cohesion, coupling, cycles, orphan areas and unstable boundaries.
- [x] **CMP-25 — Review operations.** Users can edit, lock, reorder, split, merge,
  delete, compare, regenerate and skip proposals without mutation.
- [x] **CMP-26 — Evidence and uncertainty.** Every generated responsibility and
  boundary is supported by evidence or explicitly identified as an assumption.
- [x] **CMP-27 — Stable regeneration.** A no-op reanalysis does not arbitrarily
  rename or reshuffle accepted/staged boundaries; material changes are explained.
- [x] **CMP-28 — Manual parity.** Manually authored contracts support every field
  and validation available to generated contracts.
- [x] **CMP-29 — Cross-reference validation.** Interfaces, dependencies,
  territory and shared responsibilities reference valid entities/components or
  remain explicit unresolved questions.
- [x] **CMP-30 — Existing-repo evolution.** The designer can propose changes to
  an initialized repository as a diff without overwriting current contracts.

## F. Front and portfolio design

- [x] **FRO-20 — Goal-to-front planning.** A selected product goal and component
  model can produce a set of outcome-oriented fronts rather than file/task
  fragments.
- [x] **FRO-21 — Complete v2 contract.** Every proposed front contains outcome,
  lead component, affected components, motivation, scope/non-goals,
  dependencies, readiness, acceptance, verification, deliverables, risks,
  unknowns, evidence and ordered checklist.
- [x] **FRO-22 — Single lead ownership.** Each front has exactly one lead
  component while explicitly recording cross-component impact.
- [x] **FRO-23 — Dependency DAG.** Dependencies are cycle-checked, explainable
  and distinguish hard readiness from informational/coordination relationships.
- [x] **FRO-24 — Parallelism view.** Handraise identifies ready work, critical
  path, safe concurrency and ownership collisions without allocating worktrees.
- [x] **FRO-25 — Plan alternatives.** Meaningful sequencing or slicing choices
  can be compared by outcome, risk, dependency and feedback speed.
- [x] **FRO-26 — Review operations.** Users can edit, lock, split, merge, remove,
  reorder, regenerate or manually add fronts and checklist items.
- [x] **FRO-27 — Verification planning.** Acceptance evidence and checks are
  defined before execution; “agent says done” is not completion.
- [x] **FRO-28 — Discovery routing.** Unknowns can become explicit research,
  decision or implementation fronts rather than hidden checklist assumptions.
- [x] **FRO-29 — Plan-wide validation.** The full portfolio reports uncovered
  goals, duplicate outcomes, invalid references, cycles and fronts too broad to
  verify.
- [x] **FRO-30 — Replanning.** A user can revise queued work after discoveries
  while preserving completed evidence and accepted decisions.

## G. Draft review and publication

- [x] **PUB-01 — Draft isolation.** Product, component and front proposals stay
  outside repository state until an explicit acceptance operation.
- [x] **PUB-02 — Whole-plan review.** Users can inspect a textual and graphical
  diff of every file and relationship that acceptance would create/change.
- [x] **PUB-03 — Selective acceptance.** Users can accept only product/components,
  defer fronts, or publish an explicitly selected complete workspace.
- [x] **PUB-04 — Final revalidation.** Adapter, fingerprint, schema, slugs,
  references, dependencies and destination conflicts are rechecked immediately
  before writing.
- [x] **PUB-05 — Serialized atomicity.** One repository-scoped writer stages the
  full accepted set on the same filesystem and publishes all-or-nothing.
- [x] **PUB-06 — No implicit overwrite.** Existing files or changed baselines
  yield a recoverable conflict and require a newly reviewed diff.
- [x] **PUB-07 — Failure recovery.** Cancellation, crash and partial I/O leave
  accepted repository state unchanged and remove/recover staging safely.
- [x] **PUB-08 — Audit record.** Accepted publication records human action,
  proposal/analyzer versions and source snapshot without storing secrets or a
  required opaque transcript.
- [x] **PUB-09 — Director safety.** Director-backed repositories use only
  validated Director capabilities; unsupported publication remains read-only.
- [x] **PUB-10 — V1 compatibility.** Existing files remain readable and V2 edits
  preserve unknown frontmatter/sections through tested migration paths.

## H. Planning-model capabilities

- [x] **MOD-01 — Provider-neutral contract.** Planning operations use declared
  model/tool/structured-output/context capabilities rather than provider names.
- [x] **MOD-02 — Existing authentication.** Supported integrations reuse
  first-party authentication or explicit provider configuration without copying
  credentials into Handraise/repositories.
- [x] **MOD-03 — Bounded context.** The planner prefers graph queries and selected
  evidence over an automatic unbounded repository upload.
- [x] **MOD-04 — Structured validation.** Model output is schema-validated;
  bounded repair is allowed but invalid output never becomes a draft contract.
- [x] **MOD-05 — Claim grounding.** Generated claims cite evidence/intent or are
  marked as assumptions/questions.
- [x] **MOD-06 — Operation controls.** Jobs expose provider/model, progress,
  timeout, cancellation, retry and usage/cost metadata where available.
- [x] **MOD-07 — Prompt-injection boundary.** Repository text is untrusted data
  and cannot authorize tools, mutate state, expose secrets or execute commands.
- [x] **MOD-08 — Deterministic/manual fallback.** Failure or absence of a model
  leaves maps and manual planning usable with explicit limitations.

## I. Understand → Design → Run experience

- [ ] **UX-20 — Guided entry.** Initialization asks for repository, product
  context and optional analysis in an order that explains consequences before
  work starts.
- [ ] **UX-21 — Three-mode navigation.** The primary information architecture
  makes Understand, Design and Run visible while preserving quick fleet access.
- [ ] **UX-22 — Job states.** Analysis/planning clearly distinguish queued,
  running, awaiting input, stale, cancelled, failed and complete.
- [ ] **UX-23 — Progressive results.** Long jobs expose useful progress and
  diagnostics without presenting incomplete output as accepted truth.
- [ ] **UX-24 — Evidence everywhere.** Maps, components and fronts provide a
  consistent route to evidence, provenance and uncertainty.
- [ ] **UX-25 — Decision workspace.** Questions, alternatives, locked decisions
  and pending conflicts are reviewable in one place.
- [ ] **UX-26 — Plan graph.** Users can inspect goals, components, fronts,
  dependencies, readiness and runs without losing a readable list/text view.
- [ ] **UX-27 — Honest empty/error states.** Missing Graphify/model/auth/context
  and partial language support have actionable, non-inflated messages.
- [ ] **UX-28 — Responsive/accessibility parity.** Core understand/design/run
  actions are keyboard accessible and usable on supported desktop/mobile PWA
  layouts.
- [ ] **UX-29 — Resume.** Draft analysis and planning can safely resume after a
  browser reconnect/server restart when retained, with staleness revalidation.
- [ ] **UX-30 — Local/remote parity.** Authenticated remote clients can perform
  allowed planning operations; only the implicit server-host client can approve
  host-sensitive setup/data-boundary actions when required.
- [x] **UX-31 — Guided repository home.** Opening a repository starts on a
  plain-language vertical guide with one recommended next action, current
  delivery context and compact Understand, Design and Run entry points instead
  of opening a dense specialist dashboard.
- [ ] **UX-32 — Progressive disclosure.** Outcome, state, next action, related
  entities and recovery precede evidence, revisions, paths, raw diagnostics and
  advanced commands on every core detail screen.
- [x] **UX-33 — Hyperlinked work graph.** Release, front, component, run,
  worktree and session relationships are directly navigable through canonical
  URLs or an honest contextual target; normal browser history, copy-link and
  open-in-new-tab behavior remain available.
- [x] **UX-34 — Vertical delivery model.** The repository client explains and
  navigates release → front → run → worktree/session vertically while linking
  each front to its component owner and never presenting sessions as progress.
- [ ] **UX-35 — Mobile-first operational parity.** Core planning, release,
  worktree and agent-control decisions are designed from a single-column 320px
  viewport upward, use at least 44px touch targets, require no hover or wide
  table, respect safe areas and retain the same safety authority as desktop.

## J. Plan-driven agent execution

- [x] **RUN-20 — Run manifest.** Starting a front snapshots its accepted front,
  component, dependencies, territory, checks, repository revision and agent
  capability requirements.
- [x] **RUN-21 — Readiness gate.** Hard dependencies, stale contracts, active
  conflicts, unsafe Git state and missing capabilities block start with a clear
  recovery path.
- [x] **RUN-22 — Explicit start.** Plan generation never starts an agent,
  worktree, tunnel, external write or paid model operation implicitly.
- [x] **RUN-23 — Context fidelity.** Agents receive the accepted outcome,
  boundaries, decisions, evidence and verification contract with source
  revisions.
- [x] **RUN-24 — Safe concurrency.** Recommended parallel runs respect component
  ownership, dependency and worktree/branch isolation constraints.
- [x] **RUN-25 — Outcome status.** Progress separates process activity, checklist
  claims, checks and accepted completion.
- [x] **RUN-26 — Verified checklist updates.** Handraise marks plan tasks complete
  only from a user action or configured verifiable evidence, preserving who/what
  supplied it.
- [x] **RUN-27 — Discovery capture.** Agents/users can attach discoveries,
  blockers, decisions and scope changes to the run for downstream review.
- [x] **RUN-28 — Safe handoff/resume.** A different supported agent can resume a
  run with explicit context and worktree state, without pretending continuity
  of hidden conversation state.
- [x] **RUN-29 — Completion gate.** Front completion checks acceptance criteria,
  required verification and repository risk before lifecycle transition.
- [x] **RUN-30 — Existing runtime parity.** Attention, typed permissions, live
  terminal, graceful wrap-up, worktree safety and cleanup remain available in
  plan-driven runs.

## K. Reconciliation and learning

- [x] **REC-01 — Incremental refresh.** Handraise can create a new snapshot after
  code changes and report added, removed and changed evidence.
- [x] **REC-02 — Architecture drift.** It detects boundary crossings, orphan or
  overlapping responsibility, stale territory and new interfaces/deployables.
- [x] **REC-03 — Planning drift.** It identifies fronts invalidated by upstream
  discoveries, changed contracts or repository state.
- [x] **REC-04 — Outcome reconciliation.** Completed runs are compared with their
  acceptance/verification contract and resulting code evidence.
- [x] **REC-05 — Proposed updates only.** Drift and run discoveries generate
  reviewable changes; no accepted brief/component/front is silently rewritten.
- [x] **REC-06 — Decision memory.** Dismissed, deferred and accepted findings
  retain rationale so unchanged evidence does not repeatedly create noise.
- [x] **REC-07 — Staleness propagation.** Changed evidence marks dependent maps,
  proposals and queued fronts stale with explainable scope.
- [x] **REC-08 — Learning evaluation.** Feedback can improve ranking/prompts and
  benchmark cases without uploading source or treating acceptance as universal
  truth.

## L. Multi-repository product planning

- [ ] **MUL-01 — Product repository set.** A product brief can reference multiple
  connected repositories and assign each an explicit role.
- [ ] **MUL-02 — Cross-repository map.** Declared and observed interfaces can be
  mapped with evidence and uncertainty while retaining repository-local graphs.
- [ ] **MUL-03 — Cross-repository goals.** One goal can produce coordinated
  fronts across repositories; each front has exactly one repository and lead
  component.
- [ ] **MUL-04 — Dependency orchestration.** Cross-repository dependencies affect
  readiness without bypassing either repository's locks/adapters.
- [ ] **MUL-05 — Partial availability.** Offline, inaccessible or unsupported
  repositories appear as missing context rather than disappearing from plans.
- [ ] **MUL-06 — Product portfolio view.** Users can inspect outcomes, fronts,
  readiness, runs, drift and risk across the full product and drill into a repo.

## M. Trust, evaluation and operations

- [ ] **QOS-01 — Zero-mutation suite.** Every analyzer and failure/cancellation
  path passes repository before/after content, metadata, Git-index and hook
  sentinels.
- [ ] **QOS-02 — Evidence integrity.** All accepted/generated evidence references
  resolve against their snapshot or are explicitly stale/missing.
- [ ] **QOS-03 — Planning benchmark.** A versioned corpus and blind expert rubric
  measure usefulness, coverage, cohesion, overlap, stability and uncertainty.
- [ ] **QOS-04 — Hard plan invariants.** Published plans have valid schemas,
  unique slugs, one lead per front, valid references and no hard-dependency cycle.
- [ ] **QOS-05 — Adversarial corpus.** Tests cover malicious repo text, symlink
  escape, huge/binary/generated trees, secrets, malformed analyzer output,
  command injection and resource exhaustion.
- [ ] **QOS-06 — Operational observability.** Jobs expose structured duration,
  stage, analyzer/model version, cancellation/failure class and resource use
  without logging source/secrets by default.
- [ ] **QOS-07 — Crash recovery.** Server restart recovers or safely expires jobs,
  drafts, locks and staging without corrupting accepted state.
- [ ] **QOS-08 — Performance budgets.** Fixture classes define analysis, query,
  map rendering and plan-generation budgets with regression gates.
- [ ] **QOS-09 — Accessibility/security regression.** New intelligence and
  planning paths join browser, API authorization, CSRF, host-spoofing and
  accessibility test suites.
- [ ] **QOS-10 — Release truthfulness.** UI/docs expose analyzer/provider limits,
  experimental capabilities and benchmark version; marketing does not claim
  semantic certainty or autonomous product understanding.

## N. Releases and ad-hoc work

- [ ] **RLS-01 — First-class release contract.** A repository can define a
  human-readable release with one observable delivery outcome, version/name,
  lifecycle, selected requirement IDs, exact front revisions and target branch.
- [ ] **RLS-02 — Release assembly.** Users can create a release from ready fronts,
  add/remove/reorder them and see affected components, dependencies, critical
  path, uncovered requirements and ownership conflicts before acceptance.
- [ ] **RLS-03 — Single membership authority.** One canonical release contract
  owns target membership; a front belongs to at most one open release at a time,
  while released history preserves the exact prior association.
- [ ] **RLS-04 — Release lifecycle.** Draft, ready, active, blocked, candidate,
  released and cancelled states have explicit legal transitions and reasons.
- [ ] **RLS-05 — Requirement and test gate.** Readiness requires every selected
  requirement to have acceptance criteria and required tests; candidate/released
  state requires current passing evidence with no skipped, todo or stale result.
- [ ] **RLS-06 — Cumulative regression.** A candidate reruns its own gates and all
  prior supported release gates; later capability cannot silently weaken an
  earlier invariant or support envelope.
- [ ] **RLS-07 — Exact candidate identity.** Candidate evidence binds source,
  accepted contracts, run outcomes, dependency/tool versions, artifact digest
  and measurement profile so a development server cannot impersonate it.
- [ ] **RLS-08 — Compatibility and change record.** A release records migrations,
  compatibility bounds, known limitations, user-visible changes and recovery or
  rollback guidance before release.
- [ ] **RLS-09 — Release observability.** The client exposes release progress by
  requirement/front/gate, explains every blocker and drills into exact evidence
  without equating active sessions with delivery progress.
- [ ] **RLS-10 — Repository-local authority.** Initial releases are atomic within
  one repository. Multi-repository releases remain a later coordinated contract
  that preserves each repository's independent lock and publication authority.

- [ ] **ADH-01 — Explicit ad-hoc start.** A user can start an unplanned run without
  a front or release from a clearly separate action, with required purpose,
  repository, agent and workspace/isolation choice.
- [ ] **ADH-02 — Optional component context.** An ad-hoc run may select a component
  for useful territory/guidance, but that association does not create a front,
  satisfy a requirement or add release progress.
- [ ] **ADH-03 — Equal safety.** Ad-hoc work uses the same authentication,
  capability, terminal, permission, Git/worktree, stop, recovery and cleanup
  boundaries as planned runs.
- [ ] **ADH-04 — Separate lifecycle and metrics.** Ad-hoc runs are visibly labeled
  and reported outside release/front throughput, readiness and completion.
- [ ] **ADH-05 — Durable outcome.** Purpose, sessions, changes, discoveries,
  checks, handoff and terminal outcome remain inspectable even without a front.
- [ ] **ADH-06 — Explicit promotion.** Discoveries or changes can propose a new
  front, attach a proposal to an existing front or enter a release review, but
  never retroactively rewrite the run as planned or mutate accepted contracts.
- [ ] **ADH-07 — Candidate classification.** A release candidate surfaces commits
  or changed files produced by ad-hoc/unattributed work and requires explicit
  inclusion, exclusion or follow-up classification.
- [ ] **ADH-08 — System-session distinction.** Agent login/setup, diagnostics and
  maintenance sessions have explicit system roles and are not counted as either
  planned delivery or ad-hoc product work.
