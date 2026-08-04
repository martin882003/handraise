# Transactional plan publication

Handraise keeps product direction, component architectures and front portfolios
private until a person accepts one exact publication revision. Publication is
the only boundary that turns those proposals into repository-owned contracts;
it never starts a worktree or an agent.

## Selectable scopes

Every preview names its sources and one explicit scope:

- `components-only` publishes one reviewed component alternative and preserves
  accepted product/front files exactly;
- `product-components` publishes one private product draft plus one reviewed
  component alternative and preserves fronts exactly;
- `complete-plan` publishes one reviewed component alternative and one
  compatible front portfolio, with product inclusion remaining an explicit
  choice.

Absence is never deletion. Removing accepted components or fronts requires the
corresponding deletion option, and removing completed-front evidence requires a
second explicit override.

## Exact review contract

`POST /api/repositories/:id/publications` creates a private, expiring preview.
The preview contains:

- exact before and after bytes for every create, update and delete;
- component dependency and front ownership/goal/dependency changes;
- selected draft IDs and revisions, analysis snapshot/manifest identity and
  analyzer identity;
- complete portfolio diagnostics and Gate C/Gate D results;
- the durable audit file that would be created;
- a revision digest covering the complete reviewed operation set.

Preparing, listing, opening or discarding a preview cannot mutate accepted
repository state. Confirmation must name the exact preview revision and come
from the same authenticated paired client—or the same implicit server-host
authority—that prepared it.

## Final validation

Immediately before writing, while holding the repository management lock,
Handraise rechecks:

- adapter identity and advertised mutation support;
- every selected private source revision;
- the complete analyzed repository scope, including newly added or removed
  files, file bytes/modes and Git identity;
- accepted destination bytes against the reviewed baselines;
- rendered V2 schemas, unique slugs, references, one-lead ownership, lifecycle
  transitions and hard-dependency cycles;
- Gate C and Gate D for the selected alternatives.

A mismatch produces a typed, recoverable conflict. Handraise does not merge or
overwrite the changed destination implicitly; the user prepares and reviews a
new preview.

## Native transaction protocol

For an existing native repository, Handraise:

1. acquires `.handraise/.management-lock` with a process seal;
2. recovers any publication journal left by a dead process;
3. revalidates the complete preview under that lock;
4. stages before/after bytes and a durable journal under
   `.handraise/.publication-transactions/<publication-id>/` on the same
   filesystem;
5. applies per-file atomic replacements/deletes and verifies every result;
6. rolls the whole set back byte-for-byte if any operation fails;
7. durably records `.handraise/publications/<publication-id>.json`, marks the
   private preview committed and removes staging.

For an uninitialized repository, the complete `.handraise` tree—including
product, components, fronts, project metadata and audit—is built as a sibling
directory and exposed with one directory rename. An already-created target is
always a conflict; it is never overwritten.

Commit is idempotent. If the accepted after-state already matches the reviewed
manifest, retry returns the original result. Startup recovery either proves the
whole committed after-state or restores the whole before-state. Conflicting
external edits are preserved and surfaced as `PUBLICATION_RECOVERY_REQUIRED`
rather than guessed away.

## Adapter and compatibility policy

Native V1 Markdown remains readable. V2 updates preserve unknown frontmatter
keys and unknown Markdown sections. Director-backed repositories currently do
not advertise one atomic product/component/front operation, so Handraise returns
`DIRECTOR_PUBLICATION_UNSUPPORTED` and leaves the private workspace untouched.

Publication previews live in private server state with `0700`/`0600`
permissions and bounded retention. The repository audit contains actor
authority, source/analyzer identity, selected scope, artifact revisions and
validation counts, but no credentials, source dump or opaque model transcript.

## Verification

Core and API tests cover exact preview isolation, selective scope, unknown
Markdown preservation, duplicate destinations, stale sources and snapshots,
new files entering scope, manual destination edits, actor/revision conflicts,
live and stale process locks, failure injection around staging/rename/fsync,
rollback, crash recovery, startup recovery, idempotency and honest Director
degradation. The browser smoke covers the complete human review and acceptance
flow against the built UI.
