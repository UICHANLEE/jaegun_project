const ARCHIVE_TABLE = "game_archives";
const GROUP_NUMBERS = [1, 2, 3];

function supabaseUrl() {
  return String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
}

function supabaseServerKey() {
  return String(
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "",
  );
}

export function hasSupabaseArchive() {
  return Boolean(supabaseUrl() && supabaseServerKey());
}

export function archiveConfigurationMessage() {
  if (!supabaseUrl()) return "SUPABASE_URL 환경변수가 없습니다.";
  if (!supabaseServerKey()) return "SUPABASE_SERVICE_ROLE_KEY 또는 SUPABASE_SECRET_KEY 환경변수가 없습니다.";
  return "";
}

async function supabaseRequest(path, options = {}) {
  if (!hasSupabaseArchive()) throw new Error(archiveConfigurationMessage());
  const response = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: supabaseServerKey(),
      Authorization: `Bearer ${supabaseServerKey()}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const detail = payload?.message || payload?.details || payload?.hint || payload || `HTTP ${response.status}`;
    throw new Error(`Supabase 보관 실패: ${detail}`);
  }
  return payload;
}

function parseJsonList(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => {
      if (value && typeof value === "object") return value;
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseHash(values) {
  const source = Array.isArray(values) ? values : [];
  const result = {};
  for (let index = 0; index < source.length; index += 2) {
    const key = String(source[index] || "");
    const rawValue = source[index + 1];
    if (!key) continue;
    try {
      result[key] = JSON.parse(rawValue);
    } catch {
      result[key] = rawValue;
    }
  }
  return result;
}

export function buildTeamArchive(redisResults) {
  return Object.fromEntries(
    GROUP_NUMBERS.map((group, index) => {
      const offset = index * 3;
      const evidence = parseJsonList(redisResults[offset]);
      const clueIds = [...new Set((Array.isArray(redisResults[offset + 1]) ? redisResults[offset + 1] : []).map(String))].sort();
      const notes = parseHash(redisResults[offset + 2]);
      return [
        String(group),
        {
          evidence,
          clueIds,
          notes,
          evidenceCount: evidence.length,
        },
      ];
    }),
  );
}

export function buildArchiveSummary(teamData) {
  return Object.fromEntries(
    GROUP_NUMBERS.map((group) => {
      const data = teamData[String(group)] || {};
      const notes = data.notes && typeof data.notes === "object" ? data.notes : {};
      const noteCount = Object.values(notes).reduce((total, note) => {
        const items = Array.isArray(note?.items) ? note.items : note?.content ? [note] : [];
        return total + items.length;
      }, 0);
      return [
        String(group),
        {
          evidenceCount: Array.isArray(data.evidence) ? data.evidence.length : 0,
          clueCount: Array.isArray(data.clueIds) ? data.clueIds.length : 0,
          noteCount,
        },
      ];
    }),
  );
}

export async function saveGameArchive(modeState, teamData) {
  const sessionId = String(modeState?.sessionId || "legacy");
  const archivedAt = new Date().toISOString();
  const record = {
    session_id: sessionId,
    title: `게임 회차 ${archivedAt.slice(0, 10)} ${archivedAt.slice(11, 16)}`,
    archived_at: archivedAt,
    mode_state: modeState,
    team_data: teamData,
    evidence_summary: buildArchiveSummary(teamData),
    created_by: "admin-reset",
  };
  const payload = await supabaseRequest(`${ARCHIVE_TABLE}?on_conflict=session_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(record),
  });
  return Array.isArray(payload) ? payload[0] : payload;
}

export async function listGameArchives(limit = 30) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const columns = "id,session_id,title,archived_at,evidence_summary,mode_state";
  return supabaseRequest(
    `${ARCHIVE_TABLE}?select=${columns}&order=archived_at.desc&limit=${safeLimit}`,
    { method: "GET" },
  );
}

export async function getGameArchive(id) {
  const safeId = encodeURIComponent(String(id || ""));
  if (!safeId) throw new Error("보관 회차 ID가 필요합니다.");
  const payload = await supabaseRequest(
    `${ARCHIVE_TABLE}?select=*&id=eq.${safeId}&limit=1`,
    { method: "GET" },
  );
  return Array.isArray(payload) ? payload[0] || null : null;
}

export async function getGameArchiveBySessionId(sessionId) {
  const normalized = String(sessionId || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(normalized)) throw new Error("올바른 회차 세션 ID가 필요합니다.");
  const safeSessionId = encodeURIComponent(normalized);
  const payload = await supabaseRequest(
    `${ARCHIVE_TABLE}?select=*&session_id=eq.${safeSessionId}&limit=1`,
    { method: "GET" },
  );
  return Array.isArray(payload) ? payload[0] || null : null;
}
