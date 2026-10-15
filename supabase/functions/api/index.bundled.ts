// СБОРКА для вставки в редактор Supabase (index.ts + ics.ts). Генерируется из соседних файлов.
// Edge Function «api» — единственная точка записи для Mini App.
//
// Каждый POST несёт initData от Telegram. Проверяем HMAC по токену бота,
// берём uid ТОЛЬКО из подписанных данных и пишем service-ролью. Клиент не
// может ни подделать чужой id, ни писать в таблицы напрямую (RLS).
//
// POST {initData, action}:
//   hello    — проверка подписи, регистрация в bot_users, настройки оповещений
//   rank     — месячный итог в рейтинг (с проверкой правдоподобия)
//   consent  — фиксация согласия
//   profile  — смена/группа и какие оповещения слать (бот пересоберёт смены)
//   ics      — личная ссылка на календарь
//   payday   — когда пришла зарплата за месяц (только дата, без сумм)
//   paydays  — сколько человек отметили какую дату: из этого прогноз зарплаты
// GET ?ics=<token> — лента смен для календаря телефона.
//
// Deploy:  supabase functions deploy api --no-verify-jwt
// Secrets: BOT_TOKEN, PROJECT_URL, SERVICE_ROLE_KEY, [BOT_TOKENS], [PUB_SALT], [ALLOWED_ORIGINS]

// ── ics.ts встроен сюда: редактор Supabase в браузере принимает один файл ──
// Календарная лента смен (iCalendar, RFC 5545). Чистая сборка текста без
// ввода-вывода: этот же модуль гоняется тестами под node и используется
// Edge Function.
//
// Зачем именно .ics, а не «интеграция с Google Calendar»: календарь на
// телефоне умеет подписываться на ссылку и сам её перечитывает, а логиниться
// он не умеет. Одна ссылка работает и в Google Calendar, и в Apple Calendar,
// и в Outlook — отдельная OAuth-интеграция ради этого не нужна.
//
// Время местное, по Щецину, и отдаётся с TZID: тогда смена 22:00–06:00
// остаётся ночной и после перевода часов, а не уезжает на час.

type IcsShift = {
  uid: string;
  day: string;                                      // YYYY-MM-DD
  starts: string;                                   // HH:MM:SS
  ends: string;                                     // HH:MM:SS, <= starts — через полночь
  kind?: string | null;
  note?: string | null;
  updated_at?: string | null;
};

const ICS_TZID = "Europe/Warsaw";
const ICS_PRODID = "-//AutoDoc Logistic//Shifts//RU";

// Текст в поле: запятые, точки с запятой, обратные слэши и переводы строк
// экранируются, иначе календарь разберёт строку не так.
function icsEsc(s: string): string {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Строка длиннее 75 октетов складывается: продолжение начинается с пробела.
// Считаем именно октеты — кириллица в UTF-8 по два байта, иначе строгие
// разборщики спотыкаются.
function icsFold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let len = 0;
  for (const ch of line) {                          // по символам, не по кодам
    const n = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;       // в продолжении первый байт — пробел
    if (len + n > limit) { out.push(cur); cur = ""; len = 0; }
    cur += ch; len += n;
  }
  if (cur) out.push(cur);
  return out[0] + out.slice(1).map(s => "\r\n " + s).join("");
}

const pad = (n: number) => String(n).padStart(2, "0");

function icsStamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
         `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// местные дата-время без пояса: пояс задаётся отдельно через TZID
function icsLocal(day: string, hms: string): string {
  return `${day.replace(/-/g, "")}T${String(hms).slice(0, 8).replace(/:/g, "")}`;
}

function icsNextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

const hms = (s: string) => String(s).slice(0, 8);

// Правила перевода часов в Польше — чтобы календарь считал время сам, а не
// полагался на то, что у него в базе поясов.
const ICS_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  `TZID:${ICS_TZID}`,
  "X-LIC-LOCATION:Europe/Warsaw",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

function icsEvent(s: IcsShift, now: Date): string[] {
  const endDay = hms(s.ends) <= hms(s.starts) ? icsNextDay(s.day) : s.day;
  const kind = (s.kind || "Смена").trim();
  const from = hms(s.starts).slice(0, 5);
  const to = hms(s.ends).slice(0, 5);
  const out = [
    "BEGIN:VEVENT",
    `UID:autodoc-shift-${s.uid}-${s.day}@autodoc`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART;TZID=${ICS_TZID}:${icsLocal(s.day, s.starts)}`,
    `DTEND;TZID=${ICS_TZID}:${icsLocal(endDay, s.ends)}`,
    `SUMMARY:${icsEsc(`Смена ${kind} ${from}–${to}`)}`,
    `DESCRIPTION:${icsEsc(s.note ? `${kind} ${from}–${to} · ${s.note}` : `${kind} ${from}–${to}`)}`,
    "LOCATION:AutoDoc Logistic\\, Szczecin",
    "TRANSP:OPAQUE",
  ];
  if (s.updated_at) {
    const t = new Date(s.updated_at);
    if (!isNaN(+t)) out.push(`LAST-MODIFIED:${icsStamp(t)}`);
  }
  // те же два напоминания, что шлёт бот, — на случай если человек отключит бота
  for (const [trig, text] of [["-PT2H", "Смена через 2 часа"], ["-PT1H", "Смена через час"]]) {
    out.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:${trig}`,
             `DESCRIPTION:${icsEsc(text)}`, "END:VALARM");
  }
  out.push("END:VEVENT");
  return out;
}

function icsCalendar(rows: IcsShift[], name = "Смены AutoDoc", now = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${ICS_PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEsc(name)}`,
    `X-WR-TIMEZONE:${ICS_TZID}`,
    "X-PUBLISHED-TTL:PT1H",                         // намёк календарю: перечитывать раз в час
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    ...ICS_VTIMEZONE,
  ];
  for (const s of rows) lines.push(...icsEvent(s, now));
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}


