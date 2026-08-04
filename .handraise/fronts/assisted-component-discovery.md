---
slug: assisted-component-discovery
component: repository-planning
state: done
impact: alto
complexity: alta
---

# assisted-component-discovery — Propose components during repository initialization

**Componente:** repository-planning

## Observable outcome

When a native repository is initialized, the user can request a read-only analysis, review an evidence-backed proposal of complete component contracts, revise it, and create only the accepted definitions in one safe operation.

## Confirmed context

GAP-06 and COMP-11 through COMP-13 define the product contract. Analysis is optional and must inspect repository structure, documentation, manifests, tests and configuration without writing metadata. Proposals describe durable responsibilities rather than mirroring folders, expose evidence and uncertainty, and preserve the empty-initialization path. Acceptance must revalidate the repository and never overwrite existing definitions.

## ▶ Handoff

Implement one preview-to-acceptance workflow across repository initialization, API and client surfaces. Keep drafts in memory, use one serialized writer per repository, stage the full accepted set on the same filesystem, revalidate adapter/fingerprint/slugs immediately before publication, and expose conflicts as recoverable UI states. Coordinate proposal review interaction with Client Experience and analysis-agent capability with Agent Integrations.

## Checklist

- [x] 1. Define the discovery input, proposal schema, repository fingerprint and evidence/uncertainty model.
- [x] 2. Implement bounded read-only repository inspection with explicit exclusions and failure handling.
- [x] 3. Generate complete responsibility-oriented component proposals without mutating `.handraise/`.
- [x] 4. Add authenticated preview and acceptance API operations with expiry and conflict revalidation.
- [x] 5. Build review UI for editing, removing, regenerating, accepting or skipping proposed components.
- [x] 6. Publish the accepted set through one serialized atomic mutation without implicit overwrite.
- [x] 7. Cover read-only guarantees, stale fingerprints, duplicate slugs, partial failure and successful acceptance in tests.
