"""
AutoDoc Tracker Bot v2
======================
Telegram-бот к Mini App: открывает трекер, показывает смены, шлёт оповещения
(за 12 ч и за час до смены, «запиши пики» после смены, 15-го — новый месяц
в кошельке), рейтинг премий, быстрый расчёт премии.

Хранилище — только Supabase (Railway стирает файлы при редеплое).
Переменные окружения — см. .env.example.
"""

import html
import os
import re
import threading
import time
from datetime import timedelta

import requests
import telebot
from telebot.apihelper import ApiTelegramException
from telebot.types import (BotCommand, InlineKeyboardButton, InlineKeyboardMarkup,
                           MenuButtonWebApp, WebAppInfo)

import shifts as SH

# ── окружение ────────────────────────────────────────────────
TOKEN = os.environ.get("TOKEN") or os.environ.get("BOT_TOKEN")
if not TOKEN:
    raise SystemExit("Не задан TOKEN (токен от @BotFather). Railway → Variables.")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "").strip()
if not WEBAPP_URL.startswith("https://"):
    raise SystemExit("WEBAPP_URL должен быть https-адресом Mini App (GitHub Pages).")
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
}


def calc(st, peaks, hours):
    norm_rate, table = ST[st][2], ST[st][3]
    pph = peaks / hours if hours > 0 else 0
    norm = int(norm_rate * hours + 0.5)   # тоже как Math.round
    above = max(0, peaks - norm)
    rp = int(pph + 0.5)            # как Math.round в JS: 52.5 → 53 (round() в Python дал бы 52)
    r = next((x for lo, hi, x in table if lo <= rp <= hi), table[-1][2])
    tier = next((i for i, (lo, hi, _) in enumerate(table) if lo <= rp <= hi), len(table) - 1)
    return dict(pph=pph, norm=norm, above=above, rate=r, bonus=above * r, tier=tier, tiers=len(table))


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


NT_LABEL = {"h12": "За 12 часов до смены", "h1": "За час до смены",
            "peaks": "После смены: записать пики", "pay": "15-го: новый месяц в кошельке"}


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
            "▸ пики и премия по таблицам OS, PA, SIO, PC\n"
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
                                 "select": "name,emoji,bonus,peaks,shifts"},
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
        lines.append(f"{medal[i] if i < 3 else f'{i + 1}.'} {esc(x.get('emoji') or '👷')} <b>{esc(x.get('name') or 'Аноним')}</b> — <b>{b:.2f} zł</b>\n"
                     f"<code>{'█' * fill}{'░' * (8 - fill)}</code> {int(x.get('peaks') or 0)} шт, {int(x.get('shifts') or 0)} смен")
    return f"🏆 <b>Рейтинг премий, {month}</b>\n\n" + "\n".join(lines)


def calc_text(st, peaks, hours):
    c = calc(st, peaks, hours)
    name, full, norm, _ = ST[st]
    return (f"🧮 <b>{name}, {full}</b>\n\n"
            f"Пики: <b>{peaks}</b> за <b>{hours:g} ч</b>\n"
            f"Темп: <b>{c['pph']:.1f}</b> в час (норма {norm})\n"
            f"Ступень: <code>{bar(c['tier'], c['tiers'])}</code> {c['rate']:.3f} zł/шт\n"
            f"Сверх нормы: <b>{c['above']}</b> шт из {c['norm']} по норме\n\n"
            f"💰 <b>{c['bonus']:.2f} zł</b> премии, если такой темп будет весь месяц.\n"
            "<i>Премия считается по среднему темпу за месяц, а не за смену.</i>")


def pay_text():
    left, target = SH.days_to_pay()
    when = "сегодня" if left == 0 else f"через {left} дн."
    return (f"💼 <b>Кошелёк</b>\n\nСледующее обновление — <b>{target:%d.%m}</b>, {when}.\n"
            "До 15-го в кошельке виден расчёт за прошлый месяц, с 15-го — за текущий. "
            "Премия за пики пересчитывается каждый раз, когда открываешь кошелёк.")


# ── команды ──────────────────────────────────────────────────
STATE = {}          # uid → ожидание ввода: ("calc", st) | ("bc", text)


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
        send(m.chat.id, "Предпросмотр:\n\n" + text)
    except ApiTelegramException as e:
        return send(m.chat.id, f"⚠️ Текст не принят Telegram: <code>{esc(e.description)}</code>")
    STATE[m.from_user.id] = ("bc", text)
    kb = InlineKeyboardMarkup()
    kb.add(InlineKeyboardButton("📢 Разослать всем", callback_data="bc_go"), InlineKeyboardButton("Отмена", callback_data="menu"))
    send(m.chat.id, "Разослать это всем активным?", kb)


def run_broadcast(chat_id, text):
    try:
        users = [u["uid"] for u in STORE.users(active="is.true")]
    except Exception:
        return send(chat_id, "⚠️ База недоступна.")
    send(chat_id, f"📤 Рассылаю {len(users)}…")
    ok = bad = 0
    for uid in users:
        try:
            bot.send_message(int(uid), text, disable_web_page_preview=True)
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
    if d == "bc_go" and is_admin(uid):
        st = STATE.pop(uid, None)
        if st and st[0] == "bc":
            edit(c, "📤 Рассылка запущена.")
            threading.Thread(target=run_broadcast, args=(chat, st[1]), daemon=True).start()


@bot.message_handler(content_types=["text"])
def on_text(m):
    st = STATE.get(m.from_user.id)
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
        return ("💼 <b>Сегодня 15-е — кошелёк обновился</b>\n\n"
                "Расчёт за прошлый месяц ушёл в историю. Открой кошелёк, проверь часы и сохрани расчёт за новый месяц.")
    start, end = SH.bounds(row)
    now = SH.now()
    if kind == "peaks":
        return (f"📦 <b>Смена закончилась</b>\n\n{SH.line(row)}\n\n"
                "Запиши пики, пока помнишь цифры — премия за месяц пересчитается сразу.")
    left = SH.left_text((start - now).total_seconds())
    head = "⏰ <b>Смена через 12 часов</b>" if kind == "h12" else "🚌 <b>Скоро смена</b>"
    tail = "" if kind == "h12" else "\n\nНе забудь жилет, обувь BHP и бейдж."
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
    for u in STORE.users(rebuild="is.true"):
        try:
            SH.rebuild_user(STORE, SCHED, u)
        except Exception as e:
            print("rebuild", u.get("uid"), e)
    # 3. разослать то, что пора
    users = STORE.users(active="is.true")
    a = (today - timedelta(days=1)).isoformat()
    b = (today + timedelta(days=1)).isoformat()
    rows = STORE.get_shifts(since=a, until=b)
    for uid, key, kind, row in SH.plan(rows, users):
        if not STORE.claim(uid, key):
            continue                                  # уже отправлено
        try:
            send(int(uid), notify_text(kind, row), notify_kb_for(kind), effect="party" if kind == "pay" else None)
        except ApiTelegramException as e:
            if gone(e):
                set_inactive(uid)
            else:
                STORE.unclaim(uid, key)              # временная ошибка — повторим на следующем круге
        except Exception:
            STORE.unclaim(uid, key)
        time.sleep(0.05)


def notifier():
    state = {}
    while True:
        try:
            tick(state)
        except Exception as e:
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
            print("⏳ 409: работает другой экземпляр бота с этим токеном — жду 15 с")
            time.sleep(15)
