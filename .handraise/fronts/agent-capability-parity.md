---
slug: agent-capability-parity
component: agent-integrations
state: done
impact: alto
complexity: alta
---

# agent-capability-parity — Make every agent integration honest and recoverable

**Componente:** agent-integrations

## Observable outcome

Before launch, users can see exactly which control, attention, permission and wrap-up capabilities each agent provides, and installed Claude Code or Codex integrations can be diagnosed, repaired and used without hidden degradation.

## Confirmed context

Handraise detects Claude Code and Codex, reuses their existing accounts and constructs validated invocations. Capability reporting and hook infrastructure exist, but every client surface must remain accurate, Codex parity needs end-to-end verification, permission details are abbreviated, denial reasons are absent and hook uninstall/repair behavior requires complete coverage.

## ▶ Handoff

Treat each CLI as an adapter with tested capabilities instead of assuming parity from configuration. Verify hook delivery through the real agent lifecycle, make install/repair/uninstall idempotent, and show degradation before launch. Coordinate generic lifecycle state with Runtime & Worktree Control and capability/permission presentation with Client Experience.

## Checklist

- [x] 1. Define and expose the supported-agent capability matrix from one server-side source of truth.
- [x] 2. Verify Claude Code and Codex attention, typed permission and graceful wrap-up behavior end to end.
- [x] 3. Show capability degradation and setup guidance before an affected session launches.
- [x] 4. Present complete relevant permission input and suggestions with explicit redaction rules.
- [x] 5. Support an optional denial reason and return it to the requesting agent when supported.
- [x] 6. Complete idempotent hook status, install, repair and uninstall workflows for each adapter.
- [x] 7. Add hook timeout, decision, repair and agent-capability tests.
- [x] 8. Launch and observe first-party Claude Code and Codex login from Settings, then refresh the CLI-owned account state.
