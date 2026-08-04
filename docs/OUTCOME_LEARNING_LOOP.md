# Outcome learning loop

**Status:** implemented private review loop

**Schema version:** 1

## Objective

Handraise turns durable execution outcomes and reviewed architecture drift into
better planning proposals without silently rewriting product, component or
front contracts. “Learning” means an inspectable change in proposal ranking and
review inputs; it does not mean that an agent claim, one user's acceptance or a
model output becomes universal product truth.

The enforced transition is:

```text
run/check/finding
        │
        ▼
private proposal ──► human decision ──► validated private draft
                                              │
                                              ▼
                              explicit transactional publication
```

No learning API writes `.handraise/product.md`, component Markdown or front
Markdown. Draft routing returns `contractMutation: false` and
`publicationRequired: true`.

## Authority and inputs

Inputs retain their original authority:

- passing configured or user-observed checks from an explicitly accepted run
  are observed verification evidence;
- agent-only check claims are excluded from verified outcome proposals;
- discoveries, blockers, decisions and scope changes recorded during a run are
  declared inputs, not repository facts;
- reconciliation findings keep observed/inferred/declared provenance and enter
  learning only after `accepted-for-planning` review;
- every target carries the exact accepted product/component/front revision that
  existed when its cause was correlated.

Generated changes are bounded to reviewable product assumptions, component
responsibilities/dependencies/territory/evidence/uncertainty/verification,
front scope/readiness/risks/verification, or a complete proposed new front.
Every field change retains before/after digests, a readable before summary,
reason, evidence references, confidence and affected goals/components/fronts/
runs.

## Stable identity, decisions and staleness

A proposal identity hashes repository, cause, exact target and proposed field
changes. Repeating the same cycle increments `occurrences` instead of creating
duplicate noise. Contradictory changes to the same target field remain separate
and lower each other's rank so the disagreement is visible.

Users can:

- dismiss with a retained rationale;
- defer with a retained rationale and optional reconsideration date;
- reopen a prior decision;
- delete a private proposal and its attached feedback;
- route a current exact revision into a normal draft workspace.

An unchanged refresh preserves dismissal/defer memory. A deferred proposal can
reopen after its explicit reconsideration date while keeping the prior
rationale. A changed accepted target revision marks the old proposal `stale`;
stale/expired or changed proposal revisions cannot be routed.

## Existing draft and publication boundaries

Routing deliberately reuses the existing stores and validators:

- product assumptions create a private product-direction draft;
- component changes create a current analysis-backed component-design draft,
  select the current accepted alternative and apply supported changes there;
- front changes first create a current component workspace, then create a
  front-design workspace and apply supported changes to its accepted baseline;
- unowned findings create a complete decision-front candidate with goal,
  ownership, evidence, readiness, acceptance, verification, risks and tasks.

The UI opens the returned product, component or front editor directly. The user
can edit, compare, lock, discard or continue through the same whole-plan
publication review used by every other proposal. If draft validation fails, the
proposal remains open and accepted contracts remain unchanged.

## Local feedback and optional export

Feedback records `useful` or `not-useful`, one bounded reason code and an
optional private rationale. It is inspectable and deletable. On refresh it can
adjust only the local rank for the same cause/target category; it cannot change
evidence authority, confidence provenance, accepted state or publication
validation.

There is no automatic telemetry or upload. Optional benchmark contribution is
a two-step host-only operation:

1. the implicit loopback client selects exact feedback records and purpose;
2. Handraise renders an exact sanitized payload and revision;
3. the user explicitly confirms that revision;
4. the browser downloads JSON locally.

Paired LAN/Internet clients receive `403` for export preview/confirmation.
Export strips source, snippets, paths, credentials, actor identity and free-text
rationale. Confirmation reports `delivery: download-only` and
`networkRequestMade: false`; sending that downloaded file elsewhere remains a
separate user action.

## Authenticated HTTP surface

All routes are repository-scoped and use the normal Handraise authentication
and origin protections:

```text
GET    /api/repositories/:id/learning
POST   /api/repositories/:id/learning
GET    /api/repositories/:id/learning/proposals/:proposal
DELETE /api/repositories/:id/learning/proposals/:proposal
POST   /api/repositories/:id/learning/proposals/:proposal/decision
POST   /api/repositories/:id/learning/proposals/:proposal/route
POST   /api/repositories/:id/learning/proposals/:proposal/feedback
DELETE /api/repositories/:id/learning/feedback/:feedback
POST   /api/repositories/:id/learning/exports/preview
POST   /api/repositories/:id/learning/exports/:preview/confirm
```

`POST .../learning` is an explicit rebuild from current durable runs, accepted
portfolio and reviewed active findings. Run discovery/completion and an
accepted-for-planning reconciliation decision also attempt a private refresh;
failure never rolls back their authoritative durable operation.

## Private storage and bounds

Learning state lives under the server's private state root in `learning/`, not
inside the repository. The directory is forced to mode `0700`; repository-keyed
atomic JSON files are `0600`. Proposals, feedback and export previews have
bounded retention counts, proposals expire, export previews expire after 15
minutes, and disconnecting a repository removes its learning state.

## Verification

The test suite covers:

- accepted completed outcomes versus agent-only claims;
- failed and blocked runs, decisions and scope changes;
- reviewed drift, contradictions, deduplication and repeated refreshes;
- dismissed/deferred rationale and reconsideration;
- stale exact revisions and optimistic route conflicts;
- product, component and front routing through real validated draft stores;
- failed routing without partial proposal or accepted-contract mutation;
- local rank effects, deletion and restrictive filesystem permissions;
- remote export denial, exact host-only confirmation and forbidden-data
  sanitization;
- a headless-browser path from proposal feedback through editor routing and
  local sanitized download;
- the automated planning benchmark after integration.

Independent blind human benchmark review remains a separate release gate. The
learning loop cannot use its own acceptance data to satisfy that gate.
