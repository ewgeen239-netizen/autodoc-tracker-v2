"""
AutoDoc Tracker Bot v2
======================
Telegram-бот к Mini App: открывает трекер, показывает смены, шлёт оповещения
(за 2 часа и за час до смены, «запиши пики» после смены, 10-го — новый месяц
в кошельке), рейтинг премий, быстрый расчёт премии.

Хранилище — только Supabase (Railway стирает файлы при редеплое).
Переменные окружения — см. .env.example.
"""

import hashlib
import hmac
import html
import json
import os
import re
import threading
import time
from datetime import timedelta
from urllib.parse import urlencode

import requests
import telebot
from telebot.apihelper import ApiTelegramException
from telebot.types import (BotCommand, BotCommandScopeChat, InlineKeyboardButton,
                           InlineKeyboardMarkup, MenuButtonWebApp, WebAppInfo)

import shifts as SH

# ── окружение ────────────────────────────────────────────────
TOKEN = os.environ.get("TOKEN") or os.environ.get("BOT_TOKEN")
if not TOKEN:
    raise SystemExit("Не задан TOKEN (токен от @BotFather). Railway → Variables.")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "").strip()
if not WEBAPP_URL.startswith("https://"):
    raise SystemExit("WEBAPP_URL должен быть https-адресом Mini App (GitHub Pages).")
# Частая ошибка: вписать ссылку на репозиторий, а не на сайт. Тогда кнопка
# «Открыть трекер» показывает страницу GitHub. Переводим в адрес GitHub Pages.
_gh = re.match(r"^https://github\.com/([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", WEBAPP_URL)
if _gh:
    _fixed = f"https://{_gh.group(1).lower()}.github.io/{_gh.group(2)}/"
    print(f"⚠️ WEBAPP_URL указывает на репозиторий GitHub, а не на приложение. Использую {_fixed} — поправь переменную в Railway.")
    WEBAPP_URL = _fixed
if not WEBAPP_URL.endswith("/"):
    WEBAPP_URL += "/"

# URL и anon-ключ публичные (они же лежат в assets/js/config.js), поэтому есть значения по умолчанию.
# Секрет здесь только один — SUPABASE_SERVICE_KEY, его задают в Railway → Variables.
SUPABASE_URL = (os.environ.get("SUPABASE_URL") or "https://mkuwkntdcpfsxhqblkic.supabase.co").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY") or (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rdXdrbnRkY3Bmc3hocWJsa2ljIiwicm9sZSI6"
    "ImFub24iLCJpYXQiOjE3ODI5NTc3MDQsImV4cCI6MjA5ODUzMzcwNH0.k0_tWR0SgvWKBWmfkb9Z7qRLhHSAvkmmpGnQWEFm2f8")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")  # секрет: смены, оповещения, реестр
API_FN = os.environ.get("API_FN", "api")
ADMIN_IDS = {int(x) for x in os.environ.get("ADMIN_TELEGRAM_IDS", "").split(",") if x.strip().isdigit()}
TICK = int(os.environ.get("NOTIFY_TICK_SEC", "60"))

bot = telebot.TeleBot(TOKEN, parse_mode="HTML", threaded=True, num_threads=4)
STORE = SH.Store(SUPABASE_URL, SUPABASE_SERVICE_KEY)
try:
    SCHED = SH.load_schedule()
except Exception as e:                       # без файла бот живёт, но без графика
    SCHED = None
    print(f"⚠️ schedule.json не прочитался: {e}")

esc = lambda s: html.escape(str(s or ""), quote=False)

# ── станции и премия (как в assets/js/core.js) ───────────────
ST = {
    "os":  ("OS",  "Oversize",       45,  [(0, 45, 0), (46, 52, .61), (53, 59, .631), (60, 67, .651), (68, 74, .681), (75, 81, .70), (82, 85, .72), (86, 999, .74)]),
    "pa":  ("PA",  "Packing Auto",   120, [(0, 120, 0), (121, 133, .05), (134, 142, .09), (143, 151, .14), (152, 167, .17), (168, 182, .20), (183, 210, .22), (211, 999, .24)]),
    "sio": ("SIO", "Single Item",    54,  [(0, 54, 0), (55, 60, .22), (61, 64, .27), (65, 68, .31), (69, 75, .36), (76, 82, .39), (83, 95, .44), (96, 999, .46)]),
    "pc":  ("PC",  "Picking Consol", 225, [(0, 225, 0), (226, 250, .04), (251, 267, .06), (268, 283, .08), (284, 313, .09), (314, 342, .10), (343, 394, .121), (395, 999, .141)]),
    "plc": ("PLC", "Placement Consol", 180, [(0, 180, 0), (181, 200, .04), (201, 214, .06), (215, 227, .08), (228, 250, .10), (251, 274, .12), (275, 316, .16), (317, 999, .18)]),
    "pi":  ("PI",  "Picking Inventory", 160, [(0, 160, 0), (161, 178, .08), (179, 189, .10), (190, 202, .12), (203, 222, .14), (223, 243, .16), (244, 281, .19), (282, 999, .21)]),
    "op":  ("OP",  "Oversize Placement", 144, [(0, 144, 0), (145, 160, .07), (161, 170, .08), (171, 181, .11), (182, 200, .13), (201, 218, .15), (219, 252, .17), (253, 999, .19)]),
    "hr":  ("HR",  "Direct Receive HR", 140, [(0, 140, 0), (141, 158, .03), (159, 176, .061), (177, 190, .076), (191, 205, .096), (206, 230, .11), (231, 255, .132), (256, 999, .146)]),
    "dp":  ("DP",  "Disassembly Pallet", 165, [(0, 165, 0), (166, 183, .03), (184, 196, .05), (197, 208, .07), (209, 229, .09), (230, 251, .11), (252, 289, .13), (290, 999, .15)]),
    "rod": ("ROD", "Receiving On Demand", 165, [(0, 165, 0), (166, 183, .07), (184, 196, .09), (197, 208, .11), (209, 229, .13), (230, 250, .15), (251, 289, .17), (290, 999, .19)]),
    "pod": ("POD", "Putwall On Demand", 212, [(0, 212, 0), (213, 235, .03), (236, 251, .05), (252, 267, .07), (268, 295, .08), (296, 322, .09), (323, 371, .11), (372, 999, .12)]),
    "zk":  ("ZK",  "Załadunek kontenerów", 100, [(0, 100, 0), (101, 110, 8.92), (111, 115, 11.90), (116, 130, 13.69), (131, 145, 16.07), (146, 160, 17.85), (161, 999, 20.83)]),
}
HOURLY = {"zk"}                              # ставка за час, а не за штуку сверх нормы


def calc(st, peaks, hours):
    norm_rate, table = ST[st][2], ST[st][3]
    pph = peaks / hours if hours > 0 else 0
    norm = int(norm_rate * hours + 0.5)   # тоже как Math.round
    above = max(0, peaks - norm)
    rp = int(pph + 0.5)            # как Math.round в JS: 52.5 → 53 (round() в Python дал бы 52)
    r = next((x for lo, hi, x in table if lo <= rp <= hi), table[-1][2])
    tier = next((i for i, (lo, hi, _) in enumerate(table) if lo <= rp <= hi), len(table) - 1)
    bonus = hours * r if st in HOURLY else above * r
    return dict(pph=pph, norm=norm, above=above, rate=r, bonus=bonus, tier=tier, tiers=len(table))


def bar(i, n):
    """Шкала ступеней ставки: ▰▰▰▱▱▱▱▱"""
    return "▰" * (i + 1) + "▱" * (n - i - 1)


# ── защита и мелочи ──────────────────────────────────────────
_last = {}


def flood(uid, gap=0.7):
    """True — человек жмёт слишком часто, запрос пропускаем."""
    now = time.monotonic()
    if now - _last.get(uid, 0) < gap:
        return True
    _last[uid] = now
    if len(_last) > 10000:
        _last.clear()
    return False


def is_admin(uid):
    return uid in ADMIN_IDS


EFFECT = {"party": "5046509860389126442", "fire": "5104841245755180586", "like": "5107584321108051014"}


def send(chat_id, text, kb=None, effect=None):
    """Сообщение с эффектом-анимацией Telegram (если клиент умеет)."""
    if effect:
        try:
            return bot.send_message(chat_id, text, reply_markup=kb, message_effect_id=EFFECT[effect],
                                    disable_web_page_preview=True)
        except (TypeError, ApiTelegramException):
            pass
    return bot.send_message(chat_id, text, reply_markup=kb, disable_web_page_preview=True)


def edit(call, text, kb=None):
    try:
        bot.edit_message_text(text, call.message.chat.id, call.message.message_id, reply_markup=kb,
                              disable_web_page_preview=True)
    except ApiTelegramException as e:
        if "message is not modified" not in str(e):
            send(call.message.chat.id, text, kb)


def loading(chat_id, label):
    """Короткая «анимация» загрузки: ▱▱▱ → ▰▱▱ → ▰▰▱. Возвращает сообщение для правки."""
    try:
        bot.send_chat_action(chat_id, "typing")
        m = bot.send_message(chat_id, f"{label}  ▱▱▱")
        for f in ("▰▱▱", "▰▰▱"):
            time.sleep(0.25)
            bot.edit_message_text(f"{label}  {f}", chat_id, m.message_id)
        return m
    except ApiTelegramException:
        return None


def finish(chat_id, msg, text, kb=None):
    if msg:
        try:
            bot.edit_message_text(text, chat_id, msg.message_id, reply_markup=kb, disable_web_page_preview=True)
            return
        except ApiTelegramException:
            pass
    send(chat_id, text, kb)


def no_store():
    return "⚠️ Смены и оповещения выключены: боту не выдан <code>SUPABASE_SERVICE_KEY</code>. Скажи администратору."


def register(u):
    if not STORE.ok():
        return
    try:
        STORE.upsert_user({"uid": str(u.id), "name": " ".join(filter(None, [u.first_name, u.last_name]))[:60],
                           "username": (u.username or "")[:40] or None, "active": True})
    except Exception as e:
        print("register:", e)


