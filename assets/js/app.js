/* AutoDoc Tracker — интерфейс Mini App.
 * Логика денег и дат — в core.js, здесь только состояние, сеть и отрисовка.
 * Никаких inline-обработчиков: всё через data-act и делегирование (строгая CSP).
 */
(() => {
'use strict';

const C = window.Core, CFG = window.APP_CONFIG;
const APP_VERSION = '20261027.1909';                                  // ставит tools/bump_version.py
// Скрипт Telegram создаёт WebApp и в обычном браузере — тогда это пустышка
// версии 6.0. Работаем с ним только внутри Telegram, где есть подписанный initData.
const TG_RAW = window.Telegram && window.Telegram.WebApp;
const IN_TG = !!(TG_RAW && TG_RAW.initData);
const TG = IN_TG ? TG_RAW : null;
const tgv = v => !!(TG && TG.isVersionAtLeast && TG.isVersionAtLeast(v));
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (Number(n) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = n => Math.round(Number(n) || 0).toLocaleString('ru-RU');
const h1 = n => { const v = Math.round((Number(n) || 0) * 10) / 10; return v.toLocaleString('ru-RU'); };
const fmtD = s => { if (!s) return ''; const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`; };
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const mLabel = mk => { const [y, m] = mk.split('-').map(Number); return `${cap(MONTHS[m - 1])} ${y}`; };
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const hf = () => tgv('6.1') ? TG.HapticFeedback : null;
const haptic = {
  tap: () => { try { hf()?.impactOccurred('light'); } catch {} },
  ok: () => { try { hf()?.notificationOccurred('success'); } catch {} },
  err: () => { try { hf()?.notificationOccurred('error'); } catch {} },
  pick: () => { try { hf()?.selectionChanged(); } catch {} },
};

// ═════════════════════ ХРАНЕНИЕ ═════════════════════
const KEY = 'adx2', LEGACY = 'ad_db', SCHED_KEY = 'adx_sched';
const RE_DAY = /^\d{4}-\d{2}-\d{2}$/, RE_MK = /^\d{4}-\d{2}$/, RE_HM = /^\d{2}:\d{2}$/;
const fin = (v, lo, hi, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const str = (v, max) => String(v ?? '').slice(0, max);

// Свои станции на вкладке «Пики»: 3–5 штук, остальные — под «Дополнительно».
const MAIN_ST = ['os', 'pa', 'sio', 'pc', 'plc'], MAIN_MIN = 3, MAIN_MAX = 5;
function cleanMain(v) {
  const a = [...new Set((Array.isArray(v) ? v : []).filter(k => C.ST[k]))].slice(0, MAIN_MAX);
  return a.length >= MAIN_MIN ? a : MAIN_ST.slice();
}

function defaults() {
  return {
    v: 2, uid: '', name: '', emoji: '👷', photo: '', team: 'dark', group: 'A', teamAt: 0,
    ws: 'mon', theme: 'auto', consent: null, mainSt: MAIN_ST.slice(),
    entries: [], archive: {}, notes: [], urlop: {}, absent: {}, ovt: [], slips: [], indirect: [],
    profile: { birth: '', birthOk: false, rateMode: '33.00', rate: 33.00, kup: 'local', pit2: true, ppk: false, nightBasis: 'min', extra: 0,
      dark: 300, ekw: 22.95, deduct: 0 },
    wallet: { cur: null, draft: null, hist: [] },
    notify: { h2: true, h1: true, peaks: true, pay: true },
  };
}

// Всё, что пришло из localStorage или облака, — недоверенные данные:
// проверяем типы и диапазоны, лишнее выбрасываем.
function sanitize(raw) {
  const d = defaults(); if (!raw || typeof raw !== 'object') return d;
  d.uid = str(raw.uid, 20).replace(/\D/g, '');
  d.name = str(raw.name, 40); d.emoji = str(raw.emoji, 8) || '👷';
  d.photo = /^https:\/\/([a-z0-9-]+\.)*(t\.me|telegram\.org)\//i.test(raw.photo || '') ? str(raw.photo, 300) : '';
  d.team = ['dark', 'orange', 'green'].includes(raw.team) ? raw.team : 'dark';
  d.group = /^[A-F]$/.test(raw.group) ? raw.group : 'A';
  d.teamAt = fin(raw.teamAt, 0, 9e15);
  d.ws = raw.ws === 'sun' ? 'sun' : 'mon';
  d.mainSt = cleanMain(raw.mainSt);
  d.theme = ['auto', 'dark', 'light'].includes(raw.theme) ? raw.theme : 'auto';
  d.consent = raw.consent && typeof raw.consent.v === 'string' ? { v: str(raw.consent.v, 10), at: str(raw.consent.at, 40) } : null;
  d.entries = (Array.isArray(raw.entries) ? raw.entries : []).filter(e => e && C.ST[e.station] && RE_DAY.test(e.shiftDate)).slice(-2000).map(e => ({
    id: fin(e.id, 0, 9e15, Date.now()), station: e.station, shiftDate: e.shiftDate,
    peaks: Math.round(fin(e.peaks, 0, 100000)), hours: fin(e.hours, 0, 24),
    from: RE_HM.test(e.from) ? e.from : '', to: RE_HM.test(e.to) ? e.to : '', addedAt: str(e.addedAt, 8),
  })).filter(e => e.hours > 0);
  for (const [k, v] of Object.entries(raw.archive || {})) if (RE_MK.test(k) && v && typeof v === 'object')
    d.archive[k] = { bonus: fin(v.bonus, 0, 1e6), peaks: fin(v.peaks, 0, 1e7), hours: fin(v.hours, 0, 1e4), shifts: fin(v.shifts, 0, 62), ppc: fin(v.ppc, 0, 1e4) };
  d.notes = (Array.isArray(raw.notes) ? raw.notes : []).slice(-200).map(n => ({ id: fin(n.id, 0, 9e15), text: str(n.text, 500), at: str(n.at || n.date, 40) })).filter(n => n.text);
  for (const key of ['urlop', 'absent'])
    for (const [k, v] of Object.entries(raw[key] || {})) if (RE_MK.test(k) && v && typeof v === 'object') {
      const days = {}; Object.keys(v).forEach(x => { const n = +x; if (n >= 1 && n <= 31) days[n] = 1; }); d[key][k] = days;
    }
  d.ovt = (Array.isArray(raw.ovt) ? raw.ovt : []).filter(o => o && RE_DAY.test(o.date)).slice(-500).map(o => ({
    id: fin(o.id, 0, 9e15, Date.now()), date: o.date, hours: fin(o.hours, 0, 16), pct: o.pct === 50 ? 50 : 100, night: !!o.night,
  })).filter(o => o.hours > 0);
  d.slips = (Array.isArray(raw.slips) ? raw.slips : []).map(cleanSlip).filter(Boolean).slice(-36);
  const indSeen = new Set();
  d.indirect = (Array.isArray(raw.indirect) ? raw.indirect : []).filter(x => x && RE_MK.test(x.month)).reverse()
    .filter(x => !indSeen.has(x.month) && indSeen.add(x.month))
    .map(x => ({ month: x.month, amount: fin(x.amount, 0, 20000), hours: fin(x.hours, 0, 400), at: str(x.at, 40) }))
    .filter(x => x.amount > 0 && x.hours > 0).reverse().slice(-24);
  const p = raw.profile || {};
  d.profile = {
    birth: RE_DAY.test(p.birth) ? p.birth : '', birthOk: !!p.birthOk && RE_DAY.test(p.birth),
    // старые пресеты 32,00 и 33,50 переносим в «свою ставку», чтобы не потерять число
    rateMode: ['31.40', '33.00', '35.00', 'own'].includes(p.rateMode) ? p.rateMode : ['32.00', '33.50'].includes(p.rateMode) ? 'own' : '33.00',
    rate: ['32.00', '33.50'].includes(p.rateMode) ? Number(p.rateMode) : fin(p.rate, 0, 500, 33.00), kup: p.kup === 'commute' ? 'commute' : 'local',
    pit2: p.pit2 !== false, ppk: !!p.ppk, nightBasis: p.nightBasis === 'own' ? 'own' : 'min', extra: fin(p.extra, 0, 1e5),
    dark: fin(p.dark ?? 300, 0, 5000), ekw: fin(p.ekw ?? 22.95, 0, 1000), deduct: fin(p.deduct, 0, 5000),
  };
  const w = raw.wallet || {};
  const cleanInp = i => i && RE_MK.test(i.month) ? {
    month: i.month, hours: fin(i.hours, 0, 744), nightHours: fin(i.nightHours, 0, 744), urlopHours: fin(i.urlopHours, 0, 744),
    ovt50: fin(i.ovt50, 0, 300), ovt100: fin(i.ovt100, 0, 300), ovtNight: fin(i.ovtNight, 0, 300),
    ...(Number.isFinite(+i.urlopVar) && i.urlopVar !== null && i.urlopVar !== '' ? { urlopVar: fin(i.urlopVar, 0, 200) } : {}),
    ...(Number.isFinite(+i.ytd) && i.ytd !== null && i.ytd !== '' ? { ytd: fin(i.ytd, 0, 1e6) } : {}),
    ...(Number.isFinite(+i.absences) && i.absences !== null && i.absences !== '' ? { absences: Math.round(fin(i.absences, 0, 31)) } : {}),
  } : null;
  d.wallet.cur = w.cur && cleanInp(w.cur.inp) ? { month: w.cur.inp.month, inp: cleanInp(w.cur.inp), savedAt: str(w.cur.savedAt, 40) } : null;
  d.wallet.draft = cleanInp(w.draft);
  d.wallet.hist = (Array.isArray(w.hist) ? w.hist : []).filter(h => h && RE_MK.test(h.month)).slice(-36).map(h => ({
    month: h.month, netto: fin(h.netto, 0, 1e6), brutto: fin(h.brutto, 0, 1e6), bonus: fin(h.bonus, 0, 1e6), savedAt: str(h.savedAt, 40),
    ...(Number.isFinite(+h.var) && +h.hours > 0 ? { var: fin(h.var, 0, 1e5), hours: fin(h.hours, 0, 744) } : {}),
    ...(h.slip ? { slip: true } : {}),
    ...(h.calc && Number.isFinite(+h.calc.netto) ? { calc: { netto: fin(h.calc.netto, 0, 1e6), brutto: fin(h.calc.brutto, 0, 1e6), bonus: fin(h.calc.bonus, 0, 1e6) } } : {}),
  }));
  if (Number.isFinite(+w.lastBonus)) d.wallet.lastBonus = fin(w.lastBonus, 0, 1e6);
  const nt = raw.notify || {};
  d.notify = { h2: (nt.h2 ?? nt.h12) !== false, h1: nt.h1 !== false, peaks: nt.peaks !== false, pay: nt.pay !== false };
  return d;
}

// Разобранный odcinek: только известные поля и числа (см. slip.js).
const SLIP_F = ['rate', 'hours', 'base', 'bonus', 'nightHours', 'night', 'dark', 'urlopHours', 'urlop', 'ovtTotal', 'brutto', 'zusBase',
  'zus', 'zusEm', 'zusRent', 'zusChor', 'pitBase', 'pitPct', 'healthBase', 'health', 'pit', 'benefit', 'ekw', 'ppk', 'transfer', 'netto'];
const numOr = (v, lo, hi) => v !== null && v !== '' && v !== undefined && Number.isFinite(+v) ? fin(v, lo, hi) : undefined;
function cleanSlip(s) {
  if (!s || !RE_MK.test(s.month)) return null;
  const f = {}; SLIP_F.forEach(k => { const v = numOr(s.f?.[k], -1e6, 1e6); if (v !== undefined) f[k] = v; });
  if (f.netto === undefined || f.brutto === undefined) return null;
  const ovt = {};
  [50, 100].forEach(p => { const o = s.ovt?.[p]; if (o && typeof o === 'object') ovt[p] = { hours: numOr(o.hours, 0, 744), amount: numOr(o.amount, 0, 1e6) }; });
  return { id: str(s.id, 40) || `${s.month}#${s.kind}`, month: s.month, list: str(s.list, 30), listName: str(s.listName, 40), kind: s.kind === 'kor' ? 'kor' : 'main',
    payDate: RE_DAY.test(s.payDate) ? s.payDate : '', gotOn: RE_DAY.test(s.gotOn) ? s.gotOn : '', f, ovt,
    other: (Array.isArray(s.other) ? s.other : []).slice(0, 20).map(o => ({ label: str(o && o.label, 40), value: fin(o && o.value, -1e6, 1e6) })).filter(o => o.label),
    at: str(s.at, 40) };
}

// Перенос из прежней версии трекера (ключ ad_db).
function fromLegacy(o) {
  if (!o || typeof o !== 'object') return null;
  return {
    uid: o.uid, name: o.name, emoji: o.emoji, photo: o.photoUrl, team: o.team, group: o.group,
    entries: o.entries, archive: o.archive, urlop: o.urlop,
    notes: (o.notes || []).map(n => ({ id: n.id, text: n.text, at: `${n.date || ''} ${n.time || ''}`.trim() })),
    ovt: (o.ovt || []).map(x => ({ id: x.id, date: x.date, hours: x.hours, pct: x.pct === 50 ? 50 : 100 })),
  };
}

let DB = defaults();
function loadLocal() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  if (!raw) { try { raw = fromLegacy(JSON.parse(localStorage.getItem(LEGACY) || 'null')); } catch {} }
  return raw ? sanitize(raw) : null;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch {}
  cloudBackupSoon();
}

// ── резервная копия в облаке Telegram (CloudStorage) ──
// Хранится у Telegram под аккаунтом пользователя: переживает смену телефона
// и очистку кэша. Значение ≤ 4096 символов — режем на куски.
const CS = tgv('6.9') && TG.CloudStorage ? TG.CloudStorage : null;
const csCall = (fn, ...a) => new Promise(res => { try { CS[fn](...a, (err, v) => res(err ? null : v)); } catch { res(null); } });
let _cbT = null;
function cloudBackupSoon() { if (!CS) return; clearTimeout(_cbT); _cbT = setTimeout(cloudBackup, 2500); }
async function cloudBackup() {
  const body = JSON.stringify({ ...DB, photo: '' });
  const parts = body.match(/[\s\S]{1,3800}/g) || [];
  if (parts.length > 60) return;                                   // разумный предел
  for (let i = 0; i < parts.length; i++) await csCall('setItem', 'b' + i, parts[i]);
  await csCall('setItem', 'bn', JSON.stringify({ n: parts.length, at: Date.now() }));
}
async function cloudRestore() {
  if (!CS) return null;
  const meta = await csCall('getItem', 'bn');
  let m; try { m = JSON.parse(meta || 'null'); } catch { return null; }
  if (!m || !(m.n > 0) || m.n > 60) return null;
  const keys = Array.from({ length: m.n }, (_, i) => 'b' + i);
  const got = await csCall('getItems', keys);
  if (!got) return null;
  try { return sanitize(JSON.parse(keys.map(k => got[k] || '').join(''))); } catch { return null; }
}

// ═════════════════════ СЕТЬ ═════════════════════
const STATE = { verified: false, uid: '', server: false, sched: null, tab: 'home', stack: [], curSt: 'os', calY: 0, calM: 0, rankMonth: null, schedTab: 'cal', indStats: null, indAt: 0, paydays: null, paydaysAt: 0, slipView: null, slipErr: '' };

async function api(action, payload = {}, timeout = 9000) {
  if (!IN_TG) throw new Error('no-tg');
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(`${CFG.SB_URL}/functions/v1/${CFG.API_FN}`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', apikey: CFG.SB_KEY, Authorization: 'Bearer ' + CFG.SB_KEY },
      body: JSON.stringify({ initData: TG.initData, action, ...payload }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'http ' + r.status); e.status = r.status; e.reason = j.reason || ''; throw e; }
    return j;
  } finally { clearTimeout(t); }
}

let _rankT = null;
function pushRank() {
  if (!STATE.verified) return;
  clearTimeout(_rankT);
  _rankT = setTimeout(() => {
    const m = C.monthKey(new Date()), s = C.monthSnapshot(DB.entries, m);
    // В рейтинг — вся премия, как на главной: пики × обецность + Indirect
    const indirect = indAmount(m), bonus = C.r2(s.bonus * C.premiumFactor(autoHours(m).absences) + indirect);
    api('rank', { row: { month: m, name: DB.name || 'Аноним', emoji: DB.emoji, team: DB.team, group: DB.group, bonus, indirect, peaks: s.peaks, hours: s.hours, shifts: s.shifts, ppc: s.ppc } }).catch(() => {});
  }, 1500);
}
let _profT = null;
function pushProfile() {
  if (!STATE.verified) return;
  clearTimeout(_profT);
  const today = C.iso(new Date());
  const off = [DB.urlop, DB.absent].flatMap(src => Object.entries(src).flatMap(([mk, days]) => Object.keys(days).map(d => `${mk}-${String(d).padStart(2, '0')}`))).filter(d => d >= today).sort().slice(0, 120);
  _profT = setTimeout(() => api('profile', { team: DB.team, group: DB.group, notify: DB.notify, name: DB.name, off }).catch(() => toast('Не удалось сохранить настройки оповещений — проверь связь')), 900);
}

// ═════════════════════ ЗАГРУЗЧИК ═════════════════════
function step(k, state, note) {
  const li = document.querySelector(`#boot-checks li[data-k="${k}"]`); if (!li) return;
  li.className = state; li.querySelector('small')?.remove();
  if (note) { const s = document.createElement('small'); s.textContent = note; li.appendChild(s); }
}

// Telegram кэширует файлы приложения. Если на сервере уже новая версия —
// перезагружаемся с новой меткой ?v=, тогда браузер берёт свежие файлы.
async function checkVersion() {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return false;
    const { v } = await r.json();
    if (!v || v === APP_VERSION) return false;
    if (sessionStorage.getItem('adx_reloaded') === v) return false;   // не уходим в цикл
    sessionStorage.setItem('adx_reloaded', v);
    location.replace(location.pathname + '?v=' + encodeURIComponent(v) + location.hash);
    return true;
  } catch { return false; }
}

