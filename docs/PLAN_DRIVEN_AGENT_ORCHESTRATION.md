# Plan-driven agent orchestration

**Status:** implemented for native Handraise v2 repositories

**Boundary:** accepted plan → explicit run → reviewed evidence → accepted outcome

Handraise compiles an accepted v2 front into one auditable run. Preparing or
reviewing a run never creates a worktree, starts tmux, edits a contract, invokes
a planning model or exposes the server. Allocation begins only after the same
authenticated client confirms the exact current preflight revision.

Legacy Director repositories keep their existing session path. Handraise does
not pretend that Director Markdown can participate in the native atomic run
contract.

## State transition

```text
accepted front
    │
    ├─ prepare preflight ── read-only, private, expiring
    │       │
    │       ├─ blocked ─── diagnostics + recovery actions
    │       └─ ready
    │             │ exact revision + same actor + explicit confirmation
    │             ▼
    │       final revalidation
    │             │
    │       create/reuse workspace
    │             │ second revalidation
    │             ▼
    │       immutable run manifest ── start tmux agent
    │             │
    │       process / claims / checks / discoveries / handoff
    │             │
    └─────────────┴─ explicit completion gate ── accepted front `done`
```

The private preflight expires after 30 minutes. Its revision binds the actor,
repository, complete accepted front and component snapshots, goals, product
context, dependency revisions/states, selected agent/capabilities, exact
workspace path/branch/revision, source identities, bounded prompt, readiness
diagnostics and optional handoff. Persisted preflights are integrity-checked
before use.

## Immutable run manifest

An accepted start creates a manifest containing:

- the complete front outcome, boundaries, checklist, acceptance criteria,
  verification, evidence, risks and source revision;
- complete selected component responsibility/boundary snapshots, territory,
  verification, evidence and uncertainty;
- linked product goals plus accepted purpose, constraints, invariants and
  resolved decisions;
- hard/coordination dependency states and exact contract revisions;
- repository/workspace revision, branch, path and creation status;
- selected agent, model, effort, integration version, authentication provider,
  capability requirements and capability snapshot;
- the exact bounded execution prompt, its digest and explicit unknowns;
- originating preflight and optional prior-handoff revisions.

The manifest has its own content revision and is never rewritten by runtime
events. Loading a record whose manifest no longer matches that revision fails
closed with `RUN_MANIFEST_CORRUPT`. Mutable process/evidence state lives beside,
not inside, the manifest.

Private records use user-only directories/files under the Handraise state root:

```text
~/.handraise/runs/
  preflights/<repository-key>/<preflight-id>.json
  runs/<repository-key>/<run-id>.json
  locks/<repository-key>/
```

Writes use a same-directory temporary file, file `fsync`, atomic rename and
parent-directory `fsync` with mode `0600`; directories remain `0700`.

## Readiness and concurrency

Readiness fails closed when Handraise cannot inspect accepted contracts,
durable run ownership, Git worktrees or repository Git state. It otherwise
checks:

- native v2 schema and whole-portfolio reference/DAG validity;
- front lifecycle, hard dependencies and missing dependency revisions;
- component/goal availability and analysis-snapshot freshness;
- existing sessions and durable running, paused or awaiting-acceptance runs;
- component and declared-territory overlap across active ownership;
- existing worktree branch, dirty, ahead and local-only commit risk;
- primary-checkout safety for non-isolated execution;
- agent enabled/installed/authenticated state, terminal support, effort support
  and lifecycle/permission hook degradation.

Every diagnostic includes a concrete recovery action. Warnings remain visible
without being inflated into blockers.

Start re-runs readiness under a repository-scoped private run lock. After the
workspace is created or reused, it verifies the exact reviewed Git revision and
re-runs source/capability/ownership readiness before launching the agent. A
changed dependency, contract, capability, active owner or baseline aborts. A
newly created workspace is cleaned up on failure; a reused workspace is
preserved.

Repeated start of the same accepted preflight is idempotent. Separate reviewed
preflights cannot race into duplicate durable ownership.

## Agent context and runtime parity

The agent receives at most 64 KiB of server-generated context. Repository text
is explicitly labeled untrusted project data and cannot override the execution
boundary. The prompt contains all accepted context and says not to assume a
hidden prior conversation.

The run ID is stored in tmux as `@handraise-run`. Existing fleet state therefore
continues to provide live activity, attention, typed permissions, terminal
control, pause/wrap-up and crash status. A missing process changes the effective
run view to `awaiting-acceptance`; it does not fabricate completion. A session
reappearing with the same run ID reconnects process state to the durable run.

## Evidence and lifecycle authority

Handraise records these independently:

- process activity and attention;
- agent checklist claims;
- user or trusted configured-check task evidence;
- acceptance-criterion and verification results;
- discoveries, blockers, decisions and scope changes, including affected
  downstream fronts;
- structured, revisioned handoffs;
- the finally accepted outcome.

An `agent-claim` never edits the accepted checklist and never satisfies the
completion gate. Browser clients cannot self-label evidence as a trusted
`configured-check`; their evidence is normalized to user-observed authority.
The current browser flow deliberately does not execute arbitrary commands
parsed from verification prose.

Verified task updates and the final lifecycle transition use the accepted
front's exact revision and the native serialized writer. Concurrent external
edits fail with a baseline conflict instead of being overwritten.

## Handoff, resume and completion

A handoff records a summary, bounded next steps, blockers, actor, timestamp and
content revision. Resume can select a different supported agent and reuses only
that reviewed handoff plus the immutable accepted context; it does not claim
conversation continuity. Existing risky work is preserved for an explicit
resume rather than silently replaced.

Completion requires all of the following at final revalidation:

1. no active session for the run;
2. the exact current accepted-front revision;
3. every checklist item explicitly done or skipped by non-agent authority;
4. non-agent passing evidence for every exact acceptance criterion and
   verification item;
5. available Git state with no dirty bytes, ahead/local-only commits or branch
   mismatch;
6. an explicit authenticated user action.

Only then is the accepted front transitioned to `done` and the accepted outcome
recorded with actor, time, resulting front revision, Git risks and evidence IDs.

## HTTP surface

All routes use the normal Handraise authentication boundary:

```text
GET  /api/repositories/:repo/runs
POST /api/repositories/:repo/runs/preflight
GET  /api/repositories/:repo/runs/preflight/:preflight
POST /api/repositories/:repo/runs/preflight/:preflight/start
GET  /api/repositories/:repo/runs/:run
POST /api/repositories/:repo/runs/:run/tasks/:index
POST /api/repositories/:repo/runs/:run/checks
POST /api/repositories/:repo/runs/:run/discoveries
POST /api/repositories/:repo/runs/:run/handoff
POST /api/repositories/:repo/runs/:run/complete
```

The browser never supplies an arbitrary launch command. The server builds the
Claude Code or Codex invocation from the reviewed integration and shell-quotes
the bounded prompt.

## Verification

The contract and API tests cover exact manifests, permissions, read-only
preflight, actor/revision confirmation, stale contracts/dependencies,
capability loss, duplicate starts, active ownership, baseline movement,
rollback, corruption, claims versus evidence, Git completion gates, crash,
reconnect and cross-agent handoff/resume. The headless-browser acceptance path
covers preflight review through explicit launch, evidence and outcome
acceptance while asserting no worktree or contract mutation before start.
