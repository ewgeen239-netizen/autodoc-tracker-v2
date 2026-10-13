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

t('кошелёк: до 15-го прошлый месяц, с 15-го — текущий', () => {
  assert.equal(C.walletMonth(new Date(2026, 9, 13)), '2026-09');
  assert.equal(C.walletMonth(new Date(2026, 9, 14, 23, 59)), '2026-09');
  assert.equal(C.walletMonth(new Date(2026, 9, 15, 0, 1)), '2026-10');
  assert.equal(C.walletMonth(new Date(2026, 0, 3)), '2025-12');
  assert.equal(C.walletUntil('2026-09'), '2026-10-15');
  assert.equal(C.walletUntil('2026-12'), '2027-01-15');
  assert.equal(C.daysLeft('2026-10-15', new Date(2026, 9, 13, 20)), 2);
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
