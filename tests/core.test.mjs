// node tests/core.test.mjs — проверки денег и дат без браузера.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const C = require('../assets/js/core.js');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('нетто при минималке 4806 zł, старше 26', () => {
  const s = C.salary({ month: '2026-03', rate: 4806 / C.nominalHours('2026-03'), hours: C.nominalHours('2026-03') });
  assert.equal(s.brutto, 4806);
  assert.equal(s.zus, 658.91);
  assert.equal(s.health, 373.24);
  assert.equal(s.pit, 168);
  assert.equal(s.netto, 3605.85);
});

t('до 26 лет PIT = 0, ZUS и здоровье остаются', () => {
  const s = C.salary({ month: '2026-03', rate: 4806 / 176, hours: 176, young: true });
  assert.equal(s.pit, 0);
  assert.equal(s.netto, 3773.85);
});

t('премия входит в брутто и облагается', () => {
  const a = C.salary({ month: '2026-10', rate: 31.4, hours: 160 });
  const b = C.salary({ month: '2026-10', rate: 31.4, hours: 160, bonus: 300 });
  assert.equal(r(b.brutto - a.brutto), 300);
  assert.ok(b.netto - a.netto < 300 && b.netto - a.netto > 200);
});

t('ночная доплата: 20% от минимальной часовой', () => {
  const s = C.salary({ month: '2026-10', rate: 31.4, hours: 168, nightHours: 168 });
  const minH = 4806 / C.nominalHours('2026-10');
  assert.equal(s.parts.night, C.r2(168 * .2 * minH));
  const own = C.salary({ month: '2026-10', rate: 31.4, hours: 168, nightHours: 168, nightBasis: 'own' });
  assert.equal(own.parts.night, C.r2(168 * .2 * 31.4));
});

t('сверхурочные 50% и 100%', () => {
  const s = C.salary({ month: '2026-10', rate: 30, hours: 0, ovt50: 2, ovt100: 3 });
  assert.equal(s.parts.ovt50, 90);
  assert.equal(s.parts.ovt100, 180);
});

t('отпуск: ставка + средняя переменная часть за 3 месяца', () => {
  const avg = C.urlopAverage([{ var: 1200, hours: 168 }, { var: 900, hours: 160 }, { var: 1000, hours: 176 }, { var: 50, hours: 0 }]);
  assert.equal(avg.months, 3);
  assert.equal(avg.perHour, C.r2(3100 / 504));
  const plain = C.salary({ month: '2026-10', rate: 31.4, hours: 0, urlopHours: 16 });
  const urlop = C.salary({ month: '2026-10', rate: 31.4, hours: 0, urlopHours: 16, urlopVar: avg.perHour });
  assert.equal(plain.parts.urlop, C.r2(16 * 31.4));
  assert.equal(urlop.parts.urlop, C.r2(16 * (31.4 + avg.perHour)));
  assert.ok(urlop.parts.urlop > plain.parts.urlop);
  const s = C.salary({ month: '2026-09', rate: 31.4, hours: 160, nightHours: 160, ovt50: 4, bonus: 250 });
  const v = C.variableOf(s, { hours: 160, ovt50: 4 });
  assert.equal(v.hours, 164);
  assert.equal(v.var, C.r2(s.parts.night + s.parts.ovt50 + 250));
});

t('статьи AutoDoc: Dodatek DARK облагается, эквиваленты — нет, удержания из «на руки»', () => {
  const base = { month: '2026-10', rate: 30, hours: 100, young: true };
  const a = C.salary(base);
  const b = C.salary({ ...base, dark: 300 });
  assert.equal(C.r2(b.brutto - a.brutto), 300);
  assert.ok(b.zus > a.zus && b.health > a.health);           // dark входит в ZUS и здоровье
  const c = C.salary({ ...base, ekw: 20, deduct: 5 });
  assert.equal(c.brutto, a.brutto);                          // эквиваленты не в брутто
  assert.equal(C.r2(c.netto - a.netto), 15);
  const v = C.variableOf(b, { hours: 100 });
  assert.equal(v.var, 300);                                  // dark — переменная часть для отпускных
});

t('ulga dla młodych: сверх лимита 85 528 zł PIT считается', () => {
  const inp = { month: '2026-11', rate: 50, hours: 160, young: true };
  assert.equal(C.salary({ ...inp, ytd: 70000 }).pit, 0);              // до лимита
  const over = C.salary({ ...inp, ytd: 85528 });                      // лимит исчерпан
  const old = C.salary({ ...inp, young: false });
  assert.equal(over.pit, old.pit);
  const part = C.salary({ ...inp, ytd: 82528 });                      // 3000 из 8000 ещё без налога
  assert.equal(part.taxable, 5000);
  assert.ok(part.pit > 0 && part.pit < old.pit);
});

t('окно отпускных: 3 месяца по дате выплаты', () => {
  assert.deepEqual(C.urlopWindow('2026-08'), ['2026-04', '2026-05', '2026-06']);
  assert.deepEqual(C.urlopWindow('2026-01'), ['2025-09', '2025-10', '2025-11']);
});