def set_inactive(uid):
    try:
        STORE.patch_user(uid, {"active": False})
    except Exception:
        pass


def gone(e):
    return getattr(e, "error_code", None) == 403 or "chat not found" in str(e).lower()


def get_user(uid):
    try:
        return STORE.get_user(uid) if STORE.ok() else None
    except Exception:
        return None


# ── клавиатуры ───────────────────────────────────────────────
def app_btn(text="📱 Открыть трекер", tab=""):
    return InlineKeyboardButton(text, web_app=WebAppInfo(url=WEBAPP_URL + (f"#{tab}" if tab else "")))


def main_kb():
    kb = InlineKeyboardMarkup(row_width=2)
    kb.add(app_btn())
    kb.add(InlineKeyboardButton("🗓 Мои смены", callback_data="sh"),
           InlineKeyboardButton("🔔 Оповещения", callback_data="nt"))
    kb.add(InlineKeyboardButton("🏆 Рейтинг", callback_data="rk"),
           InlineKeyboardButton("🧮 Премия", callback_data="calc"))
    kb.add(app_btn("💼 Кошелёк", "wallet"), InlineKeyboardButton("⚙️ Смена и группа", callback_data="tm"))
    return kb


def back_kb(*extra):
    kb = InlineKeyboardMarkup(row_width=2)
    for b in extra:
        kb.add(b)
    kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
    return kb


def shifts_kb():
    kb = InlineKeyboardMarkup(row_width=3)
    kb.add(InlineKeyboardButton("Сегодня", callback_data="sh_t"),
           InlineKeyboardButton("Неделя", callback_data="sh_w"),
           InlineKeyboardButton("Месяц", callback_data="sh_m"))
    kb.add(InlineKeyboardButton("📲 В календарь телефона", callback_data="ics"))
    kb.add(InlineKeyboardButton("⚙️ Смена и группа", callback_data="tm"), InlineKeyboardButton("↩️ Меню", callback_data="menu"))
    return kb


def team_kb(cur_team=None, cur_grp=None):
    kb = InlineKeyboardMarkup(row_width=6)
    for t, meta in (SCHED or {}).get("teams", {}).items():
        mark = "● " if t == cur_team else ""
        kb.add(InlineKeyboardButton(f"{mark}{meta['label']} · {meta['legend']}", callback_data="noop"))
        kb.add(*[InlineKeyboardButton(("✓" if t == cur_team and g == cur_grp else "") + g, callback_data=f"tm_{t}_{g}")
                 for g in meta["groups"]])
    kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
    return kb


NT_LABEL = {"h2": "За 2 часа до смены", "h1": "За час до смены",
            "peaks": "После смены: записать пики", "pay": "10-го: новый месяц в кошельке"}


def notify_kb(p):
    kb = InlineKeyboardMarkup(row_width=1)
    for k, t in NT_LABEL.items():
        kb.add(InlineKeyboardButton(f"{'✅' if p[k] else '▫️'} {t}", callback_data=f"nt_{k}"))
    kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
    return kb


# ── тексты ───────────────────────────────────────────────────
def welcome(u):
    name = esc(u.first_name or "коллега")
    return (f"👋 Привет, <b>{name}</b>!\n\n"
            "Это трекер для склада <b>AutoDoc M13, Szczecin</b>:\n"
            "▸ пики и премия по таблицам OS, PA, SIO, PC, PLC\n"
            "▸ график смен DARK, ORANGE, GREEN по группам\n"
            "▸ кошелёк: зарплата на руки по ставкам 2026\n"
            "▸ оповещения перед сменой и после неё\n\n"
            "Открой трекер и выбери свою смену — оповещения включатся сами.")


def team_line(user):
    if not user or not user.get("team"):
        return "Смена не выбрана."
    label = ((SCHED or {}).get("teams", {}).get(user["team"]) or {}).get("label", user["team"].upper())
    return f"Смена <b>{esc(label)} {esc(user.get('grp') or '')}</b>."


def my_rows(uid, a, b):
    try:
        return STORE.get_shifts(uid=uid, since=a.isoformat(), until=b.isoformat())
    except Exception:
        return []


def today_text(uid):
    d = SH.shift_day()
    rows = my_rows(uid, d - timedelta(days=1), d + timedelta(days=45))
    now = SH.now()
    for r in rows:
        start, end = SH.bounds(r)
        if end <= now:
            continue
        if start <= now:
            return f"🟢 <b>Смена идёт</b>\n\n{SH.line(r)}\n\nДо конца {SH.left_text((end - now).total_seconds())[6:]}."
        head = "📅 <b>Смена сегодня</b>" if SH._d(r["day"]) == d else "📅 <b>Сегодня выходной</b>\n\nБлижайшая смена:"
        return f"{head}\n\n{SH.line(r)}\n\n⏱ {SH.left_text((start - now).total_seconds())}"
    return "📅 Смен в графике нет. Проверь смену и группу: «⚙️ Смена и группа»."


def rating_text():
    month = SH.today().strftime("%Y-%m")
    try:
        r = requests.get(f"{SUPABASE_URL}/rest/v1/leaderboard",
                         params={"month": f"eq.{month}", "order": "bonus.desc", "limit": "15",
                                 "select": "name,emoji,bonus,peaks,shifts,team,grp"},
                         headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}, timeout=10)
        r.raise_for_status()
        rows = r.json()
    except Exception:
        return "⚠️ Рейтинг сейчас недоступен — нет связи с базой."
    if not rows:
        return f"🏆 <b>Рейтинг премий, {month}</b>\n\nПока пусто. Запиши смену в трекере — и окажешься в таблице."
    medal = ["🥇", "🥈", "🥉"]
    top = max(float(rows[0].get("bonus") or 0), 1)
    lines = []
    for i, x in enumerate(rows):
        b = float(x.get("bonus") or 0)
        fill = round(b / top * 8)
        tag = f" <i>{esc((x.get('team') or '').upper())} {esc(x.get('grp') or '')}</i>".rstrip() if x.get("team") else ""
        lines.append(f"{medal[i] if i < 3 else f'{i + 1}.'} {esc(x.get('emoji') or '👷')} <b>{esc(x.get('name') or 'Аноним')}</b>{tag} — <b>{b:.2f} zł</b>\n"
                     f"<code>{'█' * fill}{'░' * (8 - fill)}</code> {int(x.get('peaks') or 0)} шт, {int(x.get('shifts') or 0)} смен")
    return (f"🏆 <b>Рейтинг премий, {month}</b>\n<i>премия с обецностью: без пропусков ×1,25</i>\n\n"
            + "\n".join(lines))


def calc_text(st, peaks, hours):
    c = calc(st, peaks, hours)
    name, full, norm, _ = ST[st]
    return (f"🧮 <b>{name}, {full}</b>\n\n"
            f"Пики: <b>{peaks}</b> за <b>{hours:g} ч</b>\n"
            f"Темп: <b>{c['pph']:.1f}</b> в час (норма {norm})\n"
            f"Ступень: <code>{bar(c['tier'], c['tiers'])}</code> "
            + (f"{c['rate']:.2f} zł/ч\n" if st in HOURLY else f"{c['rate']:.3f} zł/шт\n") +
            f"Сверх нормы: <b>{c['above']}</b> шт из {c['norm']} по норме\n\n"
            f"💰 <b>{c['bonus']:.2f} zł</b> премии, если такой темп будет весь месяц.\n"
            "<i>Премия считается по среднему темпу за месяц, а не за смену.</i>")


def pay_text():
    left, target = SH.days_to_pay()
    when = "сегодня" if left == 0 else f"через {left} дн."
    return (f"💼 <b>Кошелёк</b>\n\nСледующее обновление — <b>{target:%d.%m}</b>, {when}.\n"
            "До 10-го в кошельке виден расчёт за прошлый месяц, с 10-го — за текущий. "
            "Премия за пики пересчитывается каждый раз, когда открываешь кошелёк.")


# ── команды ──────────────────────────────────────────────────
STATE = {}          # uid → ожидание ввода: ("calc", st) | ("bc", text) | ("nsend", team, grp, text)
# Состояние фонового потока оповещений — для /nstatus. Пауза живёт до перезапуска бота.
NOTIFY = {"paused": False, "last_tick": None, "last_error": None, "sent": 0, "failed": 0, "started": None}


@bot.message_handler(commands=["start", "menu", "help"])
def cmd_start(m):
    if flood(m.from_user.id):
        return
    register(m.from_user)
    STATE.pop(m.from_user.id, None)
    send(m.chat.id, welcome(m.from_user), main_kb(), effect="party" if m.text.startswith("/start") else None)
    # первый вход: сразу просим вписать смену — без неё нет графика и оповещений
    u = get_user(m.from_user.id)
    if STORE.ok() and SCHED and not (u or {}).get("team"):
        send(m.chat.id, "⚙️ <b>Сначала выбери свою смену и группу</b>\n\nПо ним бот соберёт график и будет напоминать о сменах.",
             team_kb())


@bot.message_handler(commands=["today", "week", "month", "shifts"])
def cmd_shifts(m):
    if flood(m.from_user.id):
        return
    if not STORE.ok():
        return send(m.chat.id, no_store())
    cmd = m.text.split()[0][1:].split("@")[0]
    uid = m.from_user.id
    if cmd == "today":
        return send(m.chat.id, today_text(uid), shifts_kb())
    d = SH.today()
    if cmd == "week":
        return send(m.chat.id, SH.list_text(my_rows(uid, d, d + timedelta(days=6)), "🗓 Смены на 7 дней"), shifts_kb())
    if cmd == "month":
        a, b = SH.month_range(d.strftime("%Y-%m"))
        return send(m.chat.id, SH.list_text(my_rows(uid, a, b), f"📆 Смены, {d:%m.%Y}"), shifts_kb())
    send(m.chat.id, f"🗓 <b>Мои смены</b>\n\n{team_line(get_user(uid))}", shifts_kb())


