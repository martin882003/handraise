# Semantic system map

**Status:** implemented deterministic derived-map contract and explorer

**Contract:** schema v1 · algorithm `1.0.0`

The system map turns one immutable normalized analysis snapshot into bounded,
explainable views of the repository. It is intentionally a derived artifact:
it does not create components, alter planning contracts or claim that a graph
community is an ownership boundary.

Every response carries this authority statement:

> This map is derived analysis, not accepted repository planning truth or a
> component definition.

## Derivation boundary

`src/intelligence/system-map.mjs` consumes only a validated
`AnalysisSnapshot`. It does not read the live repository, invoke an analyzer,
call a model, access the network or write local/repository state. The map ID is
stable over the source snapshot ID, algorithm version and exact derivation
limits. Repeating derivation over the same immutable input is a no-op.

The full map retains bounded normalized entities, relations, evidence and file
fingerprints. HTTP overview responses expose only summary metadata and a
bounded query result rather than serializing an unfiltered graph into the
browser. An in-memory least-recently-used cache reuses immutable maps; server
shutdown clears it.

## Lenses and responsibility hypotheses

The map reports these lenses independently:

- overlapping responsibility candidates;
- modules/packages/files;
- deployables and runtime entry points;
- dependencies and reverse dependencies;
- interfaces and data flow;
- data stores;
- tests and verification evidence;
- external systems;
- change coupling when normalized history evidence exists.

Explicit analyzer communities, dependency affinity, normalized entity kinds,
relations, source locations and history are separate signals. Responsibility
candidates can overlap. If relations/community evidence is absent, a path
affinity fallback remains available but is marked high-uncertainty and says
directly that a directory is not assumed to be a component.

Every group includes stable identity, member/relation/evidence IDs, rationale,
provenance, alternatives, uncertainty reasons and coverage impact. Derived
classifications remain `inferred` even when the source entity was extracted;
the source evidence retains its own extracted/inferred/declared provenance.

Missing deployable, interface, data, test, external-system or history evidence
creates an `unsupported` lens with a capability gap. A partial/stale snapshot,
scope exclusions or exhausted derivation budget produces diagnostics rather
than an empty-looking complete architecture.

## Bounded queries

The map query contract supports:

- `overview` and `aggregate`;
- `search` across groups, names, kinds and source paths;
- `group` and `entity` detail;
- directional `neighbors`;
- bounded dependency `path`;
- `reverse-dependencies`;
- exact evidence lookup.

Default query limit is 50; the maximum is 500. Neighborhood depth is at most 5
and path depth at most 12. Results cap groups, entities, relations and evidence
independently and set `truncated` when more exists. Relation-kind filters are a
closed bounded list supplied as data, never a provider-specific query language.

Derivation defaults are 20,000 entities, 80,000 relations, 80,000 evidence
records, 1,000 groups and 250 members per group. Budgets are distributed across
responsibility and structural lenses so a large module inventory cannot consume
the entire map. Reaching a budget is visible in diagnostics and never interpreted
as repository absence.

## Comparison and export

Map comparison keeps four causes distinct:

- code/content fingerprint changes, including detectable file moves;
- observed entity/relation/evidence changes;
- analyzer version/configuration changes;
- changed derived grouping/inference.

A no-op comparison is stable. Partial file indexes remain explicitly
`truncated`. Comparisons across repository or adapter identities fail closed.

Markdown and JSON export are bounded to 2 MiB by default. Markdown starts with
the derived/non-authoritative warning and includes snapshot/analyzer identity,
coverage and evidence references. Export returns content to the authenticated
client for an explicit download; it does not write into the repository.

## HTTP and client surface

- `GET /api/repositories/:id/analysis/jobs/:jobId/map`
- `POST /api/repositories/:id/analysis/jobs/:jobId/map/query`
- `GET /api/repositories/:id/analysis/jobs/:jobId/map/compare?fromJobId=...`
- `GET /api/repositories/:id/analysis/jobs/:jobId/map/export?format=markdown|json`

All endpoints use the same authenticated client boundary as analysis snapshots.
Paired remote clients may inspect bounded maps; no host-sensitive operation is
performed. Invalid limits, repository mismatches, missing snapshots and unsafe
export sizes are typed failures.

The repository-level **Map** route provides map/list modes, lens and search
filters, group/entity detail, incoming/outgoing relation navigation, exact
source locations, coverage/diagnostics, snapshot comparison and explicit
export. Interactive nodes are native buttons with keyboard focus; the layout
collapses to a single readable column on mobile.

## Verification

`test/system-map.test.mjs`, `test/auth-config.test.mjs` and
`test/browser-smoke.test.mjs` verify:

- stable no-op derivation and no input/repository mutation;
- rich, inventory-only, partial, polyglot, dirty, stale and large snapshots;
- evidence/provenance/uncertainty integrity and unsupported capability states;
- all bounded query classes, path and reverse-dependency behavior;
- code/evidence/analyzer/inference comparison and file moves;
- labeled bounded exports;
- authenticated local/remote APIs and invalid-limit rejection;
- responsive map/list/detail browser navigation and keyboard-focusable nodes.
