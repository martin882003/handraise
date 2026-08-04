---
slug: operational-readiness
component: local-platform-trust
state: done
impact: alto
complexity: alta
---

# operational-readiness — Make the local service diagnosable and recoverable

**Componente:** local-platform-trust

## Observable outcome

An operator can install, start, inspect, diagnose, repair and stop Handraise through supported commands, with actionable errors and verification that covers the real authenticated API and runtime control path.

## Confirmed context

The CLI already serves, starts and lists sessions, manages repositories and authentication, installs hooks and runs basic diagnostics. Missing coverage includes friendly bind failures, readiness separate from authentication, persistent-service lifecycle, deeper `doctor` checks, version-aware repair, consistent terminology and API/browser/tmux integration tests.

## ▶ Handoff

Design the operational contract around common failure recovery, not only the happy-path command list. Keep health unauthenticated but minimal, readiness precise, service installation explicit and reversible, and diagnostics safe to run repeatedly. Coordinate hook-specific checks with Agent Integrations and offline/readiness presentation with Client Experience.

## Checklist

- [x] 1. Return short actionable diagnostics for port conflicts, bind failures and invalid service configuration.
- [x] 2. Add explicit health/readiness and supported server status commands with distinct authentication semantics.
- [x] 3. Provide persistent-service install, start, stop, status and uninstall workflows with clear platform support.
- [x] 4. Expand `doctor` across Node compatibility, agents/auth, hooks, permissions and stale runtime state.
- [x] 5. Complete version-aware repair and recovery guidance for inaccessible clients, paths and failed agents.
- [x] 6. Normalize server/client terminology across CLI, API errors and browser copy.
- [x] 7. Add authenticated API integration, pairing browser and real-tmux control smoke tests to the release gate.
