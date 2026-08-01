# Handraise

**Every coding agent on your machine, in one place.**

If you run more than one coding agent at a time, the thing that breaks your day
isn't the agents — it's walking terminal to terminal to find the one sitting
there waiting for permission.

Handraise puts all of them in one view: what each one is doing, how long it's been
at it, and the permission request as something you answer right there. When
reading the status isn't enough, the live terminal is one click away and you can
type into it.

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

## Install

```bash
npm install -g handraise     # or: git clone && npm link
handraise install-hooks      # wires the attention + permission hooks
handraise serve              # http://127.0.0.1:4177
```

Then start an agent through handraise so the panel can drive it:

```bash
handraise start api --dir ~/code/api
handraise start web --dir ~/code/web --agent codex
```

Requires **tmux**, **Node 20+** and **python3**. Works with Claude Code and
Codex today; the panel doesn't care what runs inside the pane, so any CLI agent
shows up — the permission bridge is Claude Code specific.

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

## How it stays honest

A few rules the code holds to, because each one was a bug first:

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

## Security

Handraise binds to `127.0.0.1` and has no authentication, because it drives real
agents with real permissions on your machine. If you point `--host` at anything
routable, put something that authenticates in front of it. There is no relay and
nothing leaves your machine.

## Status

Early. It's the panel I use every day to run my own fleet; it does what's
described above and not much more. Issues and PRs welcome — especially from
anyone running agents I haven't tried.

MIT.