async function boot() {
  if (await checkVersion()) return;
  const t0 = Date.now();
  applyTheme();

  // 1. Среда: открыто ли из Telegram и есть ли подписанные данные
  step('env', 'run');
  if (TG) {
    try { TG.ready(); TG.expand(); if (tgv('7.7')) TG.disableVerticalSwipes(); } catch {}
  }
  await sleep(250);
  step('env', IN_TG ? 'ok' : 'warn', IN_TG ? '' : 'браузер');

  // 2. Подпись: сервер проверяет HMAC initData и возвращает доверенный id
  step('sign', 'run');
  const hello = await verifyAccount();
  step('sign', STATE.verified ? 'ok' : 'warn', STATE.verified ? '' : VERIFY_TEXT[STATE.verifyState].short);

  // 3. Данные: локальная копия → облачная копия Telegram → чистый старт
  step('data', 'run');
  let local = loadLocal();
  if (!local || (!local.entries.length && !local.wallet.cur && !local.consent)) {
    const cloud = await cloudRestore();
    if (cloud) { local = cloud; toastLater('Данные восстановлены из облака Telegram'); }
  }
  DB = local || defaults();
  const u = TG?.initDataUnsafe?.user;
  if (u) {
    if (!DB.name) DB.name = [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 40);
    if (u.photo_url && /^https:\/\//.test(u.photo_url)) DB.photo = u.photo_url;
  }
  if (STATE.verified) {
    if (DB.uid && DB.uid !== STATE.uid) { DB = defaults(); DB.name = u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : ''; } // чужие данные на устройстве не показываем
    DB.uid = STATE.uid;
    const p = hello && hello.profile;
    if (p && p.team && (+new Date(p.team_at || 0)) > DB.teamAt) { DB.team = p.team; DB.group = p.grp || DB.group; DB.teamAt = +new Date(p.team_at); }
    if (p && p.notify) DB.notify = { ...DB.notify, ...p.notify };
  }
  pruneOldMonths();
  walletRollover();
  save();
  step('data', 'ok', DB.entries.length ? `${DB.entries.length} ${plural(DB.entries.length, 'запись', 'записи', 'записей')}` : '');

  // 4. График смен — один файл для приложения и бота
  step('sched', 'run');
  STATE.sched = await loadSchedule();
  step('sched', STATE.sched ? 'ok' : 'warn', STATE.sched ? '' : 'нет файла');

  if (!IN_TG) note('Открыто вне Telegram: всё считается, но рейтинг и оповещения работают только из бота.');
  else if (!STATE.verified) note('Сервер не подтвердил аккаунт. Пики и зарплата работают, рейтинг и оповещения — после переоткрытия из бота.');

  const wait = Math.max(0, 1900 - (Date.now() - t0));
  await sleep(REDUCED ? 0 : wait);
  $('boot').classList.add('out');
  setTimeout(() => $('boot').remove(), 500);

  const n = new Date(); STATE.calY = n.getFullYear(); STATE.calM = n.getMonth();
  $('app').hidden = false;
  renderVerify();
  renderAll();
  // Telegram дописывает к адресу свои параметры: #wallet&tgWebAppData=… — берём только вкладку
  const hashTab = (location.hash.slice(1).split('&')[0] || '').split('=').length === 1 ? location.hash.slice(1).split('&')[0] : '';
  if (TABS.includes(hashTab) || RENDER[hashTab]) go(hashTab);
  if (!DB.consent || DB.consent.v !== CFG.CONSENT_VERSION) $('consent').hidden = false;
  else if (!DB.teamAt) onboard();                          // первый вход: сразу выбираем смену
  else if (STATE.verified) {
    pushRank();
    const sp = hello && hello.profile;                    // сервер не знает нашу смену — сообщим боту
    if (!sp || sp.team !== DB.team || sp.grp !== DB.group) pushProfile();
  }
  if (tgv('6.1')) TG.BackButton.onClick(back);
  loadPaydays();
  flushToast();
}
// Первый вход: без смены и группы не стартуем — от них зависят график,
// кошелёк (часы из графика) и оповещения бота.
function onboard() {
  const teams = STATE.sched ? Object.keys(STATE.sched.teams) : ['dark', 'orange', 'green'];
  const t = STATE.obTeam, g = STATE.obGroup;
  $('consent').hidden = false;
  document.querySelector('#consent .gate-card').innerHTML = `<div class="tape" aria-hidden="true"></div>
    <h1 class="gate-h">Твоя смена</h1>
    <p>Выбери бригаду и группу, как в графике на складе. По ним строятся календарь, часы в кошельке и напоминания в Telegram. Поменять можно в любой момент.</p>
    <div class="teams" style="margin-top:14px">${teams.map(k => { const m = teamMeta(k); return `<button class="team-b${k === t ? ' on' : ''}" style="--tc:${TEAM_COL[k] || 'var(--acc)'}" data-act="ob-team" data-v="${k}"><b>${esc(m.label)}</b><small>${esc(m.legend || '')}</small></button>`; }).join('')}</div>
    ${t ? `<div class="field" style="margin-top:14px"><span>Группа</span><div class="chips">${teamMeta(t).groups.map(x => `<button class="chip${x === g ? ' on' : ''}" data-act="ob-group" data-v="${x}">${x}</button>`).join('')}</div></div>` : ''}
    <button class="btn btn-acc btn-wide" style="margin-top:18px" data-act="ob-done" ${t && g ? '' : 'disabled'}>${t && g ? `Готово: ${esc(teamMeta(t).label)} ${g}` : 'Выбери смену и группу'}</button>`;
}
// ── подтверждение аккаунта ──
// Сервер проверяет подпись Telegram и возвращает доверенный id. Без этого
// пики и кошелёк работают, но рейтинг и оповещения — нет: писать в общую
// базу от чужого имени нельзя.
const VERIFY_TEXT = {
  ok:       { short: '',            title: 'Аккаунт подтверждён', text: 'Telegram подтвердил, что это ты. Рейтинг и оповещения работают.' },
  browser:  { short: 'браузер',     title: 'Открыто не из Telegram', text: 'Пики и кошелёк считаются, но рейтинг и оповещения работают, только если открыть трекер кнопкой «Трекер» в боте.' },
  signature:{ short: 'не принята',  title: 'Сервер не узнал бота', text: 'Пики и кошелёк работают. Рейтинг и оповещения включатся после подтверждения — администратор уже видит это в боте. Попробуй позже.' },
  expired:  { short: 'устарела',    title: 'Сессия Telegram устарела', text: 'Закрой трекер и открой его снова кнопкой в боте — подтверждение пройдёт само.' },
  mismatch: { short: 'не совпала',  title: 'Аккаунт не совпал', text: 'Telegram прислал данные другого аккаунта. Закрой трекер и открой снова.' },
  offline:  { short: 'нет связи',   title: 'Нет связи с сервером', text: 'Проверь интернет и нажми «Проверить снова». Записи сохраняются на телефоне.' },
};
async function verifyAccount() {
  if (!IN_TG) { STATE.verifyState = 'browser'; return null; }
  try {
    const hello = await api('hello', {});
    const unsafeId = String(TG.initDataUnsafe?.user?.id || '');
    if (hello.uid && (!unsafeId || unsafeId === String(hello.uid))) {
      STATE.verified = true; STATE.uid = String(hello.uid); STATE.pub = String(hello.pub || ''); STATE.server = true;
      STATE.verifyState = 'ok';
    } else STATE.verifyState = 'mismatch';
    return hello;
  } catch (e) {
    STATE.verifyState = e.status === 401 ? (e.reason === 'expired' ? 'expired' : 'signature') : 'offline';
    return null;
  }
}
function verifyBanner() {
  const v = VERIFY_TEXT[STATE.verifyState] || VERIFY_TEXT.offline;
  const bot = STATE.verifyState === 'browser' || STATE.verifyState === 'expired';
  return `<div class="vf-h"><span class="vf-ic">!</span><b>${v.title}</b></div><p>${v.text}</p>
    <div class="vf-act">${STATE.verifyState === 'browser' ? '' : '<button class="btn btn-acc" data-act="reverify">Проверить снова</button>'}
    ${bot ? '<button class="btn btn-ghost" data-act="open-bot">Открыть бота</button>' : ''}</div>`;
}
function renderVerify() {
  const o = $('offline');
  if (STATE.verified) { o.hidden = true; o.innerHTML = ''; }
  else { o.hidden = false; o.innerHTML = verifyBanner(); }
  const b = $('vf-badge');
  if (b) { b.className = 'vf-badge ' + (STATE.verified ? 'ok' : 'no'); b.title = STATE.verified ? 'Аккаунт подтверждён Telegram' : 'Аккаунт не подтверждён'; }
}
async function reverify(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Проверяю…'; }
  const hello = await verifyAccount();
  if (STATE.verified) {
    DB.uid = STATE.uid; save(); haptic.ok(); toast('Аккаунт подтверждён');
    pushRank(); if (!hello?.profile || hello.profile.team !== DB.team) pushProfile();
  } else { haptic.err(); toast(VERIFY_TEXT[STATE.verifyState].title); }
  renderVerify(); renderAll();
}
function note(t) { const n = $('boot-note'); n.hidden = false; n.textContent = t; }

async function loadSchedule() {
  const ok = s => s && s.teams && typeof s.teams === 'object' && s.dark;
  try {
    const r = await fetch('schedule.json', { cache: 'no-cache' });
    if (r.ok) { const s = await r.json(); if (ok(s)) { try { localStorage.setItem(SCHED_KEY, JSON.stringify(s)); } catch {} return s; } }
  } catch {}
  try { const s = JSON.parse(localStorage.getItem(SCHED_KEY) || 'null'); if (ok(s)) return s; } catch {}
  return null;
}

// Сырые пики прошлых месяцев → итог в архив, записи удаляем.
function pruneOldMonths() {
  const cm = C.monthKey(new Date());
  const old = DB.entries.filter(e => e.shiftDate.slice(0, 7) !== cm && e.shiftDate.slice(0, 7) < cm);
  if (!old.length) return;
  [...new Set(old.map(e => e.shiftDate.slice(0, 7)))].forEach(m => { const s = C.monthSnapshot(DB.entries, m); DB.archive[m] = s; });
  DB.entries = DB.entries.filter(e => !(e.shiftDate.slice(0, 7) < cm));
}

// ═════════════════════ ТЕМА ═════════════════════
function applyTheme() {
  const root = document.documentElement;
  if (DB.theme === 'auto') {
    if (IN_TG && TG.colorScheme) root.dataset.theme = TG.colorScheme; else delete root.dataset.theme;
  } else root.dataset.theme = DB.theme;
  document.body.dataset.team = DB.team;
  try {
    const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim();
    if (bg && tgv('6.1')) { TG.setHeaderColor(bg); TG.setBackgroundColor(bg); }
    if (bg && tgv('7.10')) TG.setBottomBarColor(bg);
  } catch {}
}
TG?.onEvent?.('themeChanged', () => { if (DB.theme === 'auto') applyTheme(); });

// ═════════════════════ МЕЛОЧИ UI ═════════════════════
let _toastT = null, _toastQ = null;
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(_toastT); _toastT = setTimeout(() => el.classList.remove('on'), 2600); }
function toastLater(t) { _toastQ = t; }
function flushToast() { const t = _toastQ; _toastQ = null; if (t) setTimeout(() => toast(t), 500); }

