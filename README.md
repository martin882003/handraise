# Handraise

**Understand the system. Design the work. Run the agents.**

If you run more than one coding agent at a time, the thing that breaks your day
isn't the agents — it's walking terminal to terminal to find the one sitting
there waiting for permission.

Handraise puts them in one view: what each one is doing, how long it has been at
it, and the permission request as something you answer right there. Repositories
are the boundary, so every repo keeps its own components, work fronts and
sessions. When the status is not enough, the live terminal is one click away and
you can type into it.

It runs entirely on your machine, on top of tmux. Closing the browser kills
nothing — the sessions are tmux sessions, so you can `tmux attach` from any
terminal and carry on.

```
┌─ api ───────────────── needs you · 40s ─┐  ┌─ web ──────────────── working ─┐
│ claude · ~/code/api                     │  │ codex · ~/code/web             │
│ ┌─────────────────────────────────────┐ │  │ seen 0m ago                    │
│ │ Bash: npm run migrate -- --force    │ │  └────────────────────────────────┘
│ │           [ Allow once ]  [ Deny ]  │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

## Install from source

```bash
git clone https://github.com/martin882003/handraise.git
cd handraise
npm install
npm run build
npm link
handraise hooks install
handraise repo add ~/code/my-project
handraise serve
```

Open `http://127.0.0.1:4177` on the server host. Direct loopback access is the
implicit server-host client, so it enters immediately and never creates a paired
device record. A browser reaching Handraise over LAN, tailnet, a public URL or a
tunnel enters the one-time code printed by `handraise serve`; it receives a
revocable, HTTP-only client session and the code expires after five minutes.

From **Settings → Pair another client**, choose how the other client will reach
the server. **Private network** lists this computer's LAN/tailnet addresses and
only enables its QR when Handraise is listening on that address; when the server
is still localhost-only, the dialog shows the exact foreground and service
restart commands. **Internet** requires the HTTPS URL of an already-running
tunnel or reverse proxy. When `cloudflared` is installed, the server-host client
can explicitly create and stop a temporary Cloudflare Quick Tunnel directly in
that dialog; Handraise waits for the provider URL before enabling its QR. An
existing HTTPS origin remains available as the advanced path.

Connect a repository in Settings. A native v2 front uses **Review run
preflight** to cross from an accepted plan into execution; **New session** stays
available for general and legacy work. The CLI remains available for scripting
and expert flows:

```bash
handraise start api --dir ~/code/my-project --component backend --front auth
handraise start web --dir ~/code/my-project --agent codex --effort xhigh
```

Requires **tmux**, **Node 20+** and **python3**. Claude Code and Codex are the two
supported client integrations, with declared terminal, lifecycle, permission
and graceful-wrap-up capabilities. An arbitrary `--command` is intentionally a
CLI-only escape hatch rather than an advertised browser integration.
`cloudflared` is optional and enables one-click temporary Internet tunnels.

## Repositories and agent settings

Handraise keeps global settings in `~/.handraise`, but operational data belongs
to the repository that produced it:

- Existing Director repositories are read through their component, front and
  live-lane metadata. Mutations use Director's validated helpers or remain
  explicitly read-only; Handraise never edits Director Markdown as a shortcut.
- New repositories can initialize a small `.handraise/` directory. An optional
  read-only discovery pass proposes responsibility-oriented components with
  evidence and uncertainty, and writes nothing until the reviewed set is
  explicitly accepted.
- Native components and fronts have editable contracts, ordered checklists and
  explicit lifecycle states. Their writes are serialized and atomic.
- Session metadata records the repository, component and front in tmux. Two
  repositories can use the same session name without colliding.
- A front can own an isolated Git worktree and branch. The client surfaces dirty,
  ahead, behind, branch-mismatch and local-only commit risks before removal or
  lifecycle actions.
- Claude Code and Codex use the CLI authentication already present on the
  machine. Settings can define global model/effort defaults and override them
  for an individual repository. If an installed CLI is not authenticated,
  **Connect Claude Code** or **Connect Codex** opens its first-party login in a
  controllable setup terminal and refreshes status after sign-in; no provider
  credential is copied into Handraise.

Useful commands:

```bash
handraise repo list
handraise repo add ~/code/another-project
handraise list
handraise doctor
handraise server status
handraise hooks status
handraise service install    # Linux/systemd user service
handraise auth reset --yes   # recovery: revoke every paired remote client
```

## Understand and design before agents run

From a repository's **Components** page, **Analyze repository** builds an exact,
private, read-only snapshot. The built-in inventory always works; an existing
compatible Graphify installation adds a richer local code graph without
installing anything or writing `graphify-out/` into the repository.

The repository's **Map** view turns that immutable snapshot into bounded
responsibility, module, deployable, dependency, interface, data, test, external
system and change-coupling lenses. Every grouping exposes its evidence,
provenance, uncertainty and alternatives. Missing capabilities remain visible,
and the map is always labeled derived—not an accepted component model. Search,
neighborhoods, reverse dependencies, snapshot comparison and Markdown/JSON
export stay read-only. The contract and limits are documented in
[docs/SEMANTIC_SYSTEM_MAP.md](docs/SEMANTIC_SYSTEM_MAP.md).