@bot.message_handler(commands=["team"])
def cmd_team(m):
    u = get_user(m.from_user.id) or {}
    send(m.chat.id, f"⚙️ <b>Смена и группа</b>\n\n{team_line(u)}\nВыбери свою — график и оповещения подстроятся.",
         team_kb(u.get("team"), u.get("grp")))


@bot.message_handler(commands=["notify", "reminders"])
def cmd_notify(m):
    if not STORE.ok():
        return send(m.chat.id, no_store())
    u = get_user(m.from_user.id) or {}
    send(m.chat.id, "🔔 <b>Оповещения</b>\n\nНажми, чтобы включить или выключить.", notify_kb(SH.prefs(u)))


@bot.message_handler(commands=["rating", "top"])
def cmd_rating(m):
    if flood(m.from_user.id):
        return
    msg = loading(m.chat.id, "🏆 Считаю рейтинг")
    finish(m.chat.id, msg, rating_text(), back_kb(app_btn("📱 Рейтинг в трекере", "rating")))


@bot.message_handler(commands=["calc"])
def cmd_calc(m):
    parts = m.text.split()[1:]
    if len(parts) == 3 and parts[0].lower() in ST:
        try:
            p, h = int(parts[1]), float(parts[2].replace(",", "."))
            if 0 < p <= 100000 and 0 < h <= 16:
                return send(m.chat.id, calc_text(parts[0].lower(), p, h), back_kb())
        except ValueError:
            pass
    kb = InlineKeyboardMarkup(row_width=4)
    kb.add(*[InlineKeyboardButton(v[0], callback_data=f"calc_{k}") for k, v in ST.items()])
    send(m.chat.id, "🧮 <b>Посчитать премию</b>\n\nВыбери станцию. Или сразу: <code>/calc os 420 8</code>", kb)


@bot.message_handler(commands=["pay", "wallet"])
def cmd_pay(m):
    send(m.chat.id, pay_text(), back_kb(app_btn("💼 Открыть кошелёк", "wallet")))


@bot.message_handler(commands=["calendar", "ics"])
def cmd_ics(m):
    send_ics(m.chat.id, m.from_user.id)


def send_ics(chat_id, uid, renew=False):
    if not STORE.ok():
        return send(chat_id, no_store())
    try:
        token = STORE.ics_token(uid, renew=renew)
    except Exception:
        return send(chat_id, "⚠️ Не получилось выдать ссылку, попробуй позже.")
    link = f"{SUPABASE_URL}/functions/v1/{API_FN}?ics={token}"
    kb = InlineKeyboardMarkup(row_width=1)
    kb.add(InlineKeyboardButton("♻️ Выпустить новую ссылку", callback_data="ics_new"))
    kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
    send(chat_id, "📲 <b>Смены в календаре телефона</b>\n\n"
                  "Это подписка: календарь сам перечитывает ссылку и обновляет смены.\n\n"
                  f"<code>{esc(link)}</code>\n\n"
                  "<b>iPhone:</b> Настройки → Календарь → Учётные записи → Добавить → Другое → Подписной календарь.\n"
                  "<b>Android:</b> calendar.google.com с компьютера → Другие календари → По URL.\n\n"
                  "⚠️ Ссылка личная. Если утекла — выпусти новую, старая перестанет работать.", kb)


@bot.message_handler(commands=["id"])
def cmd_id(m):
    send(m.chat.id, f"Твой Telegram ID: <code>{m.from_user.id}</code>")


# ── админ ────────────────────────────────────────────────────
def admin_only(m):
    if is_admin(m.from_user.id):
        return True
    send(m.chat.id, "Команда только для администратора.")
    return False


@bot.message_handler(commands=["stats"])
def cmd_stats(m):
    if not admin_only(m) or not STORE.ok():
        return
    try:
        users = STORE.users()
    except Exception:
        return send(m.chat.id, "⚠️ База недоступна.")
    active = [u for u in users if u.get("active")]
    teams = {}
    for u in active:
        if u.get("team"):
            key = f"{u['team'].upper()} {u.get('grp') or ''}"
            teams[key] = teams.get(key, 0) + 1
    lines = "\n".join(f"  {k}: {v}" for k, v in sorted(teams.items())) or "  —"
    send(m.chat.id, f"👥 Всего: <b>{len(users)}</b>, активных: <b>{len(active)}</b>\n\nПо сменам:\n{lines}")


@bot.message_handler(commands=["broadcast"])
def cmd_broadcast(m):
    if not admin_only(m):
        return
    text = m.text.partition(" ")[2].strip()
    if not text:
        return send(m.chat.id, "Напиши: <code>/broadcast текст</code>. Можно HTML: &lt;b&gt;, &lt;i&gt;.")
    try:
        send(m.chat.id, "Предпросмотр:")
        send(m.chat.id, text, broadcast_kb())
    except ApiTelegramException as e:
        return send(m.chat.id, f"⚠️ Текст не принят Telegram: <code>{esc(e.description)}</code>")
    STATE[m.from_user.id] = ("bc", text)
    kb = InlineKeyboardMarkup()
    kb.add(InlineKeyboardButton("📢 Разослать всем", callback_data="bc_go"), InlineKeyboardButton("Отмена", callback_data="menu"))
    send(m.chat.id, "Разослать это всем активным?", kb)


def broadcast_kb():
    kb = InlineKeyboardMarkup()
    kb.add(app_btn("📱 Открыть трекер"))
    return kb


def run_broadcast(chat_id, text):
    try:
        users = [u["uid"] for u in STORE.users(active="is.true")]
    except Exception:
        return send(chat_id, "⚠️ База недоступна.")
    send(chat_id, f"📤 Рассылаю {len(users)}…")
    ok = bad = 0
    for uid in users:
        try:
            bot.send_message(int(uid), text, disable_web_page_preview=True, reply_markup=broadcast_kb())
            ok += 1
        except ApiTelegramException as e:
            if e.error_code == 429:
                time.sleep(int((e.result_json or {}).get("parameters", {}).get("retry_after", 3)))
            elif gone(e):
                set_inactive(uid)
            bad += 1
        except Exception:
            bad += 1
        time.sleep(0.05)                       # ~20 сообщений в секунду
    send(chat_id, f"📢 Готово. Доставлено: <b>{ok}</b>, не дошло: <b>{bad}</b>")


RE_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
RE_HM = re.compile(r"^\d{1,2}:\d{2}$")


@bot.message_handler(commands=["shift_add"])
def cmd_shift_add(m):
    """/shift_add <id> <YYYY-MM-DD> <HH:MM> <HH:MM> [тип] [заметка]"""
    if not admin_only(m) or not STORE.ok():
        return
    p = m.text.split(maxsplit=6)
    if len(p) < 5 or not p[1].isdigit() or not RE_DAY.match(p[2]) or not RE_HM.match(p[3]) or not RE_HM.match(p[4]):
        return send(m.chat.id, "Формат: <code>/shift_add 123456 2026-10-20 22:00 06:00 DARK заметка</code>")
    row = {"uid": p[1], "day": p[2], "starts": p[3] + ":00", "ends": p[4] + ":00",
           "kind": (p[5] if len(p) > 5 else "DARK")[:12], "note": (p[6] if len(p) > 6 else None), "source": "admin"}
    try:
        STORE.put_shifts([row])
        send(m.chat.id, f"✅ Смена поставлена:\n{SH.line(row)}")
    except Exception as e:
        send(m.chat.id, f"⚠️ Не записалось: {esc(e)}")


@bot.message_handler(commands=["shift_del"])
def cmd_shift_del(m):
    if not admin_only(m) or not STORE.ok():
        return
    p = m.text.split()
    if len(p) != 3 or not p[1].isdigit() or not RE_DAY.match(p[2]):
        return send(m.chat.id, "Формат: <code>/shift_del 123456 2026-10-20</code>")
    try:
        STORE.del_shift(p[1], p[2])
        send(m.chat.id, "✅ Смена снята.")
    except Exception as e:
        send(m.chat.id, f"⚠️ {esc(e)}")


@bot.message_handler(commands=["shift_who"])
def cmd_shift_who(m):
    if not admin_only(m) or not STORE.ok():
        return
    p = m.text.split()
    day = p[1] if len(p) > 1 and RE_DAY.match(p[1]) else SH.today().isoformat()
    try:
        rows = STORE.get_shifts(since=day, until=day)
        names = {str(u["uid"]): u.get("name") or u["uid"] for u in STORE.users()}
    except Exception:
        return send(m.chat.id, "⚠️ База недоступна.")
    body = "\n".join(f"{esc(names.get(str(r['uid']), r['uid']))} — {SH.span_text(r)} {esc(r.get('kind'))}" for r in rows) or "никого"
    send(m.chat.id, f"👷 <b>{day}</b>\n\n{body}")


# ── админ: люди, их пики, личные сообщения ──────────────────
RE_MONTH = re.compile(r"^\d{4}-\d{2}$")


def send_long(chat_id, text, kb=None):
    """Telegram режет сообщение на 4096 символах — делим по строкам."""
    parts, cur = [], ""
    for ln in text.split("\n"):
        if len(cur) + len(ln) > 3800:
            parts.append(cur)
            cur = ""
        cur += ln + "\n"
    parts.append(cur)
    for i, part in enumerate(parts):
        send(chat_id, part.rstrip(), kb if i == len(parts) - 1 else None)


def user_line(u):
    tag = f"@{esc(u['username'])} " if u.get("username") else ""
    team = f" · {esc(u['team'].upper())} {esc(u.get('grp') or '')}" if u.get("team") else ""
    off = "" if u.get("active") else " 🔴"
    return f"{esc(u.get('name') or '—')} {tag}<code>{esc(u['uid'])}</code>{team}{off}"


