# Handraise target product architecture

**Status:** target architecture

**Last reviewed:** 2026-08-03

**Product thesis:** [PRODUCT_VISION.md](./PRODUCT_VISION.md)

## Architectural objective

The system must support one explainable state transition:

```text
OBSERVE ──► PROPOSE ──► REVIEW ──► ACCEPT ──► EXECUTE ──► RECONCILE
   │            │           │          │           │            │
read-only     drafts      human      atomic      isolated      suggested
evidence      only        edits      publish     runtime       changes
```

The architecture enforces the arrows. A UI convention or prompt instruction is
not sufficient protection for read-only analysis, explicit acceptance or atomic
publication.

Planned execution is organized as:

```text
product goal
  └─ release (delivery outcome + requirements + gates)
       └─ fronts (planned outcome slices and dependency DAG)
            └─ runs
                 └─ agent sessions

ad-hoc run (declared unplanned purpose; no release progress)
  └─ agent session
       └─ optional reviewed proposal for a future/existing front
```

Components own durable responsibilities across releases. A release cuts across
components by selecting fronts; it does not become another ownership boundary.

## Product layers

### A. Repository Intelligence — observed truth

Owns analyzer adapters, bounded snapshots, structural graphs, semantic
responsibility candidates, evidence, provenance, coverage, uncertainty,
freshness and drift. It never owns accepted component or front definitions.

### B. Product Direction — declared truth

Owns users, desired outcomes, constraints, non-goals, glossary, priorities and
cross-repository product context. It records human decisions that repository
analysis cannot infer.

### C. Repository Planning — proposed and accepted work design

Synthesizes observed and declared truth into component alternatives, component
contracts, fronts and a dependency graph. It owns review, validation and
transactional publication, not source analysis or process execution.

### D. Runtime & Agent Operations — execution truth

Compiles accepted fronts into ready work, worktrees, sessions and agent context.
It owns lifecycle, dependency gates, terminal control, permissions, status and
safe cleanup.

### E. Reconciliation — learning without silent mutation

Compares new analysis and runtime outcomes with accepted contracts and declared
intent. It produces drift findings and proposed changes that re-enter review.

Client Experience presents these layers as one **Understand → Design → Run**
journey. Local Platform & Trust supplies authentication, storage, process and
network guarantees across every layer. Agent Integrations supplies provider
capabilities for both planning and execution.

## State and storage model

### Versioned repository state

Accepted state is Markdown-first and reviewable in Git:

```text
.handraise/
  project.json
  product.md
  components/*.md
  fronts/*.md
  releases/*.md
```

`product.md` is the accepted product brief. Components and fronts remain the
accepted work model. Releases select exact requirement/front revisions and
their delivery gates. Their schemas evolve additively and preserve unknown
frontmatter and sections. A schema migration is explicit, previewable and
rollback-safe.

### Local derived state

Analysis graphs, indexes, model transcripts, draft workspaces and job logs are
not repository truth and do not belong in the target repository by default:

```text
~/.handraise/
  analysis/<repository-id>/<snapshot-id>/...
  drafts/<draft-id>/...
  jobs/<job-id>/...
  learning/<repository-hash>.json
```

Directories are private to the local user. Drafts have an expiry policy and can
be deleted immediately. A repository stores only accepted contracts and small
provenance references, never a required opaque graph database.

### Snapshot identity

Every analysis receives an immutable snapshot ID derived from:

- canonical repository identity and adapter;
- included file paths plus content fingerprints;
- relevant Git state, including dirty/untracked status where included;
- analyzer name, version, configuration and capability set;
- exclusion policy and optional semantic-analysis consent.

If files change during analysis, the job is marked stale instead of claiming a
coherent snapshot. Acceptance revalidates the relevant fingerprint immediately
before publication.

## Analyzer-neutral intelligence contract

No planner or UI depends directly on Graphify's internal schema. Adapters emit a
normalized contract:

```text
AnalysisSnapshot
  id, repositoryId, createdAt, analyzer, analyzerVersion
  status, freshness, capabilities, exclusions, coverage
  entities[], relations[], evidence[], findings[], diagnostics[]

Entity
  id, kind, name, location?, language?, attributes

Relation
  source, target, kind, confidence?, evidenceIds[]

Evidence
  id, sourceKind, path?, range?, revision?, excerptHash?
  provenance: extracted | inferred | declared

Finding
  kind, summary, evidenceIds[], uncertainty, alternatives[]
```