t('премия за обецность: 0 пропусков ×1,25, 1 — ×0,8, с двух 0', () => {
  assert.deepEqual([0, 1, 2, 3, 5].map(C.premiumFactor), [1.25, 0.8, 0, 0, 0]);
  assert.equal(C.premiumFactor(undefined), 1);
  const base = { month: '2026-10', rate: 30, hours: 100, bonus: 400 };
  assert.equal(C.salary({ ...base, absences: 0 }).parts.bonus, 500);
  assert.equal(C.salary({ ...base, absences: 1 }).parts.bonus, 320);
  assert.equal(C.salary({ ...base, absences: 2 }).parts.bonus, 0);
  assert.equal(C.salary({ ...base, absences: 0 }).bonusBase, 400);
});

t('номинальные часы 2026', () => {
  assert.equal(C.nominalHours('2026-01'), 160);   // 1 и 6 января — будни
  assert.equal(C.nominalHours('2026-10'), 176);
  assert.equal(C.nominalHours('2026-12'), 160);   // 24, 25 — будни, 26 — суббота
  assert.equal(C.iso(C.easter(2026)), '2026-04-05');
});

t('возраст и ulga', () => {
  assert.equal(C.youngStatus('2001-05-20', '2026-10').status, 'yes');   // 25 лет
  assert.equal(C.youngStatus('2000-10-20', '2026-10').status, 'partial'); // 26 в этом месяце
  assert.equal(C.youngStatus('2000-10-20', '2026-09').status, 'yes');
  assert.equal(C.youngStatus('1999-03-01', '2026-10').status, 'no');
  assert.equal(C.youngStatus('2001-10-20', '2026-10').status, 'yes');
  assert.equal(C.youngStatus('2001-10-20', '2027-10').status, 'partial');
  assert.equal(C.youngStatus('2001-10-20', '2027-09').status, 'yes');
  assert.equal(C.youngStatus('', '2026-10').status, 'unknown');
});

t('кошелёк: до 10-го прошлый месяц, с 10-го — текущий', () => {
  assert.equal(C.walletMonth(new Date(2026, 9, 8)), '2026-09');
  assert.equal(C.walletMonth(new Date(2026, 9, 9, 23, 59)), '2026-09');
  assert.equal(C.walletMonth(new Date(2026, 9, 10, 0, 1)), '2026-10');
  assert.equal(C.walletMonth(new Date(2026, 9, 13)), '2026-10');
  assert.equal(C.walletMonth(new Date(2026, 0, 3)), '2025-12');
  assert.equal(C.walletUntil('2026-09'), '2026-10-10');
  assert.equal(C.walletUntil('2026-12'), '2027-01-10');
  assert.equal(C.daysLeft('2026-10-10', new Date(2026, 9, 8, 20)), 2);
});

t('смена-день: ночная смена — день начала', () => {
  const now = new Date(2026, 9, 1, 7, 0);
  assert.equal(C.shiftDayOf('2026-10-01', '22:00', '06:00', now), '2026-09-30');
  assert.equal(C.shiftDayOf('2026-10-01', '00:00', '06:00', now), '2026-09-30');
  assert.equal(C.shiftDayOf('2026-10-01', '06:00', '14:00', new Date(2026, 9, 1, 15)), '2026-10-01');
  assert.equal(C.shiftToday(new Date(2026, 9, 1, 2)), '2026-09-30');
  assert.equal(C.minutesBetween('22:00', '06:00'), 480);
  assert.equal(C.nightMinutes('22:00', '06:00'), 480);
  assert.equal(C.nightMinutes('14:00', '22:00'), 0);
  assert.equal(C.nightMinutes('20:00', '23:00'), 60);
});

t('премия за месяц — агрегатом', () => {
  const es = [
    { station: 'os', peaks: 400, hours: 8, shiftDate: '2026-10-01' },
    { station: 'os', peaks: 360, hours: 8, shiftDate: '2026-10-02' },
  ];
  const a = C.monthAgg(es, 'os', '2026-10');
  assert.equal(a.norm, 720);
  assert.equal(a.above, 40);
  assert.equal(a.rate, .61);                     // темп 47.5 → 48 → 46–52
  assert.equal(C.r2(a.bonus), 24.4);
});

t('график из schedule.json', () => {
  const sched = JSON.parse(readFileSync(new URL('../schedule.json', import.meta.url)));
  const p = C.monthPlan(sched, 'dark', 'A', '2026-10');
  assert.deepEqual(p.days[1], { from: '22:00', to: '06:00' });
  const o = C.monthPlan(sched, 'orange', 'A', '2026-09');
  assert.deepEqual(o.days[1], { from: '14:00', to: '22:00' });
  assert.deepEqual(o.days[7], { from: '06:00', to: '14:00' });
  assert.equal(C.monthPlan(sched, 'green', 'A', '2026-10'), null);
});

function r(x) { return Math.round(x * 100) / 100; }
console.log(`\n${n} проверок пройдено`);