def find_users(q):
    """Поиск по имени, @нику или куску ID. Пустой запрос — все, новые сверху."""
    users = sorted(STORE.users(), key=lambda u: str(u.get("started_at") or ""), reverse=True)
    q = (q or "").strip().lstrip("@").lower()
    if not q:
        return users
    return [u for u in users if q in str(u.get("name") or "").lower() or q in str(u.get("username") or "").lower()
            or q in str(u["uid"])]


def person_kb(uid, month=None):
    kb = InlineKeyboardMarkup()
    row = [InlineKeyboardButton("📦 Пики", callback_data=f"ap_{uid}"), InlineKeyboardButton("✉️ Написать", callback_data=f"am_{uid}")]
    if month:
        y, mo = map(int, month.split("-"))
        prev = f"{y - 1}-12" if mo == 1 else f"{y}-{mo - 1:02d}"
        row[0] = InlineKeyboardButton(f"◀️ {prev[5:]}.{prev[:4]}", callback_data=f"ap_{uid}_{prev}")
    kb.add(*row)
    return kb


@bot.message_handler(commands=["users", "who"])
def cmd_users(m):
    """/users [имя | @ник | кусок ID] — люди из базы с их Telegram ID."""
    if not admin_only(m) or not need_store(m):
        return
    q = m.text.partition(" ")[2]
    try:
        found = find_users(q)
    except Exception:
        return send(m.chat.id, "⚠️ База недоступна.")
    if not found:
        return send(m.chat.id, f"Никого не нашёл по «{esc(q)}». Список всех: /users")
    shown = found[:50]
    head = f"👥 <b>{'Найдено' if q.strip() else 'В базе'}: {len(found)}</b>" + (f", показаны первые 50 — уточни: <code>/users имя</code>" if len(found) > 50 else "")
    body = "\n".join(user_line(u) for u in shown)
    kb = None
    if len(found) <= 6:
        kb = InlineKeyboardMarkup()
        for u in found:
            nm = (u.get("name") or u["uid"])[:18]
            kb.row(InlineKeyboardButton(f"📦 {nm}", callback_data=f"ap_{u['uid']}"), InlineKeyboardButton("✉️", callback_data=f"am_{u['uid']}"))
    send_long(m.chat.id, f"{head}\n\n{body}\n\n<i>Нажми на ID, чтобы скопировать. Пики: /peaks ID, написать: /msg ID текст</i>", kb)


def peaks_text(uid, month):
    u = get_user(uid) or {}
    rows = [r for r in STORE.peaks(uid, month) if not r.get("deleted")]
    lb = STORE.month_row("leaderboard", uid, month, "bonus,shifts,updated_at")
    ind = STORE.month_row("indirect", uid, month, "amount,hours")
    head = f"📦 <b>{esc(u.get('name') or uid)}</b> <code>{uid}</code> — {month[5:]}.{month[:4]}"
    if not rows:
        return (f"{head}\n\nЗаписей пиков за этот месяц на сервере нет. Они приходят из трекера, "
                "когда человек записывает или удаляет смену (старая версия приложения их не шлёт).")
    P, H = sum(r["peaks"] for r in rows), sum(float(r["hours"]) for r in rows)
    days = len({r["day"] for r in rows})
    total = [f"Итого: <b>{days}</b> дн., <b>{P}</b> шт, <b>{H:g}</b> ч"]
    if lb:
        total.append(f"премия в рейтинге <b>{float(lb['bonus']):.2f} zł</b>")
    if ind:
        total.append(f"Indirect {float(ind['amount']):.2f} zł за {float(ind['hours']):g} ч")
    by = {}
    for r in rows:
        a = by.setdefault(r["station"], [0, 0.0, 0])
        a[0] += r["peaks"]; a[1] += float(r["hours"]); a[2] += 1
    st_lines = []
    for st, (p, h, n) in sorted(by.items(), key=lambda x: -x[1][0]):
        if st in ST:
            c = calc(st, p, h)
            st_lines.append(f"<b>{ST[st][0]}</b> {esc(ST[st][1])}: {n} зап., {p} шт за {h:g} ч, темп <b>{c['pph']:.1f}</b> "
                            f"(норма {ST[st][2]}) → {c['bonus']:.2f} zł")
        else:
            st_lines.append(f"<b>{esc(st.upper())}</b>: {n} зап., {p} шт за {h:g} ч")
    lines = []
    for i, r in enumerate(rows, 1):
        st, h = r["station"], float(r["hours"])
        name = ST[st][0] if st in ST else esc(st.upper())
        pph = r["peaks"] / h if h else 0
        mark = ("▲" if pph >= ST[st][2] else "▼") if st in ST else ""
        span = f" {r['t_from']}–{r['t_to']}" if r.get("t_from") and r.get("t_to") else ""
        added = f" · записал {esc(r['added'])}" if r.get("added") else ""
        fixed = " ✏️" if r.get("admin_at") else ""
        lines.append(f"<b>#{i}</b> <code>{SH.day_label(r['day'])}</code>{span} · <b>{name}</b> {r['peaks']} шт · {h:g} ч · {pph:.1f}/ч {mark}{added}{fixed}")
    upd = (f"\n\n<i>Обновлено {ago(lb['updated_at'])}. ▲ — темп выше нормы, ✏️ — исправлено админом. "
           "Премия по станциям — до обецности.</i>" if lb else "")
    upd += ("\n\n<b>Исправить</b>: <code>/pfix 3 pa</code> — станция, <code>/pfix 3 950</code> — пики, "
            "<code>/pfix 3 950 7.5</code> — пики и часы, <code>/pfix 3 del</code> — снять, <code>/pfix 3 back</code> — вернуть как было.")
    return (f"{head}\n\n{', '.join(total)}\n\n<b>По станциям</b>\n" + "\n".join(st_lines)
            + "\n\n<b>Записи</b>\n" + "\n".join(lines) + upd)


def resolve_uid(chat_id, arg):
    """ID как есть; имя или @ник — если найден ровно один человек."""
    if arg.isdigit():
        return arg
    found = find_users(arg)
    if len(found) == 1:
        return str(found[0]["uid"])
    if not found:
        send(chat_id, f"Никого не нашёл по «{esc(arg)}». Список: /users")
    else:
        send_long(chat_id, f"По «{esc(arg)}» нашлось {len(found)} — укажи ID:\n\n" + "\n".join(user_line(u) for u in found[:30]))
    return None


@bot.message_handler(commands=["peaks"])
def cmd_peaks(m):
    """/peaks <id|имя> [YYYY-MM] — куда человек записал пики и сколько."""
    if not admin_only(m) or not need_store(m):
        return
    p = m.text.split()
    if len(p) < 2:
        return send(m.chat.id, "Формат: <code>/peaks 123456789</code> или <code>/peaks 123456789 2026-10</code>. "
                               "Можно имя вместо ID. ID людей: /users")
    month = p[-1] if len(p) > 2 and RE_MONTH.match(p[-1]) else SH.today().strftime("%Y-%m")
    who = " ".join(p[1:-1] if len(p) > 2 and RE_MONTH.match(p[-1]) else p[1:])
    uid = resolve_uid(m.chat.id, who)
    if not uid:
        return
    show_peaks(m.chat.id, uid, month, m.from_user.id)


PK_CTX = {}                                  # админ → (uid, месяц) последнего /peaks, для /pfix без ID


def show_peaks(chat_id, uid, month, admin=None):
    if admin:
        PK_CTX[admin] = (str(uid), month)
    try:
        text = peaks_text(uid, month)
    except Exception as e:
        return send(chat_id, f"⚠️ База недоступна: {esc(e)}")
    send_long(chat_id, text, person_kb(uid, month))


def r2(n):
    """Как C.r2 в core.js: Math.round((n + EPSILON) * 100) / 100."""
    return int((n + 2.220446049250313e-16) * 100 + 0.5) / 100


def month_snapshot(rows):
    """Как C.monthSnapshot: премия по станциям из суммарных пиков и часов месяца."""
    by = {}
    for r in rows:
        a = by.setdefault(r["station"], [0, 0.0])
        a[0] += int(r["peaks"]); a[1] += float(r["hours"])
    bonus = sum(calc(st, p, h)["bonus"] for st, (p, h) in by.items() if st in ST)
    peaks, hours = sum(int(r["peaks"]) for r in rows), sum(float(r["hours"]) for r in rows)
    return dict(bonus=r2(bonus), peaks=peaks, hours=r2(hours), shifts=len({r["day"] for r in rows}),
                ppc=r2(peaks / hours if hours else 0))


def rerank(uid, month, before_rows):
    """Пересчитать строку рейтинга после правки. Обецность — как прислал телефон
    (или выводится из старой премии), Indirect — из своей таблицы."""
    lb = STORE.month_row("leaderboard", uid, month, "bonus,pf")
    if not lb:
        return None
    ind = STORE.month_row("indirect", uid, month, "amount")
    indirect = float(ind["amount"]) if ind else 0.0
    pf = lb.get("pf")
    if pf is None:
        old = month_snapshot(before_rows)["bonus"]
        guess = (float(lb["bonus"]) - indirect) / old if old else 1.25
        pf = min((0, 0.8, 1, 1.25), key=lambda x: abs(x - guess))
    rows = [r for r in STORE.peaks(uid, month) if not r.get("deleted")]
    s = month_snapshot(rows)
    bonus = r2(s["bonus"] * float(pf) + indirect)
    STORE.patch_leaderboard(uid, month, {"bonus": bonus, "peaks": s["peaks"], "hours": round(s["hours"], 1), "shifts": s["shifts"],
                                         "ppc": round(s["ppc"], 1), "updated_at": SH.now().isoformat()})
    return float(lb["bonus"]), bonus


def entry_text(r):
    st = r["station"]
    return f"{ST[st][0] if st in ST else esc(st.upper())} {r['peaks']} шт за {float(r['hours']):g} ч"


