---
slug: continuous-architecture-reconciliation
component: repository-intelligence
state: done
impact: medio
complexity: alta
---

# continuous-architecture-reconciliation — Detect when code and contracts diverge

**Componente:** repository-intelligence

## Observable outcome

After repository or analyzer changes, Handraise creates/computes a new snapshot diff, marks dependent evidence and queued work stale where warranted, and presents explainable boundary/interface/coverage drift findings without changing accepted product, component or front contracts.

## Confirmed context

A one-time map decays immediately as agents change code. Graph/analyzer changes can also alter inference without source changes, so reconciliation must distinguish code evidence, tool version and reasoning changes. Drift detection belongs to observed truth; deciding whether to update architecture or plans returns to human review.

## ▶ Handoff

Depend on semantic-system-map, snapshot diff and accepted v2 evidence references. Begin with explicit/manual refresh and completed-run triggers before file watching. Emit normalized findings and staleness propagation; do not directly edit planning files. Coordinate finding decisions with outcome-learning-loop and UI patterns with Client Experience.

## Checklist

- [x] 1. Implement incremental/new snapshot creation and a diff model separating content, normalized graph, analyzer-version and inference changes.
- [x] 2. Detect stale/missing evidence, boundary crossings, orphan/overlapping responsibilities and new/removed deployables, interfaces, data or dependencies.
- [x] 3. Trace changed evidence to affected product claims, component fields, fronts and active/queued runs with bounded explainable propagation.
- [x] 4. Define finding severity, confidence/provenance, alternatives, first-seen/last-seen and stable identity to prevent unchanged duplicate noise.
- [x] 5. Add manual refresh and safe post-publication/post-run triggers with progress, cancellation, retention and no target mutation.
- [x] 6. Expose authenticated diff/finding/staleness APIs and minimal evidence-first review views without accepted-state mutation.
- [x] 7. Distinguish dismissed/deferred/accepted-for-planning decisions while keeping actual contract changes in the publication workflow.
- [x] 8. Test no-op stability, file moves, analyzer upgrades, partial failures, stale queued/active runs, repeated findings and large-diff performance.
