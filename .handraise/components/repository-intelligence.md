---
slug: repository-intelligence
title: Repository Intelligence
state: active
order: 6
since: 2026-08-03
---
## Scope

Build the evidence-backed, analyzer-neutral observed model of connected repositories. Own bounded snapshot identity, analyzer detection/execution, normalized entities and relations, provenance, coverage, uncertainty, graph queries, freshness, snapshot comparison and architecture drift findings.

## Limits

Does not own product goals, accepted component/front definitions, plan publication, agent execution or worktree lifecycle. Derived analysis is never repository truth. Analysis may not mutate the target repository or transfer source to a model without a separate explicit user action.

## Agent guidance

Treat every repository as untrusted input. Prefer deterministic extraction, validate every adapter output, preserve extracted/inferred/declared provenance, and expose unsupported or excluded areas as missing coverage. Keep analyzers behind the normalized Handraise contract; Graphify is the first rich adapter, not the domain model. Make jobs bounded, cancellable and cleanup-safe, and verify the target repository byte/metadata/index state before and after every terminal path.

## Territory

Future `src/intelligence/`, analyzer adapters, normalized snapshot/graph contracts, private analysis cache/job storage, graph query/diff APIs and their tests. Existing initialization and `src/discovery.mjs` stay with Repository Planning until an explicit migration uses the intelligence contract. Map UI is coordinated with Client Experience; planning consumes snapshots but does not bypass this component.
