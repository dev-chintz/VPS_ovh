// Logika monitora dostępności VPS w OVHcloud (port z local/monitor.py).
// Moduł nie zależy od Netlify: magazyn stanu, fetch i logowanie są wstrzykiwane,
// dzięki czemu ten sam kod działa w funkcji Netlify i w lokalnym dry-runie.
//
// Endpointy OVH (oba publiczne, bez kluczy API):
//   GET /order/catalog/public/vps?ovhSubsidiary=PL
//   GET /vps/order/rule/datacenter/aggregated?ovhSubsidiary=PL&planCodes=a,b
//
// Skrypt NIGDY nie składa zamówień.

export const VERSION = "1.1.0";
const CATALOG_PATH = "/order/catalog/public/vps";
const AVAILABILITY_PATH = "/vps/order/rule/datacenter/aggregated";
const TELEGRAM_API = "https://api.telegram.org";
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export const STATUS_LEVEL = {
  "out-of-stock": 0,
  "out-of-stock-preorder-allowed": 1,
  available: 2,
};
export const STATUS_PL = {
  available: "dostępny",
  "out-of-stock-preorder-allowed": "przedsprzedaż",
  "out-of-stock": "brak",
};
export const DC_NAMES_PL = {
  WAW: "Warszawa",
  DE: "Niemcy",
  GRA: "Gravelines (Francja)",
  SBG: "Strasburg (Francja)",
  RBX: "Roubaix (Francja)",
  UK: "Wielka Brytania",
  BHS: "Beauharnois (Kanada)",
  SGP: "Singapur",
  SYD: "Sydney",
};

export class ApiError extends Error {}
export class PlanNotFound extends Error {
  constructor(planName, names) {
    super(`Nie znaleziono planu ${planName}`);
    this.planName = planName;
    this.names = names;
  }
}

// ---------------------------------------------------------------------------
// Konfiguracja
// ---------------------------------------------------------------------------

