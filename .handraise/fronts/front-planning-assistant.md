---
slug: front-planning-assistant
component: repository-planning
state: done
impact: alto
complexity: alta
---

# front-planning-assistant — Turn product goals into executable portfolios

**Componente:** repository-planning

## Observable outcome

Using a selected component model and product goal, Handraise proposes a reviewable portfolio of outcome-oriented fronts with lead/affected ownership, dependencies, readiness, acceptance, verification, risks and ordered work; users can compare slicing/sequencing alternatives before any execution artifact exists.

## Confirmed context

Good components are necessary but insufficient: humans still struggle to turn a desired outcome into fronts with useful feedback boundaries and safe parallelism. A front is not a directory, generic task list or preallocated worktree. Planning can use selected in-memory component drafts before publication, but final references must validate against the exact set published.

## ▶ Handoff

Depend on product intent/goals, selected component architecture, work-contract-schema-v2 and planning-model/manual capabilities. Generate the plan inside the same draft workspace as its selected contracts. Validate deterministically after reasoning. Keep hard dependencies distinct from coordination/informational edges and hand the selected complete workspace to transactional-plan-publication.

## Checklist

- [x] 1. Define goal coverage, front alternative, dependency kind, readiness, verification, risk, unknown and plan-diagnostic draft schemas.
- [x] 2. Generate complete v2 fronts with one lead component, affected components and explicit links to goal, contracts and evidence.
- [x] 3. Propose outcome slices that produce feedback independently and route genuine unknowns into research/decision fronts instead of hidden assumptions.
- [x] 4. Build and validate the hard-dependency DAG, explain every edge, identify ready sets/critical path and report ownership or territory concurrency conflicts.
- [x] 5. Generate acceptance criteria, deliverables and feasible verification evidence before execution without inventing unavailable commands/capabilities.
- [x] 6. Offer materially different slicing/sequencing alternatives and compare outcome speed, risk, coupling and feedback value.
- [x] 7. Implement edit/lock/split/merge/delete/add/reorder/compare/regenerate/skip operations with stable IDs and visible diffs.
- [x] 8. Report uncovered goals, duplicate outcomes, invalid references, cycles, fronts too broad to verify and context assumptions.
- [x] 9. Pass manual/model fallback, stale draft, partial goal, adversarial content, no-mutation and planning benchmark tests.