def fix_values(was, args):
    """Разобрать «pa», «950», «950 7.5», «7.5ч» → новые станция, пики, часы. Ошибка — строка."""
    new, nums = dict(was), []
    for a in args:
        if a in ST:
            new["station"] = a
        elif re.fullmatch(r"\d+(?:[.,]\d+)?(?:ч|h)?", a):
            nums.append(a)
        else:
            return f"Не понял «{esc(a)}». Станции: {', '.join(ST)}; числа — пики и часы, например <code>950 7.5</code>."
    if len(nums) > 2:
        return "Чисел максимум два: пики и часы."
    for i, a in enumerate(nums):
        v = float(a.rstrip("чh").replace(",", "."))
        if a[-1] in "чh" or "." in a or "," in a or i == 1:
            new["hours"] = v
        else:
            new["peaks"] = int(v)
    if not (0 < new["peaks"] <= 100000 and 0 < new["hours"] <= 16):
        return "Пики — от 1 до 100 000, часы — больше 0 и не больше 16."
    return new


@bot.message_handler(commands=["pfix"])
def cmd_pfix(m):
    """/pfix [id] <№> <станция | пики [часы] | del | back> [тихо] — исправить запись пиков.
    Номер — из последнего /peaks. Меняется сервер: рейтинг сразу, телефон человека — при открытии трекера."""
    if not admin_only(m) or not need_store(m):
        return
    p = m.text.split()[1:]
    ctx = PK_CTX.get(m.from_user.id)
    if len(p) >= 2 and p[0].isdigit() and len(p[0]) >= 5 and p[1].isdigit():
        uid = p.pop(0)
        month = ctx[1] if ctx and ctx[0] == uid else SH.today().strftime("%Y-%m")
    elif ctx:
        uid, month = ctx
    else:
        return send(m.chat.id, "Сначала открой записи: <code>/peaks ID</code>, потом <code>/pfix 3 pa</code>. "
                               "Или сразу: <code>/pfix ID 3 pa</code> (текущий месяц).")
    if len(p) < 2 or not p[0].isdigit():
        return send(m.chat.id, "Формат: <code>/pfix 3 pa</code> · <code>/pfix 3 950</code> · <code>/pfix 3 950 7.5</code> · "
                               "<code>/pfix 3 del</code> · <code>/pfix 3 back</code>. Добавь <code>тихо</code> — человеку не писать.\n"
                               "Номер записи — из /peaks. Станции: " + ", ".join(ST))
    n, args = int(p[0]), [a.lower() for a in p[1:]]
    quiet = bool({"тихо", "quiet", "-q"} & set(args))
    args = [a for a in args if a not in ("тихо", "quiet", "-q")]
    try:
        before = STORE.peaks(uid, month)
    except Exception as e:
        return send(m.chat.id, f"⚠️ База недоступна: {esc(e)}")
    live = [r for r in before if not r.get("deleted")]
    if not 1 <= n <= len(live):
        return send(m.chat.id, f"Записи #{n} нет: за {month[5:]}.{month[:4]} у <code>{uid}</code> записей {len(live)}. "
                               f"Список: <code>/peaks {uid} {month}</code>")
    r = live[n - 1]
    was = {"station": r["station"], "peaks": int(r["peaks"]), "hours": float(r["hours"])}
    now = SH.now().isoformat()
    patch = {"admin_at": now, "updated_at": now}
    if not r.get("orig"):
        patch["orig"] = was
    if args and args[0] in ("del", "удалить", "снять"):
        patch["deleted"] = True
        what = f"снята запись {entry_text(r)}"
    elif args and args[0] in ("back", "вернуть"):
        o = r.get("orig") or was
        new = {"station": o["station"], "peaks": int(o["peaks"]), "hours": float(o["hours"])}
        patch.update(new, deleted=False)
        what = f"{entry_text(r)} → {entry_text({**r, **new})} (как было)"
    else:
        new = fix_values(was, args)
        if isinstance(new, str):
            return send(m.chat.id, new)
        if new == was:
            return send(m.chat.id, "Ничего не поменялось.")
        patch.update(new)
        what = f"{entry_text(r)} → {entry_text({**r, **new})}"
    try:
        STORE.patch_peak(uid, r["id"], patch)
        rk = rerank(uid, month, live)
    except Exception as e:
        return send(m.chat.id, f"⚠️ Не записалось: {esc(e)}")
    day = SH.day_label(r["day"])
    rank = f"\nПремия в рейтинге: {rk[0]:.2f} → <b>{rk[1]:.2f} zł</b>" if rk else "\nВ рейтинге его за этот месяц нет."
    told = ""
    if not quiet:
        try:
            bot.send_message(int(uid), f"✏️ <b>Администратор исправил запись пиков</b>\n\n{day}: {what}.\n\n"
                                       "Рейтинг уже обновлён, в трекере изменится, когда откроешь его.",
                             reply_markup=back_kb(app_btn("📱 Открыть трекер", "peaks")))
            told = "\nЧеловеку отправлено уведомление."
        except ApiTelegramException as e:
            if gone(e):
                set_inactive(uid)
            told = "\n⚠️ Уведомление не дошло."
    send(m.chat.id, f"✅ <code>{uid}</code>, {day}: {what}.{rank}{told}\n\n"
                    "<i>На телефоне человека запись поменяется, когда он откроет трекер.</i>", person_kb(uid))


@bot.message_handler(commands=["msg"])
def cmd_msg(m):
    """/msg <id|имя> [текст] — личное сообщение человеку от бота, с предпросмотром."""
    if not admin_only(m) or not need_store(m):
        return
    p = m.text.split(maxsplit=2)
    if len(p) < 2:
        return send(m.chat.id, "Формат: <code>/msg 123456789 текст</code>. Без текста — бот спросит его следующим сообщением. "
                               "Можно HTML: &lt;b&gt;, &lt;i&gt;. ID людей: /users")
    uid = resolve_uid(m.chat.id, p[1])
    if not uid:
        return
    if len(p) < 3 or not p[2].strip():
        return ask_msg(m.chat.id, m.from_user.id, uid)
    confirm_msg(m.chat.id, m.from_user.id, uid, p[2].strip())


def ask_msg(chat_id, admin, uid):
    u = get_user(uid)
    if not u:
        return send(chat_id, f"<code>{esc(uid)}</code> нет в базе — человек ещё не нажимал /start и не открывал трекер.")
    STATE[admin] = ("msg_wait", uid)
    send(chat_id, f"✉️ Напиши текст для <b>{esc(u.get('name') or uid)}</b> <code>{uid}</code> следующим сообщением.",
         back_kb())


def confirm_msg(chat_id, admin, uid, text):
    u = get_user(uid)
    if not u:
        return send(chat_id, f"<code>{esc(uid)}</code> нет в базе — человек ещё не нажимал /start и не открывал трекер.")
    try:
        send(chat_id, "Предпросмотр:")
        send(chat_id, text)
    except ApiTelegramException as e:
        return send(chat_id, f"⚠️ Текст не принят Telegram: <code>{esc(e.description)}</code>")
    STATE[admin] = ("msg", uid, text)
    kb = InlineKeyboardMarkup()
    kb.add(InlineKeyboardButton("✉️ Отправить", callback_data="am_go"), InlineKeyboardButton("Отмена", callback_data="menu"))
    warn = "" if u.get("active") else "\n⚠️ Он блокировал бота — может не дойти."
    send(chat_id, f"Отправить это <b>{esc(u.get('name') or uid)}</b> <code>{uid}</code>?{warn}", kb)


def run_msg(chat_id, uid, text):
    try:
        bot.send_message(int(uid), text, disable_web_page_preview=True)
        send(chat_id, f"✅ Доставлено <code>{uid}</code>.")
    except ApiTelegramException as e:
        if gone(e):
            set_inactive(uid)
            return send(chat_id, f"❌ Не дошло: <code>{uid}</code> заблокировал бота или удалил аккаунт.")
        send(chat_id, f"❌ Не дошло: <code>{esc(e.description)}</code>")


# ── админ: оповещения ────────────────────────────────────────
KIND_RU = {"h2": "за 2 ч", "h1": "за час", "peaks": "записать пики", "pay": "10-е, кошелёк"}
ADMIN_HELP = (
    "🛠 <b>Админ-команды</b>\n\n"
    "<b>Оповещения</b>\n"
    "/nstatus — работает ли рассылка, когда был последний круг, сколько ушло за сутки\n"
    "/nplan [часы] — кому и что уйдёт в ближайшие часы (по умолчанию 24)\n"
    "/nlog [N] — последние N отправленных (по умолчанию 20)\n"
    "/nuser &lt;id&gt; — настройки человека, его смены и что ему уходило\n"
    "/ntest — прислать себе все виды оповещений для проверки\n"
    "/nsend &lt;dark|orange|green|all&gt; [группа] текст — сообщение смене, с предпросмотром\n"
    "/npause, /nresume — остановить и вернуть рассылку (до перезапуска бота)\n"
    "/rebuild [id|all] — пересобрать графики из schedule.json\n"
    "/check — принимает ли сервер подпись бота (подтверждение аккаунтов)\n\n"
    "<b>Люди</b>\n"
    "/users [имя|@ник] — кто в базе и их Telegram ID\n"
    "/peaks &lt;id|имя&gt; [ГГГГ-ММ] — куда человек записал пики, сколько и какой темп\n"
    "/pfix &lt;№&gt; &lt;станция|пики [часы]|del|back&gt; [тихо] — исправить запись из /peaks: рейтинг сразу, телефон — при открытии\n"
    "/msg &lt;id|имя&gt; [текст] — личное сообщение от бота, с предпросмотром\n"
    "Перешли боту сообщение человека — бот пришлёт его ID (если тот не скрыл пересылку)\n\n"
    "<b>Прочее</b>\n"
    "/stats, /broadcast текст, /shift_add, /shift_del, /shift_who, /id"
)


def need_store(m):
    if STORE.ok():
        return True
    send(m.chat.id, no_store())
    return False


