#!/usr/bin/env python3
"""Attention routing: which session is waiting on you, and since when.

With several agents running in parallel the problem is not seeing their state —
any dashboard can show that — it is that none of them tells you when it's your
turn. This hook turns lifecycle events into two things: a desktop notification
and a state file the panel reads.

Wire it with `async: true` so it never adds latency to a turn.

Events → state:
  UserPromptSubmit  you're back: the session goes to `working` and the clock starts
  Stop              the turn ended → `waiting`
  Notification      a permission or a question is blocking → `waiting` (urgent)
  SessionEnd        the session died → its state file is removed

The notification does NOT fire in every case, on purpose. `Stop` runs at the end
of EVERY turn: notifying always turns the session you are already looking at into
a source of noise. It only fires when the turn ran longer than LONG_TURN — by
then you have moved to another session, which is exactly when it helps. A blocked
permission always notifies: that stops work whether or not you are watching.
"""
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

# Seconds of turn after which we assume you went to do something else.
LONG_TURN = 90

CLEAR = {"SessionEnd"}
# What proves a session is NOT waiting on you is another lifecycle event, never
# output on the pane. Drawing a dialog also produces output, and that is exactly
# what can hide a real wait: the agent redraws its prompt, the pane looks busy,
# and the panel decides nobody is blocked. So `PostToolUse` and
# `PermissionDenied` are what clear a wait — the agent moved on by itself.
START = {"UserPromptSubmit", "PostToolUse", "PermissionDenied"}
REASONS = {
    "Stop": "finished its turn",
    "Notification": "is waiting for you",
    "TeammateIdle": "went idle",
    "StopFailure": "stopped with an error",
}
# Two different things: ALWAYS_NOTIFY means "this doesn't depend on how long the
# turn was" — a blocked permission needs you either way — and URGENT is the level
# of the notice. Only what BLOCKS work is urgent.
ALWAYS_NOTIFY = {"Notification", "TeammateIdle"}
URGENT = {"Notification"}


def state_dir() -> Path:
    """Where handraise keeps its runtime state. One directory, no repo required."""
    root = os.environ.get("HANDRAISE_HOME") or str(Path.home() / ".handraise")
    return Path(root)


def session_slug() -> str | None:
    """The handraise session this hook is running inside, asked to tmux itself.

    The pane knows its own name, so there is nothing to infer from paths: if the
    tmux session carries our prefix, its slug is the answer, and if we are not
    inside a handraise session there is nothing to report.
    """
    if not os.environ.get("TMUX"):
        return None
    try:
        name = subprocess.run(
            ["tmux", "display-message", "-p", "#{session_name}"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return name[len("handraise-"):] if name.startswith("handraise-") else None


def tmux_option(name: str) -> str:
    try:
        return subprocess.run(
            ["tmux", "show-options", "-v", name], capture_output=True, text=True, timeout=5,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def record_session_end(root: Path, slug: str, session: str, cwd: str, payload: dict) -> None:
    """Durable fallback for turns that end while the Handraise server is down."""
    directory = root / "history"
    directory.mkdir(parents=True, exist_ok=True)
    now = time.time()
    started = float(tmux_option("@handraise-started") or 0)
    event_id = uuid.uuid4().hex
    event = {
        "id": event_id, "type": "ended", "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        "slug": tmux_option("@handraise-slug") or slug,
        "controlSlug": slug, "repoId": tmux_option("@handraise-repo") or None,
        "component": tmux_option("@handraise-component") or None,
        "front": tmux_option("@handraise-front") or None,
        "agent": tmux_option("@handraise-agent") or None,
        "role": tmux_option("@handraise-role") or "agent",
        "cwd": tmux_option("@handraise-cwd") or cwd,
        "sessionId": session, "reason": payload.get("reason") or "session ended",
        "startedAt": started or None, "durationSeconds": round(now - started) if started else None,
    }
    path = directory / f"{round(now * 1000):013d}-{event_id}.json"
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(event, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def notify(title: str, body: str, urgent: bool, key: str) -> None:
    """The notification clears itself.

    ⚠️ Never `-u critical`: by specification a critical notification does NOT
    expire and has to be dismissed by hand. What sets a blocked permission apart
    is not urgency, it is how long it stays on screen.

    The replacement key is PER SESSION. With a global key, one session's notice
    overwrites another's and two agents waiting on you look like one.
    """
    seconds = 15 if urgent else 8
    try:
        subprocess.run(
            ["notify-send", "-a", "Handraise", "-u", "normal", "-t", str(seconds * 1000),
             "-h", f"string:x-canonical-private-synchronous:handraise-{key}", title, body],
            timeout=5, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        pass  # with no graphical session the state is still written; the notice is a bonus


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, AttributeError):
        return
    event = payload.get("hook_event_name") or ""
    session = payload.get("session_id") or "no-session"
    cwd = payload.get("cwd") or os.getcwd()

    slug = session_slug()
    if slug is None:
        return  # not running inside a handraise session: nothing to report

    directory = state_dir() / "attention"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{session}.json"

    if event in CLEAR:
        record_session_end(state_dir(), slug, session, cwd, payload)
        path.unlink(missing_ok=True)
        return

    previous = {}
    try:
        previous = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pass

    now = time.time()

    if event in START:
        # The clock only restarts when you actually came back. A tool call that
        # clears a wait should not reset how long the turn has been running.
        since = previous.get("since", now) if previous.get("state") == "working" else now
        path.write_text(json.dumps({
            "session": session, "slug": slug, "cwd": cwd,
            "state": "working", "since": since,
        }), encoding="utf-8")
        return

    reason = REASONS.get(event, event)
    elapsed = now - previous.get("since", now) if previous.get("state") == "working" else 0
    path.write_text(json.dumps({
        "session": session, "slug": slug, "cwd": cwd,
        "state": "waiting", "reason": reason, "since": now,
        "turnSeconds": round(elapsed),
        "message": (payload.get("message") or "")[:200],
    }), encoding="utf-8")

    if event in ALWAYS_NOTIFY or elapsed >= LONG_TURN:
        detail = payload.get("message") or reason
        notify(f"Handraise · {slug}", str(detail)[:200], event in URGENT, slug)


if __name__ == "__main__":
    main()