const str = (env, key, def = "") => String(env[key] ?? def).trim() || def;
const bool = (env, key, def) => {
  const v = str(env, key);
  return v ? ["1", "true", "yes", "tak", "on"].includes(v.toLowerCase()) : def;
};
const num = (env, key, def) => {
  const v = str(env, key);
  if (!v) return def;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Błędna wartość ${key}=${v} (oczekiwano liczby)`);
  return n;
};
const list = (env, key, def) =>
  str(env, key, def).split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);

export function loadConfig(env = process.env) {
  const storage = str(env, "STORAGE", "local").toLowerCase();
  if (!["local", "remote", "any"].includes(storage))
    throw new Error("STORAGE musi mieć wartość: local, remote lub any");
  const osFamily = str(env, "OS_FAMILY", "linux").toLowerCase();
  if (!["linux", "windows", "any"].includes(osFamily))
    throw new Error("OS_FAMILY musi mieć wartość: linux, windows lub any");
  return {
    planName: str(env, "PLAN_NAME", "VPS-2 2027"),
    planCodesOverride: str(env, "PLAN_CODES").split(",").map((x) => x.trim()).filter(Boolean),
    subsidiary: str(env, "OVH_SUBSIDIARY", "PL").toUpperCase(),
    apiBase: str(env, "OVH_API_BASE", "https://eu.api.ovh.com/v1").replace(/\/+$/, ""),
    priorityDcs: list(env, "PRIORITY_DATACENTERS", "WAW"),
    europeDcs: list(env, "EUROPE_DATACENTERS", "WAW,DE,GRA,SBG,RBX,UK"),
    nonEuropeDcs: list(env, "NON_EUROPE_DATACENTERS", "BHS,SGP,SYD"),
    storage,
    osFamily,
    notifyPreorder: bool(env, "NOTIFY_PREORDER", true),
    catalogRefreshHours: num(env, "CATALOG_REFRESH_HOURS", 6),
    errorAlertAfter: num(env, "ERROR_ALERT_AFTER", 6),
    telegramToken: str(env, "TELEGRAM_BOT_TOKEN"),
    telegramChatId: str(env, "TELEGRAM_CHAT_ID"),
    startupMessage: bool(env, "STARTUP_MESSAGE", true),
    orderUrl: str(env, "ORDER_URL", "https://www.ovhcloud.com/pl/vps/"),
    dryRun: bool(env, "DRY_RUN", false),
  };
}

// ---------------------------------------------------------------------------
// Narzędzia
// ---------------------------------------------------------------------------

export function makeRedactor(cfg) {
  const secrets = [cfg.telegramToken, cfg.telegramChatId].filter((s) => s && s.length >= 4);
  return (text) => secrets.reduce((t, s) => t.split(s).join("***"), String(text));
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalize = (s) => String(s).replace(/ /g, " ").replace(/\s+/g, " ").trim().toLowerCase();
export const dcKey = (name) => {
  const up = String(name).trim().toUpperCase();
  return up.replace(/\d+$/, "") || up;
};
const fmtTime = (ms) =>
  new Date(ms).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw", dateStyle: "short", timeStyle: "short" });

async function fetchJson(deps, url, params, { attempts = 3, timeoutMs = 8000, deadline = Infinity } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let lastErr = "nieznany błąd";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const r = await deps.fetch(u, {
        headers: { Accept: "application/json", "User-Agent": `ovh-vps-monitor/${VERSION}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status === 200) {
        try {
          return await r.json();
        } catch {
          lastErr = "odpowiedź nie jest poprawnym JSON-em";
        }
      } else if (RETRYABLE.has(r.status)) {
        lastErr = `HTTP ${r.status}`;
      } else {
        const body = (await r.text()).slice(0, 300).replace(/\n/g, " ");
        throw new ApiError(`HTTP ${r.status} dla ${u.origin}${u.pathname}: ${body}`);
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      lastErr = `${e.name}: ${e.message}`;
    }
    if (attempt === attempts) break;
    const delay = 2000 * 2 ** (attempt - 1) + Math.random() * 500;
    if (deps.now() + delay + timeoutMs > deadline) break; // limit czasu funkcji (30 s)
    deps.log(`Błąd zapytania (${lastErr}), próba ${attempt}/${attempts}, ponawiam za ${(delay / 1000).toFixed(0)} s`);
    await deps.sleep(delay);
  }
  throw new ApiError(`${lastErr} dla ${u.origin}${u.pathname}`);
}

// ---------------------------------------------------------------------------
// OVH: katalog i dostępność
// ---------------------------------------------------------------------------

export function planInfo(plan) {
  let price = "?";
  for (const p of plan.pricings || []) {
    if (p.mode === "default" && (p.capacities || []).includes("renew") &&
        p.intervalUnit === "month" && p.interval === 1) {
      price = p.formattedPrice || "?";
      break;
    }
  }
  const dcConf = (plan.configurations || []).find((c) => c.name === "vps_datacenter");
  return {
    planCode: String(plan.planCode || ""),
    invoiceName: String(plan.invoiceName || ""),
    monthlyPrice: price,
    datacenters: (dcConf?.values || []).map(String),
  };
}

export async function fetchCatalog(cfg, deps, deadline) {
  const data = await fetchJson(deps, cfg.apiBase + CATALOG_PATH, { ovhSubsidiary: cfg.subsidiary },
    { attempts: 2, timeoutMs: 15000, deadline });
  if (!data || !Array.isArray(data.plans)) throw new ApiError("Katalog OVH ma nieoczekiwany format (brak listy 'plans')");
  return data.plans;
}

export async function discoverPlans(cfg, deps, deadline) {
  const plans = await fetchCatalog(cfg, deps, deadline);
  const target = normalize(cfg.planName);
  const found = plans.filter((p) => normalize(p.invoiceName || "") === target).map(planInfo);
  if (!found.length) {
    const names = [...new Set(plans.map((p) => p.invoiceName).filter(Boolean))].sort();
    throw new PlanNotFound(cfg.planName, names);
  }
  found.sort((a, b) => a.planCode.length - b.planCode.length || a.planCode.localeCompare(b.planCode));
  return found;
}

