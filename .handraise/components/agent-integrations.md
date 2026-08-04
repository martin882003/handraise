---
slug: agent-integrations
title: Agent Integrations
state: active
order: 3
since: 2026-08-03
---
## Scope

Provide honest, maintainable integrations with Claude Code, Codex and future supported agent CLIs: installation and authentication detection, invocation construction, model and effort configuration, lifecycle hooks, typed permission bridges, capability reporting, diagnostics and repair workflows.

## Limits

Does not own generic tmux control, worktree creation, repository planning metadata, browser navigation, or Handraise client authentication. A capability must not be advertised until its end-to-end behavior is installed, detectable and recoverable for that agent.

## Agent guidance

Treat each CLI as an explicit adapter with declared capabilities and degradation states. Reuse the CLI's existing account, keep arguments inert through strict quoting and validation, and make hook installation idempotent and reversible. Coordinate generic lifecycle semantics with Runtime & Worktree Control and capability presentation with Client Experience.

## Territory

`src/config.mjs` agent definitions and invocation logic, `src/hooks.mjs`, `hooks/`, and the agent/hook/doctor portions of `bin/handraise.mjs`, `src/server.mjs`, and `test/`.
