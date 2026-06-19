const DEFAULT_MODE = "recreation";
const MODE_KEY = "crime-scene:mode";

function normalizeMode(mode) {
  return mode === "crime" ? "crime" : DEFAULT_MODE;
}

function fallbackState() {
  globalThis.__upupGameModeState ||= {
    mode: DEFAULT_MODE,
    version: 1,
    updatedAt: new Date().toISOString(),
    timer: defaultTimer(),
    groups: defaultGroups(),
  };
  return globalThis.__upupGameModeState;
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
    const remaining = Math.floor((new Date(timer.endsAt).getTime() - Date.now()) / 1000);
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

  if (payload.action === "stop") {
    timer.remainingSeconds = currentRemaining(timer);
    timer.running = false;
    timer.endsAt = "";
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
  const response = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([command]),
  });

  if (!response.ok) {
    throw new Error(`Redis request failed with ${response.status}`);
  }

  const [result] = await response.json();
  if (result.error) {
    throw new Error(result.error);
  }
  return result.result;
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
        updatedAt: parsed.updatedAt || new Date().toISOString(),
        timer: withLiveRemaining(parsed.timer),
        groups: normalizeGroups(parsed.groups),
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
  const current = await readModeState();
  const body = payload && typeof payload === "object" ? payload : {};
  const next = {
    mode: normalizeMode(body.mode ?? current.mode),
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
    timer: nextTimer(current.timer, body.timer),
    groups: Array.isArray(body.groups) ? normalizeGroups(body.groups) : normalizeGroups(current.groups),
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
