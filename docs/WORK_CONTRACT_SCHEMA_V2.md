# Work contract schema v2

**Status:** implemented native contract and migration boundary

**Version:** 2

Handraise stores accepted component and front contracts as reviewable Markdown.
Schema v2 is additive: v1 files remain readable, normal edits do not force a
migration, and unknown frontmatter, sections and HTML comments are retained by
targeted updates. New native contracts use v2. Migration is a separate
preview-and-apply operation.

## Common rules

- `schema: 2` identifies v2. Missing `schema` means v1.
- Slugs are unique lowercase kebab-case identifiers.
- JSON arrays are used only for compact relationship metadata in frontmatter.
  The actual contract remains readable in Markdown sections.
- `_None declared._` means the field is intentionally present but empty. It is
  not evidence and migration never replaces it with inferred facts.
- Structured relationships use one stable line format:
  `- [kind] target — explanation`.
- Evidence kinds are `extracted`, `inferred` and `declared`; unknown provenance
  is invalid rather than silently coerced.
- Unknown metadata, sections and comments are outside Handraise ownership and
  are preserved.

## Component contract

Canonical frontmatter:

```yaml
---
schema: 2
slug: repository-intelligence
title: Repository Intelligence
state: active
order: 1
since: 2026-08-03
---
```

Lifecycle states are `active`, `closing` and `retired`. The canonical sections
are:

1. `Purpose` (`Scope`/`Alcance` remain compatible aliases)
2. `Outcomes`
3. `Responsibilities`
4. `Limits`
5. `Invariants`
6. `Interfaces`
7. `Dependencies`
8. `Data and external systems`
9. `Territory`
10. `Verification`
11. `Evidence`
12. `Uncertainty and open questions`
13. `Agent guidance`

Interfaces use `provides` or `consumes`. Component dependencies use `hard`,
`soft` or `external`; non-external targets must resolve to another component.
Evidence references a repository path, accepted decision, product goal or
analysis evidence identifier and always records provenance.

## Front contract

Canonical frontmatter:

```yaml
---
schema: 2
slug: semantic-system-map
title: Build the semantic system map
component: repository-intelligence
state: queued
impact: alto
complexity: alta
affected: ["client-experience"]
goals: ["goal:understand-system"]
analysis_snapshot: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
---
```

`component` is the single lead. `affected` cannot repeat that lead and every
entry must resolve. `goals` records zero or more accepted product-goal IDs.
`analysis_snapshot` is optional and, when present, is a SHA-256 snapshot
identity. Lifecycle states are `queued`, `active`, `blocked`, `paused` and
`done`.

The canonical sections are:

1. `Observable outcome`
2. `Motivation`
3. `Scope`
4. `Non-goals`
5. `Readiness`
6. `Acceptance criteria`
7. `Verification`
8. `Deliverables`
9. `Risks and unknowns`
10. `Dependencies`
11. `Evidence`
12. `Confirmed context`
13. `▶ Handoff`
14. `Checklist`

Front dependencies use `hard`, `coordination` or `informational`. Every target
must resolve to another front, self-dependencies are invalid, and hard edges
must form a DAG. Only hard edges gate readiness; the other kinds retain useful
coordination context without inventing execution blockers.

## Validation

Portfolio validation emits structured diagnostics with code, severity, field
path and actionable message. Errors cover unsupported schemas, malformed or
duplicate slugs, missing/unknown lead and affected components, invalid
lifecycle states, unknown goals when an accepted goal catalog is supplied,
invalid snapshot identities, unknown relationship kinds/targets and hard
dependency cycles. Missing v2 content is a warning so an explicit lossless
migration can represent unknowns honestly instead of fabricating answers.

Every native create, edit, state change and deletion validates the resulting
whole portfolio while holding the repository management lock. Director files
remain readable, but create/edit/migrate/plan capabilities reflect only the
helpers that repository actually exposes.

## Lossless edits and migration

Targeted editing changes only requested known metadata and section bodies. It
keeps unknown frontmatter lines, section order, custom sections and existing
HTML comments. A v1 edit stays v1; an explicit migration:

1. computes exact before/after text and revisions without writing;
2. adds `schema: 2`, front relationship arrays and missing canonical sections;
3. validates the resulting portfolio;
4. requires the exact reviewed preview ID;
5. re-reads every baseline under the shared native management lock;
6. stages every result on the same filesystem;
7. commits the set and rolls back prior writes if a later write fails.

Changed baselines invalidate the preview. Existing v2 portfolios produce a
stable no-op and no file is rewritten. Director migration is explicitly
unsupported instead of attempting a native write.

Authenticated endpoints:

- `GET /api/repositories/:id/contracts/migration`
- `POST /api/repositories/:id/contracts/migration` with `{ "previewId": "…" }`