function countUp(el, to, fmt = money) {
  const from = Number(el.dataset.v || 0); el.dataset.v = to;
  if (REDUCED || Math.abs(to - from) < 0.005) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 700;
  const tick = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

function sheet(html, onOpen) {
  $('sheet-body').innerHTML = html; const bg = $('sheet-bg'); bg.hidden = false; bg.classList.remove('closing');
  onOpen && onOpen($('sheet-body'));
}
function closeSheet() { const bg = $('sheet-bg'); if (bg.hidden) return; bg.classList.add('closing'); setTimeout(() => { bg.hidden = true; bg.classList.remove('closing'); }, 200); }
function confirmSheet(title, text, okLabel, fn) {
  sheet(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="stack"><button class="btn btn-bad btn-wide" data-act="sheet-ok">${esc(okLabel)}</button><button class="btn btn-ghost btn-wide" data-act="sheet-close">Отмена</button></div>`);
  STATE.sheetOk = fn;
}

// ═════════════════════ НАВИГАЦИЯ ═════════════════════
const TABS = ['home', 'peaks', 'sched', 'wallet', 'more'];
function go(to) {
  const isTab = TABS.includes(to);
  if (isTab) { STATE.stack = []; STATE.tab = to; }
  else if (STATE.stack[STATE.stack.length - 1] !== to) STATE.stack.push(to);
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === 'p-' + to));
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.to === (isTab ? to : STATE.tab)));
  if (tgv('6.1')) { STATE.stack.length ? TG.BackButton.show() : TG.BackButton.hide(); }
  window.scrollTo(0, 0);
  RENDER[to] && RENDER[to]();
}
function back() { if (!$('sheet-bg').hidden) return closeSheet(); STATE.stack.pop(); go(STATE.stack.length ? STATE.stack[STATE.stack.length - 1] : STATE.tab); }

// ═════════════════════ ГРАФИК: ВСПОМОГАТЕЛЬНОЕ ═════════════════════
const TEAM_COL = { dark: '#F2C230', orange: '#F27A1A', green: '#1FA463' };
const plan = mk => STATE.sched ? C.monthPlan(STATE.sched, DB.team, DB.group, mk) : null;
const teamMeta = t => (STATE.sched && STATE.sched.teams[t]) || { label: t.toUpperCase(), groups: ['A', 'B', 'C', 'D'], legend: '' };

// Ближайшая смена: текущая (если не кончилась) или следующая по графику.
function nextShift(now = new Date()) {
  for (let i = -1; i < 62; i++) {
    const day = C.addDays(C.iso(now), i), mk = day.slice(0, 7), p = plan(mk);
    if (!p) continue;
    const d = +day.slice(8), span = p.days[d];
    if (!span || DB.urlop[mk]?.[d] || DB.absent[mk]?.[d]) continue;
    const b = C.shiftBounds(day, span.from, span.to);
    if (b.en > now) return { day, span, b, label: p.label };
  }
  return null;
}
function leftText(ms) {
  const m = Math.max(0, Math.round(ms / 60000)), h = Math.floor(m / 60), mm = m % 60;
  if (h >= 24) { const d = Math.floor(h / 24); return `через ${d} ${plural(d, 'день', 'дня', 'дней')}`; }
  return h ? `через ${h} ч ${mm} мин` : `через ${mm} мин`;
}
function dayName(day) { const [y, m, d] = day.split('-').map(Number); const dt = new Date(y, m - 1, d); return `${d} ${MONTHS_GEN[m - 1]}, ${WD[dt.getDay()]}`; }

// ═════════════════════ ГЛАВНАЯ ═════════════════════
function renderHeader() {
  $('me-name').textContent = DB.name || 'Сотрудник';
  $('me-sub').innerHTML = `<span id="vf-badge" class="vf-badge ${STATE.verified ? 'ok' : 'no'}"></span>${STATE.verified ? 'подтверждён' : 'не подтверждён'}, M13 Outbound`;
  const av = $('av');
  if (DB.photo) { av.innerHTML = ''; const img = new Image(); img.alt = ''; img.referrerPolicy = 'no-referrer'; img.src = DB.photo; img.onerror = () => { av.innerHTML = `<span>${esc(DB.emoji)}</span>`; }; av.appendChild(img); }
  else av.innerHTML = `<span>${esc(DB.emoji)}</span>`;
  $('shift-chip-t').textContent = `${teamMeta(DB.team).label} ${DB.group}`;
  document.body.dataset.team = DB.team;
}

function renderHome() {
  const now = new Date(), mk = C.monthKey(now), [y, m] = mk.split('-');
  const code = `M13-${teamMeta(DB.team).label}-${DB.group}-${m}${y.slice(2)}`;
  $('plate-code').textContent = code;
  $('plate-month').textContent = mLabel(mk);
  renderPlateCheck();
  renderIndirect();
  const base = C.monthBonus(DB.entries, mk), absN = autoHours(mk).absences, pf = C.premiumFactor(absN), ind = indAmount(mk);
  // На главной вся премия: пики с множителем обецности (без пропусков ×1,25) + Indirect.
  countUp($('plate-bonus'), C.r2(base * pf + ind));
  const indTxt = ind ? ` + Indirect ${money(ind)}` : '';
  $('plate-cap').textContent = !base && !ind ? 'премия за пики и Indirect в этом месяце'
    : !base ? `премия Indirect за ${MONTHS[+mk.slice(5) - 1]}`
    : pf ? `премия: пики ${money(base)} × ${fx(pf)}${indTxt}${absN ? `, пропусков ${absN}` : ', без пропусков'}`
    : `за пики премии нет: ${absN} ${plural(absN, 'пропуск', 'пропуска', 'пропусков')}${indTxt} (без них было бы ${money(base * 1.25)} zł)`;

  const ns = nextShift(now), box = $('next-shift');
  if (!STATE.sched) box.innerHTML = `<div class="next-ic">📅</div><div><b>График не загрузился</b><small>Проверь интернет и открой приложение снова.</small></div>`;
  else if (!ns) box.innerHTML = `<div class="next-ic">📅</div><div><b>Смен в графике нет</b><small>${DB.team === 'green' ? 'График GREEN ещё не внесён.' : 'Проверь смену и группу в шапке.'}</small></div>`;
  else {
    const running = ns.b.st <= now;
    const when = running ? `идёт сейчас, до ${ns.span.to}` : leftText(ns.b.st - now);
    const today = ns.day === C.shiftToday(now);
    box.innerHTML = `<div class="next-ic">${ns.span.from >= '20:00' || ns.span.from < '05:00' ? '🌙' : '☀️'}</div>
      <div><b>${today ? 'Сегодня' : esc(dayName(ns.day))}, ${ns.span.from}–${ns.span.to}</b><small>${esc(when)}</small></div>
      <button class="go" data-act="go" data-to="sched">График</button>`;
  }

  const es = DB.entries.filter(e => e.shiftDate.slice(0, 7) === mk);
  $('h-hours').textContent = h1(es.reduce((s, e) => s + e.hours, 0));
  $('h-peaks').textContent = int(es.reduce((s, e) => s + e.peaks, 0));
  $('h-shifts').textContent = new Set(es.map(e => e.shiftDate)).size;

  const total = Math.max(1, C.monthBonus(DB.entries, mk));
  const pfH = C.premiumFactor(autoHours(mk).absences);
  const rows = Object.keys(C.ST).map(st => ({ st, a: C.monthAgg(DB.entries, st, mk) })).filter(r => r.a.n);
  $('home-st').innerHTML = rows.length ? rows.map(({ st, a }) => `
    <button class="strow" data-act="station" data-st="${st}">
      <span class="st-tag" style="background:${C.ST[st].col}">${C.ST[st].name}</span>
      <span class="strow-b"><b>${C.ST[st].full}</b><small>${int(a.P)} шт за ${h1(a.H)} ч, темп ${h1(a.pph)}</small>
        <span class="meter"><i style="width:${Math.round(a.bonus / total * 100)}%;background:${C.ST[st].col}"></i></span></span>
      <span class="strow-r">${money(a.bonus * pfH)}<small>zł × ${fx(pfH)}</small></span>
    </button>`).join('')
    : `<div class="empty"><b>В этом месяце ещё нет записей</b>После смены запиши пики — премия посчитается сама.</div>`;

  const w = walletView();
  $('home-wallet-sub').textContent = w.saved ? `${money(w.res.netto)} zł на руки` : 'посчитать зарплату';
  homeRank();
}

// Место в рейтинге за месяц на главной. Таблицу берём раз в минуту, не чаще.
async function homeRank() {
  const sub = $('home-rank-sub'), place = $('home-rank-place');
  const mk = C.monthKey(new Date()), c = STATE.rankCache;
  let rows = c && c.mk === mk && Date.now() - c.at < 60000 ? c.rows : null;
  if (!rows) {
    try {
      const r = await fetch(`${CFG.SB_URL}/rest/v1/leaderboard?month=eq.${mk}&order=bonus.desc&limit=300&select=pub,bonus`,
        { headers: { apikey: CFG.SB_KEY, Authorization: 'Bearer ' + CFG.SB_KEY } });
      if (!r.ok) throw 0;
      rows = await r.json();
      STATE.rankCache = { mk, rows, at: Date.now() };
    } catch { sub.textContent = 'кто сколько заработал за месяц'; place.innerHTML = ''; return; }
  }
  const i = STATE.pub ? rows.findIndex(x => x.pub === STATE.pub) : -1;
  if (i >= 0) {
    sub.textContent = `ты на ${i + 1}-м месте из ${rows.length}`;
    place.innerHTML = `#${i + 1}<small>${i === 0 ? 'лидер' : `до #${i}: ${money(Math.max(0, rows[i - 1].bonus - rows[i].bonus))} zł`}</small>`;
  } else {
    sub.textContent = rows.length ? `${rows.length} ${plural(rows.length, 'участник', 'участника', 'участников')} в этом месяце` : 'стань первым в этом месяце';
    place.innerHTML = rows.length ? `${money(rows[0].bonus)}<small>zł у лидера</small>` : '';
  }
}

// ═════════════════════ ПИКИ ═════════════════════
// Состояние формы живёт здесь, а не в DOM: форма перерисовывается при каждом
// входе на вкладку и возврате в приложение, и введённое не должно теряться.
// f/o/p === null — поле не трогали, берём из графика.
const qa = { mode: 'today', day: '', base: '', f: null, o: null, p: '' };
const qaReset = () => { qa.f = qa.o = null; qa.p = ''; };
// Ставка ступени: у почасовых станций — zł за час, у остальных — zł за штуку.
const rateTxt = (st, r) => C.ST[st].hourly ? `${money(r)} zł/ч` : `${r.toFixed(3).replace('.', ',')} zł`;
const stKeys = extra => extra ? Object.keys(C.ST).filter(k => !DB.mainSt.includes(k)) : DB.mainSt;
const isExtra = k => !DB.mainSt.includes(k);
// Конструктор: человек сам выбирает 3–5 станций, которые висят сверху на «Пиках».
function stSheet() {
  const a = STATE.stPick, n = a.length;
  sheet(`<h3>Свои станции</h3><p>Выбери ${MAIN_MIN}–${MAIN_MAX} рабочих мест, где ты работаешь чаще всего. Они встанут кнопками на вкладке «Пики», остальные — под «Дополнительно». Порядок — как нажимаешь.</p>
    <div class="st-pick">${Object.keys(C.ST).map(k => { const i = a.indexOf(k); return `<button class="st-pb${i >= 0 ? ' on' : ''}" style="--stc:${C.ST[k].col}" data-act="st-pick" data-st="${k}" aria-pressed="${i >= 0}">
      <span class="st-tag" style="background:${C.ST[k].col}">${C.ST[k].name}</span><span class="st-pb-b"><b>${esc(C.ST[k].full)}</b><small>норма ${C.ST[k].norm}${C.ST[k].hourly ? ', ставка за час' : ''}</small></span><i>${i >= 0 ? i + 1 : ''}</i></button>`; }).join('')}</div>
    <div class="stack"><button class="btn btn-acc btn-wide" data-act="st-save" ${n >= MAIN_MIN ? '' : 'disabled'}>${n >= MAIN_MIN ? `Сохранить: ${n} ${plural(n, 'станция', 'станции', 'станций')}` : `Выбери ещё ${MAIN_MIN - n}`}</button>
    <button class="btn btn-ghost btn-wide" data-act="st-default">Как было: ${MAIN_ST.map(k => C.ST[k].name).join(', ')}</button></div>`);
}

function renderPeaks() {
  const st = STATE.curSt, cfg = C.ST[st];
  document.getElementById('p-peaks').style.setProperty('--stc', cfg.col);
  const segB = k => `<button class="seg-b${k === st ? ' on' : ''}" role="tab" aria-selected="${k === st}" data-act="station" data-st="${k}">${C.ST[k].name}</button>`;
  $('st-seg').innerHTML = stKeys(false).map(segB).join('');
  $('st-more').innerHTML = `<button class="more-b${STATE.stMore ? ' open' : ''}${isExtra(st) ? ' has' : ''}" data-act="st-more" aria-expanded="${!!STATE.stMore}">
      <span>Дополнительно</span><small>${isExtra(st) ? `${esc(cfg.name)}, ${esc(cfg.full)}` : stKeys(true).map(k => C.ST[k].name).join(' · ')}</small><i aria-hidden="true">${STATE.stMore ? '−' : '+'}</i></button>
    ${STATE.stMore ? `<div class="seg st-seg st-extra" role="tablist">${stKeys(true).map(k => `<button class="seg-b${k === st ? ' on' : ''}" role="tab" aria-selected="${k === st}" data-act="station" data-st="${k}"><b>${C.ST[k].name}</b><small>${esc(C.ST[k].full)}</small></button>`).join('')}</div>
      <button class="link st-edit" data-act="st-edit">Настроить свои станции</button>` : ''}`;

  const now = new Date(), mk = C.monthKey(now), today = C.shiftToday(now);
  const tEs = DB.entries.filter(e => e.station === st && e.shiftDate === today);
  const tp = tEs.reduce((s, e) => s + e.peaks, 0), th = tEs.reduce((s, e) => s + e.hours, 0), tc = C.calc(st, tp, th);
  const pfP = C.premiumFactor(autoHours(mk).absences);
  const a = C.monthAgg(DB.entries, st, mk), tier = cfg.tr.findIndex(([lo, hi]) => Math.round(a.pph) >= lo && Math.round(a.pph) <= hi);
  const maxR = cfg.tr[cfg.tr.length - 1][2];
  $('gauge').innerHTML = `
    <div class="gauge-h"><b>${cfg.name}, ${cfg.full}</b><small>норма ${cfg.norm} в час</small></div>
    <div class="kpi">
      <div><b>${tp ? int(tp) : '—'}</b><span>пики сегодня</span></div>
      <div><b>${th ? h1(tc.pph) : '—'}</b><span>темп</span></div>
      <div><b>${th ? int(tc.above) : '—'}</b><span>сверх нормы</span></div>
      <div><b>${th ? h1(th) : '—'}</b><span>часов</span></div>
    </div>
    <div class="steps" aria-label="Ступени ставки по темпу месяца">${cfg.tr.map(([lo, hi, r], i) => `<i class="${i < tier ? 'hit' : i === tier && a.H ? 'cur' : ''}" style="height:${18 + Math.round(r / maxR * 82)}%" title="${lo}–${hi === 999 ? '∞' : hi}: ${rateTxt(st, r)}"></i>`).join('')}</div>
    <div class="steps-l"><span>0</span><span>норма ${cfg.norm}</span><span>${cfg.tr[cfg.tr.length - 1][0]}+</span></div>
    ${cfg.hourly ? `<p class="hint" style="margin:8px 0 0">Ставка за каждый час на станции, если средний темп месяца выше нормы ${cfg.norm} пачек в час.</p>` : ''}
    <div class="gauge-f"><div><small style="color:var(--sub)">Премия за месяц, с обецностью</small><br><span style="font-size:13px;color:var(--sub)">${cfg.hourly ? `${h1(a.H)} ч × ${rateTxt(st, a.rate)}` : `${int(a.above)} шт × ${rateTxt(st, a.rate)}`} × ${fx(pfP)}, темп ${h1(a.pph)}</span></div><b>${money(a.bonus * pfP)} zł</b></div>`;
  renderForm();
  renderPeaksMonth();
}

function renderForm() {
  const st = STATE.curSt;
  // base — дата до автосдвига ночной смены; сдвиг всегда считаем от неё,
  // иначе каждая перерисовка и каждый ввод уводили бы дату ещё на день назад.
  const day = qa.mode === 'yesterday' ? C.shiftYest() : qa.mode === 'today' ? C.shiftToday() : (qa.day || C.shiftToday());
  qa.base = day;
  if (qa.mode === 'custom') qa.day = day;
  const p = plan(day.slice(0, 7)), span = p && p.days[+day.slice(8)];
  const f = qa.f ?? (span ? span.from : ''), o = qa.o ?? (span ? span.to : '');
  $('qa').innerHTML = `
    <div class="form-h">Записать смену на ${C.ST[st].name}</div>
    <div class="chips" style="margin-bottom:10px">
      <button class="chip${qa.mode === 'today' ? ' on' : ''}" data-act="qa-mode" data-v="today">Сегодняшняя</button>
      <button class="chip${qa.mode === 'yesterday' ? ' on' : ''}" data-act="qa-mode" data-v="yesterday">Вчерашняя</button>
    </div>
    <label class="field" style="margin-bottom:10px"><span>Дата начала смены</span><input class="in" type="date" id="qa-d" value="${day}" data-in="qa"></label>
    <div class="grid2">
      <label class="field"><span>Начало</span><input class="in" type="time" id="qa-f" value="${f}" data-in="qa"></label>
      <label class="field"><span>Конец</span><input class="in" type="time" id="qa-o" value="${o}" data-in="qa"></label>
    </div>
    <div class="dur" id="qa-dur"></div>
    <label class="field"><span>Пики, штук</span><input class="in" type="number" inputmode="numeric" min="1" max="100000" id="qa-p" value="${esc(qa.p)}" placeholder="380" data-in="qa"></label>
    <div class="preview" id="qa-prev" hidden></div>
    <button class="btn btn-acc btn-wide" id="qa-save" data-act="qa-save">Сохранить смену</button>`;
  qaUpdate();
}

function qaUpdate(ev) {
  const f = $('qa-f').value, o = $('qa-o').value, d = $('qa-d');
  const id = ev && ev.target.id;
  if (id === 'qa-d') { qa.mode = 'custom'; qa.day = qa.base = d.value; document.querySelectorAll('[data-act="qa-mode"]').forEach(b => b.classList.remove('on')); }
  if (id === 'qa-f') qa.f = f;
  if (id === 'qa-o') qa.o = o;
  if (id === 'qa-p') qa.p = $('qa-p').value;
  if (qa.mode !== 'custom' && qa.base) { const fix = f && o ? C.shiftDayOf(qa.base, f, o) : qa.base; if (fix !== d.value) d.value = fix; }
  const min = C.minutesBetween(f, o), hrs = min / 60, p = Number($('qa-p').value);
  $('qa-dur').innerHTML = min ? `<span>Отработано</span><b>${Math.floor(min / 60)} ч ${String(min % 60).padStart(2, '0')} мин</b>` : '';
  const box = $('qa-prev');
  if (!p || !min) { box.hidden = true; return; }
  const c = C.calc(STATE.curSt, p, hrs);
  box.hidden = false;
  box.innerHTML = `<div><span>Темп</span><b>${h1(c.pph)}</b></div><div><span>Норма</span><b>${int(c.norm)}</b></div><div><span>Сверх</span><b>${int(c.above)}</b></div>
    <div><span>Ставка</span><b>${C.ST[STATE.curSt].hourly ? `${money(c.rate)}/ч` : c.rate.toFixed(3).replace('.', ',')}</b></div><div class="bn" style="grid-column:span 2"><span>Премия за эту смену, если темп такой весь месяц</span><b>${money(c.bonus)} zł</b></div>`;
}

function qaSave() {
  const f = $('qa-f').value, o = $('qa-o').value, p = Math.round(Number($('qa-p').value)), btn = $('qa-save');
  let day = $('qa-d').value;
  const min = C.minutesBetween(f, o);
  const fail = t => { btn.textContent = t; btn.classList.add('err'); haptic.err(); setTimeout(() => { btn.textContent = 'Сохранить смену'; btn.classList.remove('err'); }, 1400); };
  if (!RE_DAY.test(day)) return fail('Укажи дату');
  if (!min || min > 16 * 60) return fail('Проверь время смены');
  if (!(p > 0 && p <= 100000)) return fail('Укажи пики');
  if (qa.mode !== 'custom') day = C.shiftDayOf(qa.base || day, f, o);
  qaReset();
  const now = new Date();
  DB.entries.push({ id: Date.now(), station: STATE.curSt, shiftDate: day, peaks: p, hours: Math.round(min / 60 * 100) / 100, from: f, to: o,
    addedAt: now.toTimeString().slice(0, 5) });
  save(); haptic.ok();
  btn.textContent = 'Сохранено'; btn.classList.add('ok');
  setTimeout(() => { renderPeaks(); }, 700);
  pushRank();
  toast(`Записано: ${p} шт, ${C.ST[STATE.curSt].name}`);
}

function renderPeaksMonth() {
  const mk = C.monthKey(new Date());
  const es = DB.entries.filter(e => e.shiftDate.slice(0, 7) === mk);
  if (!es.length) { $('peaks-month').innerHTML = `<div class="empty"><b>Записей пока нет</b>Первая смена появится здесь.</div>`; return; }
  const by = {}; es.forEach(e => (by[e.shiftDate] = by[e.shiftDate] || []).push(e));
  $('peaks-month').innerHTML = Object.keys(by).sort().reverse().map(d => {
    const list = by[d], p = list.reduce((s, e) => s + e.peaks, 0), h = list.reduce((s, e) => s + e.hours, 0);
    return `<div class="day"><div class="day-h"><b>${esc(dayName(d))}</b><span>${int(p)} шт, ${h1(h)} ч</span></div>
      ${list.map(e => `<div class="ent"><span class="st-tag" style="background:${C.ST[e.station].col}">${C.ST[e.station].name}</span>
        <span class="ent-b"><b>${int(e.peaks)}</b>шт${e.from ? `, ${e.from}–${e.to}` : ''}, темп ${h1(e.hours ? e.peaks / e.hours : 0)}</span>
        <button class="x" data-act="del-entry" data-id="${e.id}" aria-label="Удалить запись">×</button></div>`).join('')}</div>`;
  }).join('');
}

// ═════════════════════ ГРАФИК ═════════════════════
function renderSched() {
  $('sched-cal').hidden = STATE.schedTab !== 'cal';
  $('sched-bus').hidden = STATE.schedTab !== 'bus';
  document.querySelectorAll('[data-act="sched-tab"]').forEach(b => b.classList.toggle('on', b.dataset.v === STATE.schedTab));
  if (STATE.schedTab === 'bus') return renderBus();

  const teams = STATE.sched ? Object.keys(STATE.sched.teams) : ['dark', 'orange', 'green'];
  const meta = teamMeta(DB.team);
  $('team-pick').innerHTML = `<div class="teams">${teams.map(t => { const m = teamMeta(t); return `<button class="team-b${t === DB.team ? ' on' : ''}" style="--tc:${TEAM_COL[t] || 'var(--acc)'}" data-act="team" data-v="${t}"><b>${esc(m.label)}</b><small>${esc(m.legend || '')}</small></button>`; }).join('')}</div>
    <div class="chips" aria-label="Группа">${meta.groups.map(g => `<button class="chip${g === DB.group ? ' on' : ''}" data-act="group" data-v="${g}">${g}</button>`).join('')}</div>`;
  renderCal();
  renderNotify();
}

function renderCal() {
  const y = STATE.calY, m = STATE.calM, mk = `${y}-${String(m + 1).padStart(2, '0')}`;
  $('cal-title').textContent = mLabel(mk);
  const p = plan(mk), dim = C.daysInMonth(mk), today = C.iso(new Date());
  const dows = DB.ws === 'mon' ? ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] : ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  let h = dows.map(d => `<div class="dow">${d}</div>`).join('');
  if (!p) { $('cal-grid').innerHTML = h + `<div class="cal-none">${DB.team === 'green' ? 'График GREEN ещё не внесён. Как только появится — смены и оповещения включатся сами.' : 'На этот месяц графика нет.'}</div>`; $('cal-legend').innerHTML = ''; return; }
  const first = new Date(y, m, 1).getDay(), off = DB.ws === 'mon' ? (first + 6) % 7 : first;
  for (let i = 0; i < off; i++) h += '<div class="cd e"></div>';
  const ovtDays = {}; DB.ovt.filter(o => o.date.slice(0, 7) === mk).forEach(o => { ovtDays[+o.date.slice(8)] = (ovtDays[+o.date.slice(8)] || 0) + o.hours; });
  let work = 0, hol = 0, url = 0, abs = 0;
  const pays = payMarks(mk);
  for (let d = 1; d <= dim; d++) {
    const day = `${mk}-${String(d).padStart(2, '0')}`, span = p.days[d], isU = DB.urlop[mk]?.[d], isA = DB.absent[mk]?.[d], isH = p.holidays[String(d)];
    let cls = 'cd', sub = '';
    if (isA) { cls += ' a'; sub = 'пропуск'; abs++; }
    else if (isU) { cls += ' u'; sub = 'отпуск'; url++; }
    else if (isH) { cls += ' h'; sub = 'święto'; hol++; }
    else if (span) { cls += ' w'; sub = `${span.from.slice(0, 2)}–${span.to.slice(0, 2)}`; work++; }
    if (day === today) cls += ' t'; else if (day < today) cls += ' past';
    const pay = pays.days[d];
    h += `<button class="${cls}" data-act="day" data-d="${d}" aria-label="${d} ${MONTHS_GEN[m]}${sub ? ', ' + sub : ''}${pay ? ', зарплата' : ''}">${d}${sub ? `<small>${sub}</small>` : ''}${ovtDays[d] ? '<span class="dot"></span>' : ''}${pay ? `<span class="payc${pay === 'got' ? ' got' : ''}">zł</span>` : ''}</button>`;
  }
  $('cal-grid').innerHTML = h;
  $('cal-legend').innerHTML = `<span><i style="background:var(--acc)"></i>смена ${work}</span><span><i style="background:var(--bad)"></i>праздник ${hol}</span><span><i style="background:#B07CF2"></i>отпуск ${url}</span>${abs ? `<span><i style="background:repeating-linear-gradient(-45deg,var(--warn) 0 2px,transparent 2px 4px);box-shadow:inset 0 0 0 1px var(--warn)"></i>пропуск ${abs}</span>` : ''}<span><i style="background:var(--kraft)"></i>сверхурочные</span>${pays.label ? `<span><i class="lg-pay"></i>${esc(pays.label)}</span>` : ''}`;
}

