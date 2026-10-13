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
// GET ?ics=<token> — лента смен для календаря телефона.
//
// Deploy:  supabase functions deploy api --no-verify-jwt
// Secrets: BOT_TOKEN, PROJECT_URL, SERVICE_ROLE_KEY, [PUB_SALT], [ALLOWED_ORIGINS]

import { icsCalendar, type IcsShift } from "./ics.ts";

const BOT_TOKEN = Deno.env.get("BOT_TOKEN") ?? "";
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

async function verifyInitData(initData: string): Promise<TgUser | null> {
  if (!BOT_TOKEN || !initData || initData.length > 4096) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash") ?? "";
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), enc.encode(BOT_TOKEN));
  if (!safeEq(hex(await hmac(secret, enc.encode(dcs))), hash)) return null;
  const authDate = Number(p.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SEC) return null;
  try {
    const u = JSON.parse(p.get("user") || "null");
    return u && Number.isSafeInteger(u.id) ? u : null;
  } catch { return null; }
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

Deno.serve(async (req) => {
  const C = cors(req);
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...C, "Content-Type": "application/json", "Cache-Control": "no-store" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: C });
  if (!BOT_TOKEN || !PROJECT_URL || !SERVICE_KEY) return json({ error: "not configured" }, 500);

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

  const user = await verifyInitData(String(body.initData ?? ""));
  if (!user) return json({ error: "unauthorized" }, 401);
  const uid = String(user.id);
  const action = String(body.action ?? "");
  if (tooFast(`${uid}:${action}`, action === "hello" ? 300 : 1000)) return json({ error: "slow down" }, 429);

  try {
    switch (action) {
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
        // правдоподобие: самая щедрая ставка — 0,74 zł за штуку сверх нормы
        if (bonus > peaks * 0.74 + 0.01 || ppc > 600 || hours > shifts * 16 + 0.01)
          return json({ error: "implausible" }, 422);
        const row = {
          uid, month, pub: await pubId(uid),
          name: clean(r.name, 40) || clean(user.first_name, 40) || "Аноним",
          emoji: clean(r.emoji, 8) || "👷",
          photo_url: user.photo_url && /^https:\/\//.test(user.photo_url) ? user.photo_url.slice(0, 300) : null,
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
        const notify = { h12: n.h12 !== false, h1: n.h1 !== false, peaks: n.peaks !== false, pay: n.pay !== false };
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