The normalized model must represent at least files, modules, symbols,
dependencies, calls, tests, data stores, deployables, interfaces, documentation
concepts and change coupling when the active analyzer can supply them. Missing
capabilities are reported as missing coverage, not fabricated.

### Adapter interface

Each analyzer implements:

- `detect()` — availability, version and supported capabilities;
- `plan()` — included/excluded scope, expected side effects and consent needs;
- `analyze()` — cancellable job producing a normalized snapshot;
- `query()` — bounded graph/path/evidence queries;
- `diff()` — optional comparison with a prior snapshot;
- `dispose()` — deterministic cleanup of temporary artifacts.

The baseline adapter provides bounded local structural inspection. More capable
adapters can enrich the same contract. Planner behavior degrades explicitly
when evidence is missing.

## Semantic system map

An immutable normalized snapshot can be projected into deterministic module,
deployable, entry-point, interface, data, test, external-system, dependency,
change-coupling and overlapping responsibility lenses. These are derived views,
not accepted components. Every group retains rationale, evidence, provenance,
alternatives, uncertainty and coverage impact; unsupported lenses stay visible.

Queries and browser responses are bounded independently from analyzer output.
Comparison separates code/evidence changes, analyzer changes and changed
inference. Export remains labeled non-authoritative and never writes into the
repository. The implemented schema, limits, HTTP surface and explorer are
specified in [SEMANTIC_SYSTEM_MAP.md](./SEMANTIC_SYSTEM_MAP.md).

## Graphify integration contract

