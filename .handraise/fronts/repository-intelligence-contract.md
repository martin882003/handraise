---
slug: repository-intelligence-contract
component: repository-intelligence
state: done
impact: alto
complexity: alta
---

# repository-intelligence-contract — Define observed truth independently of analyzers

**Componente:** repository-intelligence

## Observable outcome

Handraise has one versioned runtime/domain contract for repository snapshots, entities, relations, evidence, provenance, coverage, uncertainty, diagnostics and graph queries that the built-in scanner, Graphify, planners and UI can share without depending on one provider schema.

## Confirmed context

The current discovery result is component-shaped and tightly coupled to a bounded heuristic scan. The target product needs an immutable observed layer that can represent partial capabilities and stale evidence. Graphify is valuable but cannot become the source-of-truth schema. This is the first hard prerequisite on the intelligence critical path.

## ▶ Handoff

Start here. Define the normalized contract and failure taxonomy before choosing storage, Graphify invocation or map UI. Coordinate consumed fields with Repository Planning and Client Experience, but keep accepted components/fronts outside this model. Version serialized forms from day one and distinguish extracted, inferred and human-declared evidence.

## Checklist

- [x] 1. Define snapshot identity, lifecycle, freshness and immutable repository-content manifest semantics, including dirty and selected untracked files.
- [x] 2. Define normalized entity, relation, evidence, finding, coverage, exclusion, capability and diagnostic schemas with provenance rules.
- [x] 3. Define analyzer `detect/plan/analyze/query/diff/dispose` contracts, progress events, cancellation and typed terminal failures.
- [x] 4. Define bounded graph-query operations and response budgets without exposing provider-specific query languages to clients.
- [x] 5. Add runtime validation, TypeScript declarations/JSDoc and explicit serialized schema/version compatibility behavior.
- [x] 6. Add representative provider-neutral fixtures for partial languages, stale evidence, ambiguity, exclusions and malformed adapter output.
- [x] 7. Document which fields are facts, hypotheses and diagnostics and prohibit planners from inventing unsupported capabilities.
- [x] 8. Verify consumers can use a fixture snapshot without importing Graphify or the existing discovery proposal schema.