def ago(iso):
    if not iso:
        return "никогда"
    try:
        from datetime import datetime as _dt
        t = _dt.fromisoformat(str(iso).replace("Z", "+00:00"))
        sec = int((SH.now() - t).total_seconds())
    except Exception:
        return str(iso)
    if sec < 90:
        return f"{sec} с назад"
    if sec < 5400:
        return f"{sec // 60} мин назад"
    return f"{sec // 3600} ч назад"


def names_map():
    try:
        return {str(u["uid"]): u.get("name") or str(u["uid"]) for u in STORE.users()}
    except Exception:
        return {}


@bot.message_handler(commands=["admin"])
def cmd_admin(m):
    if admin_only(m):
        send(m.chat.id, ADMIN_HELP)


@bot.message_handler(commands=["nstatus"])
def cmd_nstatus(m):
    if not admin_only(m) or not need_store(m):
        return
    since = (SH.now() - timedelta(days=1)).isoformat()
    try:
        users = STORE.users()
        log = STORE.log_since(since)
        today = SH.today()
        rows = STORE.get_shifts(since=today.isoformat(), until=(today + timedelta(days=1)).isoformat())
    except Exception as e:
        return send(m.chat.id, f"⚠️ База недоступна: <code>{esc(e)}</code>")
    active = [u for u in users if u.get("active")]
    with_team = [u for u in active if u.get("team")]
    queue = [u for u in users if u.get("rebuild")]
    by_kind = {}
    for r in log:
        k = r["key"].split(":")[-1] if not r["key"].startswith("pay:") else "pay"
        by_kind[k] = by_kind.get(k, 0) + 1
    kinds = "\n".join(f"  {KIND_RU.get(k, k)}: {v}" for k, v in sorted(by_kind.items())) or "  —"
    state = "⏸ на паузе" if NOTIFY["paused"] else ("🟢 работает" if NOTIFY["last_tick"] else "🔴 поток не запускался")
    err = f"\nПоследняя ошибка: <code>{esc(NOTIFY['last_error'])}</code>" if NOTIFY["last_error"] else ""
    err += f"\n\n🔐 Подтверждение аккаунтов: {'✅' if API_CHECK['ok'] else '❌' if API_CHECK['ok'] is False else '…'} {esc(API_CHECK['text'])}"
    send(m.chat.id,
         f"🔔 <b>Оповещения: {state}</b>\n\n"
         f"Последний круг: {ago(NOTIFY['last_tick'])} (каждые {TICK} с)\n"
         f"С запуска бота: ушло {NOTIFY['sent']}, не дошло {NOTIFY['failed']}\n\n"
         f"Активных: <b>{len(active)}</b>, со сменой: <b>{len(with_team)}</b>\n"
         f"Ждут пересборки графика: {len(queue)}\n"
         f"Смен сегодня и завтра: {len(rows)}\n\n"
         f"За сутки отправлено: <b>{len(log)}</b>\n{kinds}{err}")


@bot.message_handler(commands=["nplan"])
def cmd_nplan(m):
    if not admin_only(m) or not need_store(m):
        return
    p = m.text.split()
    hours = int(p[1]) if len(p) > 1 and p[1].isdigit() else 24
    hours = max(1, min(hours, 72))
    now = SH.now()
    try:
        users = {str(u["uid"]): u for u in STORE.users(active="is.true")}
        rows = STORE.get_shifts(since=(now.date() - timedelta(days=1)).isoformat(),
                                until=(now + timedelta(hours=hours)).date().isoformat())
        sent = {(r["uid"], r["key"]) for r in STORE.log_since((now - timedelta(days=3)).isoformat(), limit=2000)}
    except Exception as e:
        return send(m.chat.id, f"⚠️ База недоступна: <code>{esc(e)}</code>")
    events = []
    for r in rows:
        u = users.get(str(r["uid"]))
        if not u:
            continue
        pr = SH.prefs(u)
        start, end = SH.bounds(r)
        day = str(r["day"])[:10]
        for kind, at in (("h2", start - timedelta(hours=2)), ("h1", start - timedelta(hours=1)),
                         ("peaks", end + timedelta(minutes=15))):
            if pr[kind] and now - timedelta(minutes=5) <= at <= now + timedelta(hours=hours) \
                    and (str(r["uid"]), f"{day}:{kind}") not in sent:
                events.append((at, u.get("name") or r["uid"], kind, SH.span_text(r)))
    events.sort(key=lambda e: e[0])
    if not events:
        return send(m.chat.id, f"📭 В ближайшие {hours} ч оповещений нет.")
    lines = [f"<code>{at:%d.%m %H:%M}</code> {esc(n)} — {KIND_RU[k]} ({sp})" for at, n, k, sp in events[:60]]
    more = f"\n…и ещё {len(events) - 60}" if len(events) > 60 else ""
    send(m.chat.id, f"🗓 <b>План на {hours} ч</b> — {len(events)} шт.\n\n" + "\n".join(lines) + more)


@bot.message_handler(commands=["nlog"])
def cmd_nlog(m):
    if not admin_only(m) or not need_store(m):
        return
    p = m.text.split()
    n = int(p[1]) if len(p) > 1 and p[1].isdigit() else 20
    try:
        log = STORE.log_since((SH.now() - timedelta(days=30)).isoformat(), limit=max(1, min(n, 100)))
    except Exception as e:
        return send(m.chat.id, f"⚠️ База недоступна: <code>{esc(e)}</code>")
    if not log:
        return send(m.chat.id, "📭 Журнал пуст.")
    names = names_map()
    lines = []
    for r in log:
        kind = "pay" if r["key"].startswith("pay:") else r["key"].split(":")[-1]
        lines.append(f"<code>{str(r['sent_at'])[5:16].replace('T', ' ')}</code> {esc(names.get(str(r['uid']), r['uid']))} — "
                     f"{KIND_RU.get(kind, kind)} <i>{esc(r['key'])}</i>")
    send(m.chat.id, "🧾 <b>Последние оповещения</b>\n\n" + "\n".join(lines))


@bot.message_handler(commands=["nuser"])
def cmd_nuser(m):
    if not admin_only(m) or not need_store(m):
        return
    p = m.text.split()
    if len(p) < 2 or not p[1].isdigit():
        return send(m.chat.id, "Формат: <code>/nuser 123456789</code>. ID человек узнаёт командой /id.")
    uid = p[1]
    u = get_user(uid)
    if not u:
        return send(m.chat.id, "Такого пользователя в базе нет — он ещё не нажимал /start и не открывал трекер.")
    pr = SH.prefs(u)
    flags = ", ".join(f"{'✅' if pr[k] else '▫️'} {KIND_RU[k]}" for k in ("h2", "h1", "peaks", "pay"))
    today = SH.today()
    rows = my_rows(uid, today, today + timedelta(days=14))[:5]
    try:
        log = STORE.log_since((SH.now() - timedelta(days=14)).isoformat(), uid=uid, limit=8)
    except Exception:
        log = []
    shifts = "\n".join(SH.line(r) for r in rows) or "смен нет"
    sent = "\n".join(f"<code>{str(r['sent_at'])[5:16].replace('T', ' ')}</code> {esc(r['key'])}" for r in log) or "ничего"
    off = ", ".join((u.get("off") or [])[:10]) or "—"
    send(m.chat.id,
         f"👷 <b>{esc(u.get('name') or uid)}</b> <code>{uid}</code>\n"
         f"{'🟢 активен' if u.get('active') else '🔴 заблокировал бота'}, {team_line(u)}\n"
         f"Оповещения: {flags}\nОтпуск: {esc(off)}\n\n"
         f"<b>Ближайшие смены</b>\n{shifts}\n\n<b>Уходило за 14 дней</b>\n{sent}")


@bot.message_handler(commands=["ntest"])
def cmd_ntest(m):
    """Прислать себе все виды оповещений — проверить вид и кнопки. В журнал не пишется."""
    if not admin_only(m):
        return
    now = SH.now()
    soon = now + timedelta(hours=1)
    row = {"uid": str(m.from_user.id), "day": soon.date().isoformat(), "starts": soon.strftime("%H:%M:00"),
           "ends": (soon + timedelta(hours=8)).strftime("%H:%M:00"), "kind": "DARK"}
    send(m.chat.id, "🧪 Тест: ниже четыре оповещения в том виде, в каком их получат люди.")
    for kind in ("h2", "h1", "peaks", "pay"):
        r = dict(row)
        if kind == "h2":
            later = now + timedelta(hours=2)
            r.update(day=later.date().isoformat(), starts=later.strftime("%H:%M:00"), ends=(later + timedelta(hours=8)).strftime("%H:%M:00"))
        send(m.chat.id, notify_text(kind, r), notify_kb_for(kind), effect="party" if kind == "pay" else None)
        time.sleep(0.3)


@bot.message_handler(commands=["npause", "nresume"])
def cmd_npause(m):
    if not admin_only(m):
        return
    NOTIFY["paused"] = m.text.split()[0].split("@")[0] == "/npause"
    send(m.chat.id, "⏸ Оповещения на паузе. Графики продолжают собираться. Вернуть: /nresume. "
                    "После перезапуска бота пауза снимается сама." if NOTIFY["paused"]
         else "▶️ Оповещения снова работают. Пропущенные за паузу напоминания уйдут, если их время ещё не прошло.")


@bot.message_handler(commands=["rebuild"])
def cmd_rebuild(m):
    if not admin_only(m) or not need_store(m):
        return
    p = m.text.split()
    try:
        if len(p) > 1 and p[1].isdigit():
            STORE.patch_user(p[1], {"rebuild": True})
            what = f"пользователя <code>{p[1]}</code>"
        else:
            STORE.mark_all_rebuild()
            what = "всех со сменой"
    except Exception as e:
        return send(m.chat.id, f"⚠️ {esc(e)}")
    send(m.chat.id, f"♻️ График {what} пересоберётся на следующем круге (до {TICK} с).")


