# Front planning assistant

**Status:** implemented private front-planning workspace

**Draft contract:** schema v1 · front output schema v2

The front planning assistant turns one reviewed component architecture and one
product goal into a reviewable portfolio of outcome-oriented work. It is the
second half of Handraise's **Design the work** mode: components establish durable
responsibility boundaries; fronts establish feedback, readiness and execution
boundaries inside that model.

The assistant never publishes contracts, creates worktrees or starts agents.
Every screen and response carries the same authority statement:

> Private plan · no execution allocation

## Inputs and authority

One workspace is bound to:

- one private component-design draft and one exact alternative/revision;
- the immutable analysis snapshot and semantic map behind that architecture;
- one accepted product goal, or one explicit partial/manual goal;
- the current accepted component/front portfolio when it exists;
- optionally, one completed, schema-validated `front-design` planning result.

The component model can remain private: users do not have to publish a flawed
intermediate architecture merely to plan fronts. Source IDs, revisions and a
stable context digest are retained. Changed product direction, accepted
portfolio, component draft, component selection or snapshot freshness marks the
workspace stale. A missing model result degrades to deterministic/manual
planning; a missing component/map source prevents regeneration but does not
erase the private review record.

## Alternatives and discovery routing

The deterministic engine creates two materially different plans:

- **parallel outcome slices** assign independently reviewable outcomes to
  component leads, represent component relationships as coordination edges and
  join accepted evidence in a product-level validation front;
- **risk-first vertical proof** resolves the highest-impact boundary question,
  proves one thin cross-component journey and validates that feedback before
  expanding throughput.

When architecture uncertainty is evidenced, the plan creates an explicit
decision front rather than hiding the question in an implementation checklist.
Research, decision, implementation, validation and migration are distinct
candidate kinds. An initialized repository contributes a current-portfolio
baseline; completed fronts and their evidence are fully locked. A valid optional
model result is a fourth alternative and passes the same reference, schema, DAG
and quality checks. Invalid model proposals are rejected without losing the
deterministic paths.

## Complete front contract and grounding

Every candidate round-trips through the front-v2 Markdown renderer/parser and
contains:

- observable outcome, motivation and bounded scope/non-goals;
- exactly one lead component and explicit affected components;
- product-goal and analysis-snapshot references;
- hard, coordination and informational dependencies, each with a reason;
- readiness, acceptance criteria and feasible verification evidence;
- deliverables, risks and separately represented unknowns;
- normalized evidence, confirmed context and handoff;
- an ordered checklist and lifecycle state.

Every field independently records evidence IDs, goal IDs, component slugs,
assumptions and questions. An empty grounding set is invalid. Evidence and
component references are allowlisted against the selected source context.
Verification is copied only from observed/accepted component evidence; when no
check exists, the candidate says that one must be resolved before readiness
instead of inventing a command. Human edits and answers remain explicit human
decisions in field grounding.

## DAG, readiness and quality

Only `hard` edges gate readiness. `coordination` and `informational` edges stay
visible without falsely serializing work. Every edge requires a target and
rationale. The whole-plan evaluator reports:

- selected-goal coverage and uncovered goals;
- invalid front/component/goal references;
- hard-dependency cycles and duplicate outcomes;
- the current ready set and critical path;
- safe concurrency pairs;
- shared component/territory collisions;
- fronts too broad or vague to verify;
- explicit risk and unknown counts.

Automated Gate D passes only for a non-empty portfolio with no hard reference or
cycle failures and no broad/unverifiable fronts. It is a deterministic
executable-plan gate, not a claim that the plan is useful; blind human quality
evaluation remains a separate roadmap concern.

## Review and replanning operations

The authenticated workspace supports selecting/comparing alternatives, editing
every front-v2 field, field lock/unlock, reorder, exact checklist partition on
split, merge with reference redirection, complete manual add, safe delete,
question answers, regenerate, skip/resume and private deletion. Stable IDs,
slugs and ordering survive no-op regeneration. Regeneration records material
front/edge changes and preserves answers and locked values.

Completed accepted fronts are immutable in replanning. Queued work can evolve,
but completed evidence and accepted decisions cannot be silently rewritten.
Every operation accepts the current draft revision; concurrent stale revisions
return a typed `409` conflict.

## Private storage and HTTP surface

`FrontPlanningDraftStore` uses a mode-`0700` Handraise state directory and
atomic mode-`0600` JSON files with a seven-day TTL. Public responses omit private
validation catalogs. Repository removal deletes its private planning drafts.

- `GET|POST /api/repositories/:id/front-design/drafts`
- `GET|DELETE /api/repositories/:id/front-design/drafts/:draftId`
- `POST /api/repositories/:id/front-design/drafts/:draftId/operations`
- `GET /api/repositories/:id/front-design/drafts/:draftId/compare?left=...&right=...`

All endpoints use Handraise authentication and same-origin mutation checks. A
paired client may review a draft; only the implicit server-host client can
authorize the separate model-egress preflight that produced an optional result.

## Browser workspace

The workspace opens either from **Components → Plan fronts** or directly from
**Plan fronts from this architecture**. It supports accepted and partial/manual
goals, optional validated model results and recent draft resume. The selected
alternative presents trade-offs, questions, Gate D, ready work, critical path,
the dependency graph, safe concurrency/collisions, exact comparison and every
field's evidence/intent/uncertainty trail. The complete manual editor and all
review operations collapse to one column on narrow screens.

There is intentionally no publish or run control inside this boundary.
Transactional publication must revalidate the selected component/front
workspace as one conflict-safe operation before accepted Markdown exists.

## Verification

`test/front-design.test.mjs`, `test/front-design-api.test.mjs` and
`test/browser-smoke.test.mjs` verify deterministic/model/accepted/manual paths,
front-v2 round trips, field grounding, DAG/readiness/critical-path/concurrency
quality, every review operation, exact split partitions, optimistic conflicts,
stable regeneration, answer/lock preservation, immutable completed evidence,
stale/partial/missing/expiry behavior, private permissions, authenticated HTTP
and unchanged accepted bytes through the full real-Chrome journey.