// Зарплата за прошлый месяц в календаре месяца mk: пришла или прогноз.
function payMarks(mk) {
  const W = C.addMonths(mk, -1), p = paydayFor(W), days = {}, name = MONTHS[+W.slice(5) - 1];
  if (p.actual && p.actual.slice(0, 7) === mk) { days[+p.actual.slice(8)] = 'got'; return { days, p, label: `зарплата за ${name} пришла` }; }
  p.days.filter(x => x.day.slice(0, 7) === mk).forEach(x => { days[+x.day.slice(8)] = x.p; });
  const l = likely(p);
  return { days, p, label: Object.keys(days).length ? `зарплата за ${name} ${l.day === p.deadline ? 'до' : '≈'} ${+l.day.slice(8)}-го` : '' };
}

// Отпуск и пропуск в один день не бывают — отметка одного снимает другое.
function markDay(kind, other, day) {
  const mk = day.slice(0, 7), d = +day.slice(8);
  DB[kind][mk] = DB[kind][mk] || {};
  if (DB[kind][mk][d]) delete DB[kind][mk][d];
  else { DB[kind][mk][d] = 1; if (DB[other][mk]) delete DB[other][mk][d]; }
  save(); haptic.ok(); closeSheet(); renderCal(); pushProfile();
  if (kind === 'absent') { pushRank(); const n = Object.keys(DB.absent[mk] || {}).length; toast(`Пропусков в месяце: ${n}, премия ×${fx(C.premiumFactor(n))}`); }
}

function payLine(mk, d) {
  const pm = payMarks(mk), v = pm.days[d]; if (!v) return '';
  const name = MONTHS[+pm.p.month.slice(5) - 1];
  return `<button class="pay-line" data-act="go" data-to="odcinek"><span>zł</span><b>${v === 'got' ? `Зарплата за ${name} пришла в этот день` : v === 1 ? `Зарплата за ${name}: крайний срок` : `Зарплата за ${name}: ${Math.round(v * 100)}%, что придёт к этому дню`}</b><small>${v === 'got' ? 'по отметкам людей' : 'прогноз по правилу «до 10-го» и датам людей'} ›</small></button>`;
}

function daySheet(d) {
  const mk = `${STATE.calY}-${String(STATE.calM + 1).padStart(2, '0')}`, day = `${mk}-${String(d).padStart(2, '0')}`;
  const p = plan(mk), span = p && p.days[d], hol = p && p.holidays[String(d)], isU = DB.urlop[mk]?.[d], isA = DB.absent[mk]?.[d];
  const ov = DB.ovt.filter(o => o.date === day);
  const absN = Object.keys(DB.absent[mk] || {}).length;
  sheet(`<h3>${esc(dayName(day))}</h3>
    <p>${hol ? `Праздник: ${esc(hol)}` : span ? `Смена ${p.label} ${span.from}–${span.to}` : 'Выходной по графику'}${isU ? '. Отмечен отпуск.' : ''}${isA ? '. Отмечен пропуск.' : ''}</p>
    ${payLine(mk, d)}
    <div class="grid2">
      <button class="btn ${isU ? 'btn-ghost' : 'btn-acc'}" data-act="urlop" data-day="${day}">${isU ? 'Снять отпуск' : 'Отпуск'}</button>
      ${span ? `<button class="btn ${isA ? 'btn-ghost' : 'btn-warn'}" data-act="absent" data-day="${day}">${isA ? 'Снять пропуск' : 'Пропуск'}</button>` : '<span></span>'}
    </div>
    ${span ? `<p class="hint" style="margin-top:8px">Пропуск — смена не отработана без отпуска (L4, прогул). Без пропусков премия ×1,25, с одним ×0,80, с двумя и больше премии нет. Сейчас в месяце ${absN} → ×${fx(C.premiumFactor(absN))}.</p>` : ''}
    <div style="margin-top:16px;font:600 18px var(--f-num)">Сверхурочные</div>
    ${ov.map(o => `<div class="ent"><span class="ent-b"><b>${h1(o.hours)} ч</b>+${o.pct}%${o.night ? ', ночью' : ''}</span><button class="x" data-act="del-ovt" data-id="${o.id}" aria-label="Удалить">×</button></div>`).join('')}
    <div class="grid2" style="margin-top:10px">
      <label class="field"><span>Часов</span><input class="in" type="number" inputmode="decimal" step="0.5" min="0.5" max="16" id="ov-h" placeholder="2"></label>
      <div class="field"><span>Доплата</span><div class="chips" id="ov-pct"><button class="chip on" data-act="ov-pct" data-v="50">50%</button><button class="chip" data-act="ov-pct" data-v="100">100%</button></div></div>
    </div>
    <label class="switch" style="margin-top:6px"><span><b>Часы в 22:00–06:00</b><small>добавится ночная доплата</small></span><span class="tg"><input type="checkbox" id="ov-n" ${span && C.nightMinutes(span.from, span.to) ? 'checked' : ''}><i></i></span></label>
    <div class="stack"><button class="btn btn-acc btn-wide" data-act="add-ovt" data-day="${day}">Добавить сверхурочные</button><button class="btn btn-ghost btn-wide" data-act="sheet-close">Готово</button></div>`);
  STATE.ovPct = 50;
}

function renderNotify() {
  const card = $('notify-card');
  if (!STATE.verified) {
    card.innerHTML = `<p style="color:var(--sub);font-size:14px">Оповещения присылает бот. Открой трекер кнопкой из бота — тогда здесь появятся настройки.</p>
      <button class="btn btn-acc btn-wide" style="margin-top:12px" data-act="open-bot">Открыть бота</button>`;
    return;
  }
  const row = (k, t, s) => `<label class="switch"><span><b>${t}</b><small>${s}</small></span><span class="tg"><input type="checkbox" data-act="notify" data-k="${k}" ${DB.notify[k] ? 'checked' : ''}><i></i></span></label>`;
  card.innerHTML = row('h2', 'За 2 часа до смены', 'чтобы спокойно собраться') +
    row('h1', 'За час до смены', 'пора выходить к автобусу') +
    row('peaks', 'После смены', 'напомнить записать пики') +
    row('pay', '10-го числа', 'кошелёк обновился, пора посчитать новый месяц') +
    `<button class="btn btn-ghost btn-wide" style="margin-top:6px" data-act="ics">Добавить смены в календарь телефона</button>`;
}

const BUS = [
  { t: 'Маршрут А', s: 'Hoża, Jana z Czarnolasu', since: '27.10.2025', c: '#EF5B4C', shifts: [
    { n: 'Zmiana 1', go: ['04:40', [['Hoża 21', '04:43'], ['Jana z Czarnolasu 11', '04:46'], ['Pasterska 11', '04:48'], ['Łabędzia 32', '04:50'], ['Krasińskiego 11', '04:52'], ['Kołłątaja 22', '04:54'], ['Sczanieckiej 21', '04:54'], ['Wyszyńskiego 11', '05:00'], ['AUTODOC Kablowa 1', '05:40', 'work']]],
      back: ['14:20', ['AUTODOC Kablowa 1', 'Plac Słowiański 11', 'Sczanieckiej 22', 'Kołłątaja 21', 'Krasińskiego 12', 'Łabędzia 31', 'Pasterska 12', 'Jana z Czarnolasu 12', 'Hoża 22']] },
    { n: 'Zmiana 2', go: ['12:40', [['Hoża 21', '12:40'], ['Jana z Czarnolasu 11', '12:43'], ['Pasterska 11', '12:46'], ['Łabędzia 32', '12:48'], ['Krasińskiego 11', '12:51'], ['Kołłątaja 22', '12:55'], ['Sczanieckiej 21', '12:55'], ['Wyszyńskiego 11', '13:03'], ['AUTODOC Kablowa 1', '13:40', 'work']]],
      back: ['22:20', ['AUTODOC Kablowa 1', 'Plac Słowiański 11', 'Sczanieckiej 22', 'Kołłątaja 21', 'Krasińskiego 12', 'Łabędzia 31', 'Pasterska 12', 'Jana z Czarnolasu 12', 'Hoża 22']] },
    { n: 'Zmiana 3, DARK', dark: 1, go: ['20:50', [['Hoża 21', '20:50'], ['Jana z Czarnolasu 11', '20:53'], ['Pasterska 11', '20:56'], ['Łabędzia 32', '20:58'], ['Krasińskiego 11', '21:00'], ['Kołłątaja 22', '21:02'], ['Sczanieckiej 21', '21:05'], ['Wyszyńskiego 11', '21:10'], ['Basen Górniczy (przy drodze głównej)', '21:17'], ['AUTODOC Kablowa 1', '21:40', 'work']]],
      back: ['06:20', ['AUTODOC Kablowa 1', 'Plac Słowiański 11', 'Basen Górniczy (przy drodze głównej)', '*Wyszyńskiego 22', 'Sczanieckiej 22', 'Kołłątaja 21', 'Krasińskiego 12', 'Łabędzia 31', 'Pasterska 12', 'Jana z Czarnolasu 12', 'Hoża 22']] }] },
  { t: 'Маршрут Б', s: 'Kleeberga, Osiedle Kaliny', since: '02.09.2024', c: '#F2C230', shifts: [
    { n: 'Zmiana 1', go: ['04:40', [['Kleeberga 11', '04:45'], ['Osiedle Kaliny 11', '04:47'], ['Osiedle Przyjaźni 11', '04:51'], ['Ku Słońcu 11', '05:00'], ['Plac Kościuszki 33', '05:05'], ['Wyszyńskiego 11', '05:05'], ['AUTODOC Kablowa 1', '05:40', 'work']]],
      back: ['14:20', ['AUTODOC Kablowa 1', 'Plac Słowiański 11', 'Plac Kościuszki', 'Ku Słońcu', 'Osiedle Przyjaźni', 'Osiedle Kaliny', 'Kleeberga']] },
    { n: 'Zmiana 2', go: ['12:35', [['Kleeberga 11', '12:35'], ['Osiedle Kaliny 11', '12:40'], ['Osiedle Przyjaźni 11', '12:42'], ['Ku Słońcu 11', '12:46'], ['Plac Kościuszki 33', '12:55'], ['Wyszyńskiego 11', '13:00'], ['AUTODOC Kablowa 1', '13:40', 'work']]],
      back: ['22:20', ['AUTODOC Kablowa 1', 'Plac Słowiański 11', 'Plac Kościuszki', 'Ku Słońcu', 'Osiedle Przyjaźni', 'Osiedle Kaliny', 'Kleeberga']] },
    { n: 'Zmiana 3, DARK', dark: 1, go: ['20:45', [['Kleeberga 11', '20:45'], ['Osiedle Kaliny 11', '20:48'], ['Osiedle Przyjaźni 11', '20:50'], ['Ku Słońcu 11', '20:54'], ['Reda 21', '20:59'], ['Mieszka I 12', '21:01', 'hi'], ['Plac Kościuszki 33', '21:05'], ['Wyszyńskiego 11', '21:10'], ['AUTODOC Kablowa 1', '21:40', 'work']]],
      back: ['06:20', ['AUTODOC Kablowa 1', 'Plac Słowiański 11', 'Wyszyńskiego 16', 'Plac Kościuszki 35', '*Mieszka I', 'Reda 11', 'Ku Słońcu 31', 'Osiedle Przyjaźni 12', 'Derdowskiego 21', 'Kleeberga 12']] }] },
  { t: 'Маршрут В', s: 'Centrum, Wyszyńskiego', since: '02.09.2024', c: '#4C8DF6', shifts: [
    { n: 'Zmiana 1', go: ['05:15', [['Wyszyńskiego 11', '05:15'], ['Basen Górniczy (przy drodze głównej)', '05:20'], ['Plac Słowiański 12', '05:26'], ['AUTODOC Kablowa 1', '05:40', 'work']]],
      back: ['14:20', ['AUTODOC Kablowa 1', 'Plac Słowiański 11', 'Basen Górniczy (przy drodze głównej)', 'Wyszyńskiego 16']] },
    { n: 'Zmiana 2', go: ['13:03', [['Wyszyńskiego 11', '13:03'], ['Basen Górniczy (przy drodze głównej)', '13:08'], ['Plac Słowiański 12', '13:15'], ['AUTODOC Kablowa 1', '13:40', 'work']]],
      back: ['22:20', ['AUTODOC Kablowa 1', 'Plac Słowiański 11', 'Basen Górniczy (przy drodze głównej)', 'Wyszyńskiego 16']] },
    { n: 'Zmiana 3, DARK', dark: 1, go: ['21:20', [['Wyszyńskiego 11', '21:20'], ['Basen Górniczy (przy drodze głównej)', '21:25'], ['Plac Słowiański 12', '21:33'], ['AUTODOC Kablowa 1', '21:40', 'work']]],
      back: ['06:20', ['AUTODOC Kablowa 1', 'Plac Słowiański 11', 'Basen Górniczy (przy drodze głównej)', 'Wyszyńskiego 16']] }] },
];
function renderBus() {
  const open = STATE.bus;
  $('sched-bus').innerHTML = BUS.map((r, i) => `<div class="card" style="margin-bottom:8px">
    <button class="bus-b" data-act="bus" data-i="${i}" aria-expanded="${open === i}"><span class="bus-c" style="background:${r.c}"></span>
      <span style="flex:1"><b style="font:700 19px var(--f-num)">${r.t}</b><br><small style="color:var(--sub)">${esc(r.s)}, с ${r.since}</small></span><span style="color:var(--sub);font-size:20px">${open === i ? '−' : '+'}</span></button>
    ${open === i ? r.shifts.filter(s => STATE.busAll || DB.team !== 'dark' || s.dark).map(s => `
      <div class="leg-h"><span>${s.dark ? '🌙 ' : ''}${esc(s.n)}, туда</span><small>выезд ${s.go[0]}</small></div>
      <ul class="stops">${s.go[1].map(([n, t, k]) => `<li class="${k || ''}"><span>${esc(n)}</span>${t ? `<b>${t}</b>` : ''}</li>`).join('')}</ul>
      <div class="leg-h"><span>Обратно</span><small>отъезд ${s.back[0]}</small></div>
      <ul class="stops">${s.back[1].map((n, j) => `<li class="${j === 0 ? 'work' : n[0] === '*' ? 'hi' : ''}"><span>${esc(n.replace(/^\*/, ''))}</span></li>`).join('')}</ul>`).join('')
      + (DB.team === 'dark' && !STATE.busAll ? `<button class="link" style="margin-top:10px" data-act="bus-all">Показать дневные смены</button>` : '') : ''}
  </div>`).join('');
}

// ═════════════════════ КОШЕЛЁК ═════════════════════
// Расчёт за месяц W виден до 10-го следующего месяца. Потом уходит в историю.
function walletRollover(now = new Date()) {
  const W = C.walletMonth(now), cur = DB.wallet.cur;
  if (cur && cur.month < W) {
    const r = C.salary(salaryInput(cur.inp));
    const v = C.variableOf(r, cur.inp);              // пригодится для отпускных следующих месяцев
    const ex = DB.wallet.hist.find(h => h.month === cur.month);
    if (ex && ex.slip) ex.calc = ex.calc || { netto: r.netto, brutto: r.brutto, bonus: r.parts.bonus };   // odcinek уже в истории — он главнее
    else DB.wallet.hist.unshift({ month: cur.month, netto: r.netto, brutto: r.brutto, bonus: r.parts.bonus, savedAt: cur.savedAt, var: v.var, hours: v.hours });
    DB.wallet.hist = DB.wallet.hist.slice(0, 36);
    DB.wallet.cur = null; DB.wallet.draft = null;
    toastLater(`Кошелёк обновлён: ${MONTHS[+cur.month.slice(5) - 1]} ушёл в историю, считаем ${MONTHS[+W.slice(5) - 1]}`);
  }
  if (DB.wallet.draft && DB.wallet.draft.month !== W) DB.wallet.draft = null;
}

// Премия за месяц W: текущий месяц — из живых записей, прошлый — из архива.
function bonusFor(mk) {
  const live = DB.entries.some(e => e.shiftDate.slice(0, 7) === mk);
  if (live) return C.monthBonus(DB.entries, mk);
  return DB.archive[mk] ? DB.archive[mk].bonus : 0;
}

function autoHours(mk) {
  const p = plan(mk); let hours = 0, night = 0, shifts = 0, urlop = 0;
  const marked = Object.keys(DB.urlop[mk] || {});
  const absences = Object.keys(DB.absent[mk] || {}).length;
  if (p) for (const [d, span] of Object.entries(p.days)) {
    if (!span) continue;
    const len = C.minutesBetween(span.from, span.to) / 60;
    if (DB.absent[mk]?.[d]) continue;                     // пропуск — смена не оплачивается
    if (DB.urlop[mk]?.[d]) { urlop += len; continue; }   // отпуск в день смены — столько часов, сколько длится смена
    shifts++; hours += len; night += C.nightMinutes(span.from, span.to) / 60;
  }
  else urlop = marked.length * 8;                         // графика нет — считаем по 8 ч
  const ov = DB.ovt.filter(o => o.date.slice(0, 7) === mk);
  return { shifts, hours, night, urlop, absences, has: !!p,
    o50: ov.filter(o => o.pct === 50).reduce((s, o) => s + o.hours, 0),
    o100: ov.filter(o => o.pct === 100).reduce((s, o) => s + o.hours, 0),
    oN: ov.filter(o => o.night).reduce((s, o) => s + o.hours, 0) };
}

function currentRate() { const p = DB.profile; return p.rateMode === 'own' ? p.rate : Number(p.rateMode); }
function youngFor(mk) { const p = DB.profile; if (!p.birthOk) return { status: 'unknown' }; return C.youngStatus(p.birth, mk); }

