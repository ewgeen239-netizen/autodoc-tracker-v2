/*  AutoDoc Tracker — чистая логика без DOM.
 *  Один файл и для приложения (window.Core), и для тестов под node (module.exports).
 *  Здесь всё, что считает деньги и даты: премия за пики, смена-день,
 *  график бригад, польская зарплата 2026, цикл «кошелька» до 10-го числа.
 */
(function (root) {
  'use strict';

  // ── станции и таблицы премий (M13 Outbound) ───────────────────────
  // tr: [от ppc/h, до ppc/h, zł за штуку сверх нормы]
  const ST = {
    os:  { name: 'OS',  full: 'Oversize',       norm: 45,  maxP: 86,  col: '#F2C230',
           tr: [[0,45,0],[46,52,.61],[53,59,.631],[60,67,.651],[68,74,.681],[75,81,.70],[82,85,.72],[86,999,.74]] },
    pa:  { name: 'PA',  full: 'Packing Auto',   norm: 120, maxP: 211, col: '#4C8DF6',
           tr: [[0,120,0],[121,133,.05],[134,142,.09],[143,151,.14],[152,167,.17],[168,182,.20],[183,210,.22],[211,999,.24]] },
    sio: { name: 'SIO', full: 'Single Item',    norm: 54,  maxP: 96,  col: '#B07CF2',
           tr: [[0,54,0],[55,60,.22],[61,64,.27],[65,68,.31],[69,75,.36],[76,82,.39],[83,95,.44],[96,999,.46]] },
    pc:  { name: 'PC',  full: 'Picking Consol', norm: 225, maxP: 395, col: '#F27A1A',
           tr: [[0,225,0],[226,250,.04],[251,267,.06],[268,283,.08],[284,313,.09],[314,342,.10],[343,394,.121],[395,999,.141]] },
    plc: { name: 'PLC', full: 'Placement Consol', norm: 180, maxP: 317, col: '#3DBE7A',
           tr: [[0,180,0],[181,200,.04],[201,214,.06],[215,227,.08],[228,250,.10],[251,274,.12],[275,316,.16],[317,999,.18]] },
  };

  const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

  function rateFor(st, pph) {
    const tr = ST[st].tr;
    for (const [lo, hi, r] of tr) if (pph >= lo && pph <= hi) return r;
    return tr[tr.length - 1][2];
  }

  // Премия по одной записи (для предпросмотра). Ставка — по округлённому темпу.
  function calc(st, peaks, hours) {
    const pph = hours > 0 ? peaks / hours : 0;
    const norm = Math.round(ST[st].norm * hours);
    const above = Math.max(0, peaks - norm);
    const rate = rateFor(st, Math.round(pph));
    return { pph, norm, above, rate, bonus: above * rate };
  }

  // Премия за месяц считается агрегатом: все пики и часы станции за месяц →
  // средний темп → ставка → премия. Не сумма премий по дням.
  function monthAgg(entries, st, mk) {
    const es = entries.filter(e => e.station === st && String(e.shiftDate || '').slice(0, 7) === mk);
    const P = es.reduce((s, e) => s + (+e.peaks || 0), 0);
    const H = es.reduce((s, e) => s + (+e.hours || 0), 0);
    const c = calc(st, P, H);
    return { P, H, pph: c.pph, norm: c.norm, above: c.above, rate: c.rate, bonus: c.bonus,
             shifts: new Set(es.map(e => e.shiftDate)).size, n: es.length };
  }
  function monthBonus(entries, mk) {
    return Object.keys(ST).reduce((s, st) => s + monthAgg(entries, st, mk).bonus, 0);
  }
  function monthSnapshot(entries, mk) {
    const es = entries.filter(e => String(e.shiftDate || '').slice(0, 7) === mk);
    const peaks = es.reduce((s, e) => s + (+e.peaks || 0), 0);
    const hours = es.reduce((s, e) => s + (+e.hours || 0), 0);
    const st = {};
    Object.keys(ST).forEach(k => {
      const a = monthAgg(entries, k, mk);
      if (a.P) st[k] = { peaks: a.P, hours: r2(a.H), bonus: r2(a.bonus), ppc: r2(a.pph) };
    });
    return { bonus: r2(monthBonus(entries, mk)), peaks, hours: r2(hours),
             shifts: new Set(es.map(e => e.shiftDate)).size,
             ppc: r2(hours > 0 ? peaks / hours : 0), st };
  }

  // ── даты (всегда по местному времени, не через toISOString) ───────
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const monthKey = d => iso(d).slice(0, 7);
  const addDays = (dayISO, n) => { const [y, m, d] = dayISO.split('-').map(Number); return iso(new Date(y, m - 1, d + n)); };
  const addMonths = (mk, n) => { const [y, m] = mk.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return monthKey(d); };
  const hmMin = t => { const [h, m] = String(t || '').split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null; };
  const daysInMonth = mk => { const [y, m] = mk.split('-').map(Number); return new Date(y, m, 0).getDate(); };

  // ── смена-день ────────────────────────────────────────────────────
  // Ночная смена 22:00–06:00 — одна смена; она принадлежит дню, в который
  // началась. Учётные сутки начинаются в 06:00. Так же считает bot.py.
  const SHIFT_CUT_H = 6;
  const shiftDayFrom = d => { const x = new Date(d); if (x.getHours() < SHIFT_CUT_H) x.setDate(x.getDate() - 1); return iso(x); };
  const shiftToday = (now = new Date()) => shiftDayFrom(now);
  const shiftYest = (now = new Date()) => { const d = new Date(now); d.setDate(d.getDate() - 1); return shiftDayFrom(d); };

  function shiftBounds(dayISO, from, to) {
    const a = hmMin(from), b = hmMin(to);
    if (a === null || b === null) return null;
    const [y, m, d] = dayISO.split('-').map(Number);
    const st = new Date(y, m - 1, d, Math.floor(a / 60), a % 60);
    const en = new Date(y, m - 1, d, Math.floor(b / 60), b % 60);
    if (b <= a) en.setDate(en.getDate() + 1);
    return { st, en };
  }

  // Дата в форме — дата НАЧАЛА смены. Утреннюю дату ночной смены сдвигаем назад.
  function shiftDayOf(dayISO, from, to, now = new Date()) {
    if (!dayISO) return dayISO;
    const a = hmMin(from);
    if (a !== null && a < SHIFT_CUT_H * 60) dayISO = addDays(dayISO, -1);
    const b = shiftBounds(dayISO, from, to);
    if (b && b.en > now) {
      const prev = shiftBounds(addDays(dayISO, -1), from, to);
      if (prev && prev.en <= now) dayISO = addDays(dayISO, -1);
    }
    return dayISO;
  }

  function minutesBetween(from, to) {
    const a = hmMin(from), b = hmMin(to);
    if (a === null || b === null) return 0;
    let d = b - a;
    if (d <= 0) d += 1440;
    return d;
  }

  // Сколько минут промежутка from–to попадает в ночь 22:00–06:00 (pora nocna).
  function nightMinutes(from, to) {
    const a = hmMin(from); const len = minutesBetween(from, to);
    if (a === null || !len) return 0;
    let n = 0;
    for (let t = a; t < a + len; t++) { const m = t % 1440; if (m >= 1320 || m < 360) n++; }
    return n;
  }

  // ── график бригад (schedule.json) ─────────────────────────────────
  function parseSpan(s) {
    const txt = String(s || '');
    const sep = ['–', '—', '-'].find(x => txt.includes(x));
    if (!sep) return null;
    const [a, b] = txt.split(sep);
    const one = p => { const [h, m] = p.trim().split(':'); return `${pad(+h)}:${pad(+(m || 0))}`; };
    return { from: one(a), to: one(b) };
  }

  // {день: {from,to}} для бригады/подгруппы; праздники отдельно.
  function monthPlan(sched, team, group, mk) {
    const t = sched && sched.teams && sched.teams[team];
    if (!t) return null;
    const m = (sched[t.sch] || {})[mk];
    if (!m) return null;
    const days = m.groups ? (m.groups[group] || []) : (m.w || []);
    const times = m.t || {};
    const out = {};
    days.forEach(d => { out[d] = parseSpan(times[String(d)] || t.defT); });
    return { days: out, holidays: m.h || {}, label: t.label };
  }

  // ── польские праздники и номинальные часы ─────────────────────────
  function easter(y) {                                   // алгоритм Гаусса/Мееуса
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, month - 1, day);
  }
  function plHolidays(y) {
    const e = easter(y), plus = n => iso(new Date(y, e.getMonth(), e.getDate() + n));
    const fixed = ['01-01', '01-06', '05-01', '05-03', '08-15', '11-01', '11-11', '12-25', '12-26'];
    if (y >= 2025) fixed.push('12-24');                  // Wigilia — wolna od 2025
    return new Set([...fixed.map(md => `${y}-${md}`), iso(e), plus(1), plus(49), plus(60)]);
  }
  // Wymiar czasu pracy: 8 ч × (будни − праздники в будни − праздники в субботу).
  function nominalHours(mk) {
    const [y, m] = mk.split('-').map(Number), hol = plHolidays(y);
    let h = 0;
    for (let d = 1; d <= daysInMonth(mk); d++) {
      const dt = new Date(y, m - 1, d), dow = dt.getDay(), key = iso(dt);
      if (dow >= 1 && dow <= 5 && !hol.has(key)) h += 8;
      if (dow === 6 && hol.has(key)) h -= 8;
    }
    return h;
  }

  // ── зарплата: umowa o pracę, Польша 2026 ──────────────────────────
  const TAX = {
    MIN_WAGE: { 2025: 4666, 2026: 4806 },
    ZUS: { em: .0976, rent: .015, chor: .0245 },        // 13.71% всего
    HEALTH: .09,
    PIT: .12,
    PIT_REDUCE: 300,                                     // kwota zmniejszająca (PIT-2)
    KUP: { local: 250, commute: 300 },
    NIGHT: .20,
    YOUNG_LIMIT: 85528,
    PPK_EMP: .02, PPK_ER: .015,
  };
  const minWage = y => TAX.MIN_WAGE[y] || TAX.MIN_WAGE[Math.max(...Object.keys(TAX.MIN_WAGE).map(Number))];

  /*  in: {
   *    month:'YYYY-MM', rate, hours (всего отработано по графику, без сверхурочных),
   *    nightHours (из них в 22–6), urlopHours, ovt50, ovt100, ovtNight (сверхурочные в 22–6),
   *    urlopVar (средняя переменная часть за час отпуска, zł/ч — см. urlopAverage),
   *    absences (пропуски за месяц: премия ×1,25 / ×0,8 / 0 — см. premiumFactor),
   *    dark (Dodatek DARK, брутто), ekw (эквиваленты за одежду/стирку — без налога),
   *    deduct (удержания из «на руки»: benefit и т.п.), ytd (брутто с начала года до месяца — для лимита ulga),
   *    bonus (премия за пики, брутто), extra (прочие доплаты брутто),
   *    young:true|false, kup:'local'|'commute', pit2:true|false, ppk:true|false,
   *    nightBasis:'min'|'own'
   *  }  */
  function salary(inp) {
    const mk = inp.month, y = +mk.slice(0, 4);
    const rate = Math.max(0, +inp.rate || 0);
    const num = k => Math.max(0, +inp[k] || 0);
    const hours = num('hours'), nightH = Math.min(num('nightHours'), hours);
    const urlopH = num('urlopHours'), o50 = num('ovt50'), o100 = num('ovt100');
    const oNight = Math.min(num('ovtNight'), o50 + o100);
    const nom = nominalHours(mk);
    const minHourly = nom ? minWage(y) / nom : 0;
    const nightRate = TAX.NIGHT * (inp.nightBasis === 'own' ? rate : minHourly);
    // Отпускные = ставка + средняя переменная часть (ночные, сверхурочные, премии)
    // за 3 предыдущих месяца в пересчёте на час. Поэтому час отпуска обычно дороже.
    const urlopVar = Math.max(0, +inp.urlopVar || 0);
    const urlopRate = rate + urlopVar;

    const parts = {
      base: r2(hours * rate),
      urlop: r2(urlopH * urlopRate),
      night: r2((nightH + oNight) * nightRate),
      ovt50: r2(o50 * rate * 1.5),
      ovt100: r2(o100 * rate * 2),
      bonus: r2(Math.max(0, +inp.bonus || 0) * premiumFactor(inp.absences)),
      dark: r2(Math.max(0, +inp.dark || 0)),
      extra: r2(Math.max(0, +inp.extra || 0)),
    };
    const brutto = r2(Object.values(parts).reduce((s, v) => s + v, 0));

    const zusParts = { em: r2(brutto * TAX.ZUS.em), rent: r2(brutto * TAX.ZUS.rent), chor: r2(brutto * TAX.ZUS.chor) };
    const zus = r2(zusParts.em + zusParts.rent + zusParts.chor);
    const health = r2((brutto - zus) * TAX.HEALTH);
    const ppkEmp = inp.ppk ? r2(brutto * TAX.PPK_EMP) : 0;
    const ppkEr = inp.ppk ? r2(brutto * TAX.PPK_ER) : 0;   // взнос работодателя — доход для PIT
    const kup = TAX.KUP[inp.kup === 'commute' ? 'commute' : 'local'];
    // Ulga dla młodych освобождает доход до 85 528 zł в год. Когда с начала года
    // набралось больше, PIT считается с той части, что вышла за лимит.
    const ytd = Math.max(0, +inp.ytd || 0);
    const exemptLeft = inp.young ? Math.max(0, TAX.YOUNG_LIMIT - ytd) : 0;
    const taxable = inp.young ? Math.max(0, brutto - exemptLeft) : brutto;
    const share = brutto > 0 ? taxable / brutto : 0;
    const pitBase = taxable > 0 ? Math.max(0, Math.round(taxable - zus * share - kup + ppkEr)) : 0;
    const pit = taxable > 0 ? Math.max(0, Math.round(pitBase * TAX.PIT - (inp.pit2 === false ? 0 : TAX.PIT_REDUCE))) : 0;
    const ekw = r2(Math.max(0, +inp.ekw || 0));            // эквиваленты: без ZUS и PIT
    const deduct = r2(Math.max(0, +inp.deduct || 0));
    const netto = r2(brutto - zus - health - pit - ppkEmp + ekw - deduct);

    return { month: mk, rate, nominal: nom, minHourly: r2(minHourly), nightRate: r2(nightRate),
             urlopVar: r2(urlopVar), urlopRate: r2(urlopRate),
             bonusBase: r2(Math.max(0, +inp.bonus || 0)), premiumFactor: premiumFactor(inp.absences),
             parts, brutto, zus, zusParts, health, ppkEmp, ppkEr, kup, pitBase, pit, ekw, deduct, netto,
             young: !!inp.young, taxable: r2(taxable), exemptLeft: r2(exemptLeft) };
  }

  // ── премия за обецность ───────────────────────────────────────────
  // Без пропусков премия ×1,25, с одним пропуском ×0,8, с двумя и больше
  // премии нет. absences не задан — множитель 1 (чистая премия).
  const ATTENDANCE = [1.25, 0.8];
  function premiumFactor(absences) {
    if (absences === undefined || absences === null || absences === '') return 1;
    const n = Math.max(0, Math.floor(+absences || 0));
    return n < ATTENDANCE.length ? ATTENDANCE[n] : 0;
  }

  // ── отпускные: средняя переменная часть за час ────────────────────
  // Kodeks pracy, rozporządzenie o urlopach (§ 9): składniki zmienne за 3 месяца
  // перед отпуском делятся на часы, реально отработанные в этих месяцах.
  // months: [{ var: сумма переменных выплат zł, hours: отработанные часы }]
  function urlopAverage(months) {
    const ok = (months || []).filter(m => m && m.hours > 0);
    const V = ok.reduce((s, m) => s + (+m.var || 0), 0), H = ok.reduce((s, m) => s + m.hours, 0);
    return { perHour: H > 0 ? r2(V / H) : 0, months: ok.length, var: r2(V), hours: H };
  }
  // Переменная часть одного месяца из результата salary(): премия, сверхурочные
  // целиком, ночные и Dodatek DARK (так считает AutoDoc).
  const variableOf = (res, inp) => ({
    var: r2(res.parts.night + res.parts.ovt50 + res.parts.ovt100 + res.parts.bonus + res.parts.dark + res.parts.extra),
    hours: (+inp.hours || 0) + (+inp.ovt50 || 0) + (+inp.ovt100 || 0),
  });

  // Окно для отпускных: 3 месяца по дате выплаты. Зарплату платят до 10-го
  // следующего месяца, поэтому для отпуска в месяце W берутся месяцы работы
  // W-4, W-3, W-2 (выплаченные в W-3…W-1).
  const urlopWindow = W => [4, 3, 2].map(k => addMonths(W, -k));

  // ── возраст и ulga dla młodych ────────────────────────────────────
  // Ulga действует на доход, полученный до дня 26-летия включительно.
  function youngStatus(birthISO, mk) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(birthISO || ''))) return { status: 'unknown' };
    const [by, bm, bd] = birthISO.split('-').map(Number);
    const b26 = iso(new Date(by + 26, bm - 1, bd));
    const first = `${mk}-01`, last = `${mk}-${pad(daysInMonth(mk))}`;
    const [y, m] = mk.split('-').map(Number);
    let age = y - by; if (m < bm || (m === bm && daysInMonth(mk) < bd)) age--;
    if (b26 > last) return { status: 'yes', age, b26 };
    if (b26 < first) return { status: 'no', age, b26 };
    return { status: 'partial', age, b26 };            // 26 исполняется в этом месяце
  }

  // ── кошелёк: цикл до 10-го ────────────────────────────────────────
  // До 10-го числа виден расчёт за прошлый месяц (его выплачивают до 10-го).
  // С 10-го — расчёт за текущий месяц, он висит до 10-го следующего.
  const PAY_DAY = 10;
  function walletMonth(now = new Date()) {
    const mk = monthKey(now);
    return now.getDate() >= PAY_DAY ? mk : addMonths(mk, -1);
  }
  const walletUntil = mk => `${addMonths(mk, 1)}-${pad(PAY_DAY)}`;
  function daysLeft(untilISO, now = new Date()) {
    const [y, m, d] = untilISO.split('-').map(Number);
    return Math.max(0, Math.ceil((new Date(y, m - 1, d) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5));
  }

  const Core = {
    ST, r2, rateFor, calc, monthAgg, monthBonus, monthSnapshot,
    iso, monthKey, addDays, addMonths, hmMin, daysInMonth,
    SHIFT_CUT_H, shiftDayFrom, shiftToday, shiftYest, shiftBounds, shiftDayOf, minutesBetween, nightMinutes,
    parseSpan, monthPlan, easter, plHolidays, nominalHours,
    TAX, minWage, salary, ATTENDANCE, premiumFactor, urlopAverage, variableOf, urlopWindow, youngStatus, PAY_DAY, walletMonth, walletUntil, daysLeft,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
