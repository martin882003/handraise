#!/usr/bin/env python3
"""Permission bridge between an agent session in tmux and the panel.

`PermissionRequest` is synchronous: the agent sits there waiting for the decision
this hook returns. While it waits, the request lives as a typed JSON file in the
handraise state directory; the panel writes the answer and this process returns it
as `allow` or `deny`. No keystrokes are guessed and no screen is parsed — the
buttons you see are the request itself.

If nobody answers before the deadline the hook exits without a decision and the
agent keeps its own native dialog. The file is marked `expired` so the panel
stops pretending it can still be resolved from the browser.
"""
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path

from attention import notify, session_slug, state_dir

WAIT_SECONDS = float(os.environ.get("HANDRAISE_PERMISSION_WAIT_SECONDS", 8 * 3600))
POLL_SECONDS = float(os.environ.get("HANDRAISE_PERMISSION_POLL_SECONDS", 0.25))


def safe_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "-", value)[:160] or "no-session"


def atomic_json(path: Path, payload: dict) -> None:
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def process_seal() -> str:
    """This hook's exact incarnation; a JSON with no live process asks nothing.

    pid alone is not enough — pids get reused — so it carries the process start
    time and the boot id. The panel checks the seal before offering a button, and
    that is what keeps a stale file from rendering as a live question.
    """
    pid = os.getpid()
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        start = stat[stat.rfind(")") + 2:].split()[19]
        boot = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="utf-8").strip()
        return f"{pid}@{start}@{boot}" if boot else f"{pid}@{start}"
    except (OSError, IndexError):
        return ""


def summary(tool: str, tool_input: dict) -> str:
    if not isinstance(tool_input, dict):
        return tool
    for key in ("description", "command", "file_path", "path", "url", "query"):
        value = tool_input.get(key)
        if value:
            return f"{tool}: {str(value).strip()[:240]}"
    return tool


def decision(behavior: str, message: str = "") -> dict:
    result = {"behavior": behavior}
    if behavior == "deny":
        result["message"] = message or "The permission was denied from Handraise."
    return {
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": result,
        }
    }


def main() -> None:
    # Only a session started by handraise has somewhere to show and resolve the
    # request. One you opened in your own terminal keeps the agent's native
    # dialog and never waits on a panel you aren't using.
    if os.environ.get("HANDRAISE") != "1":
        return
    slug = session_slug()
    if slug is None:
        return
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, AttributeError):
        return

    session = str(payload.get("session_id") or "no-session")
    cwd = str(payload.get("cwd") or os.getcwd())

    directory = state_dir() / "permissions"
    directory.mkdir(parents=True, exist_ok=True)
    key = safe_id(session)
    request_path = directory / f"{key}.json"
    response_path = directory / f"{key}.response.json"
    response_path.unlink(missing_ok=True)

    request_id = uuid.uuid4().hex
    tool = str(payload.get("tool_name") or "tool")
    tool_input = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    request = {
        "id": request_id,
        "key": key,
        "session": session,
        "slug": slug,
        "cwd": cwd,
        "state": "pending",
        "requestedAt": time.time(),
        "proc": process_seal(),
        "tool": {"name": tool, "input": tool_input},
        "summary": summary(tool, tool_input),
        "suggestions": payload.get("permission_suggestions") or [],
    }
    atomic_json(request_path, request)
    notify(f"Handraise · {slug}", request["summary"], True, slug)

    deadline = time.monotonic() + max(0, WAIT_SECONDS)
    while time.monotonic() < deadline:
        try:
            response = json.loads(response_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            time.sleep(max(0.01, POLL_SECONDS))
            continue
        if response.get("id") != request_id or response.get("behavior") not in {"allow", "deny"}:
            time.sleep(max(0.01, POLL_SECONDS))
            continue
        request_path.unlink(missing_ok=True)
        response_path.unlink(missing_ok=True)
        print(json.dumps(decision(response["behavior"], str(response.get("message") or ""))))
        return

    atomic_json(request_path, {**request, "state": "expired", "expiredAt": time.time()})


if __name__ == "__main__":
    main()
