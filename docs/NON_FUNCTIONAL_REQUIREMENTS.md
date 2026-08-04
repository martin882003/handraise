# Handraise non-functional requirements

**Status:** accepted target; Release 0 items are not yet verified

**Effective:** 2026-08-04

These requirements are release gates, not future optimization ideas. A feature
that is functionally correct but violates its applicable budget is not complete.

## Measurement profile

Release evidence records source revision, packaged artifact, OS, CPU, memory,
storage, Node version, fixture version, warm/cold state and sample count.
Performance assertions use at least 30 measured samples after warm-up unless the
case is explicitly a cold-start measurement. CI may use a calibrated relative
regression threshold; the release candidate must also pass the absolute budget
on a reference Linux workstation with at least 4 logical cores, 8 GiB RAM and a
local SSD.

The Release 0 supported envelope is:

- one local Handraise server and one OS user;
- 10 connected repositories;
- 100 components and 1,000 fronts in aggregate;
- 20 managed sessions, of which 10 may be actively producing output;
- 5 authenticated clients, including the implicit local client;
- 10,000 retained lifecycle events inside the configured retention window.

This is a local control plane, not a horizontally scalable hosted service.
Exceeding a declared bound must remain safe and observable: Handraise may
truncate, paginate, aggregate, reject or ask for a narrower scope, but must not
hang, corrupt accepted state or silently drop authority-relevant information.

## Performance

- [ ] **PERF-01 — Server readiness.** From a cold process start with valid local
  state, `/api/readiness` succeeds within 2 seconds at p95 and 4 seconds at p99;
  external agent/analyzer detection may continue asynchronously.
- [ ] **PERF-02 — Core reads.** At the Release 0 envelope, local authenticated
  state, repository portfolio and selected-front reads complete within 250 ms at
  p95 and 500 ms at p99, excluding an explicitly started analyzer/model job.
- [ ] **PERF-03 — Control acknowledgement.** A valid local terminal or lifecycle
  command is accepted or rejected within 300 ms at p95. Its confirmed runtime
  state reaches a connected client within 2 seconds at p95.
- [ ] **PERF-04 — Client usability.** The packaged local client reaches its first
  truthful interactive state within 2.5 seconds at p75 and 4 seconds at p95;
  route changes that use already-loaded data complete within 200 ms at p95.
- [ ] **PERF-05 — Portfolio rendering.** The client renders and filters the
  Release 0 portfolio without a main-thread task over 200 ms and without eagerly
  rendering more than the visible/bounded result set.
- [ ] **PERF-06 — Analysis planning and query.** Scope planning for up to 20,000
  files/256 MiB completes within 30 seconds; a normalized map query over 20,000
  entities and 80,000 relations completes within 250 ms at p95 and returns a
  bounded payload.
- [ ] **PERF-07 — Deterministic planning work.** Excluding an external model's
  response time, map derivation, contract validation and plan publication
  preparation stay within the versioned fixture-class budgets and expose each
  stage separately.

## Scalability and resource bounds

- [ ] **SCALE-01 — Release envelope.** Every Release 0 functional journey passes
  at the declared repository/component/front/session/client/event envelope.
- [ ] **SCALE-02 — Bounded storage and payloads.** State APIs paginate, aggregate
  or truncate with diagnostics; no regular API response exceeds 2 MiB and no SSE
  event exceeds 256 KiB at the Release 0 envelope.
- [ ] **SCALE-03 — Bounded fan-out.** Adding clients does not multiply Git, tmux,
  analyzer or filesystem scans per client. Shared observation is collected once
  and fanned out from bounded cached state.
- [ ] **SCALE-04 — Bounded analysis.** File, byte, output, process, CPU, memory,
  recursion and duration limits are enforced before and during every analyzer;
  limit exhaustion is a typed partial/failed result, never apparent completeness.
- [ ] **SCALE-05 — Bounded memory.** After warm-up, idle RSS remains below 200 MiB
  and RSS remains below 500 MiB at the Release 0 envelope, excluding separately
  supervised analyzer and agent processes.
