# Handraise — functional requirements checklist

Legacy implementation audit: current worktree · 2026-08-03.

> **Revalidation required.** Existing checkmarks predate the requirements-to-test
> and release-evidence rules in
> [ENGINEERING_DELIVERY_CONTRACT.md](./ENGINEERING_DELIVERY_CONTRACT.md). They
> identify implemented/previously exercised behavior, but do not by themselves
> certify a release. Component ownership is indexed in
> [COMPONENT_REQUIREMENTS.md](./COMPONENT_REQUIREMENTS.md); measurable quality
> gates live in
> [NON_FUNCTIONAL_REQUIREMENTS.md](./NON_FUNCTIONAL_REQUIREMENTS.md).

This document describes the product contract visible in the current repository,
including the accepted multi-repository planning and fleet-control layer inspired
by modelARch's Director.

## Status legend

- `[x]` Claimed by the legacy implementation audit; must be revalidated with
  requirement-linked evidence before release.
- `[ ]` Missing or not yet verified end to end.

## Product boundary

- **Server:** the `handraise serve` process owns authentication, settings, API,
  runtime observation and the web application. It starts without requesting a
  credential from the operator.
- **Client:** each browser or installed PWA is a client. Remote clients present a
  one-time credential issued by the server and receive a revocable session;
  direct loopback access is the implicit, non-revocable server-host client.
- **Managed agent:** Claude Code, Codex or another CLI process running inside a
  Handraise-owned tmux session.
- **Repository:** the boundary for components, fronts and associated sessions.
  Product metadata stays in the repository; device and global settings stay in
  Handraise's user state.

Automatic worktree ownership, conversational planning and fleet orchestration
are accepted parts of this contract. Their recorded decisions appear at the end.

## Immediate coverage gaps

- [x] **GAP-01 · Correct offline identity:** a cached client must say that the
  Handraise server is unavailable; it must never render pairing after a network
  failure.
- [x] **GAP-02 · Start from the client:** an authenticated client must be able to
  start an agent session without falling back to the CLI or calling the API by
  hand.
- [x] **GAP-03 · Honest agent capabilities:** every client surface must distinguish
  terminal control from lifecycle attention and typed permissions. Handraise
  currently installs the latter only for Claude Code.
- [x] **GAP-04 · Safe Director writes:** Director repositories must either be
  read-only or mutate through Director's own validated, locked helpers. Direct
  writes to its Markdown sources are not equivalent compatibility.
- [x] **GAP-05 · Complete native lifecycle:** components, fronts and sessions need
  explicit lifecycle operations instead of relying on creation/deletion or a
  disappearing tmux process.
- [x] **GAP-06 · Assisted component discovery:** native repository initialization
  must offer a reviewable, evidence-backed component proposal and create only
  the definitions the user explicitly accepts.

## 1. Server lifecycle

- [x] **SRV-01** `handraise serve` starts the local HTTP server.
- [x] **SRV-02** The server binds to `127.0.0.1` by default and accepts an explicit
  host and port.
- [x] **SRV-03** The server never asks the operator to enter a pairing code. On
  first bootstrap it issues and prints one for a client.
- [x] **SRV-04** Restarting or closing the server does not terminate managed tmux
  sessions.
- [x] **SRV-05** Settings and paired-client state survive a server restart.
- [x] **SRV-06** Port conflicts and bind failures produce a short actionable error,
  not an unhandled Node stack trace.
- [x] **SRV-07** Expose an explicit health/readiness result that does not conflate
  server availability with client authentication.
- [x] **SRV-08** Provide a supported persistent-service workflow and a server
  status command.

## 2. Clients, pairing and authentication

- [x] **AUTH-01** A first client can pair with the short-lived code printed by a
  fresh server.
- [x] **AUTH-02** A paired client can issue a one-time code or QR for another
  client.
- [x] **AUTH-03** Pairing creates a random session token, stores only its hash and
  delivers it in an `HttpOnly`, `SameSite=Strict` cookie.
