const MODE_KEY = "crime-scene:mode";
const EVIDENCE_KEY_PREFIX = "crime-scene:evidence:group:";
const MAX_ITEMS_PER_GROUP = 18;
const MAX_IMAGE_DATA_LENGTH = 280000;

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

async function resolveParticipantGroup(name) {
  const key = normalizeNameKey(name);
  if (!key) return null;

  const rawState = await redisCommand(["GET", MODE_KEY]);
  if (!rawState) return null;

  const state = JSON.parse(rawState);
  const groups = Array.isArray(state.groups) ? state.groups : [];
  const group = groups.find((item) =>
    (Array.isArray(item?.names) ? item.names : []).some((member) => normalizeNameKey(member) === key),
  );
  return group ? Math.max(1, Number(group.number) || 1) : null;
}

function evidenceKey(groupNumber) {
  return `${EVIDENCE_KEY_PREFIX}${groupNumber}`;
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

function isValidImageData(imageData) {
  return (
    typeof imageData === "string" &&
    imageData.length <= MAX_IMAGE_DATA_LENGTH &&
    /^data:image\/(?:jpeg|webp|png);base64,[a-z0-9+/=]+$/i.test(imageData)
  );
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
    sendError(response, 503, "Shared evidence storage is unavailable");
    return;
  }

  try {
    const name = String(request.method === "GET" ? request.query?.name || "" : request.body?.name || "").trim();
    const group = await resolveParticipantGroup(name);
    if (!group) {
      sendError(response, 403, "Group assignment required");
      return;
    }

    if (request.method === "GET") {
      const values = await redisCommand(["LRANGE", evidenceKey(group), 0, MAX_ITEMS_PER_GROUP - 1]);
      response.status(200).json({ group, items: parseEvidenceItems(values), source: "redis" });
      return;
    }

    if (request.method === "POST") {
      const imageData = request.body?.imageData;
      if (!isValidImageData(imageData)) {
        sendError(response, 400, "Invalid or oversized evidence image");
        return;
      }

      const item = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
        group,
        author: name.slice(0, 30),
        caption: String(request.body?.caption || "증거 사진").trim().slice(0, 60) || "증거 사진",
        imageData,
        createdAt: new Date().toISOString(),
      };

      await redisCommand(["LPUSH", evidenceKey(group), JSON.stringify(item)]);
      await redisCommand(["LTRIM", evidenceKey(group), 0, MAX_ITEMS_PER_GROUP - 1]);
      response.status(201).json({ group, item, source: "redis" });
      return;
    }
  } catch (error) {
    sendError(response, 503, error instanceof Error ? error.message : "Evidence storage unavailable");
    return;
  }

  sendError(response, 405, "Method not allowed");
}
