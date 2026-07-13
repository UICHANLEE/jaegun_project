from __future__ import annotations

import json
import math
import re
import threading
import uuid
from datetime import UTC, datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


ROOT = Path(__file__).resolve().parent
RUNTIME_DIR = ROOT / ".runtime"
MODE_FILE = RUNTIME_DIR / "mode.json"
MODE_TMP_FILE = RUNTIME_DIR / "mode.json.tmp"
EVIDENCE_FILE = RUNTIME_DIR / "evidence.json"
EVIDENCE_TMP_FILE = RUNTIME_DIR / "evidence.json.tmp"
PROGRESS_FILE = RUNTIME_DIR / "progress.json"
PROGRESS_TMP_FILE = RUNTIME_DIR / "progress.json.tmp"
NOTES_FILE = RUNTIME_DIR / "notes.json"
NOTES_TMP_FILE = RUNTIME_DIR / "notes.json.tmp"
PORT = 8123
STATE_LOCK = threading.Lock()
EVIDENCE_LOCK = threading.Lock()
PROGRESS_LOCK = threading.Lock()
NOTES_LOCK = threading.Lock()
MAX_EVIDENCE_ITEMS = 18
MAX_EVIDENCE_IMAGE_LENGTH = 200_000
MAX_NOTE_LENGTH = 1200
MAX_NOTE_ITEMS_PER_SUSPECT = 30
VALID_CLUE_IDS = {"H01", "H02", "H03", "H05", "H06", "H07", "H09", "H10", "H11", "H13", "H14", "H15"}
VALID_SUSPECT_IDS = {"P01", "P02", "P03", "P04"}
DRAWING_WORDS = ["찻잔", "돈", "수첩"]
DRAWING_QR_TOKEN = "JAEGUN-DRAW-NEXT"


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
    return {"started": False, "updatedAt": "", "wordAssignments": {}}


def normalize_announcement(announcement: object) -> dict[str, str] | None:
    if not isinstance(announcement, dict):
        return None
    text = str(announcement.get("text") or "").strip()[:300]
    announcement_id = str(announcement.get("id") or "").strip()
    if not text or not announcement_id:
        return None
    return {
        "id": announcement_id,
        "text": text,
        "createdAt": str(announcement.get("createdAt") or datetime.now(UTC).isoformat()),
    }


def next_announcement(current: object, payload: object) -> dict[str, str] | None:
    if not isinstance(payload, dict):
        return normalize_announcement(current)
    if payload.get("action") == "clear":
        return None
    text = str(payload.get("text") or "").strip()[:300]
    if not text:
        return normalize_announcement(current)
    return {"id": uuid.uuid4().hex, "text": text, "createdAt": datetime.now(UTC).isoformat()}


def normalize_word_assignments(assignments: object) -> dict[str, list[dict[str, object]]]:
    source = assignments if isinstance(assignments, dict) else {}
    normalized: dict[str, list[dict[str, object]]] = {}
    for group in [1, 2, 3]:
        items = source.get(str(group), source.get(group, []))
        items = items if isinstance(items, list) else []
        seen = set()
        group_items = []
        for item in items:
            item = item if isinstance(item, dict) else {}
            try:
                index = int(item.get("index"))
            except Exception:
                continue
            if index < 0 or index >= len(DRAWING_WORDS) or index in seen:
                continue
            seen.add(index)
            group_items.append(
                {
                    "index": index,
                    "word": DRAWING_WORDS[index],
                    "assignedAt": str(item.get("assignedAt") or ""),
                    "assignedBy": str(item.get("assignedBy") or "")[:40],
                }
            )
        normalized[str(group)] = sorted(group_items, key=lambda item: int(item["index"]))
    return normalized


def normalize_recreation(recreation: object) -> dict[str, str | bool]:
    recreation = recreation if isinstance(recreation, dict) else {}
    return {
        "started": bool(recreation.get("started", False)),
        "updatedAt": str(recreation.get("updatedAt") or ""),
        "wordAssignments": normalize_word_assignments(recreation.get("wordAssignments")),
    }


def next_recreation(current_recreation: object, payload: object) -> dict[str, str | bool]:
    recreation = normalize_recreation(current_recreation)
    if not isinstance(payload, dict):
        return recreation
    if isinstance(payload.get("started"), bool):
        recreation["started"] = payload["started"]
        recreation["updatedAt"] = datetime.now(UTC).isoformat()
    return recreation


