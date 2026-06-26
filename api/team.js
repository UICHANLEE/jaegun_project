const MODE_KEY = "crime-scene:mode";
const EVIDENCE_KEY_PREFIX = "crime-scene:evidence:group:";
const CLUE_KEY_PREFIX = "crime-scene:clues:group:";
const NOTE_KEY_PREFIX = "crime-scene:notes:group:";
const MAX_ITEMS_PER_GROUP = 18;
const MAX_NOTE_LENGTH = 1200;
const MAX_NOTE_ITEMS_PER_SUSPECT = 30;
const VALID_CLUE_IDS = new Set(["H01", "H02", "H03", "H05", "H06", "H07", "H09", "H10", "H11", "H13", "H14", "H15"]);
const VALID_SUSPECT_IDS = new Set(["P01", "P02", "P03", "P04"]);

function hasRedis() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
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
  if (!response.ok) throw new Error(`Redis request failed with ${response.status}`);
  const results = await response.json();
  return results.map((result) => {
    if (result.error) throw new Error(result.error);
    return result.result;
  });
}

async function redisCommand(command) {
  const [result] = await redisCommands([command]);
  return result;
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

function normalizeNoteContent(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .slice(0, MAX_NOTE_LENGTH);
}

function normalizeNoteItems(note) {
  const sourceItems = Array.isArray(note?.items)
    ? note.items
    : normalizeNoteContent(note?.content)
      ? [
          {
            id: String(note?.updatedAt || Date.now()),
            author: note?.updatedBy || "",
            content: note?.content || "",
            createdAt: note?.updatedAt || "",
          },
        ]
      : [];
  return sourceItems
    .map((item, index) => ({
      id: String(item?.id || `${item?.createdAt || "note"}-${index}`).slice(0, 80),
      author: String(item?.author || item?.updatedBy || "").trim().slice(0, 40),
      content: normalizeNoteContent(item?.content),
      createdAt: String(item?.createdAt || item?.updatedAt || ""),
    }))
    .filter((item) => item.content)
    .slice(-MAX_NOTE_ITEMS_PER_SUSPECT);
}

function normalizeNotes(values) {
  const entries = Array.isArray(values)
    ? values.reduce((result, value, index, source) => {
        if (index % 2 === 0) result.push([value, source[index + 1]]);
        return result;
      }, [])
    : Object.entries(values && typeof values === "object" ? values : {});

  return Object.fromEntries(
    entries
      .map(([suspectId, rawNote]) => {
        const id = String(suspectId || "").toUpperCase();
        if (!VALID_SUSPECT_IDS.has(id)) return null;
        let note = rawNote;
        if (typeof rawNote === "string") {
          try {
            note = JSON.parse(rawNote);
          } catch {
            note = { content: rawNote };
          }
        }
        const items = normalizeNoteItems(note);
        const latest = items.at(-1) || null;
        return [
          id,
          {
            items,
            updatedBy: String(latest?.author || note?.updatedBy || "").trim().slice(0, 40),
            updatedAt: String(latest?.createdAt || note?.updatedAt || ""),
          },
        ];
      })
      .filter(Boolean),
  );
}

function normalizeIncomingNote(body, author) {
  const note = body?.note && typeof body.note === "object" ? body.note : {};
  const suspectId = String(note.suspectId || body?.suspectId || "").toUpperCase();
  if (!VALID_SUSPECT_IDS.has(suspectId)) return null;
  const content = normalizeNoteContent(note.content ?? body?.content).trim();
  if (!content) return null;
  return {
    suspectId,
    item: {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
      author: String(author || "").trim().slice(0, 40),
      content,
      createdAt: new Date().toISOString(),
    },
  };
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
      const evidenceKey = `${EVIDENCE_KEY_PREFIX}${group}`;
      const clueKey = `${CLUE_KEY_PREFIX}${group}`;
      const noteKey = `${NOTE_KEY_PREFIX}${group}`;
      const commands = includeEvidence
        ? [
            ["LRANGE", evidenceKey, 0, MAX_ITEMS_PER_GROUP - 1],
            ["LLEN", evidenceKey],
            ["LINDEX", evidenceKey, 0],
            ["SMEMBERS", clueKey],
            ["HGETALL", noteKey],
          ]
        : [
            ["LLEN", evidenceKey],
            ["LINDEX", evidenceKey, 0],
            ["SMEMBERS", clueKey],
            ["HGETALL", noteKey],
          ];
      const results = await redisCommands(commands);
      const evidence = includeEvidence ? results[0] : null;
      const offset = includeEvidence ? 1 : 0;
      const evidenceCount = Number(results[offset]) || 0;
      const latestEvidenceRaw = results[offset + 1];
      const latestEvidenceId = parseEvidenceItems(latestEvidenceRaw ? [latestEvidenceRaw] : [])[0]?.id || "";
      const clueIds = results[offset + 2];
      const notes = results[offset + 3];
      response.status(200).json({
        group,
        clueIds: normalizeClueIds(clueIds),
        notes: normalizeNotes(notes),
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
      const clueKey = `${CLUE_KEY_PREFIX}${group}`;
      const noteKey = `${NOTE_KEY_PREFIX}${group}`;
      const incomingNote = normalizeIncomingNote(request.body, name);
      const commands = [];
      if (incomingNote) {
        const currentRawNote = await redisCommand(["HGET", noteKey, incomingNote.suspectId]);
        const currentNote = normalizeNotes({ [incomingNote.suspectId]: currentRawNote })[incomingNote.suspectId] || { items: [] };
        const nextNote = {
          items: [...currentNote.items, incomingNote.item].slice(-MAX_NOTE_ITEMS_PER_SUSPECT),
        };
        commands.push(["HSET", noteKey, incomingNote.suspectId, JSON.stringify(nextNote)]);
      }
      if (clueIds.length) {
        commands.push(["SADD", clueKey, ...clueIds]);
      }
      commands.push(["SMEMBERS", clueKey], ["HGETALL", noteKey]);
      const results = await redisCommands(commands);
      const storedClueIds = results.at(-2);
      const storedNotes = results.at(-1);
      response.status(200).json({ group, clueIds: normalizeClueIds(storedClueIds), notes: normalizeNotes(storedNotes), source: "redis" });
      return;
    }
  } catch (error) {
    sendError(response, 503, error instanceof Error ? error.message : "Team storage unavailable");
    return;
  }

  sendError(response, 405, "Method not allowed");
}
