import {
  archiveConfigurationMessage,
  buildTeamArchive,
  hasSupabaseArchive,
  saveGameArchive,
} from "../lib/supabase-archive.js";
import { broadcastRealtime, globalRealtimeTopic, modeChangeKind } from "../lib/realtime.js";

const DEFAULT_MODE = "recreation";
const MODE_KEY = "crime-scene:mode";
const MODE_LOCK_KEY = `${MODE_KEY}:write-lock`;
const EVIDENCE_KEYS = [1, 2, 3].map((group) => `crime-scene:evidence:group:${group}`);
const CLUE_KEYS = [1, 2, 3].map((group) => `crime-scene:clues:group:${group}`);
const NOTE_KEYS = [1, 2, 3].map((group) => `crime-scene:notes:group:${group}`);
const DRAWING_WORDS = ["찻잔", "돈", "수첩"];
const DRAWING_QR_TOKEN = "JAEGUN-DRAW-NEXT";

function newSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeMode(mode) {
  return mode === "crime" ? "crime" : DEFAULT_MODE;
}

function fallbackState() {
  globalThis.__upupGameModeState ||= {
    mode: DEFAULT_MODE,
    version: 1,
    sessionId: "legacy",
    updatedAt: new Date().toISOString(),
    timer: defaultTimer(),
    groups: defaultGroups(),
    participants: [],
    recreation: defaultRecreation(),
    announcement: null,
  };
  return globalThis.__upupGameModeState;
}

function normalizeAnnouncement(announcement) {
  if (!announcement || typeof announcement !== "object") return null;
  const text = String(announcement.text || "").trim().slice(0, 300);
  const id = String(announcement.id || "").trim();
  if (!text || !id) return null;
  return {
    id,
    text,
    createdAt: String(announcement.createdAt || new Date().toISOString()),
  };
}

function nextAnnouncement(currentAnnouncement, payload) {
  if (!payload || typeof payload !== "object") return normalizeAnnouncement(currentAnnouncement);
  if (payload.action === "clear") return null;
  const text = String(payload.text || "").trim().slice(0, 300);
  if (!text) return normalizeAnnouncement(currentAnnouncement);
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    createdAt: new Date().toISOString(),
  };
}

function defaultRecreation() {
  return { started: false, updatedAt: "", wordAssignments: {} };
}

