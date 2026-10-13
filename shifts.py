"""Смены и оповещения: расписание, хранение в Supabase, кого и когда будить.

Всё, что считает, — чистые функции (их гоняют тесты без сети и Telegram).
Сетевые вызовы собраны в классе Store внизу.

Время везде местное, по Щецину. Ночная смена DARK 22:00–06:00 переходит
через полночь: ends <= starts как раз это и означает.
"""
import json
import os
import secrets
from datetime import date, datetime, time, timedelta

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Warsaw")
except Exception:                                   # pragma: no cover — без tzdata
    TZ = None

import requests

SCHEDULE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schedule.json")
DASHES = "–—-"
SHIFT_CUT_H = 6                                     # учётные сутки начинаются в 06:00
PAY_DAY = 10


# ── время ────────────────────────────────────────────────────
def now():
    return datetime.now(TZ) if TZ else datetime.now()


def today():
    return now().date()


def shift_day(at=None):
    """Какой рабочий день идёт сейчас: в 2 часа ночи — ещё вчерашний."""
    d = at or now()
    if d.hour < SHIFT_CUT_H:
        d = d - timedelta(days=1)
    return d.date() if isinstance(d, datetime) else d


def _t(v):
    if isinstance(v, time):
        return v
    h, m, *rest = str(v).split(":")
    return time(int(h), int(m), int(rest[0]) if rest else 0)


def _d(v):
    return v if isinstance(v, date) else date.fromisoformat(str(v)[:10])


def bounds(row):
    """Начало и конец смены. Конец раньше начала → следующий день."""
    d = _d(row["day"])
    st, en = _t(row["starts"]), _t(row["ends"])
    start = datetime.combine(d, st, TZ) if TZ else datetime.combine(d, st)
    end = datetime.combine(d, en, TZ) if TZ else datetime.combine(d, en)
    if en <= st:
        end += timedelta(days=1)
    return start, end


def hours(row):
    start, end = bounds(row)
    return (end - start).total_seconds() / 3600


# ── расписание ───────────────────────────────────────────────
def load_schedule(path=SCHEDULE_FILE):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def parse_span(s):
    """'22–6' → (time(22,0), time(6,0))."""
    txt = str(s or "")
    sep = next((d for d in DASHES if d in txt), None)
    if not sep:
        raise ValueError(f"не пойму время смены: {s!r}")
    a, b = txt.split(sep, 1)

    def one(part):
        h, _, m = part.strip().partition(":")
        return time(int(h), int(m or 0))

    return one(a), one(b)


def team_of(sched, team):
    t = (sched.get("teams") or {}).get(team)
    if not t:
        raise KeyError(f"нет такой бригады: {team}")
    return t


def month_days(sched, team, group, month):
    """{день: строка времени} для бригады и подгруппы. Пусто — графика нет."""
    t = team_of(sched, team)
    m = (sched.get(t["sch"]) or {}).get(month)
    if not m:
        return {}
    days = (m.get("groups") or {}).get(group) if m.get("groups") else m.get("w")
    if not days:
        return {}
    times = m.get("t") or {}
    return {int(d): times.get(str(d), t["defT"]) for d in days}


def months_ahead(start=None, count=3):
    d = start or today()
    out, y, m = [], d.year, d.month
    for _ in range(count):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return out


def gen_shifts(sched, uid, team, group, month, off=()):
    """Смены сотрудника за месяц в виде строк таблицы shifts. off — дни отпуска."""
    t = team_of(sched, team)
    off = set(off or ())
    out = []
    for d, span in sorted(month_days(sched, team, group, month).items()):
        day = f"{month}-{d:02d}"
        if day in off:
            continue
        st, en = parse_span(span)
        out.append({"uid": str(uid), "day": day, "starts": st.strftime("%H:%M:%S"),
                    "ends": en.strftime("%H:%M:%S"), "kind": t["label"], "source": "auto"})
    return out


# ── оповещения ───────────────────────────────────────────────
H2, H1 = 2 * 3600, 3600
PEAKS_AFTER = (15 * 60, 3 * 3600)        # «запиши пики»: от 15 минут до 3 часов после конца
PAY_HOURS = (10, 21)                     # 10-го числа — с 10:00 до 21:59

DEFAULT_NOTIFY = {"h2": True, "h1": True, "peaks": True, "pay": True}


def prefs(user):
    n = dict(user.get("notify") or {})
    if "h2" not in n and "h12" in n:                # старая настройка «за 12 часов» → «за 2 часа»
        n["h2"] = n["h12"]
    return {k: n.get(k, v) is not False for k, v in DEFAULT_NOTIFY.items()}


