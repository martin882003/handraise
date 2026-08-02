# Handraise

**Every coding agent on your machine, in one place.**

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
handraise install-hooks
handraise repo add ~/code/my-project
handraise serve
```

Open `http://127.0.0.1:4177` and enter the one-time code printed by
`handraise serve`. The browser receives a revocable, HTTP-only device session;
the code expires after five minutes.

Then start an agent through Handraise so the panel can drive it:

```bash
handraise start api --dir ~/code/my-project --component backend --front auth
handraise start web --dir ~/code/my-project --agent codex --effort xhigh
```

Requires **tmux**, **Node 20+** and **python3**. Works with Claude Code and
Codex today; the panel doesn't care what runs inside the pane, so any CLI agent
shows up — the permission bridge is Claude Code specific.

## Repositories and agent settings

Handraise keeps global settings in `~/.handraise`, but operational data belongs
to the repository that produced it:

- Existing Director repositories are read through their component, front and
  live-lane metadata.
- New repositories can initialize a small `.handraise/` directory for native
  components and fronts.
- Session metadata records the repository, component and front in tmux. Two
  repositories can use the same session name without colliding.
- Claude Code and Codex use the CLI authentication already present on the
  machine. Settings can define global model/effort defaults and override them
  for an individual repository; no provider API key is copied into Handraise.

Useful commands:

```bash
handraise repo list
handraise repo add ~/code/another-project
handraise list
handraise doctor
handraise auth reset --yes   # recovery: revoke every paired browser
```

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

Both are installed at user level and both are inert outside handraise: the
attention hook returns unless tmux carries our prefix, and the permission hook
returns unless `HANDRAISE=1` is set, which only `handraise start` does. Sessions you
open in your own terminal keep their native dialog and never wait on a browser
you aren't looking at.

Your previous `~/.claude/settings.json` is saved next to it as
`settings.json.handraise-backup`.

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
paired with the short-lived terminal code; additional devices use a one-time QR
or code from Settings. Session tokens are random, stored only as SHA-256 hashes
on disk, sent in `HttpOnly`/`SameSite=Strict` cookies and revocable per device.
Unsafe cross-origin API requests are rejected.

Keep it on localhost. If you deliberately bind to a routable address, use a
private network and HTTPS in front of it: the panel can type into and stop real
agent sessions on your machine.

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
device. Open Settings through that HTTPS URL before generating the QR so the QR
contains an address the phone can reach. Do not use Tailscale Funnel for this.

## Status

Public preview. Sessions and permission control are live; repository-scoped
components and fronts are currently portfolio views. Issues and PRs are welcome.

MIT.