// Переменная часть за прошедший месяц: из сохранённого расчёта, а если его нет —
// оценка по графику, ночным часам, сверхурочным из календаря и премии из архива.
function monthVariable(mk) {
  const h = DB.wallet.hist.find(x => x.month === mk && x.hours > 0);
  if (h) return { var: h.var, hours: h.hours, src: 'calc' };
  const a = autoHours(mk);
  if (!a.has || !a.hours) return null;
  const inp = { month: mk, hours: a.hours, nightHours: a.night, ovt50: a.o50, ovt100: a.o100, ovtNight: a.oN, absences: a.absences };
  const r = C.salary({ ...inp, rate: currentRate(), bonus: bonusFor(mk), indirect: (indirectFor(mk) || {}).amount || 0, dark: darkFor(), nightBasis: DB.profile.nightBasis });
  return { ...C.variableOf(r, inp), src: 'est' };
}
// Средняя доплата к часу отпуска: 3 месяца по дате выплаты (работа W-4…W-2).
function urlopAuto(W) {
  const ms = C.urlopWindow(W);
  const rows = ms.map(m => ({ m, v: monthVariable(m) })).filter(x => x.v);
  const avg = C.urlopAverage(rows.map(x => x.v));
  return { ...avg, from: rows[0]?.m, to: rows[rows.length - 1]?.m, est: rows.some(x => x.v.src === 'est') };
}

// Dodatek DARK — только у ночной бригады.
const darkFor = () => DB.team === 'dark' ? DB.profile.dark : 0;
// Брутто с начала года до месяца W — для лимита ulga dla młodych. Из прошлых выплат кошелька.
const ytdAuto = W => r2s(DB.wallet.hist.filter(h => h.month.slice(0, 4) === W.slice(0, 4) && h.month < W).reduce((s, h) => s + h.brutto, 0));
const r2s = n => Math.round(n * 100) / 100;

function salaryInput(inp) {
  const p = DB.profile, ys = youngFor(inp.month);
  return { ...inp, urlopVar: inp.urlopVar ?? urlopAuto(inp.month).perHour,
    rate: currentRate(), bonus: bonusFor(inp.month), indirect: (indirectFor(inp.month) || {}).amount || 0, extra: p.extra, dark: darkFor(), ekw: p.ekw, deduct: p.deduct,
    ytd: inp.ytd ?? ytdAuto(inp.month),
    absences: inp.absences ?? autoHours(inp.month).absences,
    young: ys.status === 'yes' || ys.status === 'partial', kup: p.kup, pit2: p.pit2, ppk: p.ppk, nightBasis: p.nightBasis };
}

function autoInp(W) {
  const a = autoHours(W), r1 = x => Math.round(x * 10) / 10;
  return { month: W, hours: r1(a.hours), nightHours: r1(a.night), urlopHours: r1(a.urlop), ovt50: r1(a.o50), ovt100: r1(a.o100), ovtNight: r1(a.oN),
    urlopVar: urlopAuto(W).perHour, absences: a.absences };
}
// Что показываем: несохранённые правки → сохранённый расчёт → часы из графика.
function walletView(now = new Date()) {
  const W = C.walletMonth(now), saved = !!(DB.wallet.cur && DB.wallet.cur.month === W);
  const draft = DB.wallet.draft && DB.wallet.draft.month === W ? DB.wallet.draft : null;
  const inp = draft || (saved ? DB.wallet.cur.inp : autoInp(W));
  return { W, saved, dirty: saved && !!draft, inp, res: C.salary(salaryInput(inp)) };
}

function renderWallet(fresh = true) {
  walletRollover();
  const v = walletView(), until = C.walletUntil(v.W), left = C.daysLeft(until);
  const prevBonus = DB.wallet.lastBonus;
  const bonusChanged = fresh && prevBonus !== undefined && Math.abs(prevBonus - v.res.parts.bonus) > .004;
  DB.wallet.lastBonus = v.res.parts.bonus;
  renderSlip(v, until, left, bonusChanged);
  renderWalletForm(v);
  renderBreakdown(v.res);
  $('wallet-hist').innerHTML = DB.wallet.hist.length ? DB.wallet.hist.map(h => { const lv = h.slip ? slipLevel(h.month) : null; return `<${h.slip ? 'button data-act="slip-view" data-m="' + h.month + '"' : 'div'} class="whist"><div><b>${mLabel(h.month)}${lv ? ` <span class="oc-chip ${lv}">odcinek ${LV[lv].ic}</span>` : ''}</b><small>брутто ${money(h.brutto)} zł, премия ${money(h.bonus)} zł${h.calc ? `, трекер насчитал ${money(h.calc.netto)}` : ''}</small>${lv ? slipShort(h.month) : ''}</div><div class="v">${money(h.netto)}<small>zł на руки</small></div></${h.slip ? 'button' : 'div'}>`; }).join('')
    : `<div class="empty">Здесь появятся прошлые месяцы. Расчёт переходит сюда 10-го числа.</div>`;
  if (bonusChanged) toast(`Премия обновлена: ${money(v.res.parts.bonus)} zł`);
}

function renderSlip(v, until, left, flash) {
  const [, um, ud] = until.split('-');
  $('slip').innerHTML = `
    <div class="slip-top"><span>Wypłata за ${MONTHS[+v.W.slice(5) - 1]} ${v.W.slice(0, 4)}</span><span class="slip-due">до ${ud}.${um}, ${left} ${plural(left, 'день', 'дня', 'дней')}</span></div>
    <div class="slip-num"><span class="num" id="slip-netto" data-v="${STATE.slipV || 0}">0</span><small>zł</small></div>
    <div class="slip-sub">${v.dirty ? 'есть несохранённые правки, нажми «Обновить расчёт»' : v.saved ? `на руки, расчёт сохранён ${esc(fmtD((DB.wallet.cur.savedAt || '').slice(0, 10)))}` : 'черновик: проверь часы и нажми «Сохранить расчёт»'}</div>
    <div class="slip-bonus${flash ? ' fresh' : ''}"><span>Премия, брутто<br><small style="opacity:.75">пики ${money(v.res.bonusBase)} × ${fx(v.res.premiumFactor)} — ${absText(v.res.premiumFactor, salaryInput(v.inp).absences)}${v.res.indirect ? ` + Indirect ${money(v.res.indirect)}` : ''}</small></span><b>${money(v.res.parts.bonus)} zł</b></div>`;
  countUp($('slip-netto'), v.res.netto); STATE.slipV = v.res.netto;
}

const fx = f => f.toFixed(2).replace('.', ',');           // множитель премии: 1,25 / 0,80 / 0
const absText = (f, n) => n ? `${n} ${plural(n, 'пропуск', 'пропуска', 'пропусков')}${f ? '' : ', премии нет'}` : 'без пропусков +25%';

function renderWalletForm(v) {
  const p = DB.profile, ys = youngFor(v.W), a = autoHours(v.W), i = v.inp;
  const ageLine = !p.birthOk ? `<div class="age-ok n">Пока возраст не подтверждён, PIT считается как для 26+.</div>`
    : ys.status === 'yes' ? `<div class="age-ok y"><b>${ys.age}</b> лет: ulga dla młodych, PIT 0% до лимита ${int(C.TAX.YOUNG_LIMIT)} zł в год.</div>`
    : ys.status === 'partial' ? `<div class="age-ok p">В этом месяце тебе исполняется 26 (${fmtD(ys.b26)}). Ulga действует на выплаты до дня рождения — итог в pasku может отличаться.</div>`
    : `<div class="age-ok n"><b>${ys.age}</b> лет: PIT 12%, kwota zmniejszająca ${p.pit2 ? '300 zł' : 'не применяется'}.</div>`;
  const rateChip = (m, t) => `<button class="chip${p.rateMode === m ? ' on' : ''}" data-act="rate" data-v="${m}">${t}</button>`;
  $('wallet-form').innerHTML = `
    <div class="card wstep"><div class="wstep-h"><i>1</i><b>Возраст</b><small>для налога PIT</small></div>
      <label class="field"><span>Дата рождения</span><input class="in" type="date" id="w-birth" value="${p.birth}" max="${C.iso(new Date())}" data-in="birth"></label>
      <label class="check" style="margin:12px 0 0"><input type="checkbox" id="w-birth-ok" data-act="birth-ok" ${p.birthOk ? 'checked' : ''} ${p.birth ? '' : 'disabled'}><span>Подтверждаю, что дата рождения верна</span></label>
      ${ageLine}${ys.status === 'yes' || ys.status === 'partial' ? ytdBlock(v) : ''}</div>

    <div class="card wstep"><div class="wstep-h"><i>2</i><b>Ставка в час</b><small>брутто</small></div>
      <div class="chips">${rateChip('33.00', '33,00 AutoDoc')}${rateChip('31.40', '31,40 мин.')}${rateChip('35.00', '35,00')}${rateChip('own', 'Своя')}</div>
      ${p.rateMode === 'own' ? `<label class="field" style="margin-top:10px"><span>Своя ставка, zł/ч</span><input class="in" type="number" inputmode="decimal" step="0.01" min="0" max="500" id="w-rate" value="${p.rate}" data-in="w"></label>` : ''}</div>

    <div class="card wstep"><div class="wstep-h"><i>3</i><b>Часы за ${MONTHS[+v.W.slice(5) - 1]}</b></div>
      ${a.has ? `<div class="auto"><span>По графику ${esc(teamMeta(DB.team).label)} ${DB.group}: ${a.shifts} ${plural(a.shifts, 'смена', 'смены', 'смен')}, ${h1(a.hours)} ч, ночных ${h1(a.night)}</span><button class="link" data-act="w-auto">Подставить</button></div>` : ''}
      <div class="grid3">
        <label class="field"><span>Отработано</span><input class="in" type="number" inputmode="decimal" step="0.5" min="0" id="w-hours" value="${i.hours}" data-in="w"></label>
        <label class="field"><span>Из них ночью</span><input class="in" type="number" inputmode="decimal" step="0.5" min="0" id="w-night" value="${i.nightHours}" data-in="w"></label>
        <label class="field"><span>Отпуск, ч</span><input class="in" type="number" inputmode="decimal" step="1" min="0" id="w-urlop" value="${i.urlopHours}" data-in="w"></label>
      </div>
      ${urlopBlock(v.W, i)}${absBlock(v)}</div>

    <div class="card wstep"><div class="wstep-h"><i>4</i><b>Сверхурочные</b><small>из календаря: ${h1(a.o50 + a.o100)} ч</small></div>
      <div class="grid3">
        <label class="field"><span>+50%, ч</span><input class="in" type="number" inputmode="decimal" step="0.5" min="0" id="w-o50" value="${i.ovt50}" data-in="w"></label>
        <label class="field"><span>+100%, ч</span><input class="in" type="number" inputmode="decimal" step="0.5" min="0" id="w-o100" value="${i.ovt100}" data-in="w"></label>
        <label class="field"><span>Из них ночью</span><input class="in" type="number" inputmode="decimal" step="0.5" min="0" id="w-on" value="${i.ovtNight}" data-in="w"></label>
      </div></div>

    <div class="card wstep"><div class="wstep-h"><i>5</i><b>Налоги и доплаты</b></div>
      <div class="field"><span>Koszty uzyskania przychodu</span><div class="chips"><button class="chip${p.kup === 'local' ? ' on' : ''}" data-act="kup" data-v="local">250 zł, живу в Щецине</button><button class="chip${p.kup === 'commute' ? ' on' : ''}" data-act="kup" data-v="commute">300 zł, езжу из другого города</button></div></div>
      <div class="field" style="margin-top:10px"><span>Ночная доплата 20%</span><div class="chips"><button class="chip${p.nightBasis === 'min' ? ' on' : ''}" data-act="nb" data-v="min">от минималки, ${money(C.salary({ month: v.W, rate: 0 }).minHourly)} zł/ч</button><button class="chip${p.nightBasis === 'own' ? ' on' : ''}" data-act="nb" data-v="own">от моей ставки</button></div></div>
      <label class="switch" style="margin-top:8px"><span><b>PIT-2 подан</b><small>минус 300 zł налога каждый месяц</small></span><span class="tg"><input type="checkbox" data-act="pit2" ${p.pit2 ? 'checked' : ''}><i></i></span></label>
      <label class="switch"><span><b>Участвую в PPK</b><small>2% с меня, 1,5% от работодателя</small></span><span class="tg"><input type="checkbox" data-act="ppk" ${p.ppk ? 'checked' : ''}><i></i></span></label>
      ${DB.team === 'dark' ? `<label class="field" style="margin-top:6px"><span>Dodatek DARK, zł</span><input class="in" type="number" inputmode="decimal" step="1" min="0" id="w-dark" value="${p.dark}" data-in="w"></label>
      <p class="hint" style="margin-top:6px">300 zł, если отработаны все смены по графику; отпуск не мешает. При пропусках доплату могут уменьшить.</p>` : ''}
      <div class="grid2" style="margin-top:10px">
        <label class="field"><span>Эквивалент за одежду и стирку</span><input class="in" type="number" inputmode="decimal" step="0.01" min="0" id="w-ekw" value="${p.ekw}" data-in="w"></label>
        <label class="field"><span>Удержания (benefit и т.п.)</span><input class="in" type="number" inputmode="decimal" step="0.01" min="0" id="w-ded" value="${p.deduct || ''}" placeholder="0" data-in="w"></label>
      </div>
      <p class="hint" style="margin-top:6px">Эквивалент (12,00 + 10,95 zł) идёт без налога прямо в «на руки». Удержания — например, карта Multisport, если она есть в pasku.</p>
      <label class="field" style="margin-top:10px"><span>Другие доплаты брутто, zł</span><input class="in" type="number" inputmode="decimal" step="0.01" min="0" id="w-extra" value="${p.extra || ''}" placeholder="0" data-in="w"></label>
    </div>
    <div class="save-row"><button class="btn btn-acc" data-act="w-save">${v.saved ? 'Обновить расчёт' : 'Сохранить расчёт'}</button><button class="btn btn-ghost" data-act="w-reset" aria-label="Сбросить к графику">Сбросить</button></div>`;
}

// Пропуски и множитель премии за обецность.
function absBlock(v) {
  const auto = autoHours(v.W).absences, n = v.inp.absences ?? auto, f = C.premiumFactor(n);
  const chip = (k, t) => `<button class="chip${Math.min(n, 2) === k ? ' on' : ''}" data-act="w-abs" data-v="${k}">${t}</button>`;
  return `<div class="urlop-box">
    <div class="field"><span>Пропуски в ${MONTHS_GEN[+v.W.slice(5) - 1].replace(/я$/, 'е').replace(/а$/, 'е')}</span>
      <div class="chips">${chip(0, '0 · ×1,25')}${chip(1, '1 · ×0,80')}${chip(2, '2+ · 0')}</div></div>
    <p>Без пропусков премия ×1,25, с одним пропуском ×0,80, с двумя и больше премии нет. ${auto ? `В календаре отмечено ${auto}.` : 'Отмечай пропуски в календаре — посчитается само.'}${n !== auto ? ` <button class="link" data-act="w-abs-auto">Взять из календаря (${auto})</button>` : ''} Сейчас премия ×${fx(f)}.</p>
  </div>`;
}

// Отпускные: ставка + средняя доплата за час. Показываем, откуда взялось число.
function urlopBlock(W, i) {
  const ua = urlopAuto(W), uv = i.urlopVar ?? ua.perHour;
  const span = ua.months ? (ua.from === ua.to ? MONTHS[+ua.from.slice(5) - 1] : `${MONTHS[+ua.from.slice(5) - 1]}–${MONTHS[+ua.to.slice(5) - 1]}`) : '';
  const note = ua.months
    ? `Среднее за ${span} (3 месяца по дате выплаты): премия, сверхурочные, ночные${DB.team === 'dark' ? ' и Dodatek DARK' : ''} делятся на отработанные часы — ${money(ua.perHour)} zł/ч${ua.est ? ', оценка по графику и архиву' : ''}.`
    : 'Нет данных за прошлые месяцы. Впиши среднюю доплату из pasku или оставь 0.';
  const differs = ua.months && Math.abs(uv - ua.perHour) > 0.004;
  return `<div class="urlop-box">
    <label class="field"><span>Доплата к часу отпуска, zł/ч</span><input class="in" type="number" inputmode="decimal" step="0.01" min="0" max="200" id="w-uvar" value="${uv}" data-in="w"></label>
    <p>${note} Час отпуска = ставка + доплата.${differs ? ` <button class="link" data-act="w-uvar-auto">Вернуть ${money(ua.perHour)}</button>` : ''}</p>
  </div>`;
}

// Лимит ulga dla młodych: сколько дохода с начала года уже набрано.
function ytdBlock(v) {
  const ytd = v.inp.ytd ?? ytdAuto(v.W), left = Math.max(0, C.TAX.YOUNG_LIMIT - ytd);
  return `<label class="field" style="margin-top:12px"><span>Брутто с января до ${MONTHS_GEN[+v.W.slice(5) - 1]}, zł</span>
    <input class="in" type="number" inputmode="decimal" step="0.01" min="0" id="w-ytd" value="${ytd}" data-in="w"></label>
    <p class="hint" style="margin-top:6px">${left > 0 ? `Без PIT осталось ${money(left)} zł из ${int(C.TAX.YOUNG_LIMIT)}.` : 'Лимит ulga исчерпан — PIT удерживается.'} Сумма берётся из прошлых выплат кошелька, впиши точную из последнего pasku.</p>`;
}

function renderBreakdown(r) {
  const row = (k, v, cls = '', sub = '') => v || cls ? `<tr class="${cls}"><td>${k}${sub ? `<small>${sub}</small>` : ''}</td><td>${cls === 'minus' ? '−' : ''}${money(v)}</td></tr>` : '';
  $('wallet-break').innerHTML = `<h2 class="sec">Из чего складывается</h2><div class="card"><table class="tbl">
    ${row('Основные часы', r.parts.base, '', `${money(r.rate)} zł/ч`)}${row('Отпуск (urlop)', r.parts.urlop, '', r.urlopVar ? `${money(r.rate)} + ${money(r.urlopVar)} средних доплат = ${money(r.urlopRate)} zł/ч` : `${money(r.rate)} zł/ч`)}
    ${row('Ночная доплата', r.parts.night, '', `${money(r.nightRate)} zł за ночной час`)}${row('Сверхурочные +50%', r.parts.ovt50)}${row('Сверхурочные +100%', r.parts.ovt100)}
    ${r.parts.bonus ? row('Премия (zadaniowa)', r.parts.bonus, '', [r.bonusBase ? `пики ${money(r.bonusBase)} × ${fx(r.premiumFactor)} за обецность` : '', r.indirect ? `Indirect ${money(r.indirect)}` : ''].filter(Boolean).join(' + ')) : ''}${row('Dodatek DARK', r.parts.dark)}${row('Другие доплаты', r.parts.extra)}
    <tr class="tot"><td>Брутто</td><td>${money(r.brutto)}</td></tr>
    ${row('ZUS: пенсионный, рентовый, больничный', r.zus, 'minus', '13,71% от брутто')}
    ${row('Składka zdrowotna', r.health, 'minus', '9% от брутто без ZUS')}
    ${row('PIT', r.pit, 'minus', r.young && !r.pit ? 'ulga dla młodych' : `12% от ${int(r.pitBase)} zł${DB.profile.pit2 ? ' минус 300' : ''}${r.young ? ', сверх лимита ulga' : ''}`)}
    ${r.ppkEmp ? row('PPK', r.ppkEmp, 'minus', '2%') : ''}
    ${r.ekw ? `<tr><td>Эквивалент: одежда и стирка<small>без налога</small></td><td>+${money(r.ekw)}</td></tr>` : ''}
    ${r.deduct ? row('Удержания', r.deduct, 'minus', 'benefit и т.п.') : ''}
    <tr class="tot net"><td>На руки</td><td>${money(r.netto)}</td></tr></table></div>
    <p class="hint">Ориентир по ставкам 2026 года. Точная сумма — в pasku płacowym.</p>`;
}

