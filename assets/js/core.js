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
    // Дополнительные станции (Regulamin § 6, пункты f, j, k, m, o, r, s). extra — по
    // умолчанию под кнопкой «Дополнительно»; свои 3–5 станций человек выбирает сам.
    // hourly — ставка не за штуку, а за час:
    // премия = часы × ставка ступени (Załadunek, Aneks 2/2026 с 01.06.2026).
    pi:  { name: 'PI',  full: 'Picking Inventory',  norm: 160, maxP: 282, col: '#2EC4B6', extra: true,
           tr: [[0,160,0],[161,178,.08],[179,189,.10],[190,202,.12],[203,222,.14],[223,243,.16],[244,281,.19],[282,999,.21]] },
    op:  { name: 'OP',  full: 'Oversize Placement', norm: 144, maxP: 253, col: '#E85D75', extra: true,
           tr: [[0,144,0],[145,160,.07],[161,170,.08],[171,181,.11],[182,200,.13],[201,218,.15],[219,252,.17],[253,999,.19]] },
    hr:  { name: 'HR',  full: 'Direct Receive HR',  norm: 140, maxP: 256, col: '#7FB241', extra: true,
           tr: [[0,140,0],[141,158,.03],[159,176,.061],[177,190,.076],[191,205,.096],[206,230,.11],[231,255,.132],[256,999,.146]] },
    dp:  { name: 'DP',  full: 'Disassembly Pallet', norm: 165, maxP: 290, col: '#5BB8F2', extra: true,
           tr: [[0,165,0],[166,183,.03],[184,196,.05],[197,208,.07],[209,229,.09],[230,251,.11],[252,289,.13],[290,999,.15]] },
    rod: { name: 'ROD', full: 'Receiving On Demand', norm: 165, maxP: 290, col: '#F29BC9', extra: true,
           tr: [[0,165,0],[166,183,.07],[184,196,.09],[197,208,.11],[209,229,.13],[230,250,.15],[251,289,.17],[290,999,.19]] },
    pod: { name: 'POD', full: 'Putwall On Demand', norm: 212, maxP: 372, col: '#A3D977', extra: true,
           tr: [[0,212,0],[213,235,.03],[236,251,.05],[252,267,.07],[268,295,.08],[296,322,.09],[323,371,.11],[372,999,.12]] },
    zk:  { name: 'ZK',  full: 'Załadunek kontenerów', norm: 100, maxP: 161, col: '#C98B5A', extra: true, hourly: true,
           tr: [[0,100,0],[101,110,8.92],[111,115,11.90],[116,130,13.69],[131,145,16.07],[146,160,17.85],[161,999,20.83]] },
  };

  const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

  function rateFor(st, pph) {
    const tr = ST[st].tr;
    for (const [lo, hi, r] of tr) if (pph >= lo && pph <= hi) return r;
    return tr[tr.length - 1][2];
  }

  // Премия по одной записи (для предпросмотра). Ставка — по округлённому темпу.
  // У почасовых станций премия = часы × ставка, штуки сверх нормы только для справки.
  function calc(st, peaks, hours) {
    const pph = hours > 0 ? peaks / hours : 0;
    const norm = Math.round(ST[st].norm * hours);
    const above = Math.max(0, peaks - norm);
    const rate = rateFor(st, Math.round(pph));
    return { pph, norm, above, rate, bonus: ST[st].hourly ? hours * rate : above * rate };
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
   *    bonus (премия за пики, брутто), indirect (премия Indirect из pasku — входит в премию,
 *    множитель обецности на неё не действует),
 *    extra (прочие доплаты брутто),
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
      // премия = пики × обецность + Indirect (сумма из pasku как есть)
      bonus: r2(Math.max(0, +inp.bonus || 0) * premiumFactor(inp.absences) + Math.max(0, +inp.indirect || 0)),
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
             bonusPeaks: r2(Math.max(0, +inp.bonus || 0) * premiumFactor(inp.absences)), indirect: r2(Math.max(0, +inp.indirect || 0)),
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

  // ── проверка odcinka ──────────────────────────────────────────────
  // slips — все odcinki одного месяца работы (główna + korekty), разобранные
  // slip.js: { kind, f: {brutto, zus, health, …}, ovt, other }.
  // ctx: { young: true|false|null, team, rate, tracker: { bonus, bonusBase, pf, indirect,
  //        hours, urlopHours, netto, has } } — что насчитал сам трекер.
  // Возвращает пункты проверки (ok | info | warn | bad) и общий итог.
  const near = (a, b, tol = .02) => Math.abs(a - b) <= tol + 1e-9;
  const isHoursLabel = l => /^ilo[sś][cć]/i.test(l);
  function slipTaxes(s, ctx, pre) {
    const f = s.f, out = [], add = (level, title, text) => out.push({ level, title: pre + title, text });
    const brutto = f.brutto || 0, zusBase = f.zusBase ?? brutto;
    // ZUS работника: 9,76% + 1,5% + 2,45% от podstawy ZUS, каждая часть округляется
    if (f.zus !== undefined) {
      const exp = r2(r2(zusBase * TAX.ZUS.em) + r2(zusBase * TAX.ZUS.rent) + r2(zusBase * TAX.ZUS.chor));
      near(f.zus, exp, .03) ? add('ok', 'ZUS 13,71%', `${fmt(f.zus)} zł с ${fmt(zusBase)} zł — верно`)
        : add('bad', 'ZUS 13,71%', `удержано ${fmt(f.zus)} zł, по ставкам должно быть ${fmt(exp)} zł`);
    }
    const zus = f.zus || 0;
    if (f.health !== undefined) {
      const hb = f.healthBase ?? r2(zusBase - zus), exp = r2(hb * TAX.HEALTH);
      near(f.health, exp, .03) ? add('ok', 'Składka zdrowotna 9%', `${fmt(f.health)} zł с ${fmt(hb)} zł — верно`)
        : add('bad', 'Składka zdrowotna 9%', `удержано ${fmt(f.health)} zł, должно быть ${fmt(exp)} zł`);
    }
    // PIT на odcinku может не печататься (при uldze его нет) — выводим из остатка
    const known = r2(brutto - zus - (f.health || 0) - (f.benefit || 0) - (f.ppk || 0) + (f.ekw || 0));
    const pit = f.pit !== undefined ? f.pit : r2(known - (f.netto || 0));
    if (f.pit !== undefined) {
      const exp = r2(known - f.pit);
      near(f.netto, exp, .03) ? add('ok', 'Арифметика «на руки»', `брутто − ZUS − здоровье − PIT − удержания + эквиваленты = ${fmt(f.netto)} zł`)
        : add('bad', 'Арифметика «на руки»', `по строкам odcinka выходит ${fmt(exp)} zł, а к выплате ${fmt(f.netto)} zł`);
    } else if (Math.abs(pit - Math.round(pit)) > .02) {
      add('warn', 'Удержание без названия', `из «на руки» ушло ещё ${fmt(pit)} zł, которых нет в строках odcinka. Спроси в kadrach, что это.`);
    }
    const pitR = Math.round(pit);
    const pct = (f.pitPct || TAX.PIT * 100) / 100;
    const pb = f.pitBase || 0;
    if (pitR <= 0) {
      ctx.young === false ? add('warn', 'PIT не удержан', 'Так бывает при uldze dla młodych (до 26 лет). Тебе 26+ — уточни в kadrach, иначе налог доплатишь в PIT-37.')
        : add(ctx.young ? 'ok' : 'info', 'PIT 0 zł', 'ulga dla młodych: доход до 26 лет без налога (до 85 528 zł в год)');
    } else if (pb) {
      const with2 = Math.max(0, Math.round(pb * pct - TAX.PIT_REDUCE)), without = Math.round(pb * pct);
      if (Math.abs(pitR - with2) <= 1) add('ok', 'PIT', `${fmt(pitR)} zł = ${Math.round(pct * 100)}% от ${fmt(pb)} − 300 (PIT-2 учтён)`);
      else if (Math.abs(pitR - without) <= 1) add('warn', 'PIT без PIT-2', `${fmt(pitR)} zł = ${Math.round(pct * 100)}% от ${fmt(pb)} без вычета 300 zł. Подай PIT-2 в kadry — будешь получать на 300 zł больше в месяц.`);
      else if (ctx.young) add('bad', 'PIT удержан', `${fmt(pitR)} zł, хотя по возрасту положена ulga dla młodych. Проверь дату рождения в kadrach.`);
      else add('warn', 'PIT', `${fmt(pitR)} zł не сходится с ${Math.round(pct * 100)}% от ${fmt(pb)} − 300 (${fmt(with2)} zł)`);
    }
    return { items: out, pit: Math.max(0, pitR) };
  }

  function slipCheck(slips, ctx = {}) {
    const items = [], add = (level, title, text) => items.push({ level, title, text });
    const main = slips.find(s => s.kind === 'main') || slips[0];
    const f = (main && main.f) || {};
    const mk = main && main.month, y = mk ? +mk.slice(0, 4) : 2026;
    const rate = f.rate || 0;
    if (f.hours !== undefined && rate && f.base !== undefined) {
      const exp = r2(f.hours * rate);
      near(f.base, exp) ? add('ok', 'Основные часы', `${fmt(f.hours)} ч × ${fmt(rate)} zł = ${fmt(f.base)} zł`)
        : add('bad', 'Основные часы', `${fmt(f.hours)} ч × ${fmt(rate)} zł = ${fmt(exp)} zł, а начислено ${fmt(f.base)} zł`);
    }
    if (f.nightHours && f.night !== undefined && mk) {
      const nom = nominalHours(mk), exp = r2(f.nightHours * TAX.NIGHT * minWage(y) / nom), own = r2(f.nightHours * TAX.NIGHT * rate);
      if (f.night + .05 >= exp) add('ok', 'Ночная доплата 20%', `${fmt(f.nightHours)} ч × ${fmt(r2(TAX.NIGHT * minWage(y) / nom))} zł = ${fmt(f.night)} zł${near(f.night, own, .05) && !near(own, exp, .05) ? ' (от твоей ставки)' : ''}`);
      else add('bad', 'Ночная доплата 20%', `за ${fmt(f.nightHours)} ч положено ${fmt(exp)} zł (20% от минимальной часовой), начислено ${fmt(f.night)} zł`);
    }
    for (const [pct, o] of Object.entries((main && main.ovt) || {})) {
      if (!o.hours || o.amount === undefined || !rate) continue;
      const exp = r2(o.hours * rate * (pct === '50' ? 1.5 : 2));
      o.amount + .02 >= exp ? add('ok', `Сверхурочные +${pct}%`, `${fmt(o.hours)} ч × ${fmt(rate)} × ${pct === '50' ? '1,5' : '2'} = ${fmt(o.amount)} zł`)
        : add('bad', `Сверхурочные +${pct}%`, `за ${fmt(o.hours)} ч положено ${fmt(exp)} zł, начислено ${fmt(o.amount)} zł`);
    }
    if (f.urlopHours && f.urlop !== undefined) {
      const ph = r2(f.urlop / f.urlopHours);
      ph + .01 >= rate ? add('ok', 'Отпуск', `${fmt(f.urlopHours)} ч по ${fmt(ph)} zł: ставка ${fmt(rate)} + ${fmt(r2(ph - rate))} средних доплат`)
        : add('bad', 'Отпуск', `час отпуска ${fmt(ph)} zł — меньше ставки ${fmt(rate)} zł`);
    }
    // Брутто = сумма начислений. Незнакомые статьи (siła wyższa, chorobowe) тоже деньги.
    if (main && f.brutto !== undefined) {
      const money = ['base', 'bonus', 'night', 'dark', 'urlop'].reduce((s, k) => s + (f[k] || 0), 0)
        + (f.ovtTotal ?? Object.values(main.ovt || {}).reduce((s, o) => s + (o.amount || 0), 0))
        + main.other.filter(o => !isHoursLabel(o.label)).reduce((s, o) => s + o.value, 0);
      const extra = main.other.filter(o => !isHoursLabel(o.label)).map(o => o.label);
      if (!near(r2(money), f.brutto, .05)) add('warn', 'Брутто', `статьи дают ${fmt(r2(money))} zł, а брутто ${fmt(f.brutto)} zł — в odcinku есть строки, которые трекер не узнал`);
      else if (extra.length) add('info', 'Другие начисления', extra.join(', '));
    }
    let pitTotal = 0;
    slips.forEach(s => { const r = slipTaxes(s, ctx, s.kind === 'kor' ? 'Korekta: ' : ''); items.push(...r.items); pitTotal += r.pit; });

    // сравнение с тем, что насчитал трекер
    const sum = k => r2(slips.reduce((s, x) => s + (x.f[k] || 0), 0));
    const bonus = sum('bonus'), netto = sum('netto'), brutto = sum('brutto');
    const t = ctx.tracker || {};
    // премия трекера = пики × обецность + Indirect
    const how = () => [t.bonusBase > 0 ? `пики ${fmt(t.bonusBase)} × ${String(t.pf).replace('.', ',')}` : '', t.indirect > 0 ? `Indirect ${fmt(t.indirect)}` : ''].filter(Boolean).join(' + ');
    if (t.bonus > 0) {
      const diff = r2(bonus - t.bonus), tol = Math.max(1, t.bonus * .005);
      if (diff >= -tol) add('ok', 'Премия', `${fmt(bonus)} zł, трекер насчитал ${fmt(t.bonus)} zł (${how()})${diff > tol ? `, выплатили на ${fmt(diff)} zł больше` : ''}`);
      else add('bad', 'Премия недоплачена', `в odcinku ${fmt(bonus)} zł, по трекеру ${fmt(t.bonus)} zł (${how()}). Не хватает ${fmt(-diff)} zł — спроси у лидера или жди korektę.`);
    } else if (bonus) add('info', 'Премия', `${fmt(bonus)} zł. В трекере нет пиков и Indirect за этот месяц — сравнить не с чем.`);
    if (t.has && f.hours !== undefined) {
      const sh = r2((f.hours || 0) + (f.urlopHours || 0)), th = r2((t.hours || 0) + (t.urlopHours || 0));
      Math.abs(sh - th) <= 1 ? add('ok', 'Часы по графику', `${fmt(sh)} ч, как в графике трекера`)
        : add('warn', 'Часы по графику', `в odcinku ${fmt(sh)} ч (работа + отпуск), по графику трекера ${fmt(th)} ч. Проверь отметки отпуска и пропусков в календаре.`);
    }
    if (ctx.team === 'dark' && main && main.kind === 'main') {
      if (!f.dark) add('warn', 'Dodatek DARK', 'в odcinku его нет. Если весь месяц ты в ночной смене — спроси в kadrach.');
      else if (f.dark < 300) add('info', 'Dodatek DARK', `${fmt(f.dark)} из 300 zł — так бывает за неполный месяц смен`);
    }
    if (t.netto > 0) add('info', 'Кошелёк трекера', `насчитал ${fmt(t.netto)} zł на руки, по odcinku ${fmt(netto)} zł (${netto >= t.netto ? '+' : '−'}${fmt(Math.abs(r2(netto - t.netto)))})`);

    const level = items.some(i => i.level === 'bad') ? 'bad' : items.some(i => i.level === 'warn') ? 'warn' : 'ok';
    // что можно перенести в настройки кошелька
    const profile = {};
    if (rate) profile.rate = rate;
    if (f.ekw !== undefined) profile.ekw = f.ekw;
    profile.deduct = f.benefit || 0;
    profile.ppk = !!f.ppk;
    if (pitTotal === 0 && (f.pitBase || 0) > 0) profile.youngLikely = true;
    else if (f.pitBase && f.zusBase !== undefined) {
      const kup = Math.round((f.zusBase - (f.zus || 0)) - f.pitBase);
      if (Math.abs(kup - 250) <= 1) profile.kup = 'local'; else if (Math.abs(kup - 300) <= 1) profile.kup = 'commute';
    }
    return { level, items, netto, brutto, bonus, pit: pitTotal, profile };
  }
  const fmt = n => (Number(n) || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  // ── дата зарплаты ────────────────────────────────────────────────
  // Зарплату за месяц W платят до 10-го числа месяца W+1. Выпадает 10-е на
  // выходной или праздник — платят в последний рабочий день перед ним. Если
  // накануне тоже рабочий день и это не раньше 8-го, деньги чаще приходят
  // накануне: 80% — за день до срока, 100% — в срок. Так говорит опыт людей;
  // reports (даты от всех, кто отметил, когда пришли деньги) уточняют правило.
  const isWorkday = day => { const [y, m, d] = day.split('-').map(Number), w = new Date(y, m - 1, d).getDay(); return w > 0 && w < 6 && !plHolidays(y).has(day); };
  const prevWorkday = day => { let d = addDays(day, -1); while (!isWorkday(d)) d = addDays(d, -1); return d; };
  const workdaysBetween = (a, b) => { let n = 0, d = a; while (d < b) { d = addDays(d, 1); if (isWorkday(d)) n++; } return n; };
  function payDeadline(W) {
    let D = `${addMonths(W, 1)}-${pad(PAY_DAY)}`;
    while (!isWorkday(D)) D = addDays(D, -1);
    return D;
  }
  const payPrior = D => { const p = prevWorkday(D); return +p.slice(8) >= 8 ? { 1: .8, 0: .2 } : { 0: 1 }; };
  // reports: { 'YYYY-MM' (месяц работы): { 'YYYY-MM-DD': сколько человек } }
  function payday(W, reports = {}) {
    const D = payDeadline(W);
    const got = reports[W] || {};
    const top = Object.entries(got).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    // опыт прошлых месяцев: на сколько рабочих дней раньше срока пришли деньги
    const seen = {}; let months = 0;
    for (const [m, days] of Object.entries(reports)) {
      if (m === W) continue;
      const best = Object.entries(days).sort((a, b) => b[1] - a[1])[0];
      if (!best) continue;
      const Dm = payDeadline(m);
      if (best[0] > Dm) continue;                         // отметили позже срока — это не день прихода
      const k = workdaysBetween(best[0], Dm);
      if (k > 3) continue;
      seen[k] = (seen[k] || 0) + 1; months++;
    }
    const prior = payPrior(D), W0 = 2, dist = {};
    new Set([...Object.keys(prior), ...Object.keys(seen)]).forEach(k => { dist[k] = (W0 * (prior[k] || 0) + (seen[k] || 0)) / (W0 + months); });
    let cum = 0;
    const days = Object.keys(dist).map(Number).sort((a, b) => b - a).map(k => {
      let d = D; for (let i = 0; i < k; i++) d = prevWorkday(d);
      return { day: d, p: dist[k] };
    }).filter(x => x.day.slice(0, 7) === addMonths(W, 1) && x.p >= .05)
      .map(x => { cum += x.p; return { day: x.day, p: Math.min(1, Math.round(cum * 100) / 100) }; });
    if (days.length) days[days.length - 1].p = 1;
    return { month: W, deadline: D, days, src: months ? 'data' : 'rule', months,
             actual: top ? top[0] : null, actualN: top ? top[1] : 0 };
  }

  const Core = {
    ST, r2, rateFor, calc, monthAgg, monthBonus, monthSnapshot,
    slipCheck, isWorkday, payDeadline, payday,
    iso, monthKey, addDays, addMonths, hmMin, daysInMonth,
    SHIFT_CUT_H, shiftDayFrom, shiftToday, shiftYest, shiftBounds, shiftDayOf, minutesBetween, nightMinutes,
    parseSpan, monthPlan, easter, plHolidays, nominalHours,
    TAX, minWage, salary, ATTENDANCE, premiumFactor, urlopAverage, variableOf, urlopWindow, youngStatus, PAY_DAY, walletMonth, walletUntil, daysLeft,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  else root.Core = Core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
