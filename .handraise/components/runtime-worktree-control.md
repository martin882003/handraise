---
slug: runtime-worktree-control
title: Runtime & Worktree Control
state: active
order: 1
since: 2026-08-03
---
## Scope

Own the reliable execution and control of managed agent sessions: tmux lifecycle, live terminal interaction, status derivation, graceful and hard stops, worktree isolation, Git safety signals, and recovery of failed or completed runs.

## Limits

Does not define provider-specific authentication or hook installation, repository planning semantics, browser interaction design, or device pairing. It must not infer lifecycle state from terminal text or remove a worktree with uncommitted or unbacked work.

## Agent guidance

Preserve process identity and repository isolation across every operation. Prefer explicit lifecycle evidence over timing heuristics, send user text literally, keep special-key handling allow-listed, and treat Git state as a safety boundary. Coordinate contract changes with Agent Integrations, Repository Planning, and Client Experience before changing shared session payloads or routes.

## Territory

`src/control.mjs`, `src/state.mjs`, `src/worktrees.mjs`, and the session/worktree control contracts and endpoints in `src/server.mjs`. Runtime-facing tests in `test/` belong here; browser rendering of those contracts belongs to Client Experience.
