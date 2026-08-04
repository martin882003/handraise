# Component architecture designer

**Status:** implemented private architecture workspace

**Draft contract:** schema v1 · component output schema v2

The component architecture designer combines observed system evidence with
declared product intent and turns both into reviewable responsibility
boundaries. It is the bridge between Handraise's first two product modes:
understanding a repository and designing how work should be owned.

The designer does not publish components. Every response and screen identifies
the result as private proposed truth:

> Private draft · nothing published

Accepted `.handraise/components/*.md`, Director contracts, fronts, Git state,
worktrees and running agents remain outside this boundary.

## Inputs and authority

One workspace is bound to:

- one completed immutable analysis snapshot;
- the deterministic semantic map derived from that exact snapshot;
- the accepted product brief when the user includes it;
- the current accepted component/front portfolio, including an empty baseline;
- optionally, one completed and schema-validated `component-design` planning
  result.

The model path is optional. Deterministic synthesis and the complete manual
editor remain available if no planning adapter exists, a provider fails, the
user declines model transfer or a private planning result is deleted.

Snapshot, map, product, portfolio and optional model-result identities form a
stable context digest. A changed product/portfolio, stale snapshot or missing
private source is visible on reopen. A different snapshot cannot be substituted
into an existing workspace.

## Alternative decompositions

The deterministic engine starts with two different hypotheses where the map
supports them:

- **responsibility/dependency:** analyzer communities and dependency-affinity
  neighborhoods are primary; path grouping is only a high-uncertainty coverage
  fallback;
- **deployable/responsibility hybrid:** runtime, deployable, interface and data
  seams anchor boundaries before uncovered responsibilities are filled.

An initialized repository adds the current accepted architecture as an
evolution baseline. A separately consented planning result adds a model
alternative after the same deterministic contract/evidence validation. Exact
duplicate entity assignments are collapsed instead of being presented as
cosmetic choices.

Each alternative explains rationale, strengths, risks and conditions under
which its axis is useful. Comparison reports components added/removed/changed,
exact entity ownership moves and both quality reports. Comparing a generated
alternative to the accepted baseline is the existing-repository evolution diff;
the baseline files are never rewritten here.

## Complete candidate contract and grounding

Every candidate round-trips through the accepted component v2 renderer/parser
and contains:

- purpose and outcomes;
- responsibilities and limits;
- invariants;
- provided/consumed interfaces;
- hard, soft and external dependencies;
- data/external systems;
- territory;
- verification;
- evidence;
- uncertainties/open questions;
- agent guidance.

Every field also has independent grounding:

- normalized evidence IDs;
- accepted product-intent IDs;
- explicit assumptions;
- open questions.

An empty grounding set is invalid. Evidence references must resolve to the
selected snapshot/map, a derived group or an already validated model allowlist.
Non-external component dependencies must resolve inside the same alternative;
member entities must exist in the map. Existing stale evidence is replaced by a
visible snapshot fallback and uncertainty rather than being silently blessed.
Human edits without replacement citations become explicit human-authored
assumptions.

## Human decisions and review operations

Questions are emitted only for choices that can affect ownership, limits,
interfaces, data lifecycle or product priority. Answers are retained across
regeneration, influence the preferred architecture axis where deterministic
interpretation is possible and are attached to affected field grounding on the
next synthesis.

The authenticated workspace supports:

- selecting and comparing alternatives;
- editing every v2 field;
- locking/unlocking individual contract fields with a recorded reason/digest;
- reordering candidates;
- splitting one candidate with an exact, non-overlapping full entity partition;
- merging two or more candidates and redirecting internal references;
- adding a complete manual candidate with generated-validation parity;
- deleting an unreferenced, unlocked candidate;
- answering questions;
- stable regeneration, skip/resume and private-draft deletion.

Renames, splits and merges redirect internal dependencies visibly. Deletion
fails while another component still references the target. Every operation can
carry the current draft revision; stale concurrent revisions receive a typed
`409` conflict instead of overwriting a newer human decision.

Regeneration uses stable IDs, slugs and ordering for a no-op context. It
preserves locked values and answers. Its history records per-strategy component
and entity-move diffs and says explicitly when there was no material boundary
change.

## Quality critique and Gate C

Each alternative reports:

- responsibility/entity coverage and orphan evidence;
- overlapping ownership;
- duplicate responsibility statements;
- internal-relation cohesion proxy;
- cross-boundary coupling;
- component dependency cycles;
- unstable boundaries and source-freshness diagnostics;
- component-v2 portfolio validation diagnostics.

Automated Gate C passes only when there are no hard validation/cycle failures
and at least 80% of selected map entities have an owner. This is a machine
safety/evidence gate, not a claim that the architecture is useful. The roadmap's
blind-human usefulness benchmark remains a separate product-evaluation measure.
When the original map is unavailable, structural edits remain private but mark
quality stale and force Gate C to fail instead of evaluating against an invented
empty graph.

## Private storage and lifecycle

`ComponentDesignDraftStore` persists JSON under Handraise private state, not in
the repository. The directory is mode `0700`, files are atomically replaced at
mode `0600`, IDs are path-safe UUIDs and drafts expire after seven days. Public
responses omit the private evidence/intent/entity validation catalogs.

Repository removal deletes its private architecture drafts. Draft operations do
not execute processes, call models, access the network, allocate worktrees or
write accepted planning metadata. Model execution and consent remain isolated
in the planning runtime; this workspace only imports an already validated
result.

## HTTP surface

- `GET|POST /api/repositories/:id/component-design/drafts`
- `GET|DELETE /api/repositories/:id/component-design/drafts/:draftId`
- `POST /api/repositories/:id/component-design/drafts/:draftId/operations`
- `GET /api/repositories/:id/component-design/drafts/:draftId/compare?left=...&right=...`

All routes use Handraise's authenticated client boundary and same-origin checks
for mutations. A paired remote client may review and operate on a private draft;
it cannot authorize model source egress. Context/result mismatches, fabricated
evidence, stale revisions, invalid partitions, unresolved dependencies and
missing sources fail with typed errors.

## Browser workspace

**Components → Design architecture** opens the responsive evidence-first
workspace. It requires a completed analysis, optionally selects one completed
model result and accepted product direction, and can resume recent private
drafts. Alternative cards expose trade-offs and compact quality; the selected
alternative shows questions, exact comparison, candidate operations, every
contract field and its evidence/intent/assumption trail.

Controls are native buttons, labels, selects, checkboxes and details elements;
the layout collapses from a two-pane reviewer to one column on narrow screens.
The complete manual editor uses the same field and validation contract as
generated candidates. There is intentionally no accept/publish control in this
front.

## Verification

`test/component-design.test.mjs`, `test/component-design-api.test.mjs` and
`test/browser-smoke.test.mjs` verify:

- deterministic/product/model/accepted alternatives and complete v2
  round-trips;
- per-field evidence/intent/assumption integrity and fabricated-evidence
  rejection;
- coverage, overlap, coupling, cohesion, cycle, orphan, instability and Gate C
  diagnostics;
- lock/edit/reorder/split/merge/add/delete/compare/answer/regenerate/skip
  operations;
- exact split partitions and cross-reference safety;
- no-op stability, material regeneration diffs and lock/answer preservation;
- partial/stale/no-product/no-model/source-unavailable/expiry behavior;
- private permissions, optimistic conflicts, authenticated remote APIs and no
  repository mutation;
- the full real-Chrome review journey, complete manual editor and unchanged
  accepted contract bytes.
