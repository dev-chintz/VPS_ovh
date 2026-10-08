// Narzędzia uruchamiane lokalnie przed wdrożeniem na Netlify:
//   npm run dry-run        – jedno sprawdzenie OVH, wynik na ekranie, nic nie jest wysyłane
//   npm run chat-id        – odczytuje ID czatu (najpierw napisz coś do bota)
//   npm run test-telegram  – wysyła wiadomość testową
// Ustawienia czyta z pliku .env w tym folderze (patrz .env.example).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  runCheck, memoryStore, loadConfig, sendTelegram, makeRedactor, dcLabel, classify, statusText,
} from "../lib/monitor-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && `"'`.includes(value[0])) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const cmd = process.argv[2];

if (cmd === "dry-run") {
  const res = await runCheck({
    env: { ...process.env, DRY_RUN: "true" },
    store: memoryStore(),
    budgetMs: 60000,
    log: (m) => console.log(`[log] ${m}`),
  });
  const { cfg } = res;
  console.log(`\n=== DRY RUN: ${cfg.planName} | oddział OVH: ${cfg.subsidiary} | dysk: ${cfg.storage} | system: ${cfg.osFamily} ===`);
  if (!res.ok) {
    console.log(`Błąd: ${res.error}`);
    process.exit(1);
  }
  console.log("Kody planu:", res.codes.join(", "));
  const groupPl = { priority: "PRIORYTET", europe: "Europa", unknown: "nieznana", non_europe: "poza UE" };
  const order = { priority: 0, europe: 1, unknown: 2, non_europe: 3 };
  const rows = Object.values(res.statuses).sort((a, b) =>
    order[classify(cfg, a.name)] - order[classify(cfg, b.name)] || a.name.localeCompare(b.name));
  console.log("Lokalizacja".padEnd(28), "Grupa".padEnd(12), "Status".padEnd(34), "Plan");
  for (const s of rows) {
    console.log(dcLabel(s.name).padEnd(28), groupPl[classify(cfg, s.name)].padEnd(12), statusText(s).padEnd(34), s.planCode);
  }
  console.log();
  if (res.message) {
    console.log("Ta wiadomość ZOSTAŁABY wysłana na Telegram (dry-run: nie wysyłam):");
    console.log("-".repeat(60) + "\n" + res.message + "\n" + "-".repeat(60));
  } else {
    console.log("Brak dostępności w Europie – nic nie zostałoby wysłane.");
  }
} else if (cmd === "chat-id") {
  const cfg = loadConfig();
  if (!cfg.telegramToken) {
    console.log("Najpierw wpisz TELEGRAM_BOT_TOKEN do pliku .env");
    process.exit(1);
  }
  const redact = makeRedactor(cfg);
  try {
    const r = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/getUpdates`);
    const data = await r.json();
    if (!data.ok) {
      console.log("Telegram odrzucił token:", data.description);
      process.exit(1);
    }
    const chats = new Map();
    for (const u of data.result || []) {
      const chat = (u.message || u.channel_post || {}).chat;
      if (chat?.id) chats.set(chat.id, chat.first_name || chat.title || chat.username || "");
    }
    if (!chats.size) {
      console.log("Brak wiadomości. Napisz coś do swojego bota w Telegramie i uruchom ponownie.");
      process.exit(1);
    }
    console.log("Znalezione czaty (wpisz właściwe ID jako TELEGRAM_CHAT_ID):");
    for (const [id, name] of chats) console.log(`  ${id}  ${name}`);
  } catch (e) {
    console.log("Błąd:", redact(`${e.name}: ${e.message}`));
    process.exit(1);
  }
} else if (cmd === "test-telegram") {
  const cfg = loadConfig();
  const ok = await sendTelegram(cfg, {
    fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now,
    log: (m) => console.log(makeRedactor(cfg)(m)),
  }, `✅ Test: monitor ${cfg.planName} ma połączenie z Telegramem.`);
  console.log(ok ? "Wiadomość testowa wysłana." : "Nie udało się wysłać – sprawdź komunikat powyżej.");
  process.exit(ok ? 0 : 1);
} else {
  console.log("Użycie: npm run dry-run | npm run chat-id | npm run test-telegram");
  process.exit(1);
}
