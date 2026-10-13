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

export type IcsShift = {
  uid: string;
  day: string;                                      // YYYY-MM-DD
  starts: string;                                   // HH:MM:SS
  ends: string;                                     // HH:MM:SS, <= starts — через полночь
  kind?: string | null;
  note?: string | null;
  updated_at?: string | null;
};

export const ICS_TZID = "Europe/Warsaw";
export const ICS_PRODID = "-//AutoDoc Logistic//Shifts//RU";

// Текст в поле: запятые, точки с запятой, обратные слэши и переводы строк
// экранируются, иначе календарь разберёт строку не так.
export function icsEsc(s: string): string {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Строка длиннее 75 октетов складывается: продолжение начинается с пробела.
// Считаем именно октеты — кириллица в UTF-8 по два байта, иначе строгие
// разборщики спотыкаются.
export function icsFold(line: string): string {
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

export function icsStamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
         `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// местные дата-время без пояса: пояс задаётся отдельно через TZID
export function icsLocal(day: string, hms: string): string {
  return `${day.replace(/-/g, "")}T${String(hms).slice(0, 8).replace(/:/g, "")}`;
}

export function icsNextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

const hms = (s: string) => String(s).slice(0, 8);

// Правила перевода часов в Польше — чтобы календарь считал время сам, а не
// полагался на то, что у него в базе поясов.
export const ICS_VTIMEZONE = [
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

export function icsEvent(s: IcsShift, now: Date): string[] {
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
  for (const [trig, text] of [["-PT12H", "Смена через 12 часов"], ["-PT1H", "Смена через час"]]) {
    out.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:${trig}`,
             `DESCRIPTION:${icsEsc(text)}`, "END:VALARM");
  }
  out.push("END:VEVENT");
  return out;
}

export function icsCalendar(rows: IcsShift[], name = "Смены AutoDoc", now = new Date()): string {
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
