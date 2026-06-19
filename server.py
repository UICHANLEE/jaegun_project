from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
RUNTIME_DIR = ROOT / ".runtime"
MODE_FILE = RUNTIME_DIR / "mode.json"
PORT = 8123


def normalize_mode(mode: str | None) -> str:
    return "crime" if mode == "crime" else "recreation"


def read_mode() -> str:
    try:
        payload = json.loads(MODE_FILE.read_text(encoding="utf-8"))
        return normalize_mode(payload.get("mode"))
    except Exception:
        return "recreation"


def default_timer() -> dict[str, str | int | bool]:
    return {
        "durationSeconds": 0,
        "remainingSeconds": 0,
        "running": False,
        "endsAt": "",
        "updatedAt": "",
    }


def default_groups() -> list[dict[str, int | list[str]]]:
    return [
        {"number": 1, "names": []},
        {"number": 2, "names": []},
        {"number": 3, "names": []},
    ]


def default_recreation() -> dict[str, str | bool]:
    return {"started": False, "updatedAt": ""}


def normalize_recreation(recreation: object) -> dict[str, str | bool]:
    recreation = recreation if isinstance(recreation, dict) else {}
    return {
        "started": bool(recreation.get("started", False)),
        "updatedAt": str(recreation.get("updatedAt") or ""),
    }


def next_recreation(current_recreation: object, payload: object) -> dict[str, str | bool]:
    recreation = normalize_recreation(current_recreation)
    if not isinstance(payload, dict):
        return recreation
    if isinstance(payload.get("started"), bool):
        recreation["started"] = payload["started"]
        recreation["updatedAt"] = datetime.now(UTC).isoformat()
    return recreation


def normalize_name(name: object) -> str:
    return str(name or "").strip()


def normalize_name_key(name: object) -> str:
    return "".join(normalize_name(name).split()).lower()


def normalize_participants(participants: object) -> list[dict[str, str]]:
    source = participants if isinstance(participants, list) else []
    normalized = []
    seen = set()
    for participant in source:
        participant = participant if isinstance(participant, dict) else {}
        name = normalize_name(participant.get("name"))
        key = normalize_name_key(name)
        if not key or key in seen:
            continue
        seen.add(key)
        normalized.append(
            {
                "name": name,
                "joinedAt": str(participant.get("joinedAt") or datetime.now(UTC).isoformat()),
            }
        )
    return sorted(normalized, key=lambda item: item["joinedAt"])


def next_participants(current_participants: object, payload: object) -> list[dict[str, str]]:
    participants = normalize_participants(current_participants)
    if not isinstance(payload, dict):
        return participants

    if payload.get("action") == "join":
        name = normalize_name(payload.get("name"))
        key = normalize_name_key(name)
        if not key:
            return participants
        existing = next((item for item in participants if normalize_name_key(item["name"]) == key), None)
        if existing:
            existing["name"] = name
            existing["joinedAt"] = existing.get("joinedAt") or datetime.now(UTC).isoformat()
        else:
            participants.append({"name": name, "joinedAt": datetime.now(UTC).isoformat()})

    if payload.get("action") == "clear":
        participants = []

    return normalize_participants(participants)


def normalize_groups(groups: object) -> list[dict[str, int | list[str]]]:
    source = groups if isinstance(groups, list) and groups else default_groups()
    normalized = []
    for index, group in enumerate(source):
        group = group if isinstance(group, dict) else {}
        seen = set()
        names = []
        for raw_name in group.get("names", []):
            name = str(raw_name or "").strip()
            if name and name not in seen:
                names.append(name)
                seen.add(name)
        try:
            number = max(1, int(group.get("number", index + 1)))
        except Exception:
            number = index + 1
        normalized.append({"number": number, "names": names})
    return sorted(normalized, key=lambda item: int(item["number"]))


def normalize_timer(timer: dict | None) -> dict[str, str | int | bool]:
    normalized = default_timer()
    if not isinstance(timer, dict):
        return normalized

    duration = int(timer.get("durationSeconds") or 0)
    remaining = int(timer.get("remainingSeconds") or duration)
    normalized.update(
        {
            "durationSeconds": max(0, duration),
            "remainingSeconds": max(0, remaining),
            "running": bool(timer.get("running")),
            "endsAt": str(timer.get("endsAt") or ""),
            "updatedAt": str(timer.get("updatedAt") or ""),
        }
    )
    return normalized


