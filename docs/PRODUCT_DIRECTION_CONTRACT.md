# Product Direction contract v1

**Status:** implemented native contract

**Runtime module:** `src/product-direction.mjs`

**Accepted repository file:** `.handraise/product.md`

## Purpose

Product Direction records the truths that source analysis cannot establish:
who the product serves, what outcomes matter, which constraints/non-goals must
hold, which terms mean what and which goals are current.

It remains distinct from:

- repository intelligence, which records observed code evidence;
- repository planning, which proposes components and fronts;
- runtime, which executes accepted work.

Imported/generated direction is proposed truth until a human accepts the exact
Markdown diff.

## Product brief schema

The normalized v1 brief contains:

```text
ProductBrief
  schemaVersion title stage updatedAt
  purpose
  users[] outcomes[] constraints[] invariants[] nonGoals[]
  glossary[] goals[] repositoryRoles[]
  assumptions[] decisions[] conflicts[] sources[]
```

Every statement has a stable ID, source IDs, display order and lock state. Goals
also carry outcome, priority (`now`, `next`, `later`, `unspecified`), horizon,
lifecycle state, success signals, constraint references and repository IDs.
Decisions/conflicts carry open/resolved/dismissed state and rationale.

`source:human` is always available for direct human input. Document sources
record repository-relative path, content digest and selection timestamp.
Unknown source/constraint references, duplicate IDs and incompatible schemas are
rejected before draft persistence or publication.

## Human-readable Markdown

Accepted product direction is normal Markdown with small machine-readable HTML
comments retaining IDs, source links and locks. For example:

```markdown
## Desired outcomes

- [outcome:work-model] A repository has an accepted work model. <!-- handraise:{"sourceIds":["source:human"]} -->
```

The renderer updates known frontmatter and sections while preserving:

- unknown frontmatter keys;
- unknown level-two sections and their content;
- a manually maintained introduction;
- stable IDs and metadata for unchanged entries.

Manual authors can edit the documented bullet format or replace the whole file.
The next read validates it rather than silently dropping malformed content.

Known sections are:

- Purpose
- Users and jobs
- Desired outcomes
- Constraints
- Invariants
- Non-goals
- Glossary
- Goals
- Repository roles
- Assumptions and questions
- Decisions
- Conflicts to resolve
- Sources

## Guided questions

The API/UI derives focused non-blocking questions when purpose, users, outcomes,
constraints/invariants, non-goals or goals are missing. A partial brief remains
valid and can be saved/accepted; downstream planners must surface the resulting
context limitations.

No model is required. The complete brief can be authored manually.

## Private draft lifecycle

Drafts live under:

```text
~/.handraise/product-drafts/<draft-id>.json
```

The directory is mode `0700`; files are mode `0600`. Writes use a sibling
temporary file and atomic rename. Drafts:

- are repository-scoped and authenticated through normal Handraise APIs;
- survive browser disconnect and server restart;
- resume by default for seven days;
- can be explicitly reset/discarded;
- retain their accepted-file baseline hash;
- report stale when the current accepted baseline differs;
- can be edited before repository initialization without creating `.handraise/`.

The accepted file is never a draft dependency: deleting private state cannot
delete accepted product direction.

## Locks

Any purpose/statement/goal/decision can be locked. A changed or removed locked
entry is rejected unless the update names its exact ID in `unlockIds`. Import
merges only new evidence and conflicts, so it cannot rewrite locked content.

The initial UI exposes purpose locking; the typed API/Markdown contract supports
all entry locks. Regeneration/planning consumers must use the same locked-entry
check rather than relying on prompt instructions.

## Selective document import

Only explicitly selected `.md`/`.mdx` files inside the repository can be
imported. Limits are:

- at most 12 documents;
- at most 512 KiB per document;
- at most 2 MiB total.

The client first calls `import-preview`, which resolves paths and returns exact
repository-relative files and byte counts without reading content into the
draft. The user confirms that scope; only then does `import` read and propose
content. Neither operation writes the target repository.

The deterministic v1 importer recognizes purpose/vision, users/personas,
outcomes/success, constraints, invariants/principles, non-goals, glossary and
goal/roadmap headings. Unstructured selected documents become attributed
assumptions rather than invented structured truth.

A differing imported purpose or glossary definition creates an open conflict.
It never replaces the current value. Exact duplicates are deduplicated while
retaining source attribution.

## Source freshness

Document source digests are rechecked when a draft or publication preview is
read. Derived source state is:

- `current` — selected content still matches its digest;
- `stale` — the file content changed;
- `missing` — the selected file no longer exists;
- `unavailable` — it is no longer a safe/readable repository document;
- `unknown` — a connected source cannot currently be revalidated.

Freshness is not written into accepted Markdown because it is derived runtime
state. It remains visible in the review UI and preview so a human decides
whether to re-import, proceed with known stale context or discard it.

## Preview and acceptance

Preview returns:

- draft baseline and current accepted revisions;
- stale/conflict state;
- exact current and proposed Markdown;
- proposed revision;
- current source freshness;
- whether this repository adapter can accept the file.

Acceptance is available only for an initialized native Handraise repository.
This preserves the onboarding order: an uninitialized repository can retain a
private product draft, run read-only component discovery and initialize once,
then publish its brief. Product acceptance does not prematurely create metadata
or disable discovery.

For acceptance:

1. acquire the shared `.handraise/.management-lock`;
2. clean abandoned `product.md.tmp-*` files;
3. re-read and compare the exact baseline hash under the lock;
4. render against the current matching Markdown so unknown content survives;
5. write a same-directory temporary file;
6. atomically rename it to `product.md`;
7. remove the private draft only after publication succeeds.

Concurrent edits produce `PRODUCT_BASELINE_CHANGED`; an active writer produces
`PRODUCT_WRITE_BUSY`. Neither overwrites accepted content, and the draft remains
available for a fresh review.

Director repositories are not mutated through this native path. Product
Direction reports unsupported capability until Director exposes a validated
equivalent helper.

## HTTP surface

All routes require normal Handraise authentication and same-origin protection:

```text
GET    /api/repositories/:repo/product
POST   /api/repositories/:repo/product/drafts
GET    /api/repositories/:repo/product/drafts/:draft
PATCH  /api/repositories/:repo/product/drafts/:draft
DELETE /api/repositories/:repo/product/drafts/:draft
POST   /api/repositories/:repo/product/drafts/:draft/import-preview
POST   /api/repositories/:repo/product/drafts/:draft/import
GET    /api/repositories/:repo/product/drafts/:draft/preview
POST   /api/repositories/:repo/product/drafts/:draft/accept
```

Typed product failures return an error `code`; missing/expired drafts use 404,
baseline/busy/not-initialized conflicts use 409 and invalid contracts/imports use
400.

## Verification

`test/product-direction.test.mjs` covers Markdown round trips, unknown content,
partial guided questions, invalid schemas/metadata, reference validation,
private permissions, restart resume, expiry/discard, scope preview, selective
import, conflicts, lock/unlock, stale sources, zero pre-acceptance mutation,
native publication, abandoned-temp cleanup, concurrent edits, shared locks and
authenticated real HTTP flows.

`test/browser-smoke.test.mjs` verifies the production UI can save/reopen a
private draft, review exact Markdown without mutation and publish only after the
explicit acceptance action.
