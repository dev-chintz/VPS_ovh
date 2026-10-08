// GET /api/status – wynik ostatniego sprawdzenia dla strony statusu.
// Zwraca wyłącznie stan lokalizacji i czasy; token i chat ID nigdy tu nie trafiają.
import { getStore } from "@netlify/blobs";

export default async () => {
  const blobs = getStore({ name: "ovh-vps-monitor", consistency: "strong" });
  const state = await blobs.get("state", { type: "json" });
  const body = {
    lastCheck: state?.lastCheck ?? null,
    lastNotification: state?.lastNotification ?? null,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
};

export const config = {
  path: "/api/status",
};
