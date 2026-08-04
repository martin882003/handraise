---
slug: planning-model-capabilities
component: agent-integrations
state: done
impact: alto
complexity: alta
---

# planning-model-capabilities — Add bounded reasoning to observed evidence

**Componente:** agent-integrations

## Observable outcome

Handraise can invoke a declared, provider-neutral planning operation through an authenticated supported model adapter, give it bounded graph/product context, validate structured results, show the data boundary and cancel it—while manual/deterministic planning remains usable.

## Confirmed context

Claude Code and Codex execution/authentication capabilities already exist, but interactive terminal support is not a planning-model API. Semantic synthesis needs structured output, graph-query tooling, grounding and prompt-injection boundaries. Provider credentials must remain with first-party CLIs or explicit provider configuration, and a model cannot authorize repository mutation.

## ▶ Handoff

Depend on the normalized intelligence contract, not Graphify internals. Define planning operations and capability negotiation first, then implement one adapter end to end before parity. Reuse existing auth detection where truthful, but do not infer non-interactive/structured capabilities from “CLI installed”. Coordinate consent and progress UI with Client Experience and schemas with Repository Planning.

## Checklist

- [x] 1. Define planning operation, provider/model capability, context/data-boundary, usage and typed failure contracts.
- [x] 2. Define bounded tools for graph/evidence/product queries with allowlisted arguments, result limits and no mutation capability.
- [x] 3. Implement one supported adapter with existing first-party authentication, timeout, cancellation and no credential copying/logging.
- [x] 4. Add preflight showing provider/model, selected sources/snippets, local/cloud boundary and explicit consent where source may leave the host.
- [x] 5. Validate structured output, evidence IDs and schema versions; add bounded repair/retry without accepting fabricated references.
- [x] 6. Treat repository/model text as untrusted data and test prompt injection, tool escalation, secret access and generated-command attacks.
- [x] 7. Expose availability, progress, usage/cost when available, cancellation, retry and honest deterministic/manual fallback states.
- [x] 8. Add a second adapter or formally document why capability parity is not yet supportable; test authentication expiry and partial capability states.