**Design architecture** turns a selected map plus accepted product direction
into a private component-design workspace. It compares responsibility-first,
deployable/hybrid, current accepted and optional validated-model alternatives;
shows coverage, cohesion, coupling, overlap, cycles and orphan evidence; and
lets you answer boundary questions, edit every component-v2 field, lock,
reorder, split, merge, add, delete, compare, regenerate or skip. Every field
links back to evidence/intent or exposes its assumption, and no repository
contract is written or published from this workspace. The implemented boundary
is documented in
[docs/COMPONENT_ARCHITECTURE_DESIGNER.md](docs/COMPONENT_ARCHITECTURE_DESIGNER.md).

**Plan fronts** then combines one reviewed component alternative with an
accepted or explicit partial product goal. It proposes parallel outcome slices
and a risk-first vertical alternative, routes genuine unknowns into
decision/research work, and shows the hard-dependency DAG, ready set, critical
path, safe concurrency and ownership/territory collisions. Every complete
front-v2 field is editable, grounded and lockable; portfolios can be compared,
reordered, split, merged, extended, regenerated or skipped. This workspace also
remains private—no accepted Markdown, worktree or agent exists until the later
publication boundary. See
[docs/FRONT_PLANNING_ASSISTANT.md](docs/FRONT_PLANNING_ASSISTANT.md).

**Review publication** is the sole acceptance boundary. It offers explicit
components-only, product-plus-components and complete-plan scopes, renders the
exact byte and relationship diff, binds confirmation to one authenticated
client and one revision, then revalidates source/snapshot/baselines under a
repository lock. Native writes are journaled, rollback-safe, crash-recoverable
and idempotent; unsupported Director atomicity fails read-only. No worktree or
agent starts as a side effect. See
[docs/TRANSACTIONAL_PLAN_PUBLICATION.md](docs/TRANSACTIONAL_PLAN_PUBLICATION.md).

Open an accepted native v2 front and choose **Review run preflight** to inspect
the exact contract/component/goal revisions, dependency and ownership state,
agent capability snapshot, Git workspace revision and complete bounded prompt.
The review is read-only. The same authenticated client must confirm its exact
revision before Handraise creates or reuses a worktree and starts tmux. Runtime
activity, agent claims, reviewed checks, discoveries, handoffs and accepted
completion remain separate; completion fails while the process is active or
checklist, acceptance, verification or Git evidence is unsafe. See
[docs/PLAN_DRIVEN_AGENT_ORCHESTRATION.md](docs/PLAN_DRIVEN_AGENT_ORCHESTRATION.md).

After a later read-only snapshot, **Architecture reconciliation** separates
content/graph change from analyzer and inference change, then traces stale
evidence, boundary crossings, unowned/overlapping territory, new system surfaces
and run discoveries into affected product claims, components, fronts and runs.
Findings retain confidence, provenance, alternatives and stable decision memory.
Dismiss, defer and accept-for-planning are private review outcomes: accepted
contracts remain byte-identical until a separate reviewed publication. Plan
publication and run completion only recommend an explicit refresh; they never
start analysis by themselves. See
[docs/CONTINUOUS_ARCHITECTURE_RECONCILIATION.md](docs/CONTINUOUS_ARCHITECTURE_RECONCILIATION.md).

**Outcome learning proposals** then correlate exact accepted run/check evidence
and reviewed drift with exact product/component/front revisions. Discoveries
and agent claims retain their weaker authority. Users can dismiss, defer,
reopen, give private feedback or route a current proposal into the existing
product, component or front editor; accepted contracts still change only through
explicit transactional publication. Feedback adjusts inspectable local ranking
only. There is no telemetry: an optional anonymized benchmark payload requires
an exact host-only preview and confirmation, then downloads locally without an
external request. See
[docs/OUTCOME_LEARNING_LOOP.md](docs/OUTCOME_LEARNING_LOOP.md).

Planning releases are measured by a versioned executable benchmark, not by
model confidence. Ten synthetic repository classes exercise the real snapshot,
map, component, front, contract and reconciliation boundaries; hard safety,
evidence, mutation, schema and security failures have zero tolerance. The
checked report publishes exact versions, baseline/current attribution and
limitations without retaining source. Independent blind owner reviews remain a
separate required Gate C, so a missing human phase is reported as `blocked` and
prevents package promotion. See
[docs/PLANNING_QUALITY_EVALUATION.md](docs/PLANNING_QUALITY_EVALUATION.md) and the
[latest benchmark report](benchmark/results/latest.md).

**Design with model** can then combine a selected snapshot with accepted product
direction, current components/fronts and one explicit planning request. Before
anything leaves the machine, the server-host browser shows every selected
snippet, digest, byte count, provider/model and destination. A paired remote
browser cannot authorize this transfer. The result is schema-validated,
evidence-grounded and retained as a private proposal—nothing is initialized,
accepted or published implicitly, and manual component/front editing always
remains available.