function pickStatus(dc, osFamily) {
  if (osFamily === "linux") return String(dc.linuxStatus || dc.status || "");
  if (osFamily === "windows") return String(dc.windowsStatus || dc.status || "");
  return String(dc.status || "");
}

export function parseAvailability(cfg, data, planCodes, log = () => {}) {
  if (!data || !Array.isArray(data.models))
    throw new ApiError("Endpoint dostępności zwrócił nieoczekiwany format (brak listy 'models')");
  const wanted = new Set(planCodes);
  const result = {};
  let seenPlan = false;
  for (const model of data.models) {
    const pc = String(model.planCode || "");
    if (wanted.size && !wanted.has(pc)) continue;
    seenPlan = true;
    for (const dc of model.datacenters || []) {
      const remote = Boolean(dc.remoteStorage);
      if (cfg.storage === "local" && remote) continue;
      if (cfg.storage === "remote" && !remote) continue;
      const name = dcKey(dc.datacenter || dc.code || "?");
      const status = pickStatus(dc, cfg.osFamily);
      const level = STATUS_LEVEL[status] ?? -1;
      if (level === -1) log(`Nieznany status "${status}" dla ${name} (plan ${pc})`);
      const prev = result[name];
      if (!prev || level > prev.level) {
        result[name] = {
          name, status, level, planCode: pc, remote,
          days: Number.isInteger(dc.daysBeforeDelivery) ? dc.daysBeforeDelivery : null,
        };
      }
    }
  }
  if (!seenPlan) throw new ApiError(`Endpoint dostępności nie zwrócił danych dla planów: ${planCodes.join(", ")}`);
  return result;
}

export async function fetchAvailability(cfg, deps, planCodes, deadline) {
  const data = await fetchJson(deps, cfg.apiBase + AVAILABILITY_PATH,
    { ovhSubsidiary: cfg.subsidiary, planCodes: planCodes.join(",") }, { deadline });
  return parseAvailability(cfg, data, planCodes, deps.log);
}

// ---------------------------------------------------------------------------
// Ocena: co zgłosić (deduplikacja)
// ---------------------------------------------------------------------------

export function classify(cfg, name) {
  if (cfg.priorityDcs.includes(name)) return "priority";
  if (cfg.europeDcs.includes(name)) return "europe";
  if (cfg.nonEuropeDcs.includes(name)) return "non_europe";
  return "unknown";
}

const GROUP_ORDER = { priority: 0, europe: 1, unknown: 2, non_europe: 3 };

export function evaluate(cfg, statuses, levels) {
  const minLevel = cfg.notifyPreorder ? 1 : 2;
  const prefix = `${cfg.storage}/${cfg.osFamily}:`;
  const newLevels = { ...levels };
  for (const key of Object.keys(newLevels)) {
    if (key.startsWith(prefix) && !(key.slice(prefix.length) in statuses)) newLevels[key] = 0;
  }
  const notify = [];
  for (const [name, st] of Object.entries(statuses)) {
    const key = prefix + name;
    const prev = levels[key] ?? 0;
    const level = Math.max(st.level, 0);
    if (classify(cfg, name) !== "non_europe" && level >= minLevel && level > prev) notify.push(st);
    newLevels[key] = level;
  }
  notify.sort((a, b) => {
    const ga = GROUP_ORDER[classify(cfg, a.name)], gb = GROUP_ORDER[classify(cfg, b.name)];
    if (ga !== gb) return ga - gb;
    const pa = cfg.priorityDcs.indexOf(a.name), pb = cfg.priorityDcs.indexOf(b.name);
    if (pa !== pb) return pa - pb;
    return b.level - a.level || a.name.localeCompare(b.name);
  });
  return { notify, newLevels };
}

// ---------------------------------------------------------------------------
// Wiadomości
// ---------------------------------------------------------------------------

export const dcLabel = (name) => (DC_NAMES_PL[name] ? `${DC_NAMES_PL[name]} (${name})` : name);