- [x] **AUTH-04** Pairing credentials expire and repeated invalid attempts are
  rate-limited.
- [x] **AUTH-05** Clients can list and revoke paired clients, while the final
  active client cannot revoke itself accidentally.
- [x] **AUTH-06** `handraise auth reset --yes` provides terminal recovery when no
  paired client remains accessible.
- [x] **AUTH-07** Copy and labels consistently name the browser/PWA as a **client**
  and `handraise serve` as the **server**.
- [x] **AUTH-08** The client distinguishes at least: loading, server unavailable,
  server available but unpaired, authenticated and session expired.
- [x] **AUTH-09** The UI exposes logout; the API already supports it.
- [x] **AUTH-10** When the server has paired clients but the current client is not
  paired, the screen explains both recovery paths: authorize it from an existing
  client or reset authentication from the server host.
- [x] **AUTH-11** Theme and color mode are initialized before authentication so
  pairing, loading and offline screens use the same visual language as the app.
- [x] **AUTH-12** A browser reaching the server directly through a loopback origin
  (`127.0.0.1`, `localhost` or `::1`) is an implicit, non-revocable server-host
  client and does not pair. Eligibility requires both the socket peer address
  and HTTP host to be loopback; forwarding headers never widen this trust. LAN,
  tailnet, public-URL and tunneled clients continue through normal pairing.
- [x] **AUTH-13** “Pair another client” asks whether the client will connect over
  a private network or the Internet. Private-network setup shows server-derived
  host addresses and refuses to advertise them while the server is loopback-only;
  Internet setup requires an explicit HTTPS public/tunnel origin. Both paths
  produce a reachable one-time URL/QR without trusting forwarding headers.
- [x] **AUTH-14** From the Internet pairing path, the implicit server-host client
  can explicitly start, observe and stop a Handraise-managed temporary HTTPS tunnel
  when a supported connector is installed. The UI identifies the third-party
  provider, public exposure and temporary/no-SLA boundary; startup is idempotent,
  uses fixed arguments, never shells user input and only enables pairing after a
  provider-issued HTTPS origin is ready. Existing user-managed HTTPS origins
  remain supported as an advanced path.

## 3. Repository management

- [x] **REPO-01** Connect a local Git repository by path and normalize it to its
  Git root.
- [x] **REPO-02** Prevent duplicate registrations of the same Git root.
- [x] **REPO-03** Browse local directories from the authenticated client.
- [x] **REPO-04** Rename a connected repository and configure its default agent,
  model and reasoning effort.
- [x] **REPO-05** Disconnect a repository without modifying or deleting it.
- [x] **REPO-06** Detect native Handraise metadata, Director metadata or an
  uninitialized repository.
- [x] **REPO-07** Initialize `.handraise/` metadata only after an explicit user
  action.
- [x] **REPO-08** Isolate internal tmux identities by repository so equal display
  names cannot collide.
- [x] **REPO-09** Report a missing, moved or unreadable repository with a recovery
  action instead of an empty portfolio.
- [x] **REPO-10** Validate component and front references when a session is
  associated with a repository.
- [x] **REPO-11** Refresh portfolio state when repository Markdown changes outside
  the current UI.

## 4. Agent integrations

- [x] **AGENT-01** Detect whether Claude Code and Codex are installed.
- [x] **AGENT-02** Reuse each CLI's existing account; Handraise does not copy
  provider API keys.
- [x] **AGENT-03** Enable or disable each supported agent and configure global and
  repository-specific model/effort defaults.
- [x] **AGENT-04** Build quoted CLI invocations so model and effort values remain
  inert arguments.
- [x] **AGENT-05** Launch Claude Code or Codex through the CLI and session API.
- [x] **AGENT-06** Expose session creation in the authenticated client, including
  repository, agent, model, effort, component and optional front.
- [x] **AGENT-07** Show a capability matrix for each agent: terminal control,
  lifecycle attention, typed permissions and graceful wrap-up.
