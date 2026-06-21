const MODE_KEY = "crime-scene:mode";
const EVIDENCE_KEY_PREFIX = "crime-scene:evidence:group:";
const CLUE_KEY_PREFIX = "crime-scene:clues:group:";
const MAX_ITEMS_PER_GROUP = 18;
const VALID_CLUE_IDS = new Set(Array.from({ length: 12 }, (_, index) => `H${String(index + 1).padStart(2, "0")}`));

function hasRedis() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
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
  if (!response.ok) throw new Error(`Redis request failed with ${response.status}`);
  const [result] = await response.json();
  if (result.error) throw new Error(result.error);
  return result.result;
}

function normalizeNameKey(name) {
  return String(name || "").trim().replace(/\s+/g, "").toLowerCase();
}

function normalizeGroupNumber(value) {
  const group = Number(value);
  return Number.isInteger(group) && group >= 1 && group <= 3 ? group : null;
}

function normalizeClueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").toUpperCase()))]
    .filter((value) => VALID_CLUE_IDS.has(value))
    .sort();
}

function parseEvidenceItems(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function readModeState() {
  const rawState = await redisCommand(["GET", MODE_KEY]);
  return rawState ? JSON.parse(rawState) : {};
}

async function resolveParticipantGroup(name) {
  const key = normalizeNameKey(name);
  if (!key) return null;
  const state = await readModeState();
  const groups = Array.isArray(state.groups) ? state.groups : [];
  const group = groups.find((item) =>
    (Array.isArray(item?.names) ? item.names : []).some((member) => normalizeNameKey(member) === key),
  );
  return group ? normalizeGroupNumber(group.number) : null;
}

function sendError(response, status, message) {
  response.status(status).json({ error: message });
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  if (!hasRedis()) {
    sendError(response, 503, "Shared team storage is unavailable");
    return;
  }

  try {
    if (request.method === "GET") {
      const group = normalizeGroupNumber(request.query?.group);
      if (!group) {
        sendError(response, 400, "Valid group number required");
        return;
      }
      const includeEvidence = String(request.query?.evidence ?? "1") !== "0";
      const evidence = includeEvidence
        ? await redisCommand(["LRANGE", `${EVIDENCE_KEY_PREFIX}${group}`, 0, MAX_ITEMS_PER_GROUP - 1])
        : null;
      const evidenceCount = Number(await redisCommand(["LLEN", `${EVIDENCE_KEY_PREFIX}${group}`])) || 0;
      const latestEvidenceRaw = await redisCommand(["LINDEX", `${EVIDENCE_KEY_PREFIX}${group}`, 0]);
      const latestEvidenceId = parseEvidenceItems(latestEvidenceRaw ? [latestEvidenceRaw] : [])[0]?.id || "";
      const clueIds = await redisCommand(["SMEMBERS", `${CLUE_KEY_PREFIX}${group}`]);
      response.status(200).json({
        group,
        clueIds: normalizeClueIds(clueIds),
        evidenceCount,
        latestEvidenceId,
        ...(includeEvidence ? { evidence: parseEvidenceItems(evidence) } : {}),
        source: "redis",
      });
      return;
    }

    if (request.method === "POST") {
      const name = String(request.body?.name || "").trim();
      const group = await resolveParticipantGroup(name);
      if (!group) {
        sendError(response, 403, "Group assignment required");
        return;
      }
      const clueIds = normalizeClueIds(request.body?.clueIds);
      if (clueIds.length) {
        await redisCommand(["SADD", `${CLUE_KEY_PREFIX}${group}`, ...clueIds]);
      }
      const storedClueIds = await redisCommand(["SMEMBERS", `${CLUE_KEY_PREFIX}${group}`]);
      response.status(200).json({ group, clueIds: normalizeClueIds(storedClueIds), source: "redis" });
      return;
    }
  } catch (error) {
    sendError(response, 503, error instanceof Error ? error.message : "Team storage unavailable");
    return;
  }

  sendError(response, 405, "Method not allowed");
}
