import {
  archiveConfigurationMessage,
  getGameArchive,
  getGameArchiveBySessionId,
  hasSupabaseArchive,
  listGameArchives,
} from "../lib/supabase-archive.js";

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  if (request.method !== "GET") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!hasSupabaseArchive()) {
    response.status(503).json({ error: "Archive storage unavailable", message: archiveConfigurationMessage() });
    return;
  }

  try {
    const id = String(request.query?.id || "").trim();
    const sessionId = String(request.query?.sessionId || "").trim();
    if (sessionId) {
      const archive = await getGameArchiveBySessionId(sessionId);
      if (!archive) {
        response.status(404).json({ error: "Archive not found" });
        return;
      }
      response.status(200).json({ archive, source: "supabase" });
      return;
    }
    if (id) {
      const archive = await getGameArchive(id);
      if (!archive) {
        response.status(404).json({ error: "Archive not found" });
        return;
      }
      response.status(200).json({ archive, source: "supabase" });
      return;
    }
    const archives = await listGameArchives(request.query?.limit);
    response.status(200).json({ archives, source: "supabase" });
  } catch (error) {
    response.status(503).json({
      error: "Archive storage unavailable",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