def plan(rows, users, at=None):
    """Что отправить прямо сейчас: [(uid, key, kind, row|None)].

    key уникален для события — по нему журнал notify_log не даёт
    отправить одно и то же дважды, даже после перезапуска бота.
    Условие «не позже чем за», а не «ровно за»: проспал бот — напомнит
    при первой возможности, а текст честно скажет, сколько осталось."""
    at = at or now()
    by_uid = {str(u["uid"]): u for u in users if u.get("active", True)}
    out = []
    for r in rows:
        uid = str(r["uid"])
        u = by_uid.get(uid)
        if not u:
            continue
        p = prefs(u)
        start, end = bounds(r)
        day = str(r["day"])[:10]
        left = (start - at).total_seconds()
        if 0 < left <= H1:
            if p["h1"]:
                out.append((uid, f"{day}:h1", "h1", r))
        elif H1 < left <= H2:
            if p["h2"]:
                out.append((uid, f"{day}:h2", "h2", r))
        after = (at - end).total_seconds()
        if PEAKS_AFTER[0] <= after <= PEAKS_AFTER[1] and p["peaks"]:
            out.append((uid, f"{day}:peaks", "peaks", r))
    if at.day == PAY_DAY and PAY_HOURS[0] <= at.hour <= PAY_HOURS[1]:
        key = f"pay:{at:%Y-%m}"
        for uid, u in by_uid.items():
            if prefs(u)["pay"] and u.get("team"):
                out.append((uid, key, "pay", None))
    return out


