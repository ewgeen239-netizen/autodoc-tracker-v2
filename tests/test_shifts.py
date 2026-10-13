"""python -m unittest discover tests — логика смен и оповещений без сети."""
import os
import sys
import unittest
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import shifts as SH  # noqa: E402

TZ = SH.TZ
SCHED = SH.load_schedule()


def at(y, m, d, h=0, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=TZ)


ROW = {"uid": "1", "day": "2026-10-14", "starts": "22:00:00", "ends": "06:00:00", "kind": "DARK"}
USER = {"uid": "1", "active": True, "team": "dark", "grp": "A", "notify": None}


class Schedule(unittest.TestCase):
    def test_dark_october(self):
        rows = SH.gen_shifts(SCHED, 1, "dark", "A", "2026-10")
        self.assertEqual(rows[0]["day"], "2026-10-01")
        self.assertEqual((rows[0]["starts"], rows[0]["ends"]), ("22:00:00", "06:00:00"))

    def test_orange_times_by_day(self):
        rows = {r["day"]: r for r in SH.gen_shifts(SCHED, 1, "orange", "A", "2026-09")}
        self.assertEqual(rows["2026-09-01"]["starts"], "14:00:00")
        self.assertEqual(rows["2026-09-07"]["starts"], "06:00:00")

    def test_vacation_excluded(self):
        rows = SH.gen_shifts(SCHED, 1, "dark", "A", "2026-10", off={"2026-10-01"})
        self.assertNotIn("2026-10-01", [r["day"] for r in rows])

    def test_green_empty(self):
        self.assertEqual(SH.gen_shifts(SCHED, 1, "green", "A", "2026-10"), [])

    def test_night_shift_hours(self):
        self.assertEqual(SH.hours(ROW), 8)


class Plan(unittest.TestCase):
    def kinds(self, when, users=(USER,)):
        return [(k, kind) for _, k, kind, _ in SH.plan([ROW], list(users), when)]

    def test_12h(self):
        self.assertEqual(self.kinds(at(2026, 10, 14, 11)), [("2026-10-14:h12", "h12")])

    def test_1h(self):
        self.assertEqual(self.kinds(at(2026, 10, 14, 21, 10)), [("2026-10-14:h1", "h1")])

    def test_nothing_too_early(self):
        self.assertEqual(self.kinds(at(2026, 10, 14, 8)), [])

    def test_peaks_after_shift(self):
        self.assertEqual(self.kinds(at(2026, 10, 15, 6, 30)), [("2026-10-14:peaks", "peaks")])
        self.assertEqual(self.kinds(at(2026, 10, 15, 6, 5)), [])

    def test_prefs_off(self):
        u = dict(USER, notify={"h12": False})
        self.assertEqual(self.kinds(at(2026, 10, 14, 11), [u]), [])

    def test_inactive(self):
        self.assertEqual(self.kinds(at(2026, 10, 14, 11), [dict(USER, active=False)]), [])

    def test_payday(self):
        out = SH.plan([], [USER], at(2026, 10, 15, 10, 0))
        self.assertEqual([(k, kind) for _, k, kind, _ in out], [("pay:2026-10", "pay")])
        self.assertEqual(SH.plan([], [USER], at(2026, 10, 15, 8, 0)), [])
        self.assertEqual(SH.plan([], [dict(USER, team=None)], at(2026, 10, 15, 12)), [])

    def test_days_to_pay(self):
        self.assertEqual(SH.days_to_pay(at(2026, 10, 13, 12))[0], 2)
        self.assertEqual(str(SH.days_to_pay(at(2026, 10, 20, 12))[1]), "2026-11-15")

    def test_shift_day(self):
        self.assertEqual(str(SH.shift_day(at(2026, 10, 1, 2))), "2026-09-30")


class FakeStore:
    def __init__(self):
        self.shifts = [{"uid": "1", "day": (SH.today() + timedelta(days=3)).isoformat(), "source": "admin"}]
        self.deleted = self.put = self.patched = None

    def get_shifts(self, uid=None, since=None, until=None):
        return self.shifts

    def del_auto(self, uid, since):
        self.deleted = (uid, since)

    def put_shifts(self, rows):
        self.put = rows

    def patch_user(self, uid, patch):
        self.patched = patch


class Rebuild(unittest.TestCase):
    def test_keeps_admin_days(self):
        st = FakeStore()
        SH.rebuild_user(st, SCHED, {"uid": "1", "team": "dark", "grp": "A"})
        admin_day = st.shifts[0]["day"]
        self.assertNotIn(admin_day, [r["day"] for r in st.put])
        self.assertEqual(st.patched, {"rebuild": False})
        self.assertTrue(all(r["day"] >= SH.today().isoformat() for r in st.put))


if __name__ == "__main__":
    unittest.main()
