---
slug: complete-session-lifecycle
component: runtime-worktree-control
state: done
impact: alto
complexity: alta
---

# complete-session-lifecycle — Make every managed session state intentional

**Componente:** runtime-worktree-control

## Observable outcome

Users can start, inspect, recover, pause or deliberately stop managed work from the client, and completed or failed sessions remain understandable instead of disappearing without a useful record.

## Confirmed context

The runtime already launches repository-scoped tmux sessions, controls terminal input, derives attention from lifecycle events, supports graceful wrap-up and exposes Git/worktree safety. Remaining requirements include Play from a queued front, first-class error and retry, an explicit pause/resume decision, confirmed hard stop, completed history and attached-state visibility. Terminal output must never become the source of lifecycle truth.

## ▶ Handoff

Extend the existing lifecycle model rather than adding UI-only states. Specify legal transitions and evidence for each state, retain failure and completion records, and make destructive controls explain their process and Git consequences. Coordinate capability differences with Agent Integrations and all client controls with Client Experience.

## Checklist

- [x] 1. Define supported lifecycle states, legal transitions and terminal evidence, including the pause/resume product decision.
- [x] 2. Start or resume a session from a queued front with repository, component, agent and isolation defaults resolved.
- [x] 3. Represent launch/runtime errors as first-class states with actionable retry.
- [x] 4. Add confirmed hard stop while preserving graceful wrap-up as the default path.
- [x] 5. Persist useful completed, failed and stopped session records with duration and ownership context.
- [x] 6. Surface tmux attachment, worktree and Git safety state before lifecycle actions.
- [x] 7. Verify transitions with API tests and a real-tmux lifecycle smoke test.
