import { globalRealtimeTopic, realtimePublicConfig } from "../lib/realtime.js";

export default function handler(request, response) {
  response.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }
  if (request.method !== "GET") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const config = realtimePublicConfig();
  response.status(200).json({ ...config, topic: globalRealtimeTopic() });
}
