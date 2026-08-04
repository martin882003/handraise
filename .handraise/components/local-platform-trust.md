---
slug: local-platform-trust
title: Local Platform & Trust
state: active
order: 5
since: 2026-08-03
---
## Scope

Provide the secure local foundation on which every Handraise feature runs: server lifecycle, HTTP/API policy, client pairing and revocation, persistent settings, same-origin protection, local-only defaults, live-update transport, CLI service operations, diagnostics and recovery.

## Limits

Does not own feature-specific repository, session or agent semantics, and does not own their browser presentation. Handraise must not expose its control plane on an untrusted network by default, copy provider credentials, weaken cookie or origin protections, or let cached UI impersonate a reachable server.

## Agent guidance

Default to least privilege and localhost, keep secrets hashed or confined to secure cookies, separate availability from authentication state, and make recovery paths explicit. Maintain backward-compatible API behavior where practical and require preflight clarity for destructive actions. Coordinate shared route changes with the component that owns the feature contract.

## Territory

`src/auth.mjs`, server bootstrap and cross-cutting HTTP/security/SSE behavior in `src/server.mjs`, persistent store and repository registration concerns in `src/config.mjs`, and core serve/auth/repository service commands in `bin/handraise.mjs`.
