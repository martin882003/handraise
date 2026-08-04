---
slug: release-planning-and-gates
component: repository-planning
state: queued
impact: alto
complexity: alta
---

# release-planning-and-gates — Make releases the unit of delivery

**Componente:** repository-planning

## Observable outcome

Handraise builds repository-local releases above components and fronts: each
release selects exact requirements and front revisions, exposes readiness and
quality blockers, drives a cumulative candidate gate and records reproducible
released evidence without equating sessions or process activity with progress.

## Confirmed context

Components are durable responsibility boundaries and fronts are planned outcome
slices; neither answers what coherent increment is being committed and shipped.
The engineering delivery contract already needs this entity for Handraise's own
dogfood Release 0. Release membership must have one source of truth, remain
human-readable and preserve prior released history.

## ▶ Handoff

Implement the smallest repository-local release contract needed for Release 0
before richer release automation. Keep exact requirement/front/artifact revisions
and current test evidence separate from mutable labels. Do not create a hosted
CI/CD abstraction or multi-repository transaction in this front. Coordinate the
release browser surface with Client Experience and candidate/run evidence with
Runtime & Worktree Control.

## Checklist

- [x] 1. Define the release Markdown/schema, lifecycle, exact requirement/front revision membership, target branch, compatibility, gate and evidence contracts.
- [ ] 2. Implement parsing/rendering, unknown-content preservation, validation and serialized atomic create/edit/cancel operations without dual front membership authority.
- [ ] 3. Compute readiness from dependency/front state, requirement acceptance, required tests, applicable NFRs, ownership conflicts and prior-release regression obligations.
- [ ] 4. Bind candidate evidence to source/contracts/runs/tool versions/artifact digest/measurement profile and reject stale, skipped, todo or mismatched evidence.
- [x] 5. Add authenticated release list/detail/assembly/lifecycle APIs with optimistic revisions, conflict handling and repository-local authority.
- [ ] 6. Build the Releases client section with requirement/front/gate progress, exact blocker drill-down, candidate review, history and truthful empty/error states.
- [ ] 7. Associate planned runs with one front and its open release while keeping process state, front evidence and release progress distinct.
- [ ] 8. Add cumulative gate execution and compatibility/change/limitation/recovery records without silently weakening prior release envelopes.
- [ ] 9. Test schema/round-trip, membership races, stale evidence, crash recovery, candidate identity, prior-gate regression, portfolio scale and the complete Release 0 dogfood journey.
