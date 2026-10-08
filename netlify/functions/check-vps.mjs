// Funkcja cykliczna Netlify: co 5 minut sprawdza dostępność VPS w OVH
// i wysyła powiadomienie na Telegram. Stan (deduplikacja) jest w Netlify Blobs.
import { getStore } from "@netlify/blobs";
import { runCheck } from "../../lib/monitor-core.mjs";

export default async () => {
  const blobs = getStore({ name: "ovh-vps-monitor", consistency: "strong" });
  const store = {
    get: () => blobs.get("state", { type: "json" }),
    set: (state) => blobs.setJSON("state", state),
  };
  const result = await runCheck({ store, budgetMs: 25000 });
  console.log(result.ok ? "Sprawdzenie OK" : `Sprawdzenie nieudane: ${result.error}`);
};

// Cron w UTC. "*/5 * * * *" = co 5 minut.
export const config = {
  schedule: "*/5 * * * *",
};