[Graphify](https://github.com/Graphify-Labs/graphify) is the first rich analyzer
adapter, not a hard dependency or source of truth. Its documented model of
nodes, relations and `EXTRACTED` / `INFERRED` / `AMBIGUOUS` provenance is a good
fit for Handraise's evidence model; its CLI and graph outputs remain behind the
adapter boundary. See the official [concepts](https://graphify.com/concepts) and
[documentation](https://graphify.com/docs).

The integration has strict requirements:

1. Detect a compatible installed version; never install a package, skill, hook
   or daemon implicitly.
2. Never let Graphify write `graphify-out/`, `graph.json` or any other artifact
   into the target repository during analysis.
3. Analyze an isolated, read-only snapshot/mirror or invoke a library path whose
   output is redirected to Handraise's private analysis directory. The mirror
   must include the selected dirty working-tree content and prevent symlink
   escape.
4. Execute with an argument vector rather than shell interpolation; impose
   timeout, output, CPU/memory and process-tree cancellation limits.
5. Parse and validate output against a pinned compatibility schema. Preserve
   Graphify provenance while translating it into Handraise's normalized model.
6. Default to deterministic local AST analysis. Any model-assisted analysis of
   source or documentation is a separate, explicit consent step showing scope,
   provider and retention implications.
7. Clean temporary output on success, cancellation and failure. A failed rich
   adapter may offer the baseline analyzer; it must not silently claim the same
   capability or confidence.

The implemented command, compatibility and normalization details live in
[GRAPHIFY_READONLY_ADAPTER.md](./GRAPHIFY_READONLY_ADAPTER.md).

## Product direction contract

The accepted product brief contains:

- product purpose and current stage;
- target users and jobs;
- desired outcomes and success signals;
- current priorities and horizon;
- constraints, invariants and non-goals;
- domain glossary and ambiguous terms;
- known repositories and their product roles;
- unresolved decisions, assumptions and evidence sources.

The brief can be created by a guided interview or imported from selected local
documents and connected systems. Imported claims retain their source and remain
proposals until accepted. Planning can proceed with a partial brief, but it must
surface how missing intent limits the recommendation.

## Work-design contracts

### Component contract v2

A complete component records:

- durable purpose and user/system outcomes;
- owned responsibilities and explicit limits;
- invariants and quality attributes;
- provided/consumed interfaces and dependencies;
- owned data and external systems where relevant;
- code territory as evidence, not identity;
- verification strategy and operational signals;
- repository evidence, uncertainties and open questions;
- agent guidance and delegation constraints.

The proposal engine may offer multiple decompositions—such as domain,
deployable or platform boundaries—and must explain their trade-offs. It tests
coverage, cohesion, coupling, overlap and stability. It can ask the human a
question when product intent changes the correct boundary.

### Front contract v2

A complete front records:

- observable outcome and motivation;
- one lead component and zero or more affected components;
- product goal links and repository evidence;
- dependencies and readiness conditions;
- acceptance criteria, verification commands/signals and deliverables;
- scope, non-goals, risks, unknowns and decisions required;
- ordered checklist and lifecycle state;
- analysis snapshot/provenance references where generated.

Dependencies form a validated DAG. Shared impact does not imply shared
ownership: one component leads each front. A worktree is allocated only when a
front is ready to run.

### Draft planning workspace

Component alternatives, edits and front plans live in a draft workspace. The
user can edit, split, merge, remove, regenerate, compare or skip suggestions.
Regeneration preserves locked human decisions and identifies what changed.

Publication:

1. validates schemas, slugs, references and dependency cycles;
2. revalidates repository adapter, fingerprint and destination conflicts;
3. renders the complete accepted set in a sibling staging directory;
4. fsyncs/renames through one repository-scoped serialized writer;
5. never overwrites an existing contract without an explicit reviewed diff;
6. either publishes the selected set completely or leaves repository state
   unchanged.

The user may publish only components and plan fronts later, or review and
publish a complete component-plus-front workspace in one transaction.

The private component half of this target workspace is implemented in
[`COMPONENT_ARCHITECTURE_DESIGNER.md`](./COMPONENT_ARCHITECTURE_DESIGNER.md).
The private front half is implemented in
[`FRONT_PLANNING_ASSISTANT.md`](./FRONT_PLANNING_ASSISTANT.md), including
goal-grounded alternatives, discovery routing, DAG/readiness/parallelism
validation, complete front-v2 editing and safe replanning. Both deliberately
stop before mutation. Their shared acceptance boundary is implemented in
[`TRANSACTIONAL_PLAN_PUBLICATION.md`](./TRANSACTIONAL_PLAN_PUBLICATION.md): an
exact selectable diff, final under-lock revalidation, same-filesystem durable
staging, rollback/startup recovery, idempotency and a repository audit.

## Planning model architecture

Deterministic code extracts facts; a reasoning model may synthesize hypotheses
and alternatives. The model receives bounded graph queries and selected product
context rather than an unbounded repository dump whenever possible.

Planning model adapters declare:

- provider, model and authentication availability;
- structured-output/tool capabilities;
- context and file-transfer boundary;
- timeout, cancellation and cost/usage metadata;
- supported planning operations and degradation behavior.

Every generated claim must either cite normalized evidence, cite declared
intent, or be labeled as an assumption/question. Invalid structured output is
rejected and can be repaired within bounded retries. Provider credentials remain
owned by first-party CLIs or explicit provider configuration; Handraise does not
copy them into repository state.

The implemented v1 runtime, Codex invocation boundary and explicit Claude Code
non-parity decision are specified in
[PLANNING_MODEL_RUNTIME.md](./PLANNING_MODEL_RUNTIME.md).

## Plan-to-execution compiler

The runtime consumes only accepted fronts. For each ready front it builds a run
manifest containing the front revision, component contracts, dependencies,
allowed territory, verification instructions, repository snapshot and selected
agent capabilities.

Before starting, it checks:

- dependency readiness and absence of a conflicting active run;
- worktree/branch and dirty-state safety;
- agent installation, authentication and capability compatibility;
- stale front/component revisions;
- commands or permissions requiring explicit confirmation.

Handraise recommends concurrency but does not automatically start agents without
an explicit run action. Runtime status is linked back to outcome and checks, not
inferred solely from terminal activity.

This compiler is implemented for native v2 contracts in
[`PLAN_DRIVEN_AGENT_ORCHESTRATION.md`](./PLAN_DRIVEN_AGENT_ORCHESTRATION.md).
Its expiring preflight binds the authenticated actor to exact accepted,
dependency, capability and workspace revisions. It revalidates before and after
workspace allocation, launches only a server-built Claude Code/Codex command,
keeps the immutable manifest separate from process/claim/check state, supports
revisioned cross-agent handoff, and transitions the accepted front only after
non-agent evidence and final process/Git safety gates pass. Director keeps its
legacy session path until it can expose equivalent validated semantics.

## Reconciliation loop

Reconciliation compares a new snapshot and completed run with the accepted
brief, components and fronts. It detects at least:

- files or dependencies crossing accepted boundaries;
- responsibilities with no component or overlapping owners;
- stale territory/evidence references;
- new deployables, interfaces or data stores;
- front discoveries that invalidate downstream assumptions;
- completed code whose acceptance evidence is missing;
- product decisions contradicted by implementation evidence.

Findings become reviewable suggestions. A human may dismiss, defer or accept
them; accepted changes use the same transactional publication path.

The repository-local loop is implemented in
[`CONTINUOUS_ARCHITECTURE_RECONCILIATION.md`](./CONTINUOUS_ARCHITECTURE_RECONCILIATION.md).
It monitors explicitly reviewed analysis jobs, persists stable evidence-first
findings and dispositions privately, propagates bounded staleness through
accepted references/dependencies/run manifests, and records non-mutating
post-publication/post-run refresh recommendations. A stale or failed snapshot
cannot become a current cycle, and accepting a finding for planning never edits
an accepted contract.

The next private boundary is implemented in
[`OUTCOME_LEARNING_LOOP.md`](./OUTCOME_LEARNING_LOOP.md). It correlates exact
run/check outcomes and accepted-for-planning findings with exact accepted
revisions, preserves declared versus observed authority, deduplicates stable
causes and retains dismiss/defer rationale. A proposal can only enter an
existing validated product/component/front draft and still requires explicit
transactional publication. Local feedback changes inspectable rank only;
optional anonymized benchmark capture is a host-only preview-and-download flow
with no automatic telemetry or source transfer.

## Multi-repository architecture

A product can span repositories. The product-level map identifies each
repository's role and cross-repository interfaces while preserving repository
local contracts and locks. Product goals can produce fronts in multiple repos,
but each front remains owned and executed within exactly one repository.
Cross-repository dependencies are orchestration edges, not a reason to create a
shared worktree or bypass either repository's adapter.

## Security and privacy invariants

- Analysis is read-only against the target repository until explicit
  acceptance; tests compare repository contents and metadata before/after.
- Source, snippets and paths do not leave the machine by default.
- Every model-assisted operation shows provider, scope and local/cloud boundary;
  consent is operation-specific and auditable.
- Secrets, VCS internals, dependency caches, generated output and ignored paths
  are excluded by default; overrides are explicit.
- Untrusted repository text is data, not executable instruction. Analyzer and
  planner processes cannot treat repository content as shell commands.
- Local implicit access still requires both loopback socket peer and loopback
  HTTP Host. Intelligence APIs use the same authentication and CSRF boundaries
  as runtime APIs.
- Drafts and caches use private permissions, bounded retention and user-visible
  deletion.
- Acceptance and execution use structured operations; no generated shell string
  is executed as a side effect of planning.

## Compatibility and migration

- Existing native v1 component/front files remain readable.
- V2 writers preserve unknown frontmatter and Markdown sections.
- Migration is additive where possible and previewed before mutation.
- Existing Director repositories remain governed by Director helpers and
  capabilities. Unsupported product-intelligence operations are reported
  honestly rather than emulated with direct Markdown writes.
- The current heuristic component discovery remains a baseline adapter. Its
  existing safe preview/accept workflow is retained, while its semantic
  capability is labeled limited.

## Quality architecture

Three independent things are evaluated:

1. **Understanding quality:** evidence validity, structural coverage,
   provenance fidelity, stale detection and no-mutation guarantees.
2. **Design quality:** responsibility coverage, cohesion, boundary overlap,
   coupling, stability, uncertainty calibration and expert usefulness.
3. **Execution quality:** dependency correctness, plan/context fidelity, safe
   isolation, verification completion and reconciliation accuracy.

The benchmark corpus includes small fixtures, polyglot monorepos, service
collections, libraries, legacy repositories, sparse documentation, misleading
folder layouts, dirty trees, generated code and adversarial repository text.
Hard safety invariants have zero-tolerance gates; model-quality changes use
versioned baselines and blind human review.

The executable contract, corpus, release gate and current limitations are
documented in
[Planning quality evaluation](PLANNING_QUALITY_EVALUATION.md). The checked
sanitized report lives at
[`benchmark/results/latest.md`](../benchmark/results/latest.md); `blocked` is a
first-class result when independent owner ratings are missing.
