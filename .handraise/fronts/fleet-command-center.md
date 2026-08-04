---
slug: fleet-command-center
component: runtime-worktree-control
state: done
impact: alto
complexity: alta
---

# fleet-command-center — Turn the home screen into an actionable fleet verdict

**Componente:** runtime-worktree-control

## Observable outcome

The home screen gives one current, actionable view across repositories: what needs the user, what is running or unsafe, what recently completed or failed, and where a conversational manager can propose coordinated work for explicit confirmation.

## Confirmed context

Handraise already aggregates live sessions per repository and the active implementation is adding worktree/Git ownership, a conversational Director, durable history and fleet metrics. These capabilities were previously product decisions; this front treats them as an accepted product layer while preserving repository boundaries, single-owner lanes, explicit confirmation and safe adapter-specific mutations.

## ▶ Handoff

Build the fleet verdict from authoritative repository, runtime, Git and history data rather than terminal parsing. Keep manager proposals separate from execution until confirmed, identify exactly which repository/component/front each action targets, and avoid metrics that reward activity without an operational decision. Coordinate global presentation with Client Experience and agent-manager behavior with Agent Integrations.

## Checklist

- [x] 1. Define fleet-level verdicts and precedence for waiting, blocked, failed, unsafe, active and recently completed work.
- [x] 2. Aggregate repository, session, worktree, Git and attention state without collapsing ownership boundaries.
- [x] 3. Persist deduplicated lifecycle history for starts, completion, failure and intentional stops.
- [x] 4. Expose recent outcomes and a small set of decision-useful metrics with honest empty/error states.
- [x] 5. Add a conversational manager that produces scoped proposals and requires explicit confirmation before mutation or launch.
- [x] 6. Present fleet actions and drill-down paths responsively across desktop and mobile.
- [x] 7. Test verdict precedence, history deduplication, proposal confirmation and cross-repository isolation.