function readWalletInputs() {
  const n = id => { const el = $(id); return el ? Math.max(0, Number(String(el.value).replace(',', '.')) || 0) : 0; };
  const W = C.walletMonth();
  if ($('w-rate')) DB.profile.rate = Math.min(500, n('w-rate'));
  DB.profile.extra = Math.min(1e5, n('w-extra'));
  if ($('w-dark')) DB.profile.dark = Math.min(5000, n('w-dark'));
  if ($('w-ekw')) DB.profile.ekw = Math.min(1000, n('w-ekw'));
  if ($('w-ded')) DB.profile.deduct = Math.min(5000, n('w-ded'));
  const inp = { month: W, hours: n('w-hours'), nightHours: n('w-night'), urlopHours: n('w-urlop'), ovt50: n('w-o50'), ovt100: n('w-o100'), ovtNight: n('w-on') };
  if ($('w-uvar')) inp.urlopVar = Math.min(200, n('w-uvar'));
  if ($('w-ytd')) inp.ytd = Math.min(1e6, n('w-ytd'));
  DB.wallet.draft = inp;
  return inp;
}
function walletLive() {
  const inp = readWalletInputs(); save();
  const r = C.salary(salaryInput(inp));
  countUp($('slip-netto'), r.netto); STATE.slipV = r.netto;
  renderBreakdown(r);
}

// ═════════════════════ INDIRECT ═════════════════════
// Премия Indirect (процессы поддержки: Doki, Migracja, Operator wózka…) не
// считается по пикам: человек вписывает сумму из pasku и часы на Indirect.
// Сумма и часы без имени уходят на сервер — из них складывается средняя
// ставка Indirect за час по складу.
const indirectFor = mk => DB.indirect.find(x => x.month === mk) || null;
const indAmount = mk => (indirectFor(mk) || {}).amount || 0;
const indRate = x => x && x.hours > 0 ? C.r2(x.amount / x.hours) : 0;
// Месяц по умолчанию: текущий, а до 10-го — прошлый (премию узнают из pasku).
const indMonthDefault = () => C.walletMonth();

async function loadIndStats(force) {
  if (!STATE.verified || STATE.indBusy || (!force && STATE.indStats && Date.now() - STATE.indAt < 600000)) return;
  STATE.indBusy = true;
  try {
    const j = await api('indirect_stats', {});
    if (j && j.months && typeof j.months === 'object') {
      STATE.indStats = j.months; STATE.indAt = Date.now();
      if ((STATE.stack[STATE.stack.length - 1] || STATE.tab) === 'home') renderIndirect();
    }
  } catch {} finally { STATE.indBusy = false; }
}
// Свежий месяц, где у склада есть данные: сначала выбранный, потом назад.
function indCommunity(mk) {
  const st = STATE.indStats || {};
  for (let i = 0; i < 4; i++) { const m = C.addMonths(mk, -i), x = st[m]; if (x && x.n > 0 && x.rate > 0) return { ...x, month: m }; }
  return null;
}

function renderIndirect() {
  const el = $('ind-bar'); if (!el) return;
  const mk = indMonthDefault(), mine = indirectFor(mk), com = indCommunity(mk);
  el.innerHTML = `<span class="ind-ic" aria-hidden="true">${mine ? 'ID' : '＋'}</span>
    <span class="ind-b"><b>Indirect${mine ? ` · ${MONTHS[+mk.slice(5) - 1]}` : ''}</b><small>${mine ? `${money(mine.amount)} zł · ${h1(mine.hours)} ч · ${money(indRate(mine))}/ч` : 'добавь премию и часы на Indirect'}</small></span>
    <span class="ind-r">${com ? `${money(com.rate)}<small>zł/ч, склад · ${com.n}</small>` : '<small>ставка склада<br>появится скоро</small>'}</span>`;
  loadIndStats();
}

function indSheet(mk) {
  STATE.indMonth = mk;
  const cur = indirectFor(mk), com = indCommunity(mk), opts = [C.addMonths(C.monthKey(new Date()), -1), C.monthKey(new Date())];
  sheet(`<h3>Премия Indirect</h3>
    <p>Для работы на процессах поддержки: Doki, Migracja, Odpady, Operator wózka, Problem Solver и др. Впиши сумму премии из pasku и сколько часов был на Indirect — трекер посчитает ставку за час и добавит премию в кошелёк.</p>
    <div class="chips" style="margin:4px 0 12px">${opts.map(m => `<button class="chip${m === mk ? ' on' : ''}" data-act="ind-month" data-v="${m}">${cap(MONTHS[+m.slice(5) - 1])}${indirectFor(m) ? ' ✓' : ''}</button>`).join('')}</div>
    <div class="grid2">
      <label class="field"><span>Премия, zł брутто</span><input class="in" type="number" inputmode="decimal" step="0.01" min="0" max="20000" id="ind-a" value="${cur ? cur.amount : ''}" placeholder="850" data-in="ind"></label>
      <label class="field"><span>Часов на Indirect</span><input class="in" type="number" inputmode="decimal" step="0.5" min="0" max="400" id="ind-h" value="${cur ? cur.hours : ''}" placeholder="96" data-in="ind"></label>
    </div>
    <div class="ind-prev" id="ind-prev"></div>
    <p class="hint">Сумма и часы без имени попадут в общую статистику — так считается средняя ставка Indirect за час по складу${com ? `: сейчас ${money(com.rate)} zł/ч у ${com.n} ${plural(com.n, 'человека', 'человек', 'человек')} (${MONTHS[+com.month.slice(5) - 1]})` : ''}.</p>
    <div class="stack"><button class="btn btn-acc btn-wide" data-act="ind-save">Сохранить</button>
    ${cur ? '<button class="btn btn-ghost btn-wide" data-act="ind-del">Удалить за этот месяц</button>' : '<button class="btn btn-ghost btn-wide" data-act="sheet-close">Отмена</button>'}</div>`);
  indPreview();
}
function indPreview() {
  const box = $('ind-prev'); if (!box) return;
  const a = Number(String($('ind-a').value).replace(',', '.')) || 0, h = Number(String($('ind-h').value).replace(',', '.')) || 0;
  const com = indCommunity(STATE.indMonth);
  if (!(a > 0 && h > 0)) { box.innerHTML = ''; return; }
  const r = C.r2(a / h), d = com ? C.r2(r - com.rate) : 0;
  box.innerHTML = `<div><span>Твоя ставка</span><b>${money(r)} zł/ч</b></div>${com ? `<div><span>Склад в среднем</span><b>${money(com.rate)} zł/ч</b></div><div><span>Разница</span><b class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : '−'}${money(Math.abs(d))}</b></div>` : ''}`;
}
function indSave(del) {
  const mk = STATE.indMonth, num = id => Number(String($(id)?.value || '').replace(',', '.')) || 0;
  const amount = del ? 0 : Math.min(20000, Math.max(0, num('ind-a'))), hours = del ? 0 : Math.min(400, Math.max(0, num('ind-h')));
  if (!del && !(amount > 0 && hours > 0)) { haptic.err(); toast('Впиши сумму и часы'); return; }
  if (!del && amount / hours > 80) { haptic.err(); toast('Больше 80 zł за час — проверь сумму и часы'); return; }
  DB.indirect = DB.indirect.filter(x => x.month !== mk);
  if (!del) DB.indirect.push({ month: mk, amount: C.r2(amount), hours: Math.round(hours * 10) / 10, at: new Date().toISOString() });
  DB.indirect.sort((a, b) => (a.month < b.month ? -1 : 1)); DB.indirect = DB.indirect.slice(-24);
  save(); haptic.ok(); closeSheet();
  if (STATE.verified) api('indirect', { month: mk, amount: del ? 0 : amount, hours: del ? 0 : hours }).then(() => loadIndStats(true)).catch(() => {});
  pushRank(); renderHome();
  toast(del ? 'Indirect за месяц удалён' : `Indirect: ${money(amount)} zł, ${money(C.r2(amount / hours))} zł/ч — добавлено в кошелёк`);
  renderIndirect();
}

// ═════════════════════ ODCINEK ═════════════════════
// Odcinek płacowy разбирается на телефоне (slip.js), проверка — в core.js.
// Наружу уходит только дата, когда пришли деньги: из дат всех людей
// складывается прогноз следующей зарплаты.
const LV = {
  ok:   { ic: '✓', title: 'Odcinek верный' },
  warn: { ic: '!', title: 'Налоги верные, есть вопросы' },
  bad:  { ic: '✕', title: 'В odcinku ошибка' },
};
const ITEM_IC = { ok: '✓', info: 'i', warn: '!', bad: '✕' };
const slipsOf = mk => DB.slips.filter(s => s.month === mk).sort((a, b) => (a.kind === 'main' ? 0 : 1) - (b.kind === 'main' ? 0 : 1) || (a.list < b.list ? -1 : 1));
const dayLong = day => { const [, m, d] = day.split('-').map(Number); return `${d} ${MONTHS_GEN[m - 1]}`; };

// Что насчитал сам трекер за месяц — с этим сверяем odcinek.
function trackerNetto(mk) {
  const h = DB.wallet.hist.find(x => x.month === mk);
  if (h && h.calc) return h.calc.netto;
  if (h && !h.slip) return h.netto;
  if (DB.wallet.cur && DB.wallet.cur.month === mk) return C.salary(salaryInput(DB.wallet.cur.inp)).netto;
  return autoHours(mk).has ? C.salary(salaryInput(autoInp(mk))).netto : 0;
}
function slipCtx(mk) {
  const a = autoHours(mk), base = bonusFor(mk), pf = C.premiumFactor(a.absences), ys = youngFor(mk), ind = indAmount(mk);
  return { young: ys.status === 'yes' || ys.status === 'partial' ? true : ys.status === 'no' ? false : null, team: DB.team,
    tracker: { bonusBase: C.r2(base), bonus: C.r2(base * pf + ind), pf, indirect: ind, has: a.has, hours: a.hours, urlopHours: a.urlop, netto: trackerNetto(mk) } };
}
const slipResultOf = mk => { const ss = slipsOf(mk); return ss.length ? C.slipCheck(ss, slipCtx(mk)) : null; };
const slipLevel = mk => (slipResultOf(mk) || {}).level || null;
const slipIc = mk => (LV[slipLevel(mk)] || LV.ok).ic;
// Одна строка для истории: недоплата премии или «всё сходится».
function slipShort(mk) {
  const r = slipResultOf(mk); if (!r) return '';
  const bad = r.items.find(i => i.level === 'bad');
  return `<small class="oc-note ${r.level}">${bad ? esc(`${bad.title}: ${bad.text.split('. ')[0]}`) : r.level === 'ok' ? 'по odcinku всё сходится' : 'есть вопросы — открой проверку'}</small>`;
}

// Сумма odcinków месяца → «Прошлые выплаты». Прежний расчёт трекера — в calc.
function syncSlipHist(mk) {
  const ss = slipsOf(mk), hist = DB.wallet.hist, i = hist.findIndex(h => h.month === mk), h = i >= 0 ? hist[i] : null;
  if (!ss.length) {
    if (h && h.slip) { if (h.calc) { const { calc, slip, ...rest } = h; hist[i] = { ...rest, ...calc }; } else hist.splice(i, 1); }
    return;
  }
  const sum = fn => C.r2(ss.reduce((t, x) => t + fn(x), 0));
  const ovtOf = x => Object.values(x.ovt || {});
  const v = sum(x => (x.f.bonus || 0) + (x.f.night || 0) + (x.f.dark || 0) + (x.f.ovtTotal ?? ovtOf(x).reduce((a, o) => a + (o.amount || 0), 0)));
  const hrs = sum(x => (x.f.hours || 0) + ovtOf(x).reduce((a, o) => a + (o.hours || 0), 0));
  const calc = h && !h.slip ? { netto: h.netto, brutto: h.brutto, bonus: h.bonus } : h && h.calc;
  const row = { month: mk, netto: sum(x => x.f.netto), brutto: sum(x => x.f.brutto), bonus: sum(x => x.f.bonus || 0), savedAt: (h && h.savedAt) || new Date().toISOString(), slip: true,
    ...(calc ? { calc } : {}), ...(hrs > 0 ? { var: v, hours: hrs } : h && h.hours ? { var: h.var, hours: h.hours } : {}) };
  if (h) hist[i] = row; else { hist.push(row); hist.sort((a, b) => (a.month < b.month ? 1 : -1)); }
  DB.wallet.hist = hist.slice(0, 36);
}

// ── дата зарплаты: правило + даты, которые отметили люди ──
function payReports() {
  if (STATE.paydays) return STATE.paydays;
  const r = {};                                            // сервер недоступен — хотя бы свои отметки
  DB.slips.filter(s => s.kind === 'main' && s.gotOn).forEach(s => { (r[s.month] = r[s.month] || {})[s.gotOn] = 1; });
  return r;
}
async function loadPaydays(force) {
  if (!STATE.verified || (!force && STATE.paydays && Date.now() - STATE.paydaysAt < 600000)) return;
  if (STATE.paydaysBusy) return;
  STATE.paydaysBusy = true;
  try {
    const j = await api('paydays', {});
    if (j && j.reports && typeof j.reports === 'object') {
      STATE.paydays = j.reports; STATE.paydaysAt = Date.now();
      const top = STATE.stack[STATE.stack.length - 1] || STATE.tab;
      if (top === 'home') renderPlateCheck(); else if (top === 'odcinek') renderOdcinek(); else if (top === 'sched' && STATE.schedTab === 'cal') renderCal();
    }
  } catch {} finally { STATE.paydaysBusy = false; }
}
function reportPay(s) {
  if (!STATE.verified) return;
  api('payday', { month: s.month, kind: s.kind, paid_on: s.gotOn || '' }).then(() => loadPaydays(true)).catch(() => {});
}
// Своя отметка о приходе денег сильнее прогноза.
function paydayFor(W) {
  const p = C.payday(W, payReports()), own = DB.slips.find(s => s.month === W && s.kind === 'main' && s.gotOn);
  return own ? { ...p, actual: own.gotOn, own: true } : p;
}
// Ближайшая зарплата: за прошлый месяц, пока она не пришла и срок не прошёл, иначе — за текущий.
function nextPay(now = new Date()) {
  const today = C.iso(now), mk = C.monthKey(now), W = C.addMonths(mk, -1), p = paydayFor(W);
  const came = p.actual && p.actual <= today;
  return { last: came ? p : null, next: came || today > p.deadline ? paydayFor(mk) : p };
}
const likely = p => (p.days.find(x => x.p >= .5) || p.days[p.days.length - 1] || { day: p.deadline, p: 1 });
function payText(p) {
  const l = likely(p);
  return l.day === p.deadline ? `до ${dayLong(p.deadline)}` : `≈ ${dayLong(l.day)} (${Math.round(l.p * 100)}%), точно до ${dayLong(p.deadline)}`;
}

function renderPlateCheck() {
  const el = $('plate-check-sub'); if (!el) return;
  const last = [...new Set(DB.slips.map(s => s.month))].sort().pop(), np = nextPay(), l = likely(np.next);
  const lv = last ? slipLevel(last) : null;
  el.textContent = `${lv ? `${MONTHS[+last.slice(5) - 1]}: ${lv === 'ok' ? 'верно ✓' : lv === 'bad' ? 'ошибка ✕' : 'есть вопросы'} · ` : ''}зарплата ${l.day === np.next.deadline ? 'до' : '≈'} ${dayLong(l.day)}`;
  loadPaydays();
}

function renderOdcinek() {
  loadPaydays();
  const months = [...new Set(DB.slips.map(s => s.month))].sort().reverse();
  const view = months.includes(STATE.slipView) ? STATE.slipView : months[0];
  const np = nextPay(), nW = np.next.month;
  const ppl = Object.values(payReports()[nW] || {}).reduce((a, b) => a + b, 0);
  $('odcinek').innerHTML = `
    <div class="card oc-up">
      <p>Загрузи odcinek płacowy — PDF из письма или портала. Трекер прочитает его прямо на телефоне, файл никуда не уходит. Проверим налоги, премию, часы, ночные и отпускные.</p>
      ${STATE.slipErr ? `<div class="oc-err">${esc(STATE.slipErr)}</div>` : ''}
      <button class="btn btn-acc btn-wide" data-act="slip-pick" id="slip-pick">Загрузить odcinek, PDF</button>
    </div>
    <div class="card pay-card">
      <div class="pay-ic" aria-hidden="true">zł</div>
      <div class="pay-b">
        ${np.last ? `<small class="pay-last">За ${MONTHS[+np.last.month.slice(5) - 1]} пришла ${dayLong(np.last.actual)}${np.last.own ? '' : `, отметили ${np.last.actualN}`}</small>` : ''}
        <b>Зарплата за ${MONTHS[+nW.slice(5) - 1]}</b>
        <span>${np.next.actual ? `пришла ${dayLong(np.next.actual)}${np.next.own ? ', твоя отметка' : `, отметили ${np.next.actualN}`}` : esc(payText(np.next))}</span>
        ${np.next.actual ? '' : `<div class="pay-bar">${np.next.days.map((x, i, a) => `<i style="flex:${Math.max(.2, x.p - (i ? a[i - 1].p : 0))}"><b>${+x.day.slice(8)}</b><small>${Math.round(x.p * 100)}%</small></i>`).join('')}</div>`}
      </div>
    </div>
    <p class="hint">Зарплата — до 10-го. Если 10-е выпадает на выходной или праздник, деньги приходят в последний рабочий день перед ним, а часто на день раньше срока. ${np.next.src === 'data' ? `Прогноз уточнён по датам людей за ${np.next.months} ${plural(np.next.months, 'месяц', 'месяца', 'месяцев')}.` : 'Отмечай, когда пришли деньги, — прогноз станет точнее для всех.'}${ppl && !np.next.actual ? ` Уже отметили: ${ppl}.` : ''}</p>
    ${view ? slipCard(view) : ''}
    ${months.length > 1 ? `<h2 class="sec">Проверенные месяцы</h2><div class="list">${months.map(m => slipRow(m, m === view)).join('')}</div>` : ''}`;
}

