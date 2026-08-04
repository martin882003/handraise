---
slug: work-contract-schema-v2
component: repository-planning
state: done
impact: alto
complexity: alta
---

# work-contract-schema-v2 — Make components and fronts sufficient for designed work

**Componente:** repository-planning

## Observable outcome

Native component and front Markdown can represent the full target contracts—responsibilities, interfaces, evidence, uncertainty, lead/affected ownership, dependencies, acceptance and verification—without breaking or discarding existing v1 and unknown content.

## Confirmed context

Current native component fields are intentionally small and current front updates rewrite a constrained known shape. Semantic planning and plan-driven runtime need richer contracts and provenance, but existing repositories and concurrent human edits cannot be sacrificed. Director capability differences must remain explicit.

## ▶ Handoff

Build this in parallel with intelligence foundations. Start with lossless parsers/AST-preserving updates and versioned validation before adding generated content. Make front dependencies and component references domain contracts, not UI-only strings. Coordinate product-goal references with Product Direction and run-manifest needs with Runtime & Worktree Control.

## Checklist

- [x] 1. Specify additive component v2 and front v2 frontmatter/section schemas, defaults, validation and canonical rendering.
- [x] 2. Add one lead component, affected components, goal links, dependency kinds, readiness, acceptance, verification, risks and evidence to front contracts.
- [x] 3. Add purpose/outcomes, invariants, interfaces, dependencies, data, verification, evidence and uncertainty to component contracts.
- [x] 4. Replace lossy Markdown rewrites with updates that preserve unknown frontmatter, sections, comments and stable human formatting where possible.
- [x] 5. Implement valid-reference, unique-slug, one-lead, lifecycle and hard-dependency-cycle validation with actionable diagnostics.
- [x] 6. Add explicit previewable v1-to-v2 migration and rollback/no-op behavior; keep v1 files readable without forced migration.
- [x] 7. Publish adapter capability flags so Director/native read, edit, migrate and plan operations are represented honestly.
- [x] 8. Test round trips, unknown content, concurrent edits, malformed/cyclic contracts, cross-component fronts and existing fixture compatibility.