function normalizeWordAssignments(assignments) {
  const source = assignments && typeof assignments === "object" ? assignments : {};
  return Object.fromEntries(
    [1, 2, 3].map((group) => {
      const seen = new Set();
      const items = (Array.isArray(source[group]) ? source[group] : [])
        .map((item) => {
          const index = Number(item?.index);
          if (!Number.isInteger(index) || index < 0 || index >= DRAWING_WORDS.length || seen.has(index)) return null;
          seen.add(index);
          return {
            index,
            word: DRAWING_WORDS[index],
            assignedAt: String(item?.assignedAt || ""),
            assignedBy: String(item?.assignedBy || "").trim().slice(0, 40),
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.index - b.index);
      return [String(group), items];
    }),
  );
}

function normalizeRecreation(recreation) {
  return {
    started: Boolean(recreation?.started),
    updatedAt: recreation?.updatedAt || "",
    wordAssignments: normalizeWordAssignments(recreation?.wordAssignments),
  };
}

function nextRecreation(currentRecreation, payload) {
  const recreation = normalizeRecreation(currentRecreation);
  if (!payload || typeof payload !== "object") return recreation;
  if (typeof payload.started === "boolean") {
    recreation.started = payload.started;
    recreation.updatedAt = new Date().toISOString();
  }
  return recreation;
}

function validDrawingQrToken(value) {
  const token = String(value || "").trim().toUpperCase();
  return token === DRAWING_QR_TOKEN || token.includes("DRAW=NEXT") || token.includes("QR=DRAW");
}

function participantGroupNumber(name, groups) {
  const key = normalizeNameKey(name);
  if (!key) return null;
  const group = normalizeGroups(groups).find((item) => item.names.some((member) => normalizeNameKey(member) === key));
  return group ? Math.max(1, Number(group.number) || 1) : null;
}

function nextRecreationWithWordScan(currentRecreation, groups, payload) {
  const recreation = normalizeRecreation(currentRecreation);
  const scan = payload && typeof payload === "object" ? payload : null;
  if (!scan || !validDrawingQrToken(scan.token || scan.content || scan.value)) return recreation;

  const group = participantGroupNumber(scan.name, groups);
  if (!group) return recreation;

  const assignments = normalizeWordAssignments(recreation.wordAssignments);
  const groupKey = String(group);
  const currentItems = Array.isArray(assignments[groupKey]) ? assignments[groupKey] : [];
  const nextIndex = (group - 1) % DRAWING_WORDS.length;
  if (currentItems.length === 1 && currentItems[0]?.index === nextIndex) return recreation;

  assignments[groupKey] = [
    {
      index: nextIndex,
      word: DRAWING_WORDS[nextIndex],
      assignedAt: new Date().toISOString(),
      assignedBy: normalizeName(scan.name).slice(0, 40),
    },
  ].sort((a, b) => a.index - b.index);
  recreation.wordAssignments = assignments;
  recreation.updatedAt = new Date().toISOString();
  return recreation;
}

function normalizeName(name) {
  return String(name || "").trim();
}

function normalizeNameKey(name) {
  return normalizeName(name).replace(/\s+/g, "").toLowerCase();
}

function normalizeParticipants(participants) {
  const seen = new Set();
  const source = Array.isArray(participants) ? participants : [];
  return source
    .map((participant) => ({
      name: normalizeName(participant?.name),
      joinedAt: participant?.joinedAt || new Date().toISOString(),
    }))
    .filter((participant) => {
      const key = normalizeNameKey(participant.name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(a.joinedAt).localeCompare(String(b.joinedAt)));
}

function nextParticipants(currentParticipants, payload) {
  let participants = normalizeParticipants(currentParticipants);
  if (!payload || typeof payload !== "object") return participants;

  if (payload.action === "join") {
    const name = normalizeName(payload.name);
    const key = normalizeNameKey(name);
    if (!key) return participants;
    const existing = participants.find((participant) => normalizeNameKey(participant.name) === key);
    if (existing) {
      existing.name = name;
      existing.joinedAt = existing.joinedAt || new Date().toISOString();
    } else {
      participants.push({ name, joinedAt: new Date().toISOString() });
    }
  }

  if (payload.action === "rename") {
    const oldKey = normalizeNameKey(payload.oldName);
    const newName = normalizeName(payload.newName);
    const newKey = normalizeNameKey(newName);
    if (!oldKey || !newKey) return participants;
    const target = participants.find((participant) => normalizeNameKey(participant.name) === oldKey);
    if (!target) return participants;
    participants = participants.filter((participant) => normalizeNameKey(participant.name) !== newKey || normalizeNameKey(participant.name) === oldKey);
    target.name = newName;
    target.joinedAt = target.joinedAt || new Date().toISOString();
  }

  if (payload.action === "clear") {
    participants = [];
  }

  return normalizeParticipants(participants);
}

function defaultGroups() {
  return [
    { number: 1, names: [] },
    { number: 2, names: [] },
    { number: 3, names: [] },
  ];
}

function normalizeGroups(groups) {
  const source = Array.isArray(groups) && groups.length ? groups : defaultGroups();
  return source
    .map((group, index) => ({
      number: Math.max(1, Number(group?.number) || index + 1),
      names: Array.isArray(group?.names)
        ? [...new Set(group.names.map((name) => String(name || "").trim()).filter(Boolean))]
        : [],
    }))
    .sort((a, b) => a.number - b.number);
}

function defaultTimer() {
  return {
    durationSeconds: 0,
    remainingSeconds: 0,
    running: false,
    endsAt: "",
    updatedAt: "",
  };
}

function normalizeTimer(timer) {
  const normalized = defaultTimer();
  if (!timer || typeof timer !== "object") return normalized;

  const durationSeconds = Math.max(0, Number(timer.durationSeconds) || 0);
  const remainingSeconds = Math.max(0, Number(timer.remainingSeconds ?? durationSeconds) || 0);
  return {
    durationSeconds,
    remainingSeconds,
    running: Boolean(timer.running),
    endsAt: timer.endsAt || "",
    updatedAt: timer.updatedAt || "",
  };
}

function currentRemaining(timer) {
  if (timer.running && timer.endsAt) {
    const remaining = Math.ceil((new Date(timer.endsAt).getTime() - Date.now()) / 1000);
    return Math.max(0, remaining);
  }
  return Math.max(0, Number(timer.remainingSeconds) || 0);
}

function nextTimer(currentTimer, payload) {
  const timer = normalizeTimer(currentTimer);
  if (!payload || typeof payload !== "object") return timer;

  const now = new Date();
  timer.updatedAt = now.toISOString();

  if (payload.action === "start") {
    const durationSeconds = Math.max(0, Number(payload.durationSeconds || timer.durationSeconds) || 0);
    timer.durationSeconds = durationSeconds;
    timer.remainingSeconds = durationSeconds;
    timer.running = durationSeconds > 0;
    timer.endsAt = durationSeconds > 0 ? new Date(now.getTime() + durationSeconds * 1000).toISOString() : "";
  }

  if (payload.action === "pause" || payload.action === "stop") {
    timer.remainingSeconds = currentRemaining(timer);
    timer.running = false;
    timer.endsAt = "";
  }

  if (payload.action === "resume") {
    const remainingSeconds = currentRemaining(timer);
    timer.remainingSeconds = remainingSeconds;
    timer.running = remainingSeconds > 0;
    timer.endsAt = remainingSeconds > 0 ? new Date(now.getTime() + remainingSeconds * 1000).toISOString() : "";
  }

  if (payload.action === "reset") {
    const durationSeconds = Math.max(0, Number(payload.durationSeconds || timer.durationSeconds) || 0);
    timer.durationSeconds = durationSeconds;
    timer.remainingSeconds = durationSeconds;
    timer.running = false;
    timer.endsAt = "";
  }

  if (payload.action === "clear") {
    return { ...defaultTimer(), updatedAt: now.toISOString() };
  }

  return timer;
}

function hasRedis() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function stateSource() {
  return hasRedis() ? "redis" : "memory";
}

function stateWarning() {
  if (hasRedis()) return "";
  return "Redis is not configured. Vercel memory state is temporary and may not sync across phones.";
}

async function redisCommand(command) {
  const [result] = await redisCommands([command]);
  return result;
}

async function redisCommands(commands) {
  const response = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });

  if (!response.ok) {
    throw new Error(`Redis request failed with ${response.status}`);
  }

  const results = await response.json();
  return results.map((result) => {
    if (result.error) throw new Error(result.error);
    return result.result;
  });
}

function normalizeGameContent(value) {
  if (!value || typeof value !== "object") return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 2000000) throw new Error("게임 콘텐츠가 보관 제한 용량을 초과했습니다.");
    return JSON.parse(serialized);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("게임 콘텐츠를 보관할 수 없습니다.");
  }
}