def left_text(seconds):
    mins = max(0, int(seconds // 60))
    h, m = divmod(mins, 60)
    if h and m:
        return f"через {h} ч {m} мин"
    return f"через {h} ч" if h else f"через {m} мин"


def days_to_pay(at=None):
    """Сколько дней до ближайшего 10-го и сама дата."""
    d = (at or now()).date() if isinstance(at or now(), datetime) else at
    target = d.replace(day=PAY_DAY)
    if d.day > PAY_DAY:
        target = (d.replace(day=1) + timedelta(days=32)).replace(day=PAY_DAY)
    return (target - d).days, target


# ── тексты ───────────────────────────────────────────────────
WD = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]
MONTHS = ["", "января", "февраля", "марта", "апреля", "мая", "июня",
          "июля", "августа", "сентября", "октября", "ноября", "декабря"]


def day_label(d):
    d = _d(d)
    return f"{d.day} {MONTHS[d.month]}, {WD[d.weekday()]}"


def span_text(row):
    return f"{_t(row['starts']).strftime('%H:%M')}–{_t(row['ends']).strftime('%H:%M')}"


def line(row):
    night = " 🌙" if _t(row["ends"]) <= _t(row["starts"]) else ""
    note = f" · {row['note']}" if row.get("note") else ""
    return f"<b>{day_label(row['day'])}</b> — {span_text(row)} {row.get('kind') or ''}{night}{note}".rstrip()


def list_text(rows, title, empty="Смен нет."):
    if not rows:
        return f"<b>{title}</b>\n\n{empty}"
    rows = sorted(rows, key=lambda r: str(r["day"]))
    body = "\n".join(line(r) for r in rows)
    total = sum(hours(r) for r in rows)
    n = len(rows)
    word = "смена" if n % 10 == 1 and n % 100 != 11 else "смены" if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14 else "смен"
    return f"<b>{title}</b>\n\n{body}\n\nВсего: <b>{n}</b> {word}, {total:.0f} ч"


def month_range(month):
    y, m = int(month[:4]), int(month[5:7])
    first = date(y, m, 1)
    last = date(y + (m == 12), (m % 12) + 1, 1) - timedelta(days=1)
    return first, last


# ── Supabase ─────────────────────────────────────────────────
class Store:
    """Ходим service-ролью: у таблиц RLS без политик, анону они не видны."""

    def __init__(self, url, key, timeout=15):
        self.url = (url or "").rstrip("/")
        self.key = key or ""
        self.timeout = timeout
        self.s = requests.Session()

    def ok(self):
        return bool(self.url and self.key)

    def _h(self, write=False, prefer=None):
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}"}
        if write:
            h["Content-Type"] = "application/json"
        if prefer:
            h["Prefer"] = prefer
        return h

    def _get(self, table, params):
        r = self.s.get(f"{self.url}/rest/v1/{table}", params=params, headers=self._h(), timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    # ── пользователи ──
    def upsert_user(self, row):
        r = self.s.post(f"{self.url}/rest/v1/bot_users", json=row,
                        headers=self._h(True, "resolution=merge-duplicates,return=minimal"), timeout=self.timeout)
        r.raise_for_status()

    def patch_user(self, uid, patch):
        r = self.s.patch(f"{self.url}/rest/v1/bot_users", params={"uid": f"eq.{uid}"}, json=patch,
                         headers=self._h(True, "return=minimal"), timeout=self.timeout)
        r.raise_for_status()

    def get_user(self, uid):
        rows = self._get("bot_users", {"uid": f"eq.{uid}", "select": "*", "limit": "1"})
        return rows[0] if rows else None

    def users(self, **flt):
        p = {"select": "uid,name,active,team,grp,notify,off,rebuild", "limit": "5000"}
        p.update(flt)
        return self._get("bot_users", p)

    def mark_all_rebuild(self):
        r = self.s.patch(f"{self.url}/rest/v1/bot_users", params={"team": "not.is.null"}, json={"rebuild": True},
                         headers=self._h(True, "return=minimal"), timeout=self.timeout)
        r.raise_for_status()

    # ── смены ──
    def get_shifts(self, uid=None, since=None, until=None, limit=2000):
        p = {"select": "*", "order": "day.asc", "limit": str(limit)}
        if uid is not None:
            p["uid"] = f"eq.{uid}"
        if since and until:
            p["and"] = f"(day.gte.{since},day.lte.{until})"
        elif since:
            p["day"] = f"gte.{since}"
        elif until:
            p["day"] = f"lte.{until}"
        return self._get("shifts", p)

    def put_shifts(self, rows):
        if not rows:
            return 0
        r = self.s.post(f"{self.url}/rest/v1/shifts", json=rows,
                        headers=self._h(True, "resolution=merge-duplicates,return=minimal"), timeout=self.timeout)
        r.raise_for_status()
        return len(rows)

    def del_shift(self, uid, day):
        r = self.s.delete(f"{self.url}/rest/v1/shifts", params={"uid": f"eq.{uid}", "day": f"eq.{day}"},
                          headers=self._h(prefer="return=minimal"), timeout=self.timeout)
        r.raise_for_status()

    def del_auto(self, uid, since):
        r = self.s.delete(f"{self.url}/rest/v1/shifts",
                          params={"uid": f"eq.{uid}", "day": f"gte.{since}", "source": "eq.auto"},
                          headers=self._h(prefer="return=minimal"), timeout=self.timeout)
        r.raise_for_status()

    # ── журнал оповещений ──
    def claim(self, uid, key):
        """Атомарно «застолбить» оповещение. True — наше, можно слать.
        Конфликт по (uid, key) → строка уже есть → кто-то уже отправил."""
        r = self.s.post(f"{self.url}/rest/v1/notify_log", json={"uid": str(uid), "key": key},
                        headers=self._h(True, "resolution=ignore-duplicates,return=representation"), timeout=self.timeout)
        r.raise_for_status()
        return bool(r.json())

    def unclaim(self, uid, key):
        self.s.delete(f"{self.url}/rest/v1/notify_log", params={"uid": f"eq.{uid}", "key": f"eq.{key}"},
                      headers=self._h(prefer="return=minimal"), timeout=self.timeout)

    def log_since(self, since_iso, uid=None, limit=500):
        """Журнал отправленных оповещений, свежие сверху."""
        p = {"select": "uid,key,sent_at", "sent_at": f"gte.{since_iso}", "order": "sent_at.desc", "limit": str(limit)}
        if uid is not None:
            p["uid"] = f"eq.{uid}"
        return self._get("notify_log", p)

    def prune_log(self, days=60):
        cut = (now() - timedelta(days=days)).isoformat()
        self.s.delete(f"{self.url}/rest/v1/notify_log", params={"sent_at": f"lt.{cut}"},
                      headers=self._h(prefer="return=minimal"), timeout=self.timeout)

    # ── календарь ──
    def ics_token(self, uid, renew=False):
        if not renew:
            rows = self._get("ics_tokens", {"uid": f"eq.{uid}", "select": "token", "limit": "1"})
            if rows:
                return rows[0]["token"]
        token = secrets.token_urlsafe(24)
        r = self.s.post(f"{self.url}/rest/v1/ics_tokens", json={"uid": str(uid), "token": token},
                        headers=self._h(True, "resolution=merge-duplicates,return=minimal"), timeout=self.timeout)
        r.raise_for_status()
        return token


def rebuild_user(store, sched, user, months=3):
    """Пересобрать график человека. Смены, поставленные админом, не трогаем."""
    uid, team, grp = str(user["uid"]), user.get("team"), (user.get("grp") or "A")
    since = today().isoformat()
    manual = {str(r["day"])[:10] for r in store.get_shifts(uid=uid, since=since) if r.get("source") == "admin"}
    rows = []
    if team and team in (sched.get("teams") or {}):
        groups = sched["teams"][team]["groups"]
        grp = grp if grp in groups else groups[0]
        for m in months_ahead(count=months):
            rows += [r for r in gen_shifts(sched, uid, team, grp, m, user.get("off") or ())
                     if r["day"] not in manual and r["day"] >= since]
    store.del_auto(uid, since)
    store.put_shifts(rows)
    store.patch_user(uid, {"rebuild": False})
    return len(rows)