@bot.message_handler(commands=["nsend"])
def cmd_nsend(m):
    """/nsend dark A текст | /nsend orange текст | /nsend all текст"""
    if not admin_only(m) or not need_store(m):
        return
    parts = m.text.split(maxsplit=3)
    teams = list((SCHED or {}).get("teams", {}).keys())
    if len(parts) < 3 or parts[1].lower() not in teams + ["all"]:
        return send(m.chat.id, "Формат:\n<code>/nsend dark A Автобус задерживается на 15 минут</code>\n"
                               "<code>/nsend orange Завтра собрание в 13:30</code>\n<code>/nsend all текст</code>")
    team = parts[1].lower()
    grp = None
    rest = " ".join(parts[2:])
    first, _, tail = rest.partition(" ")
    if team != "all" and re.fullmatch(r"[A-Fa-f]", first) and tail.strip():
        grp, rest = first.upper(), tail
    text = rest.strip()
    flt = {"active": "is.true"}
    if team != "all":
        flt["team"] = f"eq.{team}"
    if grp:
        flt["grp"] = f"eq.{grp}"
    try:
        n = len(STORE.users(**flt))
    except Exception as e:
        return send(m.chat.id, f"⚠️ {esc(e)}")
    who = "всем" if team == "all" else f"{team.upper()}{' ' + grp if grp else ''}"
    body = f"📣 <b>{esc(who if team != 'all' else 'Всем сменам')}</b>\n\n{text}"
    try:
        send(m.chat.id, "Предпросмотр:\n\n" + body)
    except ApiTelegramException as e:
        return send(m.chat.id, f"⚠️ Текст не принят Telegram: <code>{esc(e.description)}</code>")
    STATE[m.from_user.id] = ("nsend", flt, body)
    kb = InlineKeyboardMarkup()
    kb.add(InlineKeyboardButton(f"📣 Отправить ({n})", callback_data="ns_go"), InlineKeyboardButton("Отмена", callback_data="menu"))
    send(m.chat.id, f"Отправить <b>{n}</b> получателям ({esc(who)})?", kb)


def run_nsend(chat_id, flt, body):
    try:
        users = [u["uid"] for u in STORE.users(**flt)]
    except Exception:
        return send(chat_id, "⚠️ База недоступна.")
    ok = bad = 0
    for uid in users:
        try:
            bot.send_message(int(uid), body, disable_web_page_preview=True, reply_markup=notify_kb_for("h1"))
            ok += 1
        except ApiTelegramException as e:
            if e.error_code == 429:
                time.sleep(int((e.result_json or {}).get("parameters", {}).get("retry_after", 3)))
            elif gone(e):
                set_inactive(uid)
            bad += 1
        except Exception:
            bad += 1
        time.sleep(0.05)
    send(chat_id, f"📣 Готово. Доставлено: <b>{ok}</b>, не дошло: <b>{bad}</b>")


# ── самопроверка: принимает ли функция api подпись этого бота ─
# Mini App подписан токеном бота, из которого его открыли. Если в секретах
# Supabase лежит токен другого бота, функция отвечает 401 и аккаунты людей не
# подтверждаются. Бот подписывает тестовый запрос своим токеном и узнаёт это
# сам — секреты никуда не передаются, уходит только подпись.
API_CHECK = {"ok": None, "text": "ещё не проверялось", "at": None}


def api_selfcheck():
    uid = next(iter(ADMIN_IDS), 1)
    fields = {"auth_date": str(int(time.time())), "query_id": "selfcheck",
              "user": json.dumps({"id": uid, "first_name": "selfcheck"}, separators=(",", ":"))}
    dcs = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", TOKEN.encode(), hashlib.sha256).digest()
    init = urlencode({**fields, "hash": hmac.new(secret, dcs.encode(), hashlib.sha256).hexdigest()})
    try:
        r = requests.post(f"{SUPABASE_URL}/functions/v1/{API_FN}", json={"initData": init, "action": "ping"},
                          headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}, timeout=15)
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    except Exception as e:
        API_CHECK.update(ok=False, text=f"функция {API_FN} недоступна: {e}", at=SH.now().isoformat())
        return API_CHECK
    if r.status_code == 200:
        API_CHECK.update(ok=True, text=f"подпись бота принимается (токенов в функции: {body.get('tokens', '?')})")
    elif r.status_code == 401 and body.get("reason") == "bad_signature":
        API_CHECK.update(ok=False, text=(
            "функция api НЕ принимает подпись этого бота — аккаунты не подтверждаются. "
            "Supabase → Edge Functions → Secrets → добавь BOT_TOKENS = токен этого бота (тот же, что TOKEN в Railway)"))
    elif r.status_code == 404:
        API_CHECK.update(ok=False, text=f"функция {API_FN} не задеплоена (404)")
    else:
        API_CHECK.update(ok=False, text=f"функция ответила {r.status_code}: {str(body)[:120]}")
    API_CHECK["at"] = SH.now().isoformat()
    return API_CHECK


@bot.message_handler(commands=["check"])
def cmd_check(m):
    if not admin_only(m):
        return
    c = api_selfcheck()
    store = "✅ ключ базы есть" if STORE.ok() else "❌ нет SUPABASE_SERVICE_KEY"
    send(m.chat.id, f"🔐 <b>Проверка подтверждения аккаунтов</b>\n\n"
                    f"{'✅' if c['ok'] else '❌'} {esc(c['text'])}\n{store}\n"
                    f"Mini App: <code>{esc(WEBAPP_URL)}</code>")


# ── кнопки ───────────────────────────────────────────────────
@bot.callback_query_handler(func=lambda c: True)
def on_cb(c):
    uid, d = c.from_user.id, c.data or ""
    if flood(uid, 0.4):
        return bot.answer_callback_query(c.id)
    try:
        handle_cb(c, uid, d)
    finally:
        try:
            bot.answer_callback_query(c.id)
        except ApiTelegramException:
            pass


def handle_cb(c, uid, d):
    chat = c.message.chat.id
    if d == "menu":
        STATE.pop(uid, None)
        return edit(c, welcome(c.from_user), main_kb())
    if d == "noop":
        return
    if d == "sh":
        if not STORE.ok():
            return edit(c, no_store(), back_kb())
        return edit(c, f"🗓 <b>Мои смены</b>\n\n{team_line(get_user(uid))}", shifts_kb())
    if d in ("sh_t", "sh_w", "sh_m"):
        if not STORE.ok():
            return edit(c, no_store(), back_kb())
        t = SH.today()
        if d == "sh_t":
            text = today_text(uid)
        elif d == "sh_w":
            text = SH.list_text(my_rows(uid, t, t + timedelta(days=6)), "🗓 Смены на 7 дней")
        else:
            a, b = SH.month_range(t.strftime("%Y-%m"))
            text = SH.list_text(my_rows(uid, a, b), f"📆 Смены, {t:%m.%Y}")
        return edit(c, text, shifts_kb())
    if d == "tm":
        u = get_user(uid) or {}
        return edit(c, f"⚙️ <b>Смена и группа</b>\n\n{team_line(u)}\nВыбери свою — график и оповещения подстроятся.",
                    team_kb(u.get("team"), u.get("grp")))
    if d.startswith("tm_"):
        _, team, grp = d.split("_", 2)
        teams = (SCHED or {}).get("teams", {})
        if team not in teams or grp not in teams[team]["groups"]:
            return
        if not STORE.ok():
            return edit(c, no_store(), back_kb())
        STORE.upsert_user({"uid": str(uid), "team": team, "grp": grp, "rebuild": True, "active": True,
                           "team_at": SH.now().isoformat()})
        bot.answer_callback_query(c.id, f"Смена {teams[team]['label']} {grp} сохранена")
        return edit(c, f"✅ Смена <b>{esc(teams[team]['label'])} {grp}</b>. График соберётся в течение минуты, "
                       "оповещения придут сами.", shifts_kb())
    if d == "nt":
        if not STORE.ok():
            return edit(c, no_store(), back_kb())
        return edit(c, "🔔 <b>Оповещения</b>\n\nНажми, чтобы включить или выключить.", notify_kb(SH.prefs(get_user(uid) or {})))
    if d.startswith("nt_") and d[3:] in NT_LABEL:
        p = SH.prefs(get_user(uid) or {})
        p[d[3:]] = not p[d[3:]]
        STORE.upsert_user({"uid": str(uid), "notify": p, "active": True})
        return edit(c, "🔔 <b>Оповещения</b>\n\nНажми, чтобы включить или выключить.", notify_kb(p))
    if d == "rk":
        edit(c, "🏆 Считаю рейтинг  ▰▰▱")
        return edit(c, rating_text(), back_kb(app_btn("📱 Рейтинг в трекере", "rating")))
    if d == "calc":
        kb = InlineKeyboardMarkup(row_width=4)
        kb.add(*[InlineKeyboardButton(v[0], callback_data=f"calc_{k}") for k, v in ST.items()])
        kb.add(InlineKeyboardButton("↩️ Меню", callback_data="menu"))
        return edit(c, "🧮 <b>Посчитать премию</b>\n\nВыбери станцию:", kb)
    if d.startswith("calc_") and d[5:] in ST:
        STATE[uid] = ("calc", d[5:])
        return edit(c, f"🧮 <b>{ST[d[5:]][0]}</b>\n\nНапиши пики и часы через пробел, например <code>420 8</code>",
                    back_kb())
    if d == "ics":
        return send_ics(chat, uid)
    if d == "ics_new":
        return send_ics(chat, uid, renew=True)
    if d == "ns_go" and is_admin(uid):
        st = STATE.pop(uid, None)
        if st and st[0] == "nsend":
            edit(c, "📣 Отправка запущена.")
            threading.Thread(target=run_nsend, args=(chat, st[1], st[2]), daemon=True).start()
        return
    if d.startswith("ap_") and is_admin(uid) and STORE.ok():
        parts = d.split("_")
        if parts[1].isdigit():
            month = parts[2] if len(parts) > 2 and RE_MONTH.match(parts[2]) else SH.today().strftime("%Y-%m")
            return show_peaks(chat, parts[1], month, uid)
        return
    if d.startswith("am_") and d[3:].isdigit() and is_admin(uid) and STORE.ok():
        return ask_msg(chat, uid, d[3:])
    if d == "am_go" and is_admin(uid):
        st = STATE.pop(uid, None)
        if st and st[0] == "msg":
            edit(c, "✉️ Отправляю…")
            run_msg(chat, st[1], st[2])
        return
    if d == "bc_go" and is_admin(uid):
        st = STATE.pop(uid, None)
        if st and st[0] == "bc":
            edit(c, "📤 Рассылка запущена.")
            threading.Thread(target=run_broadcast, args=(chat, st[1]), daemon=True).start()


