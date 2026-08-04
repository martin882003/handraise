---
slug: safe-live-repository-portfolio
component: repository-planning
state: done
impact: alto
complexity: alta
---

# safe-live-repository-portfolio — Keep repository planning live without weakening adapters

**Componente:** repository-planning

## Observable outcome

Connected repositories remain accurate as their files change, report actionable recovery when unavailable, and support complete component/front lifecycles only through mutation paths that preserve the native or Director adapter's safety guarantees.

## Confirmed context

Native and Director portfolios can be read, and native component/front operations already cover substantial lifecycle behavior. Remaining risk centers on missing or moved paths, external Markdown refresh, reference validation, serialized native writes, safe deletion preflights and Director mutations that must route through its own validated helpers and locks.

## ▶ Handoff

Make adapter capabilities explicit and refuse operations that lack a safe helper. Re-read external portfolio changes without requiring a Handraise mutation, validate component/front/session references at operation boundaries, and provide exact blockers and recovery actions. Do not emulate Director safety with direct Markdown writes.

## Checklist

- [x] 1. Expose missing, moved and unreadable repository states with reconnect or repair actions.
- [x] 2. Validate component and front references whenever sessions or plans are created or reassigned.
- [x] 3. Refresh component, front and priority state after external repository changes.
- [x] 4. Complete explicit component and front lifecycle transitions with one source of truth.
- [x] 5. Serialize native mutations and give destructive operations exact open-work/session preflights.
- [x] 6. Route every supported Director mutation through its validated helper or declare it read-only.
- [x] 7. Add adapter compatibility and concurrent-mutation tests that prove safety invariants are preserved.