- [x] **AGENT-08** Either install equivalent lifecycle/permission hooks for Codex
  or visibly declare the degradation before launch.
- [x] **AGENT-09** Define whether arbitrary CLI agents are a supported integration
  or only an expert `--command` escape hatch.
- [x] **AGENT-10** Surface launch failure as an actionable client state with a
  retry operation.
- [x] **AGENT-11** An installed but unauthenticated Claude Code or Codex adapter
  can start its first-party interactive login flow from Settings in an observable,
  controllable setup terminal. Handraise refreshes connection status while the
  provider credentials remain owned exclusively by the CLI.

## 5. Session lifecycle and terminal control

- [x] **SESSION-01** Launch an agent in a detached, repository-scoped tmux session.
- [x] **SESSION-02** Store agent, working directory, repository, component and
  front metadata with the tmux session.
- [x] **SESSION-03** List only Handraise-owned tmux sessions as controllable.
- [x] **SESSION-04** Display registered Director lanes not started by Handraise as
  read-only external sessions.
- [x] **SESSION-05** Capture scrollback with ANSI formatting and escape terminal
  markup before rendering it.
- [x] **SESSION-06** Send free text literally and accept special keys only from a
  closed allow-list.
- [x] **SESSION-07** Send messages, Escape, arrows and Ctrl-C from the client.
- [x] **SESSION-08** Ask an agent to wrap up gracefully and wait for evidence that
  it stopped working.
- [x] **SESSION-09** Keep a failed CLI pane available so its error can be inspected.
- [x] **SESSION-10** Start a session from a queued front with one explicit Play
  action.
- [x] **SESSION-11** Display `error` as a first-class status and offer retry.
- [x] **SESSION-12** Provide explicit pause and resume semantics, or explicitly
  reject them from the base product.
- [x] **SESSION-13** Provide an intentional hard-stop control with confirmation;
  the backend operation exists but the UI does not expose it.
- [x] **SESSION-14** Represent completed sessions or retain a useful completion
  record instead of silently removing them when tmux exits.
- [x] **SESSION-15** Show whether a tmux session is currently attached elsewhere.

## 6. Attention and notifications

- [x] **ATTN-01** Derive `working` versus `waiting` from lifecycle events rather
  than parsing pane output.
- [x] **ATTN-02** Record why and since when a session needs the user.
- [x] **ATTN-03** Sort blocked and waiting sessions ahead of working sessions.
- [x] **ATTN-04** Watch attention and permission files for immediate updates, with
  periodic polling as fallback.
- [x] **ATTN-05** Drop stale attention records after their validity window.
- [x] **ATTN-06** Send desktop notifications through `notify-send` when available.
- [x] **ATTN-07** Show notification support as a platform capability; current
  desktop notifications are Linux-specific and optional in practice.
- [x] **ATTN-08** Add supported lifecycle statuses for error, paused and completed
  sessions if those lifecycles are adopted.
- [x] **ATTN-09** Provide an idempotent hook uninstall/repair workflow.

## 7. Typed permission decisions

- [x] **PERM-01** Convert a Claude Code `PermissionRequest` into a typed pending
  request rather than inferring a prompt from terminal text.
- [x] **PERM-02** Seal the request with PID, process start time and boot identity.
- [x] **PERM-03** Display Allow once and Deny actions on the exact pending request.
- [x] **PERM-04** Reject stale, changed or already-resolved requests.
- [x] **PERM-05** Return to the agent's native permission flow when Handraise does
  not answer before timeout.
- [x] **PERM-06** Show the complete relevant tool input and permission suggestions,
  with safe redaction rules where needed; the current card shows a summary.
- [x] **PERM-07** Allow an optional denial reason and return it to the requesting
  agent.
- [x] **PERM-08** Resolve Codex permission parity or expose its absence as an
  agent capability difference.

## 8. Components

- [x] **COMP-01** List repository components and show their aggregate progress and
  front counts.
- [x] **COMP-02** Create a component with title, scope, limits, agent guidance and
  territory.
