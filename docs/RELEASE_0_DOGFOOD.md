# Release 0 — Dogfood core

**Status:** not ready

**Release outcome:** Handraise can be used to implement one bounded Handraise
front in the Handraise repository without leaving the product for normal
planning, launch, control, evidence, handoff or completion operations.

This release intentionally starts from an existing accepted repository
portfolio. Rich repository understanding and generated architecture are not a
prerequisite for bootstrapping dogfood; they become subsequent vertical
releases built through this core.

## Functional contract by component

### Local Platform & Trust

- [ ] **R0-LPT-01 — Deterministic bootstrap.** A packaged `handraise serve`
  reaches truthful local readiness, opens through loopback without pairing and
  reports actionable dependency/state problems without a stack trace.
- [ ] **R0-LPT-02 — Secure repair.** The implicit local client can inspect and
  repair state permissions and supported agent hooks; a remote client cannot
  acquire implicit-local authority.
- [ ] **R0-LPT-03 — Repository connection.** The user can connect the current Git
  root once, see missing/moved-path failures and disconnect without changing the
  repository.
- [ ] **R0-LPT-04 — Restart continuity.** Restarting the exact candidate server
  preserves registration/auth/settings and does not terminate the managed agent.

### Repository Planning

- [ ] **R0-RPL-01 — Honest existing portfolio.** Handraise reads mixed supported
  v1/v2 metadata and displays every current component and open front; an older
  schema cannot silently appear as an empty portfolio.
- [x] **R0-RPL-02 — Scoped compatibility.** When a selected front needs a schema
  upgrade, Handraise previews exact bytes for only that front and referenced
  components, performs no preview mutation and applies only after explicit
  acceptance through an atomic, conflict-safe, no-overwrite operation.
- [ ] **R0-RPL-03 — Executable front selection.** A queued/active front exposes
  outcome, component ownership, checklist, readiness, verification and a single
  unambiguous path to run preflight.
- [ ] **R0-RPL-04 — External edit fidelity.** Accepted Markdown edits made outside
  the client refresh without server restart and cannot be overwritten from a
  stale client view.
- [x] **R0-RPL-05 — Minimal release authority.** The repository has a first-class
  Release 0 contract that selects exact requirements/fronts, shows readiness and
  test blockers, and remains the single delivery-progress authority above runs.

### Agent Integrations

- [ ] **R0-AIN-01 — Truthful supported agent.** Claude Code and Codex each show
  installed/authenticated/capability/hook status from the CLI-owned account; the
  selected release path uses at least one fully ready real agent.
- [ ] **R0-AIN-02 — First-use recovery.** Missing login or hooks has one local,
  observable setup/repair path and refreshes capability status without copying a
  provider credential.
- [ ] **R0-AIN-03 — Context-faithful launch.** Invocation receives the immutable
  accepted front/component/check context and validated inert model/effort values.

### Runtime & Worktree Control

- [ ] **R0-RUN-01 — Side-effect-free preflight.** Preflight binds exact contract
  revisions, dependencies, ownership, Git/worktree risk, agent readiness and
  verification while creating no branch, worktree, session or accepted mutation.
- [ ] **R0-RUN-02 — Explicit isolated start.** One explicit start creates exactly
  one safe branch/worktree/run/tmux ownership set; duplicate/racing starts are
  idempotent or conflict cleanly and failed launch rolls back only new resources.
- [ ] **R0-RUN-03 — Real control loop.** The client shows live escaped terminal
  output, accepts literal text and allow-listed keys, and represents attention,
  permission, error, attachment and connectivity states honestly.
- [ ] **R0-RUN-04 — Evidence-aware progress.** Agent/user task claims, configured
  checks and accepted outcome remain separate. A front cannot become done only
  because the process exited or an agent claimed completion.
- [ ] **R0-RUN-05 — Safe interruption and handoff.** Graceful wrap-up, confirmed
  hard stop, crash, reconnect and cross-agent handoff preserve inspectable state
  and never delete uncommitted/unbacked work implicitly.
- [ ] **R0-RUN-06 — Verifiable completion.** The selected front reaches done only
  after its required checks/evidence and Git safety gate pass, with a durable run
  outcome linked to exact revisions.
- [x] **R0-RUN-07 — Separate ad-hoc work.** A user can start an explicitly labeled
  unplanned run with purpose and safe workspace controls but no front/release
  progress; its outcome may only create a reviewed planning proposal.

### Client Experience

- [ ] **R0-CUX-01 — One primary journey.** From the home/repository view, the user
  can reach selected front → compatibility/readiness → preflight → start → live
  run → evidence → completion without guessing which legacy/new workflow applies.
- [ ] **R0-CUX-02 — Honest recovery.** Loading, offline, stale schema, unavailable
  repository, unauthenticated agent, launch failure, disconnected stream and
  server restart each preserve context and offer the next valid action.
- [ ] **R0-CUX-03 — Core accessibility.** The journey is operable with keyboard,
  visible focus and programmatic status/errors at desktop and mobile widths.
- [ ] **R0-CUX-04 — Surface discipline.** Capabilities outside this gate are not
  presented as complete default paths; unfinished slices are absent or explicitly
  experimental with their limits and no unsafe mutation authority.
