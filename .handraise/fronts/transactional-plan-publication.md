---
slug: transactional-plan-publication
component: repository-planning
state: done
impact: alto
complexity: alta
---

# transactional-plan-publication — Make human acceptance the only commit point

**Componente:** repository-planning

## Observable outcome

A user can review the exact product/component/front file and relationship diff, select what to accept, and publish the selected plan through one serialized, all-or-nothing, stale/conflict-safe operation that never implicitly overwrites current native or Director state.

## Confirmed context

Current native initialization already stages accepted component creation safely, but the target workspace can include product intent, v2 components, v2 fronts, updates and dependencies. Publication must protect concurrent human changes and preserve unknown Markdown. A model response, button preselection or prior component acceptance cannot authorize a later changed diff.

## ▶ Handoff

Depend on work-contract-schema-v2 and the component/front draft contracts. Generalize the existing repository-scoped lock/staging approach instead of adding independent writers. Render and validate the complete selected set before locking, then re-read baselines and revalidate under the lock immediately before a same-filesystem atomic commit. Director operations must go through advertised helpers or remain unavailable.

## Checklist

- [x] 1. Define publication manifest, selected artifacts, baseline hashes/revisions, provenance/audit metadata and typed conflict/failure results.
- [x] 2. Render a whole-plan textual/relationship diff, including creates/updates/deletes, unknown-content preservation and dependency/goal changes.
- [x] 3. Support explicit components-only, product-plus-components and complete-plan selections without hidden dependent artifacts.
- [x] 4. Validate schemas, unique slugs, references, one-lead ownership, lifecycle transitions, hard-dependency cycles and adapter capabilities before write.
- [x] 5. Revalidate adapter, repository/snapshot fingerprint, baseline content and destination conflicts under one repository-scoped serialized writer.
- [x] 6. Stage the entire rendered set on the same filesystem, durably publish all-or-nothing and never overwrite an unreviewed changed baseline.
- [x] 7. Implement recoverable stale/conflict review, idempotency and crash/cancel/startup staging recovery without partial accepted state.
- [x] 8. Route Director-backed mutations only through validated Director capabilities and surface unsupported multi-artifact atomicity honestly.
- [x] 9. Test concurrent users/processes, stale analysis, manual file edits, duplicate destinations, permission/disk/fsync/rename failures and full rollback.