function slipRow(mk, on) {
  const ss = slipsOf(mk), r = slipResultOf(mk), lv = LV[r.level];
  return `<button class="strow${on ? ' me-row' : ''}" data-act="slip-view" data-m="${mk}"><span class="st-tag oc-tag ${r.level}">${lv.ic}</span>
    <span class="strow-b"><b>${mLabel(mk)}</b><small>${ss.length > 1 ? `${ss.length} листа, ` : ''}выплата ${ss[0].payDate ? fmtD(ss[0].payDate) : '—'}</small></span>
    <span class="strow-r">${money(r.netto)}<small>zł на руки</small></span></button>`;
}

function slipCard(mk) {
  const ss = slipsOf(mk), r = slipResultOf(mk), lv = LV[r.level], today = C.iso(new Date());
  return `<div class="card oc-res ${r.level}" id="oc-res">
    <div class="oc-v"><span class="oc-ic">${lv.ic}</span><div><b>${lv.title}</b><small>${mLabel(mk)}: ${ss.map(s => esc(s.kind === 'kor' ? `korekta ${s.list}` : `lista ${s.list || 'główna'}`)).join(' + ')}</small></div></div>
    <div class="oc-sum"><div><span>На руки</span><b>${money(r.netto)}</b></div><div><span>Брутто</span><b>${money(r.brutto)}</b></div><div><span>Премия</span><b>${money(r.bonus)}</b></div></div>
    <ul class="oc-list">${r.items.map(i => `<li class="${i.level}"><i aria-hidden="true">${ITEM_IC[i.level]}</i><div><b>${esc(i.title)}</b><small>${esc(i.text)}</small></div></li>`).join('')}</ul>
    ${ss.map(s => `<div class="oc-got">
      <label class="field"><span>${s.kind === 'kor' ? 'Korekta пришла' : 'Деньги пришли'} на счёт</span><input class="in" type="date" value="${s.gotOn}" max="${today}" data-in="slip-got" data-id="${esc(s.id)}"></label>
      <button class="chip" data-act="slip-today" data-id="${esc(s.id)}">Сегодня</button></div>
      <small class="oc-hint">В odcinku дата выплаты ${s.payDate ? fmtD(s.payDate) : '—'}. Дата прихода без сумм и имени попадёт в общий прогноз зарплаты.</small>`).join('')}
    ${slipSuggest(mk, r.profile)}
    <button class="btn btn-ghost btn-wide" style="margin-top:12px" data-act="slip-del" data-m="${mk}">Удалить odcinek за ${MONTHS[+mk.slice(5) - 1]}</button>
  </div>`;
}

// Что из odcinka стоит перенести в настройки кошелька.
function slipChanges(pr) {
  const p = DB.profile, out = [];
  if (pr.rate && Math.abs(pr.rate - currentRate()) > .004) out.push(['rate', `ставка ${money(pr.rate)} zł/ч`]);
  if (pr.ekw !== undefined && Math.abs(pr.ekw - p.ekw) > .004) out.push(['ekw', `эквиваленты ${money(pr.ekw)} zł`]);
  if (Math.abs((pr.deduct || 0) - p.deduct) > .004) out.push(['deduct', `удержания (benefit) ${money(pr.deduct || 0)} zł`]);
  if (pr.kup && pr.kup !== p.kup) out.push(['kup', `KUP ${pr.kup === 'commute' ? 300 : 250} zł`]);
  if (pr.ppk !== p.ppk) out.push(['ppk', pr.ppk ? 'PPK включён' : 'PPK выключен']);
  return out;
}
function slipSuggest(mk, pr) {
  const ch = slipChanges(pr);
  const young = pr.youngLikely && !DB.profile.birthOk ? '<p class="hint" style="margin-top:10px">PIT 0 zł — похоже, у тебя ulga dla młodych. Подтверди дату рождения в кошельке, чтобы расчёт совпадал.</p>' : '';
  if (!ch.length) return young;
  return `${young}<div class="oc-apply"><b>В кошельке другие цифры</b><small>${ch.map(c => c[1]).join(', ')}</small>
    <button class="btn btn-acc btn-wide" data-act="slip-apply" data-m="${mk}">Взять из odcinka</button></div>`;
}

async function slipUpload(file) {
  const btn = $('slip-pick'); if (btn) { btn.disabled = true; btn.textContent = 'Читаю odcinek…'; }
  STATE.slipErr = '';
  try {
    const parsed = await window.Slip.readFile(file);
    const id = `${parsed.month}#${parsed.list || parsed.kind}`;
    const prev = DB.slips.find(x => x.id === id);
    const rec = cleanSlip({ ...parsed, id, gotOn: prev ? prev.gotOn : '', at: new Date().toISOString() });
    if (!rec) throw new Error('not-odcinek');
    DB.slips = [...DB.slips.filter(x => x.id !== id), rec].slice(-36);
    syncSlipHist(rec.month); save(); haptic.ok();
    STATE.slipView = rec.month;
    renderOdcinek();
    const r = slipResultOf(rec.month);
    toast(r.level === 'ok' ? `Odcinek за ${MONTHS[+rec.month.slice(5) - 1]}: всё верно` : r.level === 'bad' ? 'В odcinku есть ошибка' : 'Odcinek прочитан, есть вопросы');
    $('oc-res')?.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
  } catch (e) {
    haptic.err();
    STATE.slipErr = ({ 'no-inflate': 'Телефон не умеет распаковывать PDF. Обнови Telegram или систему.', 'not-pdf': 'Это не PDF. Нужен файл odcinka из письма или портала.',
      'too-big': 'Файл больше 3 МБ — это точно odcinek?', 'not-odcinek': 'В файле нет odcinka AutoDoc: не нашёл брутто и сумму к выплате.',
      'no-text': 'В PDF нет текста — похоже, это скан или фото. Нужен PDF из письма.' })[e && e.message] || 'Не получилось прочитать файл. Нужен PDF odcinka из письма.';
    renderOdcinek();
  } finally { const fi = $('slip-file'); if (fi) fi.value = ''; }
}

function setSlipGot(id, day) {
  const s = DB.slips.find(x => x.id === id); if (!s) return;
  s.gotOn = RE_DAY.test(day) && day <= C.iso(new Date()) ? day : '';
  save(); reportPay(s); haptic.pick();
  if (s.gotOn) toast(`Отмечено: пришла ${dayLong(s.gotOn)}`);
  renderOdcinek();
}

// ═════════════════════ ЕЩЁ ═════════════════════
async function renderRating() {
  const m = STATE.rankMonth || C.monthKey(new Date());
  $('rank-month').textContent = mLabel(m);
  const wrap = $('rank-list'); wrap.innerHTML = '<div class="empty">Загружаю…</div>';
  try {
    const q = cols => fetch(`${CFG.SB_URL}/rest/v1/leaderboard?month=eq.${m}&order=bonus.desc&limit=100&select=${cols}`,
      { headers: { apikey: CFG.SB_KEY, Authorization: 'Bearer ' + CFG.SB_KEY } });
    let r = await q('pub,name,emoji,bonus,peaks,shifts,ppc,team,grp');
    if (r.status === 400 || r.status === 401) r = await q('pub,name,emoji,bonus,peaks,shifts,ppc');   // база ещё без колонок смены
    if (!r.ok) throw 0;
    const rows = await r.json();
    if (!rows.length) { wrap.innerHTML = '<div class="empty"><b>Пока никого</b>Запиши смену — и окажешься в таблице.</div>'; return; }
    const medal = ['🥇', '🥈', '🥉'];
    wrap.innerHTML = rows.map((x, i) => { const me = !!STATE.pub && x.pub === STATE.pub; return `
      <div class="strow${me ? ' me-row' : ''}"><span class="rk">${i < 3 ? medal[i] : i + 1}</span>
        <span class="strow-b"><span class="rk-name"><b>${esc(x.emoji || '👷')} ${esc(x.name || 'Аноним')}${me ? ' (ты)' : ''}</b>${teamTag(x.team, x.grp)}</span><small>${int(x.peaks)} шт, ${int(x.shifts)} ${plural(+x.shifts || 0, 'смена', 'смены', 'смен')}, темп ${h1(x.ppc)}</small></span>
        <span class="strow-r">${money(x.bonus)}<small>zł</small></span></div>`; }).join('');
  } catch { wrap.innerHTML = '<div class="empty"><b>Нет связи с базой</b>Проверь интернет и открой раздел снова.</div>'; }
}

// Маленький бейдж смены в рейтинге: точка цвета смены + «DARK A». Не переносится,
// имя рядом обрезается многоточием — строка не разъезжается на узком экране.
function teamTag(team, grp) {
  if (!TEAM_COL[team]) return '';
  const label = teamMeta(team).label + (/^[A-F]$/.test(grp || '') ? ' ' + grp : '');
  return `<span class="tm-tag" style="--tc:${TEAM_COL[team]}" title="Смена ${esc(label)}">${esc(label)}</span>`;
}

// Итоги месяца: всё, что влияет на деньги, — смены, отпуск, пропуски,
// праздники, сверхурочные, ночные, пики и премия с обецностью.
function monthStats(mk) {
  const p = plan(mk), a = autoHours(mk), cur = mk === C.monthKey(new Date());
  let scheduled = 0, urlopDays = 0;
  if (p) for (const [d, span] of Object.entries(p.days)) if (span) { scheduled++; if (DB.urlop[mk]?.[d]) urlopDays++; }
  const urlopMarked = Object.keys(DB.urlop[mk] || {}).length;
  const live = DB.entries.some(e => e.shiftDate.slice(0, 7) === mk);
  const snap = live ? C.monthSnapshot(DB.entries, mk) : DB.archive[mk] || null;
  const base = snap ? snap.bonus : 0, pf = C.premiumFactor(a.absences), ind = indAmount(mk);
  const ov = DB.ovt.filter(o => o.date.slice(0, 7) === mk);
  // Вся сумма за месяц: сохранённый расчёт кошелька, иначе расчёт по графику и отметкам
  const saved = DB.wallet.hist.find(h => h.month === mk);
  let pay;
  if (saved) pay = { netto: saved.netto, brutto: saved.brutto, src: saved.slip ? 'slip' : 'saved' };
  else {
    const inp = DB.wallet.cur && DB.wallet.cur.month === mk ? DB.wallet.cur.inp : (DB.wallet.draft && DB.wallet.draft.month === mk ? DB.wallet.draft : autoInp(mk));
    const r = C.salary(salaryInput(inp));
    pay = { netto: r.netto, brutto: r.brutto, src: DB.wallet.cur && DB.wallet.cur.month === mk ? 'saved' : 'est' };
  }
  return { mk, cur, has: !!p, scheduled, worked: a.shifts, hours: a.hours, night: a.night,
    urlopDays: p ? urlopDays : urlopMarked, urlopHours: a.urlop, absences: a.absences,
    holidays: p ? Object.keys(p.holidays).length : 0,
    ovtHours: ov.reduce((s, o) => s + o.hours, 0), ovt50: a.o50, ovt100: a.o100,
    peaks: snap ? snap.peaks : 0, ppc: snap ? snap.ppc : 0, base, pf, ind, premium: C.r2(base * pf + ind), pay };
}

function renderArchive() {
  const now = C.monthKey(new Date());
  const keys = new Set([now, ...Object.keys(DB.archive), ...Object.keys(DB.urlop), ...Object.keys(DB.absent),
    ...DB.ovt.map(o => o.date.slice(0, 7)), ...DB.wallet.hist.map(h => h.month)]);
  const ms = [...keys].filter(m => RE_MK.test(m) && m <= now).sort().reverse().slice(0, 12);
  const cell = (ic, label, val, note = '') => `<div class="ms-c"><span>${ic} ${label}</span><b>${val}</b>${note ? `<small>${note}</small>` : ''}</div>`;
  $('archive-list').innerHTML = ms.map(m => {
    const t = monthStats(m);
    return `<div class="card mcard">
      <div class="mcard-h"><div><b>${mLabel(m)}</b>${t.cur ? '<span class="ms-live">идёт</span>' : ''}</div>
        <div class="mcard-v">${money(t.pay.netto)}<small>zł на руки${t.pay.src === 'est' ? ', расчёт' : t.pay.src === 'slip' ? `, odcinek ${slipIc(m)}` : ''}</small><small>брутто ${money(t.pay.brutto)}</small></div></div>
      <div class="ms-grid">
        ${cell('🗓', 'Смен', t.has ? `${t.worked}` : '—', t.has ? `по графику ${t.scheduled}, ${h1(t.hours)} ч` : 'графика нет')}
        ${cell('🏖', 'Отпуск', t.urlopDays ? `${t.urlopDays} ${plural(t.urlopDays, 'день', 'дня', 'дней')}` : '—', t.urlopHours ? `${h1(t.urlopHours)} ч` : '')}
        ${cell('⚠️', 'Пропуски', `${t.absences}`, `премия ×${fx(t.pf)}`)}
        ${cell('⏱', 'Доп. часы', t.ovtHours ? `${h1(t.ovtHours)} ч` : '—', t.ovtHours ? [t.ovt50 ? `+50% ${h1(t.ovt50)} ч` : '', t.ovt100 ? `+100% ${h1(t.ovt100)} ч` : ''].filter(Boolean).join(', ') : '')}
        ${cell('🌙', 'Ночных', t.night ? `${h1(t.night)} ч` : '—')}
        ${cell('🎉', 'Праздники', t.holidays ? `${t.holidays}` : '—')}
        ${cell('📦', 'Пики', t.peaks ? int(t.peaks) : '—', t.peaks ? `темп ${h1(t.ppc)}` : '')}
        ${cell('⭐', 'Премия', t.premium ? money(t.premium) : '—', [t.base ? `пики ${money(t.base)} × ${fx(t.pf)}` : '', t.ind ? `Indirect ${money(t.ind)}` : ''].filter(Boolean).join(' + '))}
        ${cell('🧾', 'Вычеты', money(Math.max(0, t.pay.brutto - t.pay.netto)), 'ZUS, здоровье, PIT')}
      </div></div>`;
  }).join('') || '<div class="empty"><b>Пока пусто</b>Итоги появятся, когда начнёшь записывать смены.</div>';
}

function renderRates() {
  const mk = C.monthKey(new Date());
  const card = ([st, cfg]) => {
    const a = C.monthAgg(DB.entries, st, mk), cur = Math.round(a.pph), maxR = cfg.tr[cfg.tr.length - 1][2];
    return `<div class="card rate-card" style="--stc:${cfg.col}"><div class="gauge-h"><b>${cfg.name}, ${esc(cfg.full)}</b><small>норма ${cfg.norm} в час${cfg.hourly ? ', ставка за час' : ''}</small></div>
      ${cfg.tr.map(([lo, hi, r]) => { const on = a.H && cur >= lo && cur <= hi; return `<div class="rate-row${on ? ' cur' : ''}"><div>${lo === 0 ? `до ${hi}` : hi === 999 ? `от ${lo}` : `${lo}–${hi}`} в час${on ? ', твой темп' : ''}<div class="rate-bar"><i style="width:${Math.round(r / maxR * 100)}%"></i></div></div><b>${rateTxt(st, r)}</b></div>`; }).join('')}</div>`;
  };
  const all = Object.entries(C.ST);
  $('rates-list').innerHTML = `<h2 class="sec" style="margin-top:0">Мои станции <button class="link" data-act="st-edit">изменить</button></h2>`
    + DB.mainSt.map(k => card([k, C.ST[k]])).join('')
    + '<h2 class="sec">Дополнительно</h2>' + all.filter(([k]) => isExtra(k)).map(card).join('')
    + '<p class="hint">Премия = штуки сверх нормы × ставка по среднему темпу месяца. У ZK (Załadunek) — часы на станции × ставка за час, по Aneksowi 2/2026 с 01.06.2026.</p>';
}

const BHP = [
  { h: 'Безопасный нож', pl: 'Bezpieczna obsługa noża bezpiecznego', r: [
    ['✅', 'Только ножи от работодателя', 'Не приноси личные ножи и не используй недопущенные.'],
    ['✅', 'Проверь нож перед работой', 'Механизм выдвижения, лезвие, блокировка. Повреждённым не работай.'],
    ['✅', 'Режь от себя', 'Держи руку на расстоянии от лезвия, без резких движений.'],
    ['🚫', 'Не переделывай нож', 'Не обматывай лентой, не сверли. Сломался — прекрати работу и скажи руководителю.']],
    warn: 'О любой травме или порезе сразу сообщи руководителю. При грубом нарушении BHP (без СИЗ, чужой нож) можно потерять право на доплату больничного до 100% и единовременную компенсацию.' },
  { h: 'Химия на складе', pl: 'Produkty chemiczne na magazynie', r: [
    ['1', 'Любое повреждение — сразу руководителю', 'Порванная упаковка, утечка, сильный запах.'],
    ['2', 'Ничего не делай без решения руководителя', 'Не трогай, не переноси, не вытирай повреждённый продукт.'],
    ['3', 'Изолируй место', 'Прекрати работу с продуктом и жди инструкций.'],
    ['4', 'Работай в перчатках', 'Даже с целыми упаковками химии.'],
    ['5', 'Не вставляй ёмкости одна в другую', 'Это повреждает товар и вызывает утечки.']],
    warn: 'Алгоритм: увидел, не трогай, огради, сообщи.' },
  { h: 'Основные правила BHP', pl: 'Podstawowe zasady BHP', r: [
    ['🦺', 'Жилет всегда застёгнут', 'Kamizelka musi być zawsze zapięta.'],
    ['👟', 'Рабочая обувь BHP', 'Na terenie magazynu obowiązuje obuwie ochronne.'],
    ['💇', 'Длинные волосы собраны', 'Długie włosy muszą być spięte.'],
    ['🪪', 'Бейдж на шнурке с клипсой', 'Identyfikator na smyczy z klipsem bezpieczeństwa.']] },
  { h: 'Одежда: можно', pl: 'Zasady prawidłowego ubioru', r: [
    ['👕', 'Футболка с закрытыми плечами, спиной и животом', ''], ['👖', 'Рабочие брюки узкие, целые, без цепочек', 'Шорты — минимум до колена.'],
    ['🧥', 'Кофта застёгнута по всей длине', 'Манжеты застёгнуты, шнурки из кофты убраны.'], ['💍', 'Небольшие серьги без подвесок', ''],
    ['👜', 'Маленькая сумочка до A5', 'На выходе показать охране.']] },
  { h: 'Нельзя носить и вносить', pl: 'Zakazy', r: [
    ['🧢', 'Кепки, капюшоны, солнечные очки', ''], ['🧣', 'Шарфы, платки, толстые цепи, юбки и платья', ''],
    ['🔥', 'Зажигалки, сигареты, вейпы', ''], ['🎧', 'Наушники, колонки, зарядки, чайники', ''],
    ['💊', 'Лекарства и косметику', 'Ингалятор, инсулин — только сообщив руководителю.'], ['🎒', 'Рюкзаки и большие сумки', '']],
    warn: 'По просьбе охраны покажи вещи и бейдж. Выносить имущество AutoDoc Logistics запрещено.' },
];
function renderBhp() {
  $('bhp').innerHTML = BHP.map(b => `<div class="card bhp-card"><h3>${b.h}</h3><div class="pl">${b.pl}</div>
    ${b.r.map(([i, t, s]) => `<div class="rule"><span>${i}</span><div><b>${t}</b>${s ? `<p>${s}</p>` : ''}</div></div>`).join('')}
    ${b.warn ? `<div class="bhp-warn">${b.warn}</div>` : ''}</div>`).join('');
}