@bot.message_handler(content_types=["text"])
def on_text(m):
    st = STATE.get(m.from_user.id)
    if is_admin(m.from_user.id):
        if st and st[0] == "msg_wait" and not (m.text or "").startswith("/"):
            STATE.pop(m.from_user.id, None)
            return confirm_msg(m.chat.id, m.from_user.id, st[1], m.text.strip())
        fwd = getattr(m, "forward_from", None) or getattr(getattr(m, "forward_origin", None), "sender_user", None)
        if fwd:
            return send(m.chat.id, f"🆔 {esc(fwd.first_name)} — <code>{fwd.id}</code>", person_kb(fwd.id))
        if getattr(m, "forward_sender_name", None) or getattr(getattr(m, "forward_origin", None), "sender_user_name", None):
            return send(m.chat.id, "Человек скрыл аккаунт при пересылке — ID не виден. Найди его по имени: <code>/users имя</code>")
    if st and st[0] == "calc":
        nums = re.findall(r"\d+(?:[.,]\d+)?", m.text or "")
        try:
            p, h = int(float(nums[0].replace(",", "."))), float(nums[1].replace(",", "."))
            if not (0 < p <= 100000 and 0 < h <= 16):
                raise ValueError
        except (IndexError, ValueError):
            return send(m.chat.id, "Нужно два числа: пики и часы. Например <code>420 8</code>")
        STATE.pop(m.from_user.id, None)
        effect = "fire" if calc(st[1], p, h)["bonus"] > 0 else None
        return send(m.chat.id, calc_text(st[1], p, h), back_kb(app_btn("📱 Записать в трекер", "peaks")), effect=effect)
    if flood(m.from_user.id):
        return
    send(m.chat.id, "Выбери действие:", main_kb())


# ── оповещения: фоновый поток ────────────────────────────────
def notify_text(kind, row):
    if kind == "pay":
        return ("💼 <b>Сегодня 10-е — кошелёк обновился</b>\n\n"
                "Расчёт за прошлый месяц ушёл в историю. Открой кошелёк, проверь часы и сохрани расчёт за новый месяц.")
    start, end = SH.bounds(row)
    now = SH.now()
    if kind == "peaks":
        return (f"📦 <b>Смена закончилась</b>\n\n{SH.line(row)}\n\n"
                "Запиши пики, пока помнишь цифры — премия за месяц пересчитается сразу.")
    left = SH.left_text((start - now).total_seconds())
    head = "⏰ <b>Смена через 2 часа</b>" if kind == "h2" else "🚌 <b>Через час смена</b>"
    tail = "\n\nПора собираться: жилет, обувь BHP и бейдж." if kind == "h2" else "\n\nВремя выходить к автобусу."
    return f"{head}\n\n{SH.line(row)}\n\nНачало {left}.{tail}"


def notify_kb_for(kind):
    kb = InlineKeyboardMarkup()
    if kind == "peaks":
        kb.add(app_btn("📦 Записать пики", "peaks"))
    elif kind == "pay":
        kb.add(app_btn("💼 Открыть кошелёк", "wallet"))
    else:
        kb.add(app_btn("🗓 Открыть график", "sched"))
    return kb


def tick(state):
    if not STORE.ok() or not SCHED:
        return
    # 1. раз в сутки (и при запуске) продлеваем графики всем на 3 месяца вперёд
    today = SH.today()
    if state.get("day") != today:
        STORE.mark_all_rebuild()
        try:
            STORE.prune_log()
        except Exception:
            pass
        state["day"] = today
    # 2. пересобрать тех, кто сменил группу / отпуск в приложении или в боте
    rebuilt = shifts_n = 0
    for u in STORE.users(rebuild="is.true"):
        try:
            shifts_n += SH.rebuild_user(STORE, SCHED, u)
            rebuilt += 1
        except Exception as e:
            print(f"♻️ ошибка пересборки графика: {e}")
    if rebuilt:
        print(f"♻️ графики пересобраны: {rebuilt} чел., {shifts_n} смен")
    NOTIFY["last_tick"] = SH.now().isoformat()
    if NOTIFY["paused"]:
        return
    # 3. разослать то, что пора
    users = STORE.users(active="is.true")
    a = (today - timedelta(days=1)).isoformat()
    b = (today + timedelta(days=1)).isoformat()
    rows = STORE.get_shifts(since=a, until=b)
    sent = {}
    for uid, key, kind, row in SH.plan(rows, users):
        if not STORE.claim(uid, key):
            continue                                  # уже отправлено
        try:
            send(int(uid), notify_text(kind, row), notify_kb_for(kind), effect="party" if kind == "pay" else None)
            NOTIFY["sent"] += 1
            sent[kind] = sent.get(kind, 0) + 1
        except ApiTelegramException as e:
            NOTIFY["failed"] += 1
            if gone(e):
                set_inactive(uid)
            else:
                STORE.unclaim(uid, key)              # временная ошибка — повторим на следующем круге
        except Exception:
            NOTIFY["failed"] += 1
            STORE.unclaim(uid, key)
        time.sleep(0.05)
    if sent:
        print("🔔 отправлено: " + ", ".join(f"{KIND_RU.get(k, k)} ×{n}" for k, n in sent.items()))
    # раз в час — короткая строка, что поток жив (без имён и id)
    hour = SH.now().strftime("%Y-%m-%d %H")
    if state.get("hour") != hour:
        state["hour"] = hour
        print(f"💓 оповещения работают: смен сегодня–завтра {len(rows)}, активных {len(users)}, "
              f"с запуска ушло {NOTIFY['sent']}, не дошло {NOTIFY['failed']}")


def notifier():
    state = {}
    while True:
        try:
            tick(state)
            NOTIFY["last_error"] = None
        except Exception as e:
            NOTIFY["last_error"] = f"{SH.now():%d.%m %H:%M} {e}"[:300]
            print("оповещения:", e)
        time.sleep(TICK)


def setup():
    try:
        bot.set_my_commands([
            BotCommand("start", "Меню и трекер"), BotCommand("today", "Смена сегодня"),
            BotCommand("week", "Смены на неделю"), BotCommand("month", "Смены за месяц"),
            BotCommand("team", "Выбрать смену и группу"), BotCommand("notify", "Оповещения"),
            BotCommand("rating", "Рейтинг премий"), BotCommand("calc", "Посчитать премию"),
            BotCommand("pay", "Когда обновится кошелёк"), BotCommand("calendar", "Смены в календарь телефона"),
        ])
        bot.set_chat_menu_button(menu_button=MenuButtonWebApp("web_app", "Трекер", WebAppInfo(url=WEBAPP_URL)))
        # админам — свой список команд в меню «/» (остальные его не видят)
        admin_cmds = [BotCommand("admin", "Все админ-команды"), BotCommand("nstatus", "Состояние оповещений"),
                      BotCommand("nplan", "Что уйдёт в ближайшие сутки"), BotCommand("nlog", "Журнал отправок"),
                      BotCommand("nsend", "Сообщение смене / группе"), BotCommand("ntest", "Тест оповещений себе"),
                      BotCommand("npause", "Пауза рассылки"), BotCommand("nresume", "Вернуть рассылку"),
                      BotCommand("users", "Люди и их ID"), BotCommand("peaks", "Пики человека"),
                      BotCommand("pfix", "Исправить запись пиков"), BotCommand("msg", "Написать человеку"), BotCommand("nuser", "Профиль человека"), BotCommand("rebuild", "Пересобрать графики"),
                      BotCommand("check", "Проверка подтверждения аккаунтов"), BotCommand("stats", "Статистика"), BotCommand("broadcast", "Рассылка всем")]
        for aid in ADMIN_IDS:
            try:
                bot.set_my_commands(admin_cmds, scope=BotCommandScopeChat(aid))
            except Exception as e:
                print("admin commands", aid, e)
    except Exception as e:
        print("setup:", e)


if __name__ == "__main__":
    setup()
    if STORE.ok():
        threading.Thread(target=notifier, daemon=True).start()
        print("🔔 Оповещения включены")
    else:
        print("⚠️ SUPABASE_SERVICE_KEY не задан — смены и оповещения выключены")
    if not ADMIN_IDS:
        print("ℹ️ ADMIN_TELEGRAM_IDS не задан — админ-команды недоступны")

    def _startup_check():
        c = api_selfcheck()
        print(("🔐 " if c["ok"] else "❌ ") + "Подтверждение аккаунтов: " + c["text"])
        if not c["ok"]:
            for aid in ADMIN_IDS:
                try:
                    send(aid, f"❌ <b>Аккаунты не подтверждаются</b>\n\n{esc(c['text'])}\n\nПроверить снова: /check")
                except Exception:
                    pass
    threading.Thread(target=_startup_check, daemon=True).start()
    print("✅ AutoDoc Tracker Bot запущен")
    # 409 Conflict — тем же токеном опрашивает кто-то ещё (старый контейнер при
    # передеплое или забытый экземпляр). Не падаем, ждём и пробуем снова.
    while True:
        try:
            bot.infinity_polling(skip_pending=True, timeout=30, long_polling_timeout=25)
            break
        except ApiTelegramException as e:
            if e.error_code != 409:
                raise
            print("⏳ 409: старый экземпляр бота ещё не остановился (обычно при передеплое) — жду 15 с")
            time.sleep(15)