async function archiveCurrentGame(current, gameContent) {
  if (!hasRedis()) throw new Error("Redis가 연결되지 않아 현재 회차를 안전하게 보관할 수 없습니다.");
  if (!hasSupabaseArchive()) throw new Error(`초기화 중단: ${archiveConfigurationMessage()}`);

  const commands = [1, 2, 3].flatMap((group) => [
    ["LRANGE", `crime-scene:evidence:group:${group}`, 0, -1],
    ["SMEMBERS", `crime-scene:clues:group:${group}`],
    ["HGETALL", `crime-scene:notes:group:${group}`],
  ]);
  const teamData = buildTeamArchive(await redisCommands(commands));
  return saveGameArchive({ ...current, gameContent: normalizeGameContent(gameContent) }, teamData);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withRedisWriteLock(callback) {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + 6000;

  while (Date.now() < deadline) {
    const acquired = await redisCommand(["SET", MODE_LOCK_KEY, token, "NX", "PX", 45000]);
    if (acquired === "OK") {
      try {
        return await callback();
      } finally {
        await redisCommand([
          "EVAL",
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          MODE_LOCK_KEY,
          token,
        ]).catch(() => {});
      }
    }
    await wait(25 + Math.floor(Math.random() * 35));
  }

  throw new Error("Mode store is busy. Please retry.");
}

async function readModeState() {
  if (!hasRedis()) return fallbackState();

  const rawState = await redisCommand(["GET", MODE_KEY]);
  if (!rawState) {
    const initial = fallbackState();
    await redisCommand(["SET", MODE_KEY, JSON.stringify(initial)]);
    return initial;
  }

  try {
    const parsed = JSON.parse(rawState);
      return {
        mode: normalizeMode(parsed.mode),
        version: Number(parsed.version) || 1,
        sessionId: parsed.sessionId || "legacy",
        updatedAt: parsed.updatedAt || new Date().toISOString(),
        timer: withLiveRemaining(parsed.timer),
        groups: normalizeGroups(parsed.groups),
        participants: normalizeParticipants(parsed.participants),
        recreation: normalizeRecreation(parsed.recreation),
        announcement: normalizeAnnouncement(parsed.announcement),
      };
  } catch {
    return fallbackState();
  }
}

function withLiveRemaining(timer) {
  const normalized = normalizeTimer(timer);
  normalized.remainingSeconds = currentRemaining(normalized);
  if (normalized.running && normalized.remainingSeconds <= 0) {
    normalized.running = false;
  }
  return normalized;
}

async function writeModeState(payload) {
  if (hasRedis()) {
    return withRedisWriteLock(() => writeModeStateUnlocked(payload));
  }
  return writeModeStateUnlocked(payload);
}

async function writeModeStateUnlocked(payload) {
  const current = await readModeState();
  const body = payload && typeof payload === "object" ? payload : {};
  if (body.resetAll === true) {
    const archived = await archiveCurrentGame(current, body.gameContent);
    const reset = {
      mode: DEFAULT_MODE,
      version: current.version + 1,
      sessionId: newSessionId(),
      updatedAt: new Date().toISOString(),
      timer: defaultTimer(),
      groups: defaultGroups(),
      participants: [],
      recreation: defaultRecreation(),
      announcement: null,
      archivedSessionId: String(archived?.id || ""),
      archivedAt: String(archived?.archived_at || ""),
    };
    if (hasRedis()) {
      await redisCommands([
        ["SET", MODE_KEY, JSON.stringify(reset)],
        ["DEL", ...EVIDENCE_KEYS],
        ["DEL", ...CLUE_KEYS],
        ["DEL", ...NOTE_KEYS],
      ]);
    } else {
      globalThis.__upupGameModeState = reset;
    }
    return reset;
  }
  const next = {
    mode: normalizeMode(body.mode ?? current.mode),
    version: current.version + 1,
    sessionId: current.sessionId || "legacy",
    updatedAt: new Date().toISOString(),
    timer: nextTimer(current.timer, body.timer),
    groups: Array.isArray(body.groups) ? normalizeGroups(body.groups) : normalizeGroups(current.groups),
    participants: nextParticipants(current.participants, body.participant),
    recreation: nextRecreationWithWordScan(nextRecreation(current.recreation, body.recreation), Array.isArray(body.groups) ? body.groups : current.groups, body.wordScan),
    announcement: nextAnnouncement(current.announcement, body.announcement),
  };

  if (hasRedis()) {
    await redisCommand(["SET", MODE_KEY, JSON.stringify(next)]);
  } else {
    globalThis.__upupGameModeState = next;
  }

  return next;
}

export default async function handler(request, response) {
  const startedAt = Date.now();

  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  try {
    if (request.method === "GET") {
      const state = await readModeState();
      response.status(200).json({ ...state, source: stateSource(), warning: stateWarning(), latencyMs: Date.now() - startedAt });
      return;
    }

    if (request.method === "POST") {
      const state = await writeModeState(request.body);
      const kind = modeChangeKind(request.body);
      if (kind !== "participant") {
        await broadcastRealtime(globalRealtimeTopic(), "state-changed", {
          kind,
          version: state.version,
          sessionId: state.sessionId,
          updatedAt: state.updatedAt,
          state: {
            mode: state.mode,
            version: state.version,
            sessionId: state.sessionId,
            timer: state.timer,
            groups: state.groups,
            recreation: state.recreation,
            announcement: state.announcement,
          },
        });
      }
      response.status(200).json({ ...state, source: stateSource(), warning: stateWarning(), latencyMs: Date.now() - startedAt });
      return;
    }
  } catch (error) {
    response.status(503).json({
      error: "Mode store unavailable",
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return;
  }

  response.status(405).json({ error: "Method not allowed" });
}