The first supported planning adapter is an audited Codex CLI version using the
CLI's existing ChatGPT authentication; provider credentials are not copied into
Handraise. Claude Code planning appears honestly unavailable for now because its
minimal isolated mode cannot reuse OAuth/keychain authentication. This does not
affect normal Claude Code sessions or their first-time login flow. The full
boundary and version policy is documented in
[docs/PLANNING_MODEL_RUNTIME.md](docs/PLANNING_MODEL_RUNTIME.md).

## What the two hooks do

Everything above works without them except the two things that matter most, so
`install-hooks` is not optional decoration:

- **attention** — turns lifecycle events into "this session is waiting on you,
  since when, and why", plus a desktop notification. It deliberately stays quiet
  for short turns: notifying on every turn makes the session you're already
  looking at a source of noise.
- **permission** — `PermissionRequest` is synchronous, so the agent genuinely
  waits for the answer. The request becomes a typed JSON file, you press a button
  in the browser, and the hook returns `allow` or `deny`. **No keystrokes are
  guessed and no screen is parsed** — you're answering the request itself.

Both hooks are wired for Claude Code and Codex at user level and are inert
outside Handraise: the
attention hook returns unless tmux carries our prefix, and the permission hook
returns unless `HANDRAISE=1` is set, which only `handraise start` does. Sessions you
open in your own terminal keep their native dialog and never wait on a browser
you aren't looking at.

Install, repair and uninstall are idempotent and preserve unrelated hook entries.
The first Claude settings update also saves
`~/.claude/settings.json.handraise-backup`; Codex asks for one explicit trust
review through `/hooks` after an install or repair.

## Runtime guarantees

The control path follows a few strict rules:

- **The pane's output never decides whether a session is waiting on you.**
  Drawing a dialog produces output too, so "it printed something recently" would
  hide a real wait. Only lifecycle events move a session in and out of waiting.
- **Activity comes from tmux `window_activity`, not `session_activity`.** The
  session one freezes when the session is created, so an agent that's working
  looks idle.
- **A permission request with no live process behind it is dropped, not shown.**
  The hook seals each request with its pid, process start time and boot id. A
  button that decides nothing is worse than no button.
- **Free text is always sent literally** (`send-keys -l`) and the special keys
  are a closed list. `send-keys` without a filter is arbitrary execution.
- **Wrapping up is asking, not killing.** The session is told to finish, and the
  panel waits for a real signal — the harness saying it's done, or the pane going
  quiet — never a timer.

## Security and pairing

Handraise binds to `127.0.0.1` by default and has no relay. The first browser is
implicit only when both its socket peer and exact HTTP Host are loopback
(`127.0.0.1`, `localhost` or `::1`). Forwarding headers are never trusted for
this decision. Every remote client pairs with a short-lived terminal code or a
one-time QR/code from Settings. Session tokens are random, stored only as SHA-256
hashes on disk, sent in `HttpOnly`/`SameSite=Strict` cookies and revocable per
client. Unsafe cross-origin API requests are rejected.

Keep it on localhost unless remote access is intentional. Direct private-network
pairing requires listening on a private interface (for example with `--host
0.0.0.0`) and should be used only on a trusted network. Internet access uses
either an explicitly started managed Quick Tunnel or an existing HTTPS tunnel or
reverse proxy. Only the implicit server-host client may start or stop managed
public exposure. The panel can type into and stop real agent sessions on your
machine, so do not expose the raw HTTP listener publicly.

## Open it from your phone

The interface is responsive and installable from the browser as a home-screen
app. For private access away from the workstation, keep Handraise bound to
localhost and use [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve):

```bash
handraise serve
tailscale serve --bg http://127.0.0.1:4177
```

Open the HTTPS URL reported by Tailscale on a phone in the same tailnet. Tailnet
access controls stay in front of Handraise, and Handraise still requires a paired
client. The first remote client can use the code printed by the server; additional
clients can use Settings from that reachable origin. You can also restart with
`HANDRAISE_PUBLIC_URL=https://<tailscale-name>` so locally generated QR codes use
the tailnet URL.

For temporary Internet access without Tailscale on the phone, install
`cloudflared`, open Handraise locally and choose **Pair another client → Internet
→ Create temporary tunnel**. Handraise supervises the connector, displays its
random HTTPS URL and enables the one-time QR; reopening the dialog lets the
server-host client stop it. The tunnel also stops with Handraise. Quick Tunnels
are public, pass traffic through Cloudflare, have no uptime guarantee and are
appropriate for testing or short-lived access rather than production; see the
[Cloudflare Quick Tunnel contract](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).
Because that mode does not transport SSE, the client automatically falls back
to authenticated polling for live state.

## Status

Public preview. Fleet verdicts, repository planning, assisted discovery,
worktree ownership, session lifecycle, typed permissions, remote pairing and
offline-safe PWA behavior are live. Issues and PRs are welcome.

MIT.