const BOT_TOKEN = Deno.env.get("BOT_TOKEN") ?? "";
// Mini App могут открывать из нескольких ботов (старый и новый). Каждый
// подписывает initData своим токеном, поэтому проверяем по всем:
// BOT_TOKEN и, через запятую, BOT_TOKENS.
const TOKENS = [...new Set([BOT_TOKEN, ...(Deno.env.get("BOT_TOKENS") ?? "").split(",")].map(s => s.trim()).filter(Boolean))];
const PROJECT_URL = Deno.env.get("PROJECT_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY") ?? "";
const PUB_SALT = Deno.env.get("PUB_SALT") ?? SERVICE_KEY;          // соль для pub-id в рейтинге
const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "*").split(",").map(s => s.trim()).filter(Boolean);
const MAX_AGE_SEC = 24 * 60 * 60;
const TEAMS = ["dark", "orange", "green"];

const enc = new TextEncoder();

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ORIGINS.includes("*") ? "*" : (ORIGINS.includes(origin) ? origin : ORIGINS[0] ?? "null");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization",
    "Vary": "Origin",
  };
}

async function hmac(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
}
const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, "0")).join("");

// сравнение без утечки по времени
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

type TgUser = { id: number; first_name?: string; last_name?: string; username?: string; photo_url?: string };

// Причина отказа уходит клиенту: по ней приложение объясняет человеку, что
// делать. Секретов в ней нет.
type Verdict = { user: TgUser | null; reason: "" | "no_data" | "bad_signature" | "expired" | "no_user" };

async function verifyInitData(initData: string): Promise<Verdict> {
  if (!TOKENS.length || !initData || initData.length > 4096) return { user: null, reason: "no_data" };
  const p = new URLSearchParams(initData);
  const hash = p.get("hash") ?? "";
  if (!/^[a-f0-9]{64}$/.test(hash)) return { user: null, reason: "no_data" };
  p.delete("hash");
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  let signed = false;
  for (const token of TOKENS) {
    const secret = await hmac(enc.encode("WebAppData"), enc.encode(token));
    if (safeEq(hex(await hmac(secret, enc.encode(dcs))), hash)) { signed = true; break; }
  }
  if (!signed) return { user: null, reason: "bad_signature" };
  const authDate = Number(p.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SEC) return { user: null, reason: "expired" };
  try {
    const u = JSON.parse(p.get("user") || "null");
    return u && Number.isSafeInteger(u.id) ? { user: u, reason: "" } : { user: null, reason: "no_user" };
  } catch { return { user: null, reason: "no_user" }; }
}

const H = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
const db = (path: string, init: RequestInit = {}) =>
  fetch(`${PROJECT_URL}/rest/v1/${path}`, { ...init, headers: { ...H(), ...(init.headers as Record<string, string> || {}) } });

const pubId = async (uid: string) => hex(await hmac(enc.encode(PUB_SALT), enc.encode("pub:" + uid))).slice(0, 16);

// Простая защита от частых запросов в пределах одного инстанса функции.
const lastHit = new Map<string, number>();
function tooFast(key: string, ms: number): boolean {
  const now = Date.now(), prev = lastHit.get(key) ?? 0;
  if (now - prev < ms) return true;
  lastHit.set(key, now);
  if (lastHit.size > 5000) lastHit.clear();
  return false;
}

const num = (v: unknown, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; };
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);

