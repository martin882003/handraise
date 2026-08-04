# Read-only analysis runtime

**Status:** implemented provider-neutral runtime foundation

**Runtime version:** 1

Handraise analyzers never receive the target repository as their working
directory. The runtime first previews an exact content manifest, requires that
reviewed manifest to remain current, copies regular files into private storage,
makes the captured source tree read-only and runs the analyzer against that
copy with a separate writable output directory.

## Scope planning

Planning is read-only and Git-aware. It records:

- tracked files at their current working-tree bytes;
- selected modified tracked files (`includeDirty`);
- selected untracked files (`includeUntracked`);
- only explicitly named ignored files, and only after Git confirms them;
- Git HEAD, branch, dirty state and index digest;
- exact SHA-256, size, source kind, executable bit and relative path for every
  selected file;
- every exclusion, truncation and configured file/byte/time/resource budget.

Defaults exclude Git and Handraise internals, dependency/cache/build outputs,
common virtual environments and common secret key/environment file names.
Symbolic links are never followed. Every selected path is normalized,
`lstat`/`realpath` checked and constrained to the repository root. Planning uses
`GIT_OPTIONAL_LOCKS=0` so read operations do not refresh or rewrite the index.

Including ignored files is a host-sensitive operation: both the socket peer and
HTTP Host must establish the existing implicit loopback client. A paired LAN or
Internet client cannot request it. The same host gate applies to model-assisted
or non-local adapters, in addition to any adapter consent requirement.

## Private capture and identity

Runtime data lives under `~/.handraise/analysis` (or the configured state root),
outside and non-overlapping with the repository. Directories are mode `0700`
and metadata files are `0600`. Each job owns:

```text
jobs/<uuid>/
  job.json
  events.ndjson
  manifest.json
  source/       # captured files, 0400/0500 after capture
  output/       # the analyzer's only writable result area
  home/         # isolated HOME/XDG directories
  tmp/
  snapshot.json
```

Capture revalidates the reviewed manifest before copying, validates each file
before/after its read, and recomputes the full manifest afterward. Any mismatch
ends as `stale`; mixed bytes are never published as a coherent current
snapshot. The normalized snapshot identity remains the repository/adaptor,
manifest, analyzer/version and configuration identity defined by the
repository-intelligence contract.

If the repository changes after capture but while analysis runs, the captured
snapshot remains internally coherent and may be retained, but its freshness
and job state are `stale`. It is never represented as current.

## Jobs and process isolation

Lifecycle states are `queued`, `running`, `awaiting-input`, `stale`,
`cancelled`, `failed` and `complete`. Every transition and stage/progress update
is persisted as a bounded event stream, so reconnecting clients recover status.
Jobs interrupted by server restart recover as `stale` with a typed
`SERVER_RESTARTED` reason.

The built-in structural inventory is a trusted in-process, local-only adapter.
External command adapters use:

- one executable plus a string argv array (`shell: false`);
- a private snapshot working directory, isolated HOME/XDG/TMP and a dedicated
  output directory;
- an environment allowlist (`HANDRAISE_*` adapter additions only);
- a detached process group for whole-tree cancellation;
- wall-time and combined stdout/stderr caps;
- Linux `prlimit` address-space, CPU and additional-user-task budgets when
  available, with portable process-group/time/output enforcement elsewhere;
- SIGTERM followed by bounded SIGKILL escalation and awaited process exit.

Analyzer output must validate as a normalized snapshot for the exact reviewed
repository and manifest. A provider exit, timeout, oversized output, malformed
contract, cancellation and repository change have distinct typed outcomes.

## Retention and deletion

Plans expire after 15 minutes by default. Terminal jobs, snapshots, source
copies, output and diagnostics expire after seven days by default. Startup
removes malformed private job state and expires due records. A user can cancel
an active job and delete its complete private directory immediately; cleanup
does not follow analyzer-created symlinks.

## Authenticated API

- `GET /api/analysis/analyzers`
- `POST /api/repositories/:id/analysis/plan`
- `GET /api/repositories/:id/analysis/jobs`
- `POST /api/repositories/:id/analysis/jobs`
- `GET /api/repositories/:id/analysis/jobs/:jobId`
- `POST /api/repositories/:id/analysis/jobs/:jobId/cancel`
- `GET /api/repositories/:id/analysis/jobs/:jobId/snapshot`
- `DELETE /api/repositories/:id/analysis/jobs/:jobId`

The Components surface exposes the same plan → exact manifest → explicit start
flow, durable progress, cancellation, stale/failure states and immediate private
data deletion. Analysis never initializes `.handraise`, creates a worktree or
starts an agent session.
