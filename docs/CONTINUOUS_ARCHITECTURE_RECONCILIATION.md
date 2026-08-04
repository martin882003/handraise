# Continuous architecture reconciliation

**Status:** implemented for repository-local native Handraise planning

Architecture reconciliation closes the loop after analysis, publication and
agent execution. It compares two immutable repository snapshots, explains what
changed, traces affected accepted planning and stores human decisions. It never
edits `product.md`, component contracts, front contracts or source files.

## Boundary

The flow is deliberately split into four authorities:

1. `AnalysisRuntime` creates a private read-only snapshot after the user reviews
   its exact scope.
2. `SystemMapRuntime` computes a deterministic comparison separating content,
   normalized evidence/graph, analyzer/configuration and inferred-group change.
3. `ReconciliationRuntime` derives bounded findings and a private staleness
   overlay over product claims, components, fronts and runs.
4. A human dismisses, defers or accepts a finding for planning. Any actual
   contract change must still be designed, reviewed and committed through the
   transactional publication workflow.

An accepted-for-planning decision records intent only. It is not publication
and has `contractMutation: false` in the API result.

## Refresh lifecycle

Starting a normal reviewed analysis also creates a reconciliation monitor. The
monitor retains the previous completed snapshot as its baseline, mirrors
analysis progress, supports cancellation and compares automatically only when
the new snapshot completes coherently. A first snapshot establishes a baseline.
A cancelled, failed or stale analysis never produces a current reconciliation
cycle.

Successful plan publication and accepted run completion create deduplicated
`pending` refresh recommendations. They do not start an analyzer, modify the
repository or claim that the code changed. The next explicit matching refresh
addresses the recommendation. This keeps source inspection and its resource
cost under user control.

Private reconciliation state uses user-only directories/files (`0700`/`0600`),
atomic replacement, bounded cycle/job/trigger history and time-based retention.
Removing a connected repository removes its reconciliation state.

## Diff and finding model

Each cycle retains the two snapshot/map identities and four independent change
classes:

- selected file content, including digest-backed moves;
- normalized entities, relations and evidence;
- analyzer identity/version/configuration;
- inferred system-map groups.

Findings currently cover:

- accepted evidence or analysis snapshots that became changed/missing;
- digest-preserving files that crossed accepted component territory;
- changed paths with no owner or multiple accepted owners;
- territory patterns that no longer match observed files;
- added/removed deployables, interfaces, data concerns and dependencies;
- active/paused run manifests based on superseded evidence;
- run discoveries, blockers, decisions and scope changes as declared claims;
- accepted completed-run outcomes appearing between snapshots;
- partial/truncated analysis and analyzer-only changes.

Every finding has a content-stable identity, severity, confidence and reasons,
observed/inferred/declared provenance, exact evidence IDs/paths, alternatives,
first/last seen timestamps, occurrence count and affected product/component/
front/run references. Agent discoveries are explicitly `declared`; they are not
promoted to observed repository truth.

Stable identities prevent unchanged evidence from creating duplicate records.
Dismissed, deferred and accepted-for-planning dispositions retain actor,
rationale and optional reconsideration date across later comparisons. A no-op
comparison emits no new finding and does not pretend an older accepted-reference
risk was repaired merely because that reference is absent from both endpoints.

Propagation is conservative and bounded. Exact accepted evidence references,
component territory, front component/evidence/snapshot links, reverse front
dependencies and immutable run manifests are followed for at most three
dependency levels and fixed per-kind budgets. Human/document product sources
are not mistaken for analyzer evidence simply because they are strings.

## Failure and scale behavior

- A partial/truncated snapshot lowers confidence for absence/removal and tells
  the user to refresh with sufficient coverage.
- Analyzer changes remain distinct from content changes; inference-only drift
  is never presented as a code change.
- Missing portfolio or run context is retained as a cycle diagnostic rather
  than silently omitted.
- Per-change and per-cycle budgets bound large diffs. Reaching one emits
  `RECONCILIATION_BUDGET_REACHED` and marks the retained comparison truncated.
- Runtime persistence or map/snapshot errors fail the reconciliation job while
  preserving the private analysis result and accepted repository state.

## Authenticated HTTP surface

All routes use the normal Handraise client boundary:

- `GET /api/repositories/:id/reconciliation`
- `POST /api/repositories/:id/reconciliation/compare`
- `GET /api/repositories/:id/reconciliation/cycles`
- `GET /api/repositories/:id/reconciliation/cycles/:cycleId`
- `GET /api/repositories/:id/reconciliation/findings`
- `POST /api/repositories/:id/reconciliation/findings/:findingId/decision`
- `GET /api/repositories/:id/reconciliation/triggers`
- `GET /api/repositories/:id/reconciliation/jobs`
- `GET /api/repositories/:id/reconciliation/jobs/:jobId`
- `POST /api/repositories/:id/reconciliation/jobs/:jobId/cancel`

The Map view supplies the minimal evidence-first review: refresh/monitor state,
raw snapshot causes, exact paths/IDs, confidence/provenance, traced planning,
alternatives and rationale-bound decisions. It labels accepted contracts as
unchanged throughout the flow.

## Verification

`test/reconciliation.test.mjs` covers no-op stability, file moves, stale
evidence, graph surface/dependency change, analyzer upgrades, partial coverage,
active-run propagation, repeated finding identity and disposition memory,
private persistence, triggers, cancellation and large-diff budgets.

`test/reconciliation-api.test.mjs` covers authentication, evidence/cycle reads,
decision validation and repository byte invariance. Publication and run API
tests assert that their post-success triggers are pending, non-mutating and
deduplicated by the reconciliation store.
