---
slug: planning-quality-evaluation
component: repository-planning
state: blocked
impact: alto
complexity: alta
---

# planning-quality-evaluation — Measure whether the work model is actually useful

**Componente:** repository-planning

## Observable outcome

Every intelligence/planning release is gated by a versioned automated and blind-human benchmark that independently measures safety, evidence integrity, system coverage, decomposition usefulness, front quality, stability and uncertainty instead of model self-confidence or demo quality.

## Confirmed context

The central product risk is confidently producing a bad work model. Unit tests can validate schemas and atomicity but cannot decide whether responsibilities are coherent or fronts are useful. Evaluation must begin with the contracts, collect representative repository-owner judgments and remain independent of any one prompt, model or analyzer.

## ▶ Handoff

Start the corpus/rubric once repository-intelligence-contract and work-contract-schema-v2 stabilize; keep this front active across component/front design milestones. Separate hard zero-tolerance invariants from scored quality. Store redistributable fixtures in the repository and keep any private benchmark source outside it with reproducible manifests.

## Checklist

- [x] 1. Define separate understanding, component-design, front-design, execution and reconciliation rubrics with objective hard invariants.
- [x] 2. Build a versioned corpus spanning small/polyglot/monorepo/services/libraries/legacy/sparse-doc/misleading-layout/dirty/adversarial repositories.
- [x] 3. Define owner-authored reference facts/questions and blind review protocol without assuming one canonical decomposition where alternatives are valid.
- [x] 4. Implement automated evidence resolution, coverage, overlap, cycle, stability, mutation, security, latency and resource measurements.
- [x] 5. Implement anonymized result capture comparing analyzer/model/prompt/schema/benchmark versions and preserving reviewer rationale.
- [x] 6. Establish Gate C thresholds, including at least 80% owner-rated useful starting points and zero hard safety/evidence failures.
- [x] 7. Add regression reporting that distinguishes changed code evidence, analyzer output, inference/ranking and formatting-only differences.
- [ ] 8. Run the full benchmark against baseline heuristics and each candidate release; publish limitations and prevent release-state promotion on failed gates.

### Verified benchmark status

Automated benchmark v1 has run against baseline and current candidates with no
hard or scored gate failures; its sanitized report and limitations are checked
in under `benchmark/results/`. Promotion is wired fail-closed through
`benchmark:gate` and `prepack`. This front remains blocked, and item 8 remains
open, until real independent owner/maintainer reviews cover all ten cases. The
non-gating template is not counted as evidence.
