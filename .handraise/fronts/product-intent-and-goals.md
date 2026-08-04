---
slug: product-intent-and-goals
component: product-direction
state: done
impact: alto
complexity: alta
---

# product-intent-and-goals — Capture what the code cannot say

**Componente:** product-direction

## Observable outcome

A user can create, import, review and accept a human-readable product brief and prioritized goals before or during repository planning, while Handraise preserves source attribution, conflicts, assumptions, locked decisions and a fully manual path.

## Confirmed context

Code analysis can describe the observed implementation but cannot reliably decide target users, future outcomes, non-goals or whether a current boundary is intentional debt. Component and front recommendations need this declared truth to avoid optimizing only for the current directory/dependency graph. Accepted intent belongs in the repository; drafts do not.

## ▶ Handoff

This front can run in parallel with intelligence foundations. Define `.handraise/product.md` additively and use the same draft/acceptance discipline as planning. Begin with guided local authoring and selected Markdown import; keep connected issue/product systems behind later source adapters. Coordinate goal references with work-contract-schema-v2.

## Checklist

- [x] 1. Define the product brief, glossary, goal, source-attribution, assumption, conflict and locked-decision schemas.
- [x] 2. Implement native parsing/rendering that preserves unknown Markdown/frontmatter and supports an explicit manual authoring path.
- [x] 3. Implement private draft creation, edit/lock/unlock, conflict resolution, expiry/resume and no-mutation preview behavior.
- [x] 4. Add guided questions for users, outcomes, success signals, priorities, constraints, invariants, non-goals and repository roles.
- [x] 5. Add selective local-document import with scope preview, provenance and contradictory-claim handling.
- [x] 6. Publish accepted `.handraise/product.md` through serialized, conflict-safe, atomic mutation without implicit overwrite.
- [x] 7. Expose authenticated APIs and the minimum review UI for draft, source, conflict, diff, accept, skip and manual flows.
- [x] 8. Test partial briefs, stale sources, locked regeneration, concurrent edits, malformed Markdown, crash recovery and zero pre-acceptance mutation.