function monthOk(m: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(m)) return false;
  const [y, mo] = m.split("-").map(Number);
  const idx = y * 12 + mo - 1, now = new Date(), cur = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return mo >= 1 && mo <= 12 && idx <= cur + 1 && idx >= cur - 24;
}

// Зарплату за месяц W платят в начале W+1. Принимаем даты с 20-го числа W
// до конца W+2 (korekty приходят позже) и не из будущего.
function payDayOk(month: string, day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y, m] = month.split("-").map(Number);
  const t = Date.parse(day + "T00:00:00Z");
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== day) return false;
  return t >= Date.UTC(y, m - 1, 20) && t < Date.UTC(y, m + 2, 1) && t <= Date.now() + 864e5;
}

Deno.serve(async (req) => {
  const C = cors(req);
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...C, "Content-Type": "application/json", "Cache-Control": "no-store" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: C });
  if (!TOKENS.length || !PROJECT_URL || !SERVICE_KEY) return json({ error: "not configured" }, 500);

  const url = new URL(req.url);
  if (req.method === "GET") {
    const t = url.searchParams.get("ics");
    return t ? icsFeed(t, C) : new Response("method", { status: 405, headers: C });
  }
  if (req.method !== "POST") return new Response("method", { status: 405, headers: C });

  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 16_384) return json({ error: "too large" }, 413);
    body = JSON.parse(raw);
  } catch { return json({ error: "bad json" }, 400); }

  const { user, reason } = await verifyInitData(String(body.initData ?? ""));
  if (!user) {
    console.warn("api: 401", reason, "tokens:", TOKENS.length);
    return json({ error: "unauthorized", reason }, 401);
  }
  const uid = String(user.id);
  const action = String(body.action ?? "");
  if (tooFast(`${uid}:${action}`, action === "hello" ? 300 : 1000)) return json({ error: "slow down" }, 429);

  try {
    switch (action) {
      case "ping":                                // самопроверка бота: подпись его токеном принята
        return json({ ok: true, uid, tokens: TOKENS.length });

      case "hello": {
        const name = clean([user.first_name, user.last_name].filter(Boolean).join(" "), 60);
        await db("bot_users", {
          method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ uid, name, username: clean(user.username, 40) || null, active: true }),
        });
        const r = await db(`bot_users?uid=eq.${uid}&select=team,grp,team_at,notify&limit=1`);
        const profile = r.ok ? (await r.json())[0] ?? null : null;
        return json({ ok: true, uid, pub: await pubId(uid), profile });
      }

      case "rank": {
        const r = (body.row ?? {}) as Record<string, unknown>;
        const month = String(r.month ?? "");
        if (!monthOk(month)) return json({ error: "bad month" }, 400);
        const peaks = Math.round(num(r.peaks, 0, 200_000));
        const hours = num(r.hours, 0, 400);
        const shifts = Math.round(num(r.shifts, 0, 31));
        const bonus = num(r.bonus, 0, 20_000);
        const ppc = hours > 0 ? peaks / hours : 0;
        // правдоподобие: самая щедрая ставка — 0,74 zł за штуку сверх нормы,
        // плюс 25% за обецность (премия в рейтинге — с этим множителем)
        if (bonus > peaks * 0.74 * 1.25 + 0.01 || ppc > 600 || hours > shifts * 16 + 0.01)
          return json({ error: "implausible" }, 422);
        const row = {
          uid, month, pub: await pubId(uid),
          name: clean(r.name, 40) || clean(user.first_name, 40) || "Аноним",
          emoji: clean(r.emoji, 8) || "👷",
          photo_url: user.photo_url && /^https:\/\//.test(user.photo_url) ? user.photo_url.slice(0, 300) : null,
          team: TEAMS.includes(String(r.team)) ? String(r.team) : null,
          grp: /^[A-F]$/.test(String(r.group ?? "")) ? String(r.group) : null,
          bonus: Math.round(bonus * 100) / 100, peaks, hours: Math.round(hours * 10) / 10, shifts,
          ppc: Math.round(ppc * 10) / 10, updated_at: new Date().toISOString(),
        };
        const res = await db("leaderboard", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
        return res.ok ? json({ ok: true }) : json({ error: "db" }, 500);
      }

      case "consent": {
        const row = {
          uid, version: clean(body.version, 10) || "2.0",
          name: clean([user.first_name, user.last_name].filter(Boolean).join(" "), 60),
          tg_username: clean(user.username, 40) || null, ua: clean(body.ua, 300),
        };
        const res = await db("consents", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(row) });
        return res.ok ? json({ ok: true }) : json({ error: "db" }, 500);
      }

      case "profile": {
        const team = String(body.team ?? "");
        const grp = String(body.group ?? "");
        if (!TEAMS.includes(team) || !/^[A-F]$/.test(grp)) return json({ error: "bad team" }, 400);
        const n = (body.notify ?? {}) as Record<string, unknown>;
        const notify = { h2: (n.h2 ?? n.h12) !== false, h1: n.h1 !== false, peaks: n.peaks !== false, pay: n.pay !== false };
        const now = new Date().toISOString();
        // дни отпуска (YYYY-MM-DD) — бот не будет напоминать о смене в эти дни
        const off = (Array.isArray(body.off) ? body.off : []).map(String).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 120);
        const row: Record<string, unknown> = { uid, team, grp, notify, off, team_at: now, rebuild: true, active: true, updated_at: now };
        const name = clean(body.name, 60);
        if (name) row.name = name;
        const res = await db("bot_users", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
        return res.ok ? json({ ok: true }) : json({ error: "db" }, 500);
      }

      case "ics": {
        let token = "";
        const r = await db(`ics_tokens?uid=eq.${uid}&select=token&limit=1`);
        if (r.ok) token = (await r.json())[0]?.token ?? "";
        if (!token) {
          const b = crypto.getRandomValues(new Uint8Array(24));
          token = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          const w = await db("ics_tokens", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ uid, token }) });
          if (!w.ok) return json({ error: "db" }, 500);
        }
        return json({ ok: true, url: `${PROJECT_URL}/functions/v1/api?ics=${token}` });
      }

      case "payday": {
        // month — месяц работы, paid_on — день, когда деньги пришли на счёт.
        // Пустая дата — отметку снять.
        const month = String(body.month ?? "");
        const kind = body.kind === "kor" ? "kor" : "main";
        const paid = String(body.paid_on ?? "");
        if (!monthOk(month)) return json({ error: "bad month" }, 400);
        const key = `uid=eq.${uid}&month=eq.${month}&kind=eq.${kind}`;
        if (!paid) {
          const d = await db(`paydays?${key}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
          return d.ok ? json({ ok: true }) : json({ error: "db" }, 500);
        }
        if (!payDayOk(month, paid)) return json({ error: "bad date" }, 400);
        const row = { uid, month, kind, paid_on: paid, updated_at: new Date().toISOString() };
        const res = await db("paydays", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
        return res.ok ? json({ ok: true }) : json({ error: "db" }, 500);
      }

      case "paydays": {
        // Только счётчики по датам: кто именно отметил, наружу не уходит.
        const now = new Date(), since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 14, 1)).toISOString().slice(0, 7);
        const r = await db(`paydays?kind=eq.main&month=gte.${since}&select=month,paid_on&limit=20000`);
        if (!r.ok) return json({ error: "db" }, 500);
        const reports: Record<string, Record<string, number>> = {};
        for (const x of (await r.json()) as { month: string; paid_on: string }[]) {
          const m = (reports[x.month] ??= {});
          m[x.paid_on] = (m[x.paid_on] ?? 0) + 1;
        }
        return json({ ok: true, reports });
      }

      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    console.error("api:", action, e);
    return json({ error: "server" }, 500);
  }
});

// ── лента смен (.ics) ──
const ICS_BACK_DAYS = 30, ICS_AHEAD_DAYS = 120;
const dayShift = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);

async function icsFeed(token: string, C: Record<string, string>): Promise<Response> {
  const bad = (code: number, text: string) => new Response(text, { status: code, headers: { ...C, "Content-Type": "text/plain; charset=utf-8" } });
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return bad(400, "плохой токен");
  if (tooFast("ics:" + token, 2000)) return bad(429, "слишком часто");
  const tr = await db(`ics_tokens?token=eq.${encodeURIComponent(token)}&select=uid&limit=1`);
  if (!tr.ok) return bad(500, "база недоступна");
  const owner = (await tr.json())[0];
  if (!owner) return bad(404, "ссылка не найдена — получи новую в боте или приложении");
  const uid = String(owner.uid);
  const range = `(day.gte.${dayShift(-ICS_BACK_DAYS)},day.lte.${dayShift(ICS_AHEAD_DAYS)})`;
  const sr = await db(`shifts?uid=eq.${encodeURIComponent(uid)}&and=${encodeURIComponent(range)}&select=uid,day,starts,ends,kind,note,updated_at&order=day.asc&limit=500`);
  if (!sr.ok) return bad(500, "база недоступна");
  const rows = (await sr.json()) as IcsShift[];
  return new Response(icsCalendar(rows, "Смены AutoDoc"), {
    headers: { ...C, "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="autodoc-shifts.ics"', "Cache-Control": "private, max-age=900" },
  });
}