def valid_drawing_qr_token(value: object) -> bool:
    token = str(value or "").strip().upper()
    return token == DRAWING_QR_TOKEN or "DRAW=NEXT" in token or "QR=DRAW" in token


def participant_group_number_from_groups(name: object, groups: object) -> int | None:
    key = normalize_name_key(name)
    if not key:
        return None
    for group in normalize_groups(groups):
        if any(normalize_name_key(member) == key for member in group.get("names", [])):
            return int(group["number"])
    return None


def next_recreation_with_word_scan(recreation: object, groups: object, payload: object) -> dict[str, object]:
    next_value: dict[str, object] = normalize_recreation(recreation)
    scan = payload if isinstance(payload, dict) else {}
    if not valid_drawing_qr_token(scan.get("token") or scan.get("content") or scan.get("value")):
        return next_value
    group = participant_group_number_from_groups(scan.get("name"), groups)
    if group is None:
        return next_value
    assignments = normalize_word_assignments(next_value.get("wordAssignments"))
    group_key = str(group)
    current_items = assignments.get(group_key, [])
    next_index = (group - 1) % len(DRAWING_WORDS)
    if len(current_items) == 1 and int(current_items[0]["index"]) == next_index:
        return next_value
    assignments[group_key] = sorted(
        [
            {
                "index": next_index,
                "word": DRAWING_WORDS[next_index],
                "assignedAt": datetime.now(UTC).isoformat(),
                "assignedBy": normalize_name(scan.get("name"))[:40],
            },
        ],
        key=lambda item: int(item["index"]),
    )
    next_value["wordAssignments"] = assignments
    next_value["updatedAt"] = datetime.now(UTC).isoformat()
    return next_value


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

    if payload.get("action") == "rename":
        old_key = normalize_name_key(payload.get("oldName"))
        new_name = normalize_name(payload.get("newName"))
        new_key = normalize_name_key(new_name)
        if not old_key or not new_key:
            return participants
        target = next((item for item in participants if normalize_name_key(item["name"]) == old_key), None)
        if target is None:
            return participants
        participants = [
            item
            for item in participants
            if normalize_name_key(item["name"]) == old_key or normalize_name_key(item["name"]) != new_key
        ]
        target["name"] = new_name
        target["joinedAt"] = target.get("joinedAt") or datetime.now(UTC).isoformat()

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
    remaining_value = timer.get("remainingSeconds")
    remaining = duration if remaining_value is None else int(remaining_value)
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
            remaining = math.ceil((ends_at - datetime.now(UTC)).total_seconds())
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
            "sessionId": str(payload.get("sessionId") or "legacy"),
            "updatedAt": str(payload.get("updatedAt", "")),
            "source": "local-file",
            "timer": timer,
            "groups": normalize_groups(payload.get("groups")),
            "participants": normalize_participants(payload.get("participants")),
            "recreation": normalize_recreation(payload.get("recreation")),
            "announcement": normalize_announcement(payload.get("announcement")),
        }
    except Exception:
        return {
            "mode": "recreation",
            "version": 1,
            "sessionId": "legacy",
            "updatedAt": "",
            "source": "local-file",
            "timer": default_timer(),
            "groups": default_groups(),
            "participants": [],
            "recreation": default_recreation(),
            "announcement": None,
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
    elif action in {"pause", "stop"}:
        remaining = current_remaining(timer)
        timer["remainingSeconds"] = remaining
        timer["running"] = False
        timer["endsAt"] = ""
    elif action == "resume":
        remaining = current_remaining(timer)
        timer["remainingSeconds"] = remaining
        timer["running"] = remaining > 0
        timer["endsAt"] = (now + timedelta(seconds=remaining)).isoformat() if remaining > 0 else ""
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
    next_groups = normalize_groups(payload.get("groups") if isinstance(payload.get("groups"), list) else current.get("groups"))
    recreation_state = next_recreation(current.get("recreation"), payload.get("recreation"))
    next_state = {
        "mode": normalized,
        "version": int(current["version"]) + 1,
        "sessionId": str(current.get("sessionId") or "legacy"),
        "updatedAt": datetime.now(UTC).isoformat(),
        "source": "local-file",
        "timer": next_timer(current["timer"], payload.get("timer")),
        "groups": next_groups,
        "participants": next_participants(current.get("participants"), payload.get("participant")),
        "recreation": next_recreation_with_word_scan(recreation_state, next_groups, payload.get("wordScan")),
        "announcement": next_announcement(current.get("announcement"), payload.get("announcement")),
    }
    RUNTIME_DIR.mkdir(exist_ok=True)
    MODE_TMP_FILE.write_text(json.dumps(next_state, ensure_ascii=False, indent=2), encoding="utf-8")
    MODE_TMP_FILE.replace(MODE_FILE)
    return next_state


def participant_group_for_name(name: object) -> int | None:
    key = normalize_name_key(name)
    if not key:
        return None
    for group in read_state().get("groups", []):
        if any(normalize_name_key(member) == key for member in group.get("names", [])):
            return int(group["number"])
    return None


def read_evidence_store() -> dict[str, list[dict[str, object]]]:
    try:
        payload = json.loads(EVIDENCE_FILE.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def write_evidence_store(store: dict[str, list[dict[str, object]]]) -> None:
    RUNTIME_DIR.mkdir(exist_ok=True)
    EVIDENCE_TMP_FILE.write_text(json.dumps(store, ensure_ascii=False), encoding="utf-8")
    EVIDENCE_TMP_FILE.replace(EVIDENCE_FILE)


def valid_evidence_image(image_data: object) -> bool:
    if not isinstance(image_data, str) or len(image_data) > MAX_EVIDENCE_IMAGE_LENGTH:
        return False
    return bool(re.fullmatch(r"data:image/(?:jpeg|webp|png);base64,[A-Za-z0-9+/=]+", image_data))


def evidence_for_participant(name: object) -> tuple[int | None, list[dict[str, object]]]:
    group = participant_group_for_name(name)
    if group is None:
        return None, []
    store = read_evidence_store()
    items = store.get(str(group), [])
    return group, items[:MAX_EVIDENCE_ITEMS] if isinstance(items, list) else []


def add_evidence_for_participant(payload: object) -> tuple[int | None, dict[str, object] | None, str | None]:
    payload = payload if isinstance(payload, dict) else {}
    name = normalize_name(payload.get("name"))
    group = participant_group_for_name(name)
    if group is None:
        return None, None, "Group assignment required"
    image_data = payload.get("imageData")
    if not valid_evidence_image(image_data):
        return group, None, "Invalid or oversized evidence image"

    item: dict[str, object] = {
        "id": f"{int(datetime.now(UTC).timestamp() * 1000):x}-{threading.get_ident():x}",
        "group": group,
        "author": name[:30],
        "caption": (normalize_name(payload.get("caption")) or "증거 사진")[:60],
        "imageData": image_data,
        "createdAt": datetime.now(UTC).isoformat(),
    }
    store = read_evidence_store()
    group_items = store.get(str(group), [])
    group_items = group_items if isinstance(group_items, list) else []
    store[str(group)] = [item, *group_items][:MAX_EVIDENCE_ITEMS]
    write_evidence_store(store)
    return group, item, None


def normalize_clue_ids(values: object) -> list[str]:
    values = values if isinstance(values, list) else []
    return sorted({str(value or "").upper() for value in values if str(value or "").upper() in VALID_CLUE_IDS})


def read_progress_store() -> dict[str, list[str]]:
    try:
        payload = json.loads(PROGRESS_FILE.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def write_progress_store(store: dict[str, list[str]]) -> None:
    RUNTIME_DIR.mkdir(exist_ok=True)
    PROGRESS_TMP_FILE.write_text(json.dumps(store, ensure_ascii=False), encoding="utf-8")
    PROGRESS_TMP_FILE.replace(PROGRESS_FILE)


def add_clues_for_participant(payload: object) -> tuple[int | None, list[str], str | None]:
    payload = payload if isinstance(payload, dict) else {}
    group = participant_group_for_name(payload.get("name"))
    if group is None:
        return None, [], "Group assignment required"
    store = read_progress_store()
    clue_ids = sorted(set(normalize_clue_ids(store.get(str(group), []))) | set(normalize_clue_ids(payload.get("clueIds"))))
    store[str(group)] = clue_ids
    write_progress_store(store)
    return group, clue_ids, None


def normalize_note_content(value: object) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n")[:MAX_NOTE_LENGTH]


def normalize_note_items(note: object) -> list[dict[str, str]]:
    note = note if isinstance(note, dict) else {"content": note}
    if isinstance(note.get("items"), list):
        source = note["items"]
    elif normalize_note_content(note.get("content")).strip():
        source = [
            {
                "id": str(note.get("updatedAt") or datetime.now(UTC).isoformat()),
                "author": str(note.get("updatedBy") or ""),
                "content": str(note.get("content") or ""),
                "createdAt": str(note.get("updatedAt") or ""),
            }
        ]
    else:
        source = []
    items = []
    for index, item in enumerate(source):
        item = item if isinstance(item, dict) else {}
        content = normalize_note_content(item.get("content")).strip()
        if not content:
            continue
        items.append(
            {
                "id": str(item.get("id") or f"{item.get('createdAt') or 'note'}-{index}")[:80],
                "author": str(item.get("author") or item.get("updatedBy") or "")[:40],
                "content": content,
                "createdAt": str(item.get("createdAt") or item.get("updatedAt") or ""),
            }
        )
    return items[-MAX_NOTE_ITEMS_PER_SUSPECT:]


def normalize_notes(values: object) -> dict[str, dict[str, object]]:
    source = values if isinstance(values, dict) else {}
    notes: dict[str, dict[str, object]] = {}
    for suspect_id, raw_note in source.items():
        key = str(suspect_id or "").upper()
        if key not in VALID_SUSPECT_IDS:
            continue
        note = raw_note if isinstance(raw_note, dict) else {"content": raw_note}
        items = normalize_note_items(note)
        latest = items[-1] if items else {}
        notes[key] = {
            "items": items,
            "updatedBy": str(latest.get("author") or note.get("updatedBy") or "")[:40],
            "updatedAt": str(latest.get("createdAt") or note.get("updatedAt") or ""),
        }
    return notes


def read_notes_store() -> dict[str, dict[str, dict[str, object]]]:
    try:
        payload = json.loads(NOTES_FILE.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def write_notes_store(store: dict[str, dict[str, dict[str, object]]]) -> None:
    RUNTIME_DIR.mkdir(exist_ok=True)
    NOTES_TMP_FILE.write_text(json.dumps(store, ensure_ascii=False), encoding="utf-8")
    NOTES_TMP_FILE.replace(NOTES_FILE)


def add_note_for_participant(payload: object, group: int) -> dict[str, dict[str, object]]:
    payload = payload if isinstance(payload, dict) else {}
    note = payload.get("note") if isinstance(payload.get("note"), dict) else {}
    suspect_id = str(note.get("suspectId") or payload.get("suspectId") or "").upper()
    if suspect_id not in VALID_SUSPECT_IDS:
        return normalize_notes(read_notes_store().get(str(group), {}))
    content = normalize_note_content(note.get("content", payload.get("content"))).strip()
    if not content:
        return normalize_notes(read_notes_store().get(str(group), {}))
    store = read_notes_store()
    group_notes = normalize_notes(store.get(str(group), {}))
    current_items = group_notes.get(suspect_id, {}).get("items", [])
    created_at = datetime.now(UTC).isoformat()
    next_items = [
        *(current_items if isinstance(current_items, list) else []),
        {
            "id": f"{uuid.uuid4().hex[:10]}-{len(current_items) if isinstance(current_items, list) else 0}",
            "author": str(payload.get("name") or "")[:40],
            "content": content,
            "createdAt": created_at,
        },
    ][-MAX_NOTE_ITEMS_PER_SUSPECT:]
    group_notes[suspect_id] = {
        "items": next_items,
        "updatedBy": str(payload.get("name") or "")[:40],
        "updatedAt": created_at,
    }
    store[str(group)] = group_notes
    write_notes_store(store)
    return group_notes


def team_state(group: int, include_evidence: bool = True) -> dict[str, object]:
    evidence = read_evidence_store().get(str(group), [])
    evidence = evidence if isinstance(evidence, list) else []
    clue_ids = normalize_clue_ids(read_progress_store().get(str(group), []))
    notes = normalize_notes(read_notes_store().get(str(group), {}))
    payload: dict[str, object] = {
        "group": group,
        "clueIds": clue_ids,
        "notes": notes,
        "evidenceCount": len(evidence),
        "latestEvidenceId": str(evidence[0].get("id") or "") if evidence and isinstance(evidence[0], dict) else "",
        "source": "local-file",
    }
    if include_evidence:
        payload["evidence"] = evidence[:MAX_EVIDENCE_ITEMS]
    return payload


def reset_all_state() -> dict[str, object]:
    current = read_state()
    reset: dict[str, object] = {
        "mode": "recreation",
        "version": int(current.get("version", 1)) + 1,
        "sessionId": uuid.uuid4().hex,
        "updatedAt": datetime.now(UTC).isoformat(),
        "source": "local-file",
        "timer": default_timer(),
        "groups": default_groups(),
        "participants": [],
        "recreation": default_recreation(),
        "announcement": None,
    }
    RUNTIME_DIR.mkdir(exist_ok=True)
    MODE_TMP_FILE.write_text(json.dumps(reset, ensure_ascii=False, indent=2), encoding="utf-8")
    MODE_TMP_FILE.replace(MODE_FILE)
    write_evidence_store({})
    write_progress_store({})
    write_notes_store({})
    return reset


class EscapeRoomHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        if self.path.split("?", 1)[0].startswith("/assets/"):
            self.send_header("Cache-Control", "public, max-age=3600")
        else:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/api/mode":
            self.send_mode(200, read_state())
            return
        if parsed.path == "/api/evidence":
            name = parse_qs(parsed.query).get("name", [""])[0]
            with EVIDENCE_LOCK:
                group, items = evidence_for_participant(name)
            if group is None:
                self.send_mode(403, {"error": "Group assignment required"})
                return
            self.send_mode(200, {"group": group, "items": items, "source": "local-file"})
            return
        if parsed.path == "/api/team":
            query = parse_qs(parsed.query)
            try:
                group = int(query.get("group", ["0"])[0])
            except Exception:
                group = 0
            if group not in {1, 2, 3}:
                self.send_mode(400, {"error": "Valid group number required"})
                return
            include_evidence = query.get("evidence", ["1"])[0] != "0"
            with EVIDENCE_LOCK, PROGRESS_LOCK, NOTES_LOCK:
                payload = team_state(group, include_evidence)
            self.send_mode(200, payload)
            return
        super().do_GET()

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path not in {"/api/mode", "/api/evidence", "/api/team"}:
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > 400_000:
            self.send_mode(413, {"error": "Evidence image is too large"})
            return
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            payload = json.loads(body)
            if path == "/api/evidence":
                with EVIDENCE_LOCK:
                    group, item, error = add_evidence_for_participant(payload)
                if error:
                    self.send_mode(403 if group is None else 400, {"error": error})
                    return
                self.send_mode(201, {"group": group, "item": item, "source": "local-file"})
            elif path == "/api/team":
                with PROGRESS_LOCK, NOTES_LOCK:
                    group, clue_ids, error = add_clues_for_participant(payload)
                if error:
                    self.send_mode(403, {"error": error})
                    return
                with NOTES_LOCK:
                    notes = add_note_for_participant(payload, group) if group is not None else {}
                self.send_mode(200, {"group": group, "clueIds": clue_ids, "notes": notes, "source": "local-file"})
            else:
                if isinstance(payload, dict) and payload.get("resetAll") is True:
                    with STATE_LOCK, EVIDENCE_LOCK, PROGRESS_LOCK, NOTES_LOCK:
                        state = reset_all_state()
                else:
                    with STATE_LOCK:
                        state = write_state(payload)
                self.send_mode(200, state)
        except Exception:
            self.send_mode(400, {"error": "Invalid request payload"})

    def send_mode(self, status: int, payload: dict[str, str | int]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ConcurrentHTTPServer(ThreadingHTTPServer):
    request_queue_size = 64
    daemon_threads = True


if __name__ == "__main__":
    if not MODE_FILE.exists():
        write_state({"mode": read_mode()})
    server = ConcurrentHTTPServer(("0.0.0.0", PORT), EscapeRoomHandler)
    print(f"Escape room server running at http://localhost:{PORT}/")
    print(f"Mode starts as: {read_mode()}")
    server.serve_forever()