def current_remaining(timer: dict[str, str | int | bool]) -> int:
    if timer.get("running") and timer.get("endsAt"):
        try:
            ends_at = datetime.fromisoformat(str(timer["endsAt"]).replace("Z", "+00:00"))
            remaining = int((ends_at - datetime.now(UTC)).total_seconds())
            return max(0, remaining)
        except Exception:
            return int(timer.get("remainingSeconds") or 0)
    return int(timer.get("remainingSeconds") or 0)


def read_state() -> dict[str, str | int | bool | dict]:
    try:
        payload = json.loads(MODE_FILE.read_text(encoding="utf-8"))
        timer = normalize_timer(payload.get("timer"))
        timer["remainingSeconds"] = current_remaining(timer)
        if timer["running"] and timer["remainingSeconds"] <= 0:
            timer["running"] = False
        return {
            "mode": normalize_mode(payload.get("mode")),
            "version": int(payload.get("version", 1)),
            "updatedAt": str(payload.get("updatedAt", "")),
            "source": "local-file",
            "timer": timer,
            "groups": normalize_groups(payload.get("groups")),
            "participants": normalize_participants(payload.get("participants")),
            "recreation": normalize_recreation(payload.get("recreation")),
        }
    except Exception:
        return {
            "mode": "recreation",
            "version": 1,
            "updatedAt": "",
            "source": "local-file",
            "timer": default_timer(),
            "groups": default_groups(),
            "participants": [],
            "recreation": default_recreation(),
        }


def next_timer(current_timer: dict[str, str | int | bool], payload: dict | None) -> dict[str, str | int | bool]:
    timer = dict(current_timer)
    if not isinstance(payload, dict):
        return timer

    action = payload.get("action")
    now = datetime.now(UTC)
    timer["updatedAt"] = now.isoformat()

    if action == "start":
        duration = max(0, int(payload.get("durationSeconds") or timer.get("durationSeconds") or 0))
        timer["durationSeconds"] = duration
        timer["remainingSeconds"] = duration
        timer["running"] = duration > 0
        timer["endsAt"] = (now + timedelta(seconds=duration)).isoformat() if duration > 0 else ""
    elif action == "stop":
        remaining = current_remaining(timer)
        timer["remainingSeconds"] = remaining
        timer["running"] = False
        timer["endsAt"] = ""
    elif action == "reset":
        duration = max(0, int(payload.get("durationSeconds") or timer.get("durationSeconds") or 0))
        timer["durationSeconds"] = duration
        timer["remainingSeconds"] = duration
        timer["running"] = False
        timer["endsAt"] = ""
    elif action == "clear":
        timer = default_timer()
        timer["updatedAt"] = now.isoformat()

    return timer


def write_state(payload: dict | None) -> dict[str, str | int | bool | dict]:
    current = read_state()
    payload = payload if isinstance(payload, dict) else {}
    normalized = normalize_mode(payload.get("mode", current["mode"]))
    next_state = {
        "mode": normalized,
        "version": int(current["version"]) + 1,
        "updatedAt": datetime.now(UTC).isoformat(),
        "source": "local-file",
        "timer": next_timer(current["timer"], payload.get("timer")),
        "groups": normalize_groups(payload.get("groups") if isinstance(payload.get("groups"), list) else current.get("groups")),
        "participants": next_participants(current.get("participants"), payload.get("participant")),
        "recreation": next_recreation(current.get("recreation"), payload.get("recreation")),
    }
    RUNTIME_DIR.mkdir(exist_ok=True)
    MODE_FILE.write_text(json.dumps(next_state, ensure_ascii=False, indent=2), encoding="utf-8")
    return next_state


class EscapeRoomHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == "/api/mode":
            self.send_mode(200, read_state())
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/api/mode":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            payload = json.loads(body)
            state = write_state(payload)
            self.send_mode(200, state)
        except Exception:
            self.send_mode(400, {"error": "Invalid mode payload"})

    def send_mode(self, status: int, payload: dict[str, str | int]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    if not MODE_FILE.exists():
        write_state({"mode": read_mode()})
    server = ThreadingHTTPServer(("0.0.0.0", PORT), EscapeRoomHandler)
    print(f"Escape room server running at http://localhost:{PORT}/")
    print(f"Mode starts as: {read_mode()}")
    server.serve_forever()
