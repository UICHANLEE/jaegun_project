const GLOBAL_TOPIC = "jaegun-game";

function supabaseUrl() {
  return String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
}

function serverKey() {
  return String(
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "",
  );
}

export function realtimePublicConfig() {
  const url = supabaseUrl();
  const key = String(
    process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      "",
  );
  return { enabled: Boolean(url && key), url, key };
}

export function globalRealtimeTopic() {
  return GLOBAL_TOPIC;
}

export function teamRealtimeTopic(group) {
  const number = Math.max(1, Math.min(3, Number(group) || 1));
  return `jaegun-team-${number}`;
}

export async function broadcastRealtime(topic, event, payload) {
  const url = supabaseUrl();
  const key = serverKey();
  if (!url || !key) return false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch(
      `${url}/realtime/v1/api/broadcast/${encodeURIComponent(topic)}/events/${encodeURIComponent(event)}`,
      {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload || {}),
        signal: controller.signal,
      },
    );
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function modeChangeKind(body) {
  if (body?.resetAll === true) return "reset";
  if (body?.mode !== undefined) return "mode";
  if (body?.timer) return "timer";
  if (Array.isArray(body?.groups)) return "groups";
  if (body?.recreation) return "recreation";
  if (body?.wordScan) return "word-scan";
  if (body?.participant) return "participant";
  return "state";
}
