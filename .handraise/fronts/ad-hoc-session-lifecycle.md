---
slug: ad-hoc-session-lifecycle
component: runtime-worktree-control
state: queued
impact: alto
complexity: media
---

# ad-hoc-session-lifecycle — Support honest unplanned work

**Componente:** runtime-worktree-control

## Observable outcome

A user can intentionally start and control an unplanned agent run without a
front or release, with the same safety and recovery guarantees as planned work,
while Handraise keeps its lifecycle, outcomes and metrics separate and offers an
explicit reviewed path to promote discoveries into future planned work.

## Confirmed context

Not every useful session begins from a plan: diagnosis, exploration, emergency
repair and bounded maintenance are legitimate. Treating those sessions as fake
fronts pollutes the work model; treating them as invisible terminals loses
provenance and safety. Login/setup/diagnostic system sessions are a third role
and must not count as product work either.

## ▶ Handoff

Reuse the existing process, worktree, terminal, permission, attention and
recovery boundaries. Add an explicit `ad-hoc` run kind rather than nullable
planned semantics scattered through the runtime. Require a short purpose and
default to isolated work. Promotion creates a proposal; it never retroactively
claims that the session was planned or directly mutates a release/front.

## Checklist

- [x] 1. Define planned, ad-hoc and system run/session roles with explicit invariants, lifecycle, purpose and nullable relationship rules.
- [x] 2. Add preflight and explicit start for an ad-hoc run with repository, required purpose, optional component, agent/model and isolated-or-in-place workspace review.
- [ ] 3. Apply identical auth, capability, process identity, terminal, permission, Git safety, stop, restart and cleanup guarantees to ad-hoc work.
- [x] 4. Persist inspectable purpose, sessions, changes, discoveries, checks, handoff and terminal outcome without creating front or release progress.
- [ ] 5. Keep fleet/history/throughput views visibly labeled and exclude ad-hoc/system activity from planned readiness and delivery metrics.
- [x] 6. Implement explicit promotion into a new-front, existing-front or release-review proposal with provenance and no direct accepted-state mutation.
- [ ] 7. Surface unattributed/ad-hoc changes during release candidate review for explicit include, exclude or follow-up classification.
- [ ] 8. Build separate client start/detail/history flows and test isolation, restart, failure, cleanup, zero release progress, promotion and candidate classification end to end.