function renderNotes() {
  $('notes-list').innerHTML = DB.notes.length ? [...DB.notes].reverse().map(n => `<div class="note"><p>${esc(n.text)}<small>${esc(n.at)}</small></p><button class="x" data-act="del-note" data-id="${n.id}" aria-label="Удалить заметку">×</button></div>`).join('')
    : '<div class="empty">Заметок нет.</div>';
}

const EMOJI = ['👷', '📦', '🦺', '🚜', '⚡', '🔥', '🐺', '🦊', '🐻', '🌙', '☕', '🎧'];
function renderProfile() {
  const th = (v, t) => `<button class="chip${DB.theme === v ? ' on' : ''}" data-act="theme" data-v="${v}">${t}</button>`;
  $('profile-form').innerHTML = `<div class="card">
    <label class="field"><span>Имя в рейтинге</span><input class="in txt" id="pf-name" maxlength="40" value="${esc(DB.name)}" data-in="pf"></label>
    <div class="field" style="margin-top:12px"><span>Значок</span><div class="emojis">${EMOJI.map(e => `<button class="${DB.emoji === e ? 'on' : ''}" data-act="emoji" data-v="${e}">${e}</button>`).join('')}</div></div>
    <div class="field" style="margin-top:12px"><span>Тема</span><div class="chips">${th('auto', 'Как в Telegram')}${th('dark', 'Тёмная')}${th('light', 'Светлая')}</div></div>
    <div class="field" style="margin-top:12px"><span>Свои станции на «Пиках»</span><button class="more-b" style="margin:0" data-act="st-edit"><span>${DB.mainSt.map(k => C.ST[k].name).join(' · ')}</span><small>изменить</small><i aria-hidden="true">›</i></button></div>
    <div class="field" style="margin-top:12px"><span>Неделя в календаре начинается с</span><div class="chips"><button class="chip${DB.ws === 'mon' ? ' on' : ''}" data-act="ws" data-v="mon">понедельника</button><button class="chip${DB.ws === 'sun' ? ' on' : ''}" data-act="ws" data-v="sun">воскресенья</button></div></div>
  </div>
  <h2 class="sec">Аккаунт</h2>
  <div class="card vf-card ${STATE.verified ? 'ok' : 'no'}">${STATE.verified
    ? `<div class="vf-h"><span class="vf-ic ok">✓</span><b>${VERIFY_TEXT.ok.title}</b></div><p>${VERIFY_TEXT.ok.text}</p>`
    : verifyBanner()}</div>
  <h2 class="sec">Данные</h2>
  <div class="card"><p style="color:var(--sub);font-size:14px">${CS ? 'Копия данных хранится в облаке Telegram и восстановится на новом телефоне.' : 'Облачная копия недоступна в этом окружении.'}</p>
    <button class="btn btn-bad btn-wide" style="margin-top:12px" data-act="wipe">Удалить все данные с устройства</button></div>`;
}

const RENDER = {
  home: renderHome, peaks: renderPeaks, sched: renderSched, wallet: renderWallet, more: () => {},
  rating: renderRating, archive: renderArchive, odcinek: renderOdcinek, rates: renderRates, bhp: renderBhp, notes: renderNotes, profile: renderProfile,
};
function renderAll() { renderHeader(); (RENDER[STATE.stack[STATE.stack.length - 1] || STATE.tab] || renderHome)(); }

// ═════════════════════ СОБЫТИЯ ═════════════════════
const ACT = {
  'go': el => { haptic.pick(); if (!$('sheet-bg').hidden) closeSheet(); go(el.dataset.to); },
  'consent': () => {
    DB.consent = { v: CFG.CONSENT_VERSION, at: new Date().toISOString() }; save(); haptic.ok();
    if (STATE.verified) { api('consent', { version: CFG.CONSENT_VERSION, ua: navigator.userAgent.slice(0, 300) }).catch(() => {}); pushRank(); }
    if (!DB.teamAt) onboard(); else { $('consent').hidden = true; pushProfile(); }
  },
  'ob-team': el => { STATE.obTeam = el.dataset.v; STATE.obGroup = null; document.body.dataset.team = el.dataset.v; haptic.pick(); onboard(); },
  'ob-group': el => { STATE.obGroup = el.dataset.v; haptic.pick(); onboard(); },
  'ob-done': () => {
    if (!STATE.obTeam || !STATE.obGroup) return;
    DB.team = STATE.obTeam; DB.group = STATE.obGroup; DB.teamAt = Date.now(); save(); applyTheme(); haptic.ok();
    $('consent').hidden = true; renderAll(); pushProfile(); pushRank();
    toast(`Смена ${teamMeta(DB.team).label} ${DB.group}: график и оповещения настроены`);
  },
  'station': el => { STATE.curSt = el.dataset.st; if (isExtra(STATE.curSt)) STATE.stMore = true; haptic.pick(); if (STATE.tab !== 'peaks') go('peaks'); else renderPeaks(); },
  'st-more': () => { STATE.stMore = !STATE.stMore; haptic.pick(); renderPeaks(); },
  'st-edit': () => { STATE.stPick = DB.mainSt.slice(); stSheet(); },
  'st-pick': el => { const k = el.dataset.st, a = STATE.stPick, i = a.indexOf(k);
    if (i >= 0) a.splice(i, 1); else if (a.length < MAIN_MAX) a.push(k); else { haptic.err(); toast(`Не больше ${MAIN_MAX} станций`); return; }
    haptic.pick(); stSheet(); },
  'st-default': () => { STATE.stPick = MAIN_ST.slice(); haptic.pick(); stSheet(); },
  'st-save': () => { if (STATE.stPick.length < MAIN_MIN) return;
    DB.mainSt = cleanMain(STATE.stPick); save(); haptic.ok(); closeSheet();
    toast(`Свои станции: ${DB.mainSt.map(k => C.ST[k].name).join(', ')}`);
    const top = STATE.stack[STATE.stack.length - 1] || STATE.tab; (RENDER[top] || renderAll)(); },
  'qa-mode': el => { qa.mode = el.dataset.v; qa.f = qa.o = null; haptic.pick(); renderForm(); },
  'qa-save': () => qaSave(),
  'del-entry': el => confirmSheet('Удалить запись?', 'Премия за месяц пересчитается.', 'Удалить', () => {
    DB.entries = DB.entries.filter(e => e.id !== +el.dataset.id); save(); renderPeaks(); pushRank(); toast('Запись удалена'); }),
  'team-sheet': () => { go('sched'); STATE.schedTab = 'cal'; renderSched(); document.getElementById('team-pick').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' }); },
  'team': el => { DB.team = el.dataset.v; const g = teamMeta(DB.team).groups; if (!g.includes(DB.group)) DB.group = g[0]; DB.teamAt = Date.now(); save(); applyTheme(); haptic.ok(); renderHeader(); renderSched(); pushProfile(); pushRank(); },
  'group': el => { DB.group = el.dataset.v; DB.teamAt = Date.now(); save(); haptic.pick(); renderHeader(); renderSched(); pushProfile(); pushRank(); },
  'sched-tab': el => { STATE.schedTab = el.dataset.v; renderSched(); },
  'cal-move': el => { STATE.calM += +el.dataset.v; if (STATE.calM < 0) { STATE.calM = 11; STATE.calY--; } if (STATE.calM > 11) { STATE.calM = 0; STATE.calY++; } haptic.pick(); renderCal(); },
  'cal-now': () => { const n = new Date(); STATE.calY = n.getFullYear(); STATE.calM = n.getMonth(); renderCal(); },
  'day': el => daySheet(+el.dataset.d),
  'urlop': el => markDay('urlop', 'absent', el.dataset.day),
  'absent': el => markDay('absent', 'urlop', el.dataset.day),
  'ov-pct': el => { STATE.ovPct = +el.dataset.v; document.querySelectorAll('#ov-pct .chip').forEach(c => c.classList.toggle('on', c === el)); },
  'add-ovt': el => { const h = Number(String($('ov-h').value).replace(',', '.'));
    if (!(h > 0 && h <= 16)) { $('ov-h').focus(); haptic.err(); return; }
    DB.ovt.push({ id: Date.now(), date: el.dataset.day, hours: h, pct: STATE.ovPct === 100 ? 100 : 50, night: $('ov-n').checked }); save(); haptic.ok(); closeSheet(); renderCal(); toast(`Добавлено ${h1(h)} ч сверхурочных`); },
  'del-ovt': el => { DB.ovt = DB.ovt.filter(o => o.id !== +el.dataset.id); save(); closeSheet(); renderCal(); },
  'notify': el => { DB.notify[el.dataset.k] = el.checked; save(); haptic.pick(); pushProfile();
    if (el.checked && tgv('6.9')) { try { TG.requestWriteAccess(); } catch {} } },
  'ics': async () => {
    try { const r = await api('ics', {}); if (!r.url) throw 0;
      sheet(`<h3>Смены в календаре</h3><p>Это подписка: календарь сам перечитывает ссылку и обновляет смены. Ссылка личная — не пересылай её.</p>
        <p><b>iPhone:</b> Настройки → Календарь → Учётные записи → Добавить → Другое → Подписной календарь.<br><b>Android:</b> calendar.google.com с компьютера → Другие календари → По URL.</p>
        <input class="in txt" readonly value="${esc(r.url)}" id="ics-url"><div class="stack"><button class="btn btn-acc btn-wide" data-act="copy-ics">Скопировать ссылку</button><button class="btn btn-ghost btn-wide" data-act="sheet-close">Готово</button></div>`);
    } catch { toast('Ссылку не получить — проверь связь'); } },
  'copy-ics': () => { const v = $('ics-url').value; navigator.clipboard?.writeText(v).then(() => toast('Ссылка скопирована'), () => { $('ics-url').select(); }); },
  'open-bot': () => { const u = `https://t.me/${CFG.BOT_USERNAME}`; TG?.openTelegramLink ? TG.openTelegramLink(u) : window.open(u, '_blank', 'noopener'); },
  'bus': el => { const i = +el.dataset.i; STATE.bus = STATE.bus === i ? null : i; STATE.busAll = false; renderBus(); },
  'bus-all': () => { STATE.busAll = true; renderBus(); },
  'rate': el => { DB.profile.rateMode = el.dataset.v; save(); haptic.pick(); renderWallet(false); },
  'kup': el => { DB.profile.kup = el.dataset.v; save(); renderWallet(false); },
  'nb': el => { DB.profile.nightBasis = el.dataset.v; save(); renderWallet(false); },
  'pit2': el => { DB.profile.pit2 = el.checked; save(); renderWallet(false); },
  'ppk': el => { DB.profile.ppk = el.checked; save(); renderWallet(false); },
  'birth-ok': el => { DB.profile.birthOk = el.checked && RE_DAY.test(DB.profile.birth); save(); haptic.ok(); renderWallet(false); },
  'w-auto': () => { const W = C.walletMonth(), cur = walletView().inp, a = autoInp(W);
    DB.wallet.draft = { ...cur, hours: a.hours, nightHours: a.nightHours, urlopHours: a.urlopHours, ovt50: a.ovt50, ovt100: a.ovt100, ovtNight: a.ovtNight, urlopVar: a.urlopVar };
    save(); renderWallet(false); toast('Часы и сверхурочные взяты из графика'); },
  'w-abs': el => { const v = walletView(); DB.wallet.draft = { ...v.inp, absences: +el.dataset.v }; save(); haptic.pick(); renderWallet(false); },
  'w-abs-auto': () => { const v = walletView(); DB.wallet.draft = { ...v.inp, absences: autoHours(v.W).absences }; save(); renderWallet(false); },
  'w-uvar-auto': () => { const v = walletView(); DB.wallet.draft = { ...v.inp, urlopVar: urlopAuto(v.W).perHour }; save(); renderWallet(false); },
  'w-reset': () => confirmSheet('Сбросить расчёт?', 'Часы снова возьмутся из графика, сохранённый расчёт за этот месяц удалится.', 'Сбросить', () => { DB.wallet.cur = null; DB.wallet.draft = null; save(); renderWallet(false); }),
  'w-save': () => { const inp = readWalletInputs(); DB.wallet.cur = { month: inp.month, inp, savedAt: new Date().toISOString() }; DB.wallet.draft = null; save(); haptic.ok();
    const u = C.walletUntil(inp.month); toast(`Сохранено. Расчёт виден до ${u.slice(8)}.${u.slice(5, 7)}`); renderWallet(false); },
  'rank-move': el => { STATE.rankMonth = C.addMonths(STATE.rankMonth || C.monthKey(new Date()), +el.dataset.v); renderRating(); },
  'note-add': () => { const t = $('note-in').value.trim().slice(0, 500); if (!t) return; const n = new Date();
    DB.notes.push({ id: Date.now(), text: t, at: `${fmtD(C.iso(n))} ${n.toTimeString().slice(0, 5)}` }); $('note-in').value = ''; save(); haptic.ok(); renderNotes(); },
  'del-note': el => { DB.notes = DB.notes.filter(n => n.id !== +el.dataset.id); save(); renderNotes(); },
  'emoji': el => { DB.emoji = el.dataset.v; save(); haptic.pick(); renderHeader(); renderProfile(); pushRank(); },
  'theme': el => { DB.theme = el.dataset.v; save(); applyTheme(); renderProfile(); },
  'ws': el => { DB.ws = el.dataset.v; save(); renderProfile(); },
  'wipe': () => confirmSheet('Удалить все данные?', 'Пики, расчёты, заметки и облачная копия будут стёрты с этого аккаунта. Рейтинг на сервере останется.', 'Удалить всё', async () => {
    try { localStorage.removeItem(KEY); localStorage.removeItem(LEGACY); } catch {}
    if (CS) { const keys = ['bn', ...Array.from({ length: 60 }, (_, i) => 'b' + i)]; await csCall('removeItems', keys); }
    DB = defaults(); DB.uid = STATE.uid; DB.consent = { v: CFG.CONSENT_VERSION, at: new Date().toISOString() };
    try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch {}
    toast('Данные удалены'); go('home'); renderAll(); }),
  'reverify': el => reverify(el),
  'slip-pick': () => { $('slip-file').click(); },
  'ind-open': () => { haptic.pick(); indSheet(indMonthDefault()); loadIndStats(); },
  'ind-month': el => { haptic.pick(); indSheet(el.dataset.v); },
  'ind-save': () => indSave(false),
  'ind-del': () => indSave(true),
  'slip-view': el => { STATE.slipView = el.dataset.m; STATE.slipErr = ''; haptic.pick();
    if (STATE.stack[STATE.stack.length - 1] !== 'odcinek') go('odcinek');
    else renderOdcinek();
    $('oc-res')?.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); },
  'slip-today': el => setSlipGot(el.dataset.id, C.iso(new Date())),
  'slip-apply': el => { const r = slipResultOf(el.dataset.m); if (!r) return; const pr = r.profile, p = DB.profile;
    slipChanges(pr).forEach(([k]) => {
      if (k === 'rate') { const m = ['33.00', '31.40', '35.00'].find(x => Math.abs(+x - pr.rate) < .004); p.rateMode = m || 'own'; if (!m) p.rate = pr.rate; }
      else if (k === 'kup') p.kup = pr.kup; else if (k === 'ppk') p.ppk = pr.ppk; else p[k] = pr[k] || 0;
    });
    save(); haptic.ok(); toast('Кошелёк обновлён по odcinku'); renderOdcinek(); },
  'slip-del': el => confirmSheet('Удалить odcinek?', 'Проверка и сумма из odcinka за этот месяц удалятся с телефона. В «Прошлых выплатах» вернётся расчёт трекера.', 'Удалить', () => {
    const mk = el.dataset.m; DB.slips.filter(s => s.month === mk && s.gotOn).forEach(s => reportPay({ ...s, gotOn: '' }));
    DB.slips = DB.slips.filter(s => s.month !== mk); syncSlipHist(mk); save(); STATE.slipView = null; renderOdcinek(); toast('Odcinek удалён'); }),
  'sheet-close': () => closeSheet(),
  'sheet-ok': () => { const f = STATE.sheetOk; STATE.sheetOk = null; closeSheet(); f && f(); },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (el.type === 'checkbox') return;                       // чекбоксы — через change
  const fn = ACT[el.dataset.act]; if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'consent-cb') { $('consent-btn').disabled = !el.checked; return; }
  if (el.type === 'checkbox' && el.dataset.act && ACT[el.dataset.act]) ACT[el.dataset.act](el, e);
  if (el.id === 'slip-file') { if (el.files && el.files[0]) slipUpload(el.files[0]); return; }
  if (el.dataset.in === 'slip-got') { setSlipGot(el.dataset.id, el.value); return; }
  if (el.dataset.in === 'birth') { DB.profile.birth = RE_DAY.test(el.value) ? el.value : ''; DB.profile.birthOk = false; save(); renderWallet(false); }
});
document.addEventListener('input', e => {
  const k = e.target.dataset.in; if (!k) return;
  if (k === 'qa') qaUpdate(e);
  else if (k === 'w') walletLive();
  else if (k === 'ind') indPreview();
  else if (k === 'pf') { DB.name = e.target.value.trim().slice(0, 40); save(); renderHeader(); pushRank(); pushProfile(); }
});
$('sheet-bg').addEventListener('click', e => { if (e.target.id === 'sheet-bg') closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') back(); });
// Вернулся в приложение — обновим «сегодня», премию и кошелёк (вдруг наступило 10-е)
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('app').hidden) { pruneOldMonths(); walletRollover(); save(); renderAll(); flushToast(); } });

document.addEventListener('DOMContentLoaded', boot);
})();