export function statusText(st) {
  let t = STATUS_PL[st.status] || st.status || "?";
  if (st.status === "out-of-stock-preorder-allowed" && st.days) t += `, dostawa ok. ${st.days} dni`;
  return t;
}

export function buildMessage(cfg, items, nowMs) {
  const prio = items.find((s) => classify(cfg, s.name) === "priority");
  const head = prio
    ? `🇵🇱 ${cfg.planName}: ${DC_NAMES_PL[prio.name] || prio.name} – można zamawiać!`
    : `🟢 ${cfg.planName}: pojawiła się dostępność w Europie`;
  const lines = [head, ""];
  for (const s of items) {
    const cls = classify(cfg, s.name);
    const mark = cls === "priority" ? "⭐" : "•";
    const extra = cls === "unknown" ? " – nieznana lokalizacja, sprawdź region" : "";
    lines.push(`${mark} ${dcLabel(s.name)}: ${statusText(s)}${extra}`);
  }
  const storage = { local: "dysk lokalny", remote: "dysk zdalny", any: "dowolny dysk" }[cfg.storage];
  const os = { linux: "Linux", windows: "Windows", any: "dowolny system" }[cfg.osFamily];
  lines.push("", `Konfiguracja: ${os}, ${storage}`, `Zamów: ${cfg.orderUrl}`,
    `Sprawdzono: ${fmtTime(nowMs)}`, "Skrypt niczego nie zamawia – dostępność bywa krótka.");
  return lines.join("\n");
}

export function summarize(cfg, statuses) {
  const groups = { priority: [], europe: [], unknown: [], non_europe: [] };
  for (const name of Object.keys(statuses).sort()) {
    groups[classify(cfg, name)].push(`${name}=${STATUS_PL[statuses[name].status] || statuses[name].status || "?"}`);
  }
  const parts = [];
  if (groups.priority.length || groups.europe.length) parts.push("Europa: " + [...groups.priority, ...groups.europe].join(", "));
  if (groups.unknown.length) parts.push("nieznane: " + groups.unknown.join(", "));
  if (groups.non_europe.length) parts.push("poza Europą (ignoruję): " + groups.non_europe.join(", "));
  return parts.join(" | ") || "brak lokalizacji w odpowiedzi";
}

export async function sendTelegram(cfg, deps, text, attempts = 2) {
  if (!cfg.telegramToken || !cfg.telegramChatId) {
    deps.log("Brak TELEGRAM_BOT_TOKEN lub TELEGRAM_CHAT_ID – nie wysyłam");
    return false;
  }
  const redact = makeRedactor(cfg);
  const url = `${TELEGRAM_API}/bot${cfg.telegramToken}/sendMessage`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let err;
    let wait = 2000;
    try {
      const r = await deps.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.telegramChatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8000),
      });
      let body = {};
      try { body = await r.json(); } catch { /* brak JSON */ }
      if (r.status === 200 && body.ok) return true;
      err = `HTTP ${r.status} ${body.description || ""}`.trim();
      if (typeof body.parameters?.retry_after === "number") wait = Math.min(body.parameters.retry_after * 1000 + 500, 5000);
      if ([400, 401, 403, 404].includes(r.status)) {
        deps.log(`Telegram odrzucił wiadomość: ${redact(err)} (sprawdź token i chat ID)`);
        return false;
      }
    } catch (e) {
      err = `${e.name}: ${e.message}`;
    }
    deps.log(`Wysyłka na Telegram nie powiodła się (${redact(err)}), próba ${attempt}/${attempts}`);
    if (attempt < attempts) await deps.sleep(wait);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Jedno sprawdzenie (wywoływane przez funkcję Netlify co 5 min)
// ---------------------------------------------------------------------------

export function defaultState() {
  return {
    levels: {},
    consecutiveFailures: 0,
    failingSince: null,
    errorAlertSent: false,
    planAlertSent: false,
    planCodes: [],
    planCodesFetchedAt: 0,
    startupSent: false,
    lastCheck: null,
    lastNotification: null,
  };
}