- [x] **COMP-03** Edit that component definition.
- [x] **COMP-04** Persist native components as human-readable repository Markdown.
- [x] **COMP-05** Read Director component contracts and normalize their Spanish
  field names for the client.
- [x] **COMP-06** Support explicit active/closing lifecycle transitions.
- [x] **COMP-07** Support component ordering.
- [x] **COMP-08** Remove only an empty component, with an actionable list of open
  work when removal is refused.
- [x] **COMP-09** Make native component writes atomic and serialized.
- [x] **COMP-10** Route Director component mutations through its validated helper,
  including its lock and open-work checks.
- [x] **COMP-11** During native repository initialization, offer an optional,
  read-only discovery pass over repository structure, documentation, manifests,
  tests and configuration. It proposes responsibility-oriented components rather
  than mechanically mirroring folders, and supplies every contract field plus
  concise repository evidence and any material uncertainty.
- [x] **COMP-12** Let the user review, edit, remove and regenerate proposed
  components before accepting them. Discovery must not mutate repository metadata,
  and the user can skip it and initialize an empty portfolio.
- [x] **COMP-13** On explicit acceptance, create the selected component contracts
  in one serialized, atomic operation. Reject conflicts and never overwrite an
  existing component definition implicitly.

## 9. Fronts

- [x] **FRONT-01** List fronts by component and state.
- [x] **FRONT-02** Derive checklist progress, next open item and done state from
  repository Markdown.
- [x] **FRONT-03** Read impact/complexity priority from native metadata or a
  Director priority catalog.
- [x] **FRONT-04** Create a basic queued front with title, next step, impact and
  complexity.
- [x] **FRONT-05** Display front detail and link an associated session.
- [x] **FRONT-06** Create a complete executable plan: observable outcome,
  confirmed context, handoff and an ordered multi-item checklist.
- [x] **FRONT-07** Edit front definition, checklist, state and priority.
- [x] **FRONT-08** Support explicit queued, active, blocked, paused and done
  transitions with a single source of truth.
- [x] **FRONT-09** Prevent deletion whenever any live Handraise or Director session
  is associated with the front.
- [x] **FRONT-10** Make native front creation/deletion atomic and serialized.
- [x] **FRONT-11** Route Director front creation through its helper so component
  lifecycle, reserved slugs, priority catalog and management lock are respected.
- [x] **FRONT-12** Start or resume the associated session from the front detail.

## 10. Live updates, offline behavior and PWA

- [x] **LIVE-01** Stream session state to authenticated clients with SSE.
- [x] **LIVE-02** Reconnect after transient SSE failures.
- [x] **LIVE-03** Ship a responsive web interface, manifest and installable PWA
  shell.
- [x] **LIVE-04** Support a configured public URL when generating remote-client QR
  codes.
- [x] **LIVE-05** Distinguish API/network failure from an unauthenticated response.
- [x] **LIVE-06** An offline cached shell displays an explicit offline state and
  disables server-backed actions.
- [x] **LIVE-07** Service-worker cache upgrades cannot leave an old shell
  impersonating the current application.
- [x] **LIVE-08** External component/front/priority changes reach the client
  without requiring a page reload or a Handraise-originated mutation.
- [x] **LIVE-09** Loading, pairing, offline and authenticated surfaces share the
  selected visual theme.
- [x] **LIVE-10** Clients remain operational when an HTTPS tunnel does not carry
  Server-Sent Events: the workbench falls back to authenticated state polling,
  reports connectivity from successful API reads and resumes streaming when it
  becomes available.

## 11. Safety and recovery

- [x] **SAFE-01** Authenticate every API route except authentication status and
  the pairing exchange.
- [x] **SAFE-02** Reject unsafe cross-origin mutations.
- [x] **SAFE-03** Send restrictive CSP, frame, referrer and content-type headers.
- [x] **SAFE-04** Validate session/control slugs before constructing tmux targets.
- [x] **SAFE-05** Validate that permission decisions still target the same live
  request.