- [x] **R0-CUX-05 — Releases and ad-hoc separation.** The client has a Releases
  section for planned delivery and a visually/semantically separate ad-hoc start
  and history path; sessions are never presented as the unit of delivery.

## Required executable cases

The final case IDs must appear in test names/evidence and map back to every
requirement above.

- [ ] **R0-T01 — Cold local bootstrap:** packaged artifact, readiness, loopback
  trust, secure state and actionable repair.
- [ ] **R0-T02 — Existing Handraise portfolio:** exact 7-component/current-front
  fixture, mixed-schema visibility, external refresh and missing-path recovery.
- [x] **R0-T03 — Scoped migration:** byte-identical preview, explicit apply,
  concurrent edit, rollback, repeat/no-op and unrelated-file preservation.
- [ ] **R0-T04 — Preflight/start race:** no preflight side effects, exact manifest,
  duplicate starts, capability loss and launch rollback.
- [ ] **R0-T05 — Real process lifecycle:** real Git + worktree + tmux terminal,
  attention/permission, wrap-up, crash, handoff, checks and completion gate.
- [ ] **R0-T06 — Browser journey:** packaged UI drives T02–T05, including all
  error/recovery states and accessibility assertions.
- [ ] **R0-T07 — Restart/reconnect:** live agent survives candidate-server restart,
  clients recover and durable run/terminal outcome remains truthful.
- [ ] **R0-T08 — Security/adversarial:** host spoofing, forwarded headers, unsafe
  paths/slugs, terminal HTML/control bytes, stale permissions and cross-origin mutation.
- [ ] **R0-T09 — Performance/scale:** all applicable `PERF-*`, `SCALE-*` and
  `REL-05` budgets pass at the Release 0 envelope.
- [ ] **R0-T10 — Handraise builds Handraise:** from the packaged candidate, a real
  supported agent completes one intentionally bounded Handraise front through
  the product and leaves reproducible evidence linked to the candidate revision.
- [x] **R0-T11 — Release gate journey:** create/review Release 0, bind exact fronts
  and requirements, expose blockers, reject stale/skipped evidence and record an
  exact candidate without treating session activity as progress.
- [x] **R0-T12 — Ad-hoc journey:** launch, control, restart, stop and inspect an
  unplanned isolated run; verify zero release progress and explicit promotion to
  a planning proposal without retroactive planned provenance.

## Release gate

Release 0 is ready only when all of the following are true:

- every functional item and executable case above is checked from current,
  reproducible evidence;
- every applicable item in `NON_FUNCTIONAL_REQUIREMENTS.md` passes or is
  explicitly assigned to a later release because the associated capability is
  not exposed in Release 0;
- typecheck, build, all prior regression suites and security checks pass from
  the exact packaged candidate;
- no required test is skipped, todo, flaky-quarantined or dependent on stale
  development-server state;
- R0-T10 succeeds without manual API calls, direct Markdown edits or terminal
  fallback for an operation the product claims to own.

Until this gate passes, broad end-state implementation remains useful inventory,
but Handraise is not described as dogfood-ready.

## Verified evidence

- **R0-RPL-02 / R0-T03 · 2026-08-04:** requirement-linked contract tests cover
  exact non-mutating preview, stale/concurrent baselines, selected-front and
  referenced-component scope, unrelated v1 preservation, atomic rollback and
  repeat no-op. The real packaged-browser smoke reviews and explicitly accepts
  that scoped change before entering run preflight. Verified by `npm test`
  (150/150) and the focused browser smoke (1/1) on the current worktree.
- **R0-RPL-05 / R0-T11 · 2026-08-04:** repository-local release contracts now
  round-trip as human-readable Markdown with exact front and requirement
  membership, optimistic revisions, one-open-release ownership, legal lifecycle,
  atomic serialized writes, stale/skipped evidence rejection and exact candidate
  identity. Authenticated API and packaged-browser tests create, review and
  activate a release while proving that release assembly creates no worktree or
  agent session and that process history remains a separate surface. Verified by
  `npm test` (157/157, zero skipped/todo), focused release API (1/1) and focused
  packaged-browser smoke (1/1) on the current worktree.
- **R0-RUN-07 / R0-CUX-05 / R0-T12 · 2026-08-04:** ad-hoc work now has an explicit
  purpose, optional exact component context, read-only ownership/Git/agent
  preflight, isolated-by-default workspace and revision-bound confirmed start.
  Private durable records preserve process identity, discoveries, observed
  checks, handoff, Git-visible outcome and review-only promotion while hard-coding
  zero requirement/front/release progress and no retroactive planned provenance.
  The packaged client exposes separate Releases, Ad-hoc work and Agent sessions
  routes; its real-Chrome journey proves preflight non-mutation, launch role,
  outcome/promotion persistence, byte-identical accepted front/release state and
  mobile layout. Verified by focused unit tests (5/5), authenticated API and
  real-lifecycle integration (2/2),
  packaged-browser smoke (1/1), type/build gates and `npm test` (164/164, zero
  skipped/todo) on the current worktree. A separate real integration creates an
  actual Git worktree and tmux agent, exercises literal terminal input plus
  pause/resume, recreates the HTTP server, reconciles the same durable `runId`,
  stops and restarts that exact run in the preserved workspace, records its
  terminal outcome and confirms zero accepted delivery mutation. This journey
  also caught and fixed fleet normalization dropping tmux `runId` metadata.
