---
slug: graphify-readonly-adapter
component: repository-intelligence
state: done
impact: alto
complexity: alta
---

# graphify-readonly-adapter — Use Graphify without surrendering safety or ownership

**Componente:** repository-intelligence

## Observable outcome

When a compatible Graphify installation is available, a user can explicitly select it for richer local repository analysis; Handraise captures and normalizes its graph/provenance from isolated storage, reports exact capabilities and cleans up without writing anything into the target repository.

## Confirmed context

Graphify supplies useful tree-sitter entities, relations and provenance, but its documented CLI writes derived artifacts such as `graphify-out/` and its schema/version are external. Handraise's pre-acceptance read-only contract prohibits running that default directly in the repository. Graphify must remain optional behind repository-intelligence-contract and readonly-analysis-runtime.

## ▶ Handoff

Use official Graphify CLI/schema behavior and pin tested versions. Run only against the analysis runtime's isolated mirror or an API path with explicit private output. Start with deterministic local parsing; model-assisted Graphify stages are a separate advertised capability and consent. Never install Graphify, its hooks or skills as a side effect.

## Checklist

- [x] 1. Detect binary/package, exact version, supported command/schema/capabilities and incompatibility diagnostics without modifying the host.
- [x] 2. Define the isolated invocation/output strategy and prove `graphify-out/`, graph files, hooks and config cannot reach the target repository.
- [x] 3. Execute through structured argv with environment allowlist, timeout, resource/output caps, process cancellation and startup cleanup recovery.
- [x] 4. Validate Graphify outputs and normalize nodes, relations, locations and extracted/inferred/ambiguous provenance into Handraise contracts.
- [x] 5. Map language/relation coverage, parse failures and partial output into honest diagnostics rather than synthetic completeness.
- [x] 6. Separate deterministic local analysis from any semantic/model-assisted stage with provider/scope consent and testable no-upload default.
- [x] 7. Add baseline fallback/retry UI and APIs that preserve Graphify failure details and never relabel fallback results as Graphify-equivalent.
- [x] 8. Test compatible/incompatible/missing versions, malformed/huge output, cancellation, dirty trees, symlink attacks, restart cleanup and target zero mutation.