- [x] **SAFE-06** Confirm destructive repository/front actions in the current UI.
- [x] **SAFE-07** Default to localhost and warn when binding to a routable host.
- [x] **SAFE-08** Use adapter-specific mutation boundaries so compatibility never
  weakens a repository's native safety guarantees.
- [x] **SAFE-09** Give every destructive lifecycle operation a preflight summary
  of what will stop, change or be removed.
- [x] **SAFE-10** Provide recovery guidance for stale runtime files, missing paths,
  failed agents and inaccessible paired clients.

## 12. CLI and diagnostics

- [x] **CLI-01** Provide `serve`, `start`, `list`, repository add/list/remove,
  authentication reset, hook installation and `doctor` commands.
- [x] **CLI-02** `doctor` checks tmux, Node, Python, Claude hook wiring and the state
  location.
- [x] **CLI-03** `doctor` also checks Node compatibility, agent installation and
  authentication, Codex hook capability, state permissions and stale runtime.
- [x] **CLI-04** Provide server status and supported service install/uninstall
  commands.
- [x] **CLI-05** Provide hook uninstall and version-aware repair commands.
- [x] **CLI-06** Use server/client terminology consistently in help and runtime
  output.

## 13. Verification coverage

- [x] **TEST-01** Cover pairing persistence, token hashing, revocation and invalid
  codes.
- [x] **TEST-02** Cover repository normalization and basic Director portfolio
  parsing.
- [x] **TEST-03** Cover tmux ownership prefix, literal input, key allow-list and
  repository session-name isolation.
- [x] **TEST-04** Cover live-process seals, stale permissions, status precedence
  and ANSI escaping.
- [x] **TEST-05** Add API integration tests for authentication, repository,
  component, front, session and permission routes.
- [x] **TEST-06** Add hook tests for attention and permission timeout/decision
  behavior.
- [x] **TEST-07** Add UI tests for offline versus pairing, client lifecycle and
  destructive confirmations.
- [x] **TEST-08** Add a browser smoke test for first-client pairing through the
  authenticated workbench.
- [x] **TEST-09** Add compatibility tests proving Director writes preserve its
  invariants or are refused as read-only.
- [x] **TEST-10** Add a real-tmux lifecycle smoke test for start, terminal control,
  wrap-up, failure retention and stop.
- [x] **TEST-11** Cover remote-access classification and pairing origins, reject
  unreachable or insecure modes, and verify the interactive agent setup boundary
  without copying provider credentials.
- [x] **TEST-12** Cover managed-tunnel availability, idempotent start, provider URL
  parsing, early exit, timeout and explicit stop, plus the UI start-to-QR flow and
  state polling when SSE is unavailable.

## Accepted product decisions

- [x] **DEC-01** Handraise owns explicit per-front worktree and branch creation,
  while allowing the operator to opt out and use the selected directory.
- [x] **DEC-02** Components and fronts are planning authorities with complete,
  editable contracts rather than display-only portfolio metadata.
- [x] **DEC-03** Handraise enforces one live owner per front/lane and derives
  dirty, ahead, behind, unbacked and branch-mismatch evidence from Git.
- [x] **DEC-04** A global conversational Fleet Director may propose and, only
  after exact user confirmation, apply component/front operations through the
  typed adapter-aware mutation boundary.
- [x] **DEC-05** The home screen provides actionable fleet verdicts, attention,
  repository risk and cross-repository activity instead of navigation alone.
- [x] **DEC-06** Runtime discovery is intentionally bounded to Handraise-owned
  sessions and registered Director lanes; arbitrary external tmux sessions stay
  outside the control boundary.
- [x] **DEC-07** Durable outcomes, a 14-day activity heatmap and seven-day
  throughput summaries are part of the product.

modelARch's Director remains the reference adapter for this product layer.
Handraise shares typed planning and runtime ownership contracts with it without
copying or weakening Director's repository-native validation and locking.
