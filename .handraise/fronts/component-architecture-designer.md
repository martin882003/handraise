---
slug: component-architecture-designer
component: repository-planning
state: done
impact: alto
complexity: alta
---

# component-architecture-designer — Propose durable boundaries, not folder groups

**Componente:** repository-planning

## Observable outcome

Given a system map and product brief, Handraise can propose and compare complete responsibility-oriented component architectures, ask questions that materially change boundaries, critique coverage/overlap/coupling, and let the user edit, lock, split, merge, regenerate or reject everything without mutation.

## Confirmed context

This is the product's central differentiation. The current assisted discovery safely proposes a fixed set of heuristic contracts but does not construct a semantic system model, incorporate product direction, compare decompositions or test their quality. Correct boundaries may follow domains, deployables, platform responsibilities or deliberate combinations; no one graph clustering algorithm is authoritative.

## ▶ Handoff

Depend on product-intent-and-goals, semantic-system-map, work-contract-schema-v2 and either planning-model-capabilities or the manual/deterministic path. Keep all alternatives in one private draft workspace. Generate hypotheses from bounded graph/product queries, then run deterministic validation and evidence resolution. Do not publish here; hand the selected draft to transactional-plan-publication.

## Checklist

- [x] 1. Define architecture-alternative, boundary rationale, trade-off, question, locked decision and quality-diagnostic draft schemas.
- [x] 2. Generate complete v2 component candidates from responsibility/interface/deployable/data/history evidence plus selected product intent.
- [x] 3. Produce materially distinct alternatives where justified and explain domain/deployable/platform/hybrid trade-offs without cosmetic renaming.
- [x] 4. Ask focused questions only when answers can change ownership, boundaries, invariants or product priorities; resume generation with preserved answers.
- [x] 5. Compute responsibility coverage, duplicate/shared ownership, cohesion proxies, coupling, dependency cycles, orphan evidence and unstable boundaries.
- [x] 6. Implement edit/reorder/lock/split/merge/delete/add/compare/regenerate/skip operations while preserving user decisions and showing diffs.
- [x] 7. Ensure every generated field cites current normalized evidence/declared intent or is visibly an assumption, uncertainty or open question.
- [x] 8. Add authenticated draft APIs and an accessible evidence-first review UI without any repository planning mutation.
- [x] 9. Pass security, stale-snapshot, partial-context, model-failure, no-op stability, manual parity and benchmark Gate C tests.
