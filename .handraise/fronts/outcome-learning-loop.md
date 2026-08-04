---
slug: outcome-learning-loop
component: repository-planning
state: done
impact: medio
complexity: alta
---

# outcome-learning-loop — Turn execution discoveries into reviewed better plans

**Componente:** repository-planning

## Observable outcome

Completed/blocked runs and architecture drift can produce grounded, deduplicated proposals to update product assumptions, component contracts or queued fronts; users can dismiss, defer, edit or accept them through the normal review/publication path, and benchmark feedback improves recommendations without silently learning source or governance.

## Confirmed context

Execution reveals facts that initialization cannot know, but automatically rewriting plans would destroy authorship and create feedback loops from agent claims. Reconciliation supplies observed drift; run manifests supply scoped discoveries and verification evidence. Learning must mean better reviewable proposals and measured ranking, not opaque mutation.

## ▶ Handoff

Depend on plan-driven-agent-orchestration, continuous-architecture-reconciliation and planning-quality-evaluation. Normalize run discoveries and findings into proposal inputs, preserve provenance and prior decision rationale, then reuse component/front draft operations and transactional publication. Keep local product feedback separate from anonymized benchmark contributions and require explicit opt-in for any export.

## Checklist

- [x] 1. Define run-discovery, decision-memory, proposal-cause, affected-contract and feedback schemas with stable provenance/identity.
- [x] 2. Correlate verified run outcomes and drift findings with exact goal/component/front revisions without treating terminal/model claims as facts.
- [x] 3. Generate bounded proposed changes to assumptions, components, dependencies, readiness, acceptance, verification and queued fronts with evidence/diffs.
- [x] 4. Deduplicate unchanged findings and preserve dismissed/deferred rationale, locked decisions and expiry/reconsideration conditions.
- [x] 5. Route edit/accept operations through existing draft validation and transactional publication; never mutate accepted state directly.
- [x] 6. Add local ranking/feedback signals and benchmark-case capture that are inspectable, deletable and source-private by default.
- [x] 7. Require explicit scoped opt-in before exporting anonymized feedback and prove credentials/source/snippets cannot leak through telemetry.
- [x] 8. Verify completed/failed/blocked/scope-changed runs, contradictory findings, repeated cycles, stale proposals, rollback and measured no-regression quality.

### Verified implementation status

The private v1 store, authenticated API and Map review workspace now preserve
exact target revisions, provenance, contradictions and decision memory. Product,
component and front proposals route through their existing validated private
draft stores; real API and headless-browser tests prove accepted Markdown stays
unchanged. Feedback is local, inspectable and deletable. An optional host-only
export requires exact preview/confirmation, strips source/path/snippet/identity/
rationale/credential material and only downloads JSON locally. The full suite
passes 145/145, including real HTTP, tmux and headless-browser boundaries, and
the automated quality benchmark reports no regression. Its independent human
gate remains honestly blocked and is not counted as learning-loop evidence.
