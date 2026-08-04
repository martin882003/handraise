# Repository Intelligence contract v1

**Status:** implemented contract

**Runtime module:** `src/intelligence/contracts.mjs`

**Query consumer:** `src/intelligence/memory-query.mjs`

## Purpose

This contract is the boundary between repository analyzers and every Handraise
consumer. Built-in inspection, Graphify and future adapters can have different
internal graphs, languages and confidence models; planners and clients consume
only the normalized Handraise snapshot.

The contract represents **observed truth**. It cannot create or update product,
component or front contracts, start agents, execute generated commands or imply
that an inference was accepted by a human.

## Compatibility

- Current `schemaVersion` and analyzer `contractVersion`: `1`.
- Readers reject unsupported versions with `INCOMPATIBLE_SCHEMA`.
- Provider-specific/additive information belongs under validated JSON
  `extensions` or `attributes`; consumers must not require it for core behavior.
- Snapshot identity does not include generated findings. It identifies the
  repository content, adapter, analyzer version and analysis configuration that
  produced them.
- Serialized snapshots are validated and normalized before use. Invalid JSON,
  unsafe paths, duplicate IDs, broken references and identity mismatches are
  typed failures, not partial best-effort reads.

## Snapshot identity

`AnalysisSnapshot.id` is SHA-256 over:

1. contract version;
2. repository ID and repository adapter;
3. normalized content-manifest digest;
4. analyzer ID and version;
5. analysis-configuration digest.

File and configuration key order do not affect identity. A content change,
selected untracked-file change, analyzer update or configuration change does.
`createdAt`, findings and rendering order do not.

## Content manifest

The manifest is an immutable, sorted declaration of what was analyzed:

```text
ContentManifest
  files[]
    path          safe repository-relative POSIX path
    digest        lowercase SHA-256 of selected content
    size
    source        tracked | untracked | ignored-explicit
    mode? executable?
  git
    head? branch? dirty indexDigest?
  selection
    includeUntracked includeIgnored exclusions[]
  digest
  counts
```

`ignored-explicit` is intentionally named: ignored content is excluded by
default and can enter a snapshot only through a reviewed future scope override.
Absolute paths, empty segments, `..`, NUL and backslash escape are rejected.

The manifest describes a captured input. The analysis runtime is responsible
for re-reading or fingerprinting the target before/after capture and marking a
job stale when the repository changes mid-scan.

## Analyzer descriptor

Every adapter declares:

- stable ID, display name, exact version and contract version;
- supported languages, entity kinds and relation kinds;
- available query kinds;
- history, semantic and incremental capabilities;
- whether it is local-only or model-assisted;
- whether source may leave the host and explicit consent is required.

The validator rejects contradictory privacy claims. `sourceMayLeaveHost` always
requires consent and cannot also be labeled `localOnly`.

An adapter implements:

```text
detect()   availability, version and capability preflight
plan()     selected scope, limits, side effects and consent requirements
analyze()  cancellable production of a validated snapshot
query()    bounded provider or normalized graph query
diff()?    optional incremental comparison
dispose()  deterministic cleanup
```

`diff()` is mandatory when the descriptor advertises incremental capability.
The runtime wrapper binds methods to the validated adapter and rejects missing
required operations before a job starts.

## Normalized snapshot

```text
AnalysisSnapshot
  schemaVersion id repository createdAt
  analyzer configurationDigest status freshness
  manifest scope coverage[]
  entities[] relations[] evidence[] findings[] diagnostics[]
```

### Evidence

Evidence has a stable ID, source kind and provenance:

- `extracted` — directly parsed or read from the selected snapshot;
- `inferred` — analyzer or model conclusion based on evidence;
- `declared` — supplied or accepted by a human/product source.

Optional repository path/range, revision and excerpt hash make evidence
navigable without storing source text in the normalized snapshot. A range
requires a path. Every evidence reference in an entity, relation, finding,
coverage item or diagnostic must resolve inside the same snapshot.

### Entities and relations

Entities have provider-neutral `kind`, `name`, optional location/language and
JSON attributes. Relations identify source/target entities, relation kind,
evidence and optional normalized confidence. Duplicate IDs and unknown relation
endpoints are rejected.

Provider attributes can enrich a UI but cannot change core ownership semantics.
In particular, a Graphify label or graph community is not automatically a
Handraise component.

### Findings and uncertainty

A finding is an evidence-backed hypothesis with entity references, uncertainty
level/reasons and zero or more alternatives. Consumers must present uncertainty
and alternatives; they may not collapse them into an accepted component or
front.

### Coverage

Coverage subjects are `covered`, `partial`, `excluded`, `unsupported` or
`unknown`. An analyzer's unsupported language is therefore a first-class
result, not an empty graph interpreted as “no code”.

### Diagnostics

Diagnostics have stable codes and `info`, `warning` or `error` severity. They
may reference paths/evidence and carry bounded JSON details. A `partial`
snapshot can be useful while still reporting unsupported or failed regions.

## Freshness and lifecycle

Snapshots are immutable and can be `complete` or `partial`. Freshness is a
separate observation:

- `current` — checked against its captured repository state;
- `stale` — known mismatch, with a reason;
- `unknown` — not revalidated.

Analysis jobs use:

```text
queued → running → awaiting-input → running → complete
                    └──────────────→ cancelled | failed | stale
```

Transitions are enforced by the upcoming analysis runtime. This contract
validates job/progress records, timestamps, progress bounds and terminal error
shape. Cancellation is normalized as `CANCELLED`; adapter failures use stable
codes such as `ADAPTER_UNAVAILABLE`, `TIMEOUT`, `LIMIT_EXCEEDED`,
`INVALID_OUTPUT`, `SNAPSHOT_IDENTITY_MISMATCH` and `INCOMPATIBLE_SCHEMA`.

## Bounded graph queries

Consumers use normalized queries rather than a provider query language:

- `entity` — one entity and its direct evidence;
- `search` — bounded ID/name/kind/path search;
- `neighbors` — incoming, outgoing or bidirectional neighborhood;
- `path` — one bounded relation path;
- `evidence` — selected evidence records.

Defaults and hard caps are exported as `GRAPH_QUERY_LIMITS`. V1 limits results
to at most 500 entities, neighbor depth 5, path depth 12 and search text 240
characters. Relation and evidence responses have proportional hard caps.
Results carry the complete normalized query, snapshot ID, truncation state and
diagnostics such as `ENTITY_NOT_FOUND`, `PATH_NOT_FOUND` or
`EVIDENCE_NOT_FOUND`.

`memory-query.mjs` is the first provider-independent consumer. It demonstrates
that a fixture or cached normalized snapshot remains navigable without Graphify
or the existing component-discovery proposal schema.

## Trust boundary

- Repository content is untrusted data.
- Paths are repository-relative and validated before they can reach consumers.
- JSON extensions are depth/shape bounded and cannot contain executable values.
- The normalized contract carries no shell command or mutation operation.
- Source excerpts are represented by hashes/summaries by default, not copied
  wholesale.
- The analysis runtime, not an adapter prompt, owns process, timeout, resource,
  consent and cleanup enforcement.

## Verification

`test/intelligence-contract.test.mjs` covers:

- deterministic identity and dirty/untracked scope;
- immutable serialization round trips;
- unsafe paths, incompatible schemas and stale identities;
- duplicate/broken evidence/entity references;
- privacy/capability and adapter method invariants;
- job, progress, diff and typed cancellation behavior;
- search, entity, evidence, neighborhood and path consumers;
- hard query bounds and missing/stale result diagnostics.