/**
 * @param {object} opts
 * @param {{get: () => Promise<object|null>, set: (s: object) => Promise<void>}} opts.store
 * @param {object} [opts.env]   zmienne środowiskowe (domyślnie process.env)
 * @param {Function} [opts.fetch]
 * @param {Function} [opts.log]
 * @param {Function} [opts.sleep]
 * @param {Function} [opts.now]
 * @param {number} [opts.budgetMs] ile czasu ma jedno sprawdzenie (limit funkcji to 30 s)
 */
export async function runCheck(opts) {
  const env = opts.env || process.env;
  const cfg = loadConfig(env);
  const redact = makeRedactor(cfg);
  const deps = {
    fetch: opts.fetch || globalThis.fetch,
    sleep: opts.sleep || defaultSleep,
    now: opts.now || Date.now,
    log: (msg) => (opts.log || console.log)(redact(msg)),
  };
  const started = deps.now();
  const deadline = started + (opts.budgetMs ?? 25000);
  const state = { ...defaultState(), ...((await opts.store.get()) || {}) };
  const result = { ok: false, cfg, codes: [], statuses: {}, notify: [], message: null, error: null };

  const finish = async (fields) => {
    state.lastCheck = {
      at: started,
      ok: result.ok,
      error: result.error,
      summary: fields?.summary ?? null,
      dryRun: cfg.dryRun,
      planName: cfg.planName,
      planCodes: result.codes,
      storage: cfg.storage,
      statuses: Object.values(result.statuses)
        .map((s) => ({ name: s.name, label: dcLabel(s.name), group: classify(cfg, s.name),
          status: s.status, statusText: statusText(s), planCode: s.planCode }))
        .sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.name.localeCompare(b.name)),
    };
    if (!cfg.dryRun) await opts.store.set(state);
    return result;
  };

  const fail = async (message, { alert = true } = {}) => {
    result.error = message;
    state.consecutiveFailures += 1;
    state.failingSince ??= started;
    deps.log(`Sprawdzenie nieudane (${state.consecutiveFailures} z rzędu): ${message}`);
    if (alert && !cfg.dryRun && cfg.errorAlertAfter > 0 &&
        state.consecutiveFailures >= cfg.errorAlertAfter && !state.errorAlertSent) {
      const minutes = Math.round((started - state.failingSince) / 60000);
      const text = `⚠️ Monitor ${cfg.planName} nie może sprawdzić dostępności od ok. ${minutes} min.\n` +
        `Ostatni błąd: ${message.slice(0, 300)}\nMonitor działa dalej i będzie próbował ponownie.`;
      if (await sendTelegram(cfg, deps, text)) state.errorAlertSent = true;
    }
    return finish();
  };

  if (!cfg.dryRun && (!cfg.telegramToken || !cfg.telegramChatId)) {
    const missing = [!cfg.telegramToken && "TELEGRAM_BOT_TOKEN", !cfg.telegramChatId && "TELEGRAM_CHAT_ID"]
      .filter(Boolean).join(" i ");
    return fail(`Funkcja nie widzi zmiennej ${missing}. Sprawdź nazwę i zakres (Scopes: Functions) ` +
      "w Environment variables, a potem wdróż projekt ponownie.", { alert: false });
  }

  if (!cfg.dryRun && cfg.startupMessage && !state.startupSent) {
    const text = `▶️ Monitor ${cfg.planName} uruchomiony.\nSprawdzam co 5 min: ` +
      `${cfg.priorityDcs.map((d) => DC_NAMES_PL[d] || d).join(", ")} (priorytet) i reszta Europy.`;
    if (await sendTelegram(cfg, deps, text)) state.startupSent = true;
  }

  // 1. Kody planu (z katalogu, z pamięci podręcznej albo z PLAN_CODES)
  let codes;
  try {
    if (cfg.planCodesOverride.length) {
      codes = cfg.planCodesOverride;
    } else {
      const ageH = (started - (state.planCodesFetchedAt || 0)) / 3600000;
      if (state.planCodes.length && ageH < cfg.catalogRefreshHours) {
        codes = state.planCodes;
      } else {
        try {
          const plans = await discoverPlans(cfg, deps, deadline);
          codes = plans.map((p) => p.planCode);
          if (codes.join() !== state.planCodes.join()) {
            deps.log(`Plan "${cfg.planName}" w katalogu OVH (${cfg.subsidiary}): ` + plans.map((p) =>
              `${p.planCode} [${p.monthlyPrice}/mies. netto, lokalizacje: ${p.datacenters.join(",") || "?"}]`).join("; "));
          }
          state.planCodes = codes;
          state.planCodesFetchedAt = started;
        } catch (e) {
          if (e instanceof ApiError && state.planCodes.length) {
            deps.log(`Nie udało się odświeżyć katalogu (${e.message}) – używam zapamiętanych kodów`);
            codes = state.planCodes;
          } else {
            throw e;
          }
        }
      }
    }
  } catch (e) {
    if (e instanceof PlanNotFound) {
      const msg = `Nie znaleziono planu "${e.planName}" w katalogu OVH (${cfg.subsidiary}). ` +
        `Dostępne nazwy: ${e.names.join(", ") || "(brak)"}`;
      if (!cfg.dryRun && !state.planAlertSent &&
          await sendTelegram(cfg, deps, `⚠️ ${msg.slice(0, 3500)}\n\nUstaw PLAN_NAME albo PLAN_CODES ` +
            "w zmiennych środowiskowych. Sprawdzam dalej, bez kolejnych przypomnień.")) {
        state.planAlertSent = true;
      }
      return fail(msg, { alert: false });
    }
    if (e instanceof ApiError) return fail(`katalog: ${e.message}`);
    throw e;
  }
  state.planAlertSent = false;
  result.codes = codes;

  // 2. Dostępność
  try {
    result.statuses = await fetchAvailability(cfg, deps, codes, deadline);
  } catch (e) {
    if (e instanceof ApiError) return fail(`dostępność: ${e.message}`);
    throw e;
  }

  if (state.errorAlertSent && !cfg.dryRun) {
    await sendTelegram(cfg, deps, `✅ Monitor ${cfg.planName} znowu działa poprawnie.`);
  }
  state.consecutiveFailures = 0;
  state.failingSince = null;
  state.errorAlertSent = false;
  result.ok = true;

  const summary = summarize(cfg, result.statuses);
  deps.log(`Sprawdzenie ${cfg.planName}: ${summary}`);

  // 3. Powiadomienie
  const { notify, newLevels } = evaluate(cfg, result.statuses, state.levels);
  result.notify = notify;
  if (notify.length) {
    result.message = buildMessage(cfg, notify, started);
    if (cfg.dryRun) {
      deps.log(`DRY_RUN – ta wiadomość zostałaby wysłana:\n${result.message}`);
    } else if (await sendTelegram(cfg, deps, result.message)) {
      deps.log(`Wysłano powiadomienie: ${notify.map((s) => `${s.name}=${s.status}`).join(", ")}`);
      state.lastNotification = { at: started, text: result.message };
    } else {
      // nie zapisujemy nowego poziomu – spróbujemy przy następnym sprawdzeniu
      const prefix = `${cfg.storage}/${cfg.osFamily}:`;
      for (const s of notify) newLevels[prefix + s.name] = state.levels[prefix + s.name] ?? 0;
      deps.log("Nie udało się wysłać powiadomienia – ponowię przy następnym sprawdzeniu");
    }
  }
  state.levels = newLevels;
  return finish({ summary });
}

/** Prosty magazyn w pamięci (dry-run i testy). */
export function memoryStore(initial = null) {
  let value = initial;
  return {
    get: async () => (value ? JSON.parse(JSON.stringify(value)) : null),
    set: async (s) => { value = JSON.parse(JSON.stringify(s)); },
    peek: () => value,
  };
}