- [ ] **SCALE-06 — No unbounded retention.** Events, snapshots, drafts, logs,
  audits and temporary artifacts have explicit count/age/byte retention and
  deterministic cleanup that cannot delete accepted repository state.
- [ ] **SCALE-07 — Graceful overload.** Reconnect storms, output bursts and
  concurrent reads remain responsive; writes preserve serialization and return
  typed backpressure/conflict responses rather than queueing without bound.

## Reliability and durability

- [ ] **REL-01 — Restart continuity.** Restarting the server never terminates a
  managed tmux/agent process and restores authenticated local state, repositories,
  runs, jobs and recoverable drafts without inventing success.
- [ ] **REL-02 — Atomic accepted state.** Every multi-file accepted-state change
  is serialized, conflict-safe, all-or-nothing and crash-recoverable.
- [ ] **REL-03 — Idempotent commands.** Retried start, stop, accept, repair and
  cleanup commands have an explicit idempotency contract and never duplicate
  ownership or accepted mutations.
- [ ] **REL-04 — Failure containment.** An unavailable repository, agent,
  analyzer, tunnel or client cannot make unrelated repositories/runs unusable.
- [ ] **REL-05 — Soak stability.** A one-hour Release 0 soak with session output,
  client reconnects and repository refreshes has no crash, unbounded resource
  trend, lost terminal outcome or orphaned temporary process/artifact.

## Security and privacy

- [ ] **SEC-01 — Local trust boundary.** Implicit authority requires both a
  loopback socket peer and exact loopback Host; forwarded headers, LAN, tailnet,
  tunnel and host spoofing never widen it.
- [ ] **SEC-02 — Mutation authorization.** Every state-changing HTTP operation
  enforces authentication, same-origin/CSRF policy, typed validation and the
  narrowest applicable local/remote authority.
- [ ] **SEC-03 — Untrusted inputs.** Repository text, paths, Markdown, analyzer
  output, model output and terminal content cannot become shell commands, HTML,
  arbitrary filesystem targets or accepted truth without validation.
- [ ] **SEC-04 — Credential ownership.** Handraise does not copy provider tokens;
  local secrets and derived state use private permissions and logs redact source,
  credentials and sensitive tool input by default.
- [ ] **SEC-05 — Explicit data egress.** Source/model/tunnel egress identifies
  provider, scope and boundary and requires the declared authority/consent.

## Accessibility and experience integrity

- [ ] **A11Y-01 — Core access.** Every Release 0 journey is keyboard-operable,
  has visible focus, programmatic labels/status/error relationships and passes
  automated high-impact accessibility checks at desktop and mobile widths.
- [ ] **A11Y-02 — Honest state.** Loading, unavailable, unauthenticated, stale,
  partial, failed, experimental and verified states remain distinguishable by
  text/semantics rather than color alone.
- [ ] **A11Y-03 — Motion and terminal safety.** Reduced-motion preferences are
  respected and live terminal/state updates do not steal focus or create an
  unbounded announcement stream.

## Compatibility and operability

- [ ] **COMPAT-01 — Supported versions.** Node, OS, Git, tmux, Claude Code,
  Codex, Graphify, repository schema and browser support are versioned and
  detected; unsupported combinations fail with an actionable capability state.
- [ ] **COMPAT-02 — Explicit migration.** Older supported state remains readable;
  migrations are previewable, scoped, additive where possible, atomic and never
  overwrite concurrent edits implicitly.
- [ ] **OBS-01 — Actionable telemetry.** Jobs and runs expose stage, duration,
  version, bounded resource use and typed failure without recording source or
  credentials by default.
- [ ] **OBS-02 — Release diagnosis.** `doctor`, readiness and release evidence can
  explain which gate failed and how to reproduce it from the candidate artifact.

## Change policy

Budgets may be tightened through normal review. Loosening a budget or shrinking
the supported envelope is a product decision: it requires rationale, updated
fixtures, explicit compatibility notes and a release that does not present the
old capability as still supported.
