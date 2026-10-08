// Funkcja cykliczna Netlify: co 5 minut sprawdza dostępność VPS w OVH
// i wysyła powiadomienie na Telegram. Stan (deduplikacja) jest w Netlify Blobs.
import { getStore } from "@netlify/blobs";
import { runCheck } from "../../lib/monitor-core.mjs";

const KEYS = [
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "PLAN_NAME", "PLAN_CODES", "OVH_SUBSIDIARY",
  "PRIORITY_DATACENTERS", "EUROPE_DATACENTERS", "NON_EUROPE_DATACENTERS", "STORAGE",
  "OS_FAMILY", "NOTIFY_PREORDER", "ERROR_ALERT_AFTER", "STARTUP_MESSAGE", "ORDER_URL",
  "CATALOG_REFRESH_HOURS", "DRY_RUN",
];

// Zmienne z process.env, a jeśli ich tam nie ma – z Netlify.env (API funkcji Netlify).
function readEnv() {
  const env = { ...process.env };
  const netlifyEnv = globalThis.Netlify?.env;
  for (const key of KEYS) {
    if (!env[key] && netlifyEnv?.has?.(key)) env[key] = netlifyEnv.get(key);
  }
  return env;
}

export default async () => {
  const blobs = getStore({ name: "ovh-vps-monitor", consistency: "strong" });
  const store = {
    get: () => blobs.get("state", { type: "json" }),
    set: (state) => blobs.setJSON("state", state),
  };
  const result = await runCheck({ env: readEnv(), store, budgetMs: 25000 });
  console.log(result.ok ? "Sprawdzenie OK" : `Sprawdzenie nieudane: ${result.error}`);
};

// Cron w UTC. "*/5 * * * *" = co 5 minut.
export const config = {
  schedule: "*/5 * * * *",
};
