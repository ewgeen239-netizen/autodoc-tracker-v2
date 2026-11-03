"""python3 tests/test_bot_admin.py — админ-команды бота: /users, /peaks, /pfix, /msg.

Без сети: Telegram и база подменены заглушками. Данные выдуманные.
"""
import os
import sys
from types import SimpleNamespace as NS

os.environ.update(TOKEN="1:TEST", ADMIN_TELEGRAM_IDS="42", SUPABASE_SERVICE_KEY="svc",
                  WEBAPP_URL="https://example.github.io/app/")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import bot as B  # noqa: E402

SENT = []
B.bot.send_message = lambda chat, text, **kw: SENT.append((int(chat), text)) or NS(message_id=1)

M = "2026-11"
USERS = [{"uid": "5550001", "name": "Ola Test", "username": "ola", "active": True, "team": "dark", "grp": "A", "started_at": "2026-10-01"},
         {"uid": "5550002", "name": "Jan Probny", "username": None, "active": False, "team": None, "started_at": "2026-10-05"}]
PEAKS = [{"uid": "5550001", "month": M, "id": 1, "day": "2026-11-02", "station": "pa", "peaks": 1300, "hours": 8, "t_from": "22:00", "t_to": "06:00", "added": "06:05"},
         {"uid": "5550001", "month": M, "id": 2, "day": "2026-11-03", "station": "pa", "peaks": 1250, "hours": 8},
         {"uid": "5550001", "month": M, "id": 3, "day": "2026-11-04", "station": "zk", "peaks": 1000, "hours": 7.5},
         {"uid": "5550001", "month": M, "id": 4, "day": "2026-11-05", "station": "os", "peaks": 500, "hours": 8}]
LB = {"bonus": 518.46, "pf": 1.25, "shifts": 4, "updated_at": "2026-11-05T08:00:00+00:00"}
PATCHED = {}


class Store:
    def ok(self): return True
    def users(self, **flt): return [dict(u) for u in USERS]
    def get_user(self, uid): return next((dict(u) for u in USERS if u["uid"] == str(uid)), None)
    def peaks(self, uid, month): return [dict(r) for r in PEAKS if r["uid"] == uid and r["month"] == month]
    def month_row(self, table, uid, month, select="*"):
        return dict(LB) if table == "leaderboard" else {"amount": 120, "hours": 10} if table == "indirect" else None
    def patch_peak(self, uid, pid, patch):
        next(r for r in PEAKS if r["id"] == pid).update(patch)
    def patch_leaderboard(self, uid, month, patch):
        PATCHED.update(patch); LB.update(bonus=patch["bonus"])


B.STORE = Store()
admin = NS(id=42, first_name="Admin")


def cmd(fn, text):
    SENT.clear()
    fn(NS(text=text, chat=NS(id=42), from_user=admin))
    return "\n".join(t for _, t in SENT)


n = 0
def ok(name):
    global n; n += 1; print("ok", name)


# /users: поиск по имени и нику, ID видно
out = cmd(B.cmd_users, "/users ola")
assert "<code>5550001</code>" in out and "5550002" not in out
out = cmd(B.cmd_users, "/users")
assert "В базе: 2" in out and "🔴" in out
ok("/users — люди и их ID, поиск")

# /peaks: станции, записи с номерами, премия как в core.js
out = cmd(B.cmd_peaks, f"/peaks 5550001 {M}")
assert "#1" in out and "#4" in out and "22:00–06:00" in out and "записал 06:05" in out
assert "Załadunek kontenerów" in out and "518.46 zł" in out, out
assert B.PK_CTX[42] == ("5550001", M)
ok("/peaks — куда записал, сколько, темп")

# снимок месяца совпадает с C.monthSnapshot (318,77 zł; ×1,25 + Indirect 120 = 518,46)
s = B.month_snapshot(PEAKS)
assert (s["bonus"], s["peaks"], s["hours"], s["shifts"]) == (318.77, 4050, 31.5, 4), s
ok("премия бота = core.js")

# /pfix 4 sio — станция исправлена, рейтинг пересчитан, человеку пришло уведомление
out = cmd(B.cmd_pfix, "/pfix 4 sio")
assert PEAKS[3]["station"] == "sio" and PEAKS[3]["admin_at"] and PEAKS[3]["orig"]["station"] == "os"
assert PATCHED["bonus"] == 427.49, PATCHED          # C.r2(245.99 × 1.25 + 120)
assert any(chat == 5550001 and "исправил" in t for chat, t in SENT)
assert "518.46 → <b>427.49 zł</b>" in out
ok("/pfix — станция, рейтинг, уведомление")

# пики и часы, тихо
out = cmd(B.cmd_pfix, "/pfix 2 1200 7.5 тихо")
assert (PEAKS[1]["peaks"], PEAKS[1]["hours"]) == (1200, 7.5) and not any(chat == 5550001 for chat, _ in SENT)
assert B.fix_values({"station": "pa", "peaks": 1, "hours": 8}, ["7ч"]) == {"station": "pa", "peaks": 1, "hours": 7.0}
assert isinstance(B.fix_values({"station": "pa", "peaks": 1, "hours": 8}, ["0"]), str)
assert isinstance(B.fix_values({"station": "pa", "peaks": 1, "hours": 8}, ["abc"]), str)
ok("/pfix — пики и часы, без уведомления")

# снять и вернуть
cmd(B.cmd_pfix, "/pfix 1 del тихо")
assert PEAKS[0]["deleted"] is True
out = cmd(B.cmd_peaks, f"/peaks 5550001 {M}")
assert "#4" not in out and "22:00" not in out
cmd(B.cmd_pfix, "/pfix 3 back тихо")             # после снятия #1 запись №3 — бывшая #4 (os → sio)
assert PEAKS[3]["station"] == "os"
out = cmd(B.cmd_pfix, "/pfix 9 pa")
assert "Записи #9 нет" in out
ok("/pfix — снять, вернуть как было, неверный номер")

# /msg: предпросмотр → подтверждение → доставка
out = cmd(B.cmd_msg, "/msg 5550001 Привет, проверь пики")
assert B.STATE[42] == ("msg", "5550001", "Привет, проверь пики")
SENT.clear(); B.run_msg(42, "5550001", "Привет, проверь пики")
assert SENT[0] == (5550001, "Привет, проверь пики") and "Доставлено" in SENT[1][1]
out = cmd(B.cmd_msg, "/msg ola")
assert B.STATE[42] == ("msg_wait", "5550001") and "Напиши текст" in out
out = cmd(B.cmd_msg, "/msg nikt")
assert "Никого не нашёл" in out
ok("/msg — по ID и по нику, с предпросмотром")

# не админ — отказ
SENT.clear(); B.cmd_peaks(NS(text="/peaks 5550001", chat=NS(id=7), from_user=NS(id=7)))
assert "только для администратора" in SENT[0][1]
ok("чужим — нельзя")

print(f"\n{n} проверок пройдено")
