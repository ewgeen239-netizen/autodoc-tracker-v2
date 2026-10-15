/*  AutoDoc Tracker — чтение odcinka płacowego (PDF) прямо на телефоне.
 *  Файл никуда не отправляется: PDF разбирается здесь, наружу уходит только
 *  дата, когда пришли деньги (для прогноза зарплаты).
 *
 *  Odcinek AutoDoc печатает Streamsoft PRESTIŻ: одна страница, текст шрифтами
 *  Type0/Identity-H с картой ToUnicode, потоки сжаты Flate. Таблица идёт
 *  парами строк: строка подписей («Brutto», «Składki pracowni…»), под ней
 *  строка сумм в тех же колонках. Подписи обрезаны по ширине колонки, поэтому
 *  узнаём их по началу.
 *
 *  Чистые функции (без DOM) — их же гоняют тесты под node.
 */
(function (root) {
  'use strict';

  // ── PDF: объекты, потоки, текст ───────────────────────────────────
  const latin1 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return s; };

  // Браузерный распаковщик zlib. В node тесты передают свой (zlib.inflateSync).
  async function inflateWeb(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('no-inflate');
    const ds = new DecompressionStream('deflate');
    const w = ds.writable.getWriter(); w.write(bytes); w.close();
    const out = []; const rd = ds.readable.getReader(); let len = 0;
    try {
      for (;;) { const { value, done } = await rd.read(); if (done) break; out.push(value); len += value.length; }
    } catch (e) { if (!len) throw e; }                      // мусор после конца потока не мешает
    const all = new Uint8Array(len); let o = 0; out.forEach(c => { all.set(c, o); o += c.length; });
    return all;
  }

  function objects(bytes, s) {
    const map = {};
    const re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
    while ((m = re.exec(s))) {
      const start = re.lastIndex, end = s.indexOf('endobj', start);
      const body = s.slice(start, end < 0 ? s.length : end);
      const si = body.search(/\bstream\r?\n/);
      const o = { dict: si < 0 ? body : body.slice(0, si), start: si < 0 ? -1 : start + si + body.slice(si).match(/^stream\r?\n/)[0].length };
      map[m[1]] = o;
    }
    for (const o of Object.values(map)) {
      if (o.start < 0) continue;
      const lm = o.dict.match(/\/Length\s+(\d+)(\s+\d+\s+R)?/);
      let len = lm ? +lm[1] : -1;
      if (lm && lm[2]) { const ref = map[lm[1]]; len = ref ? parseInt(ref.dict.trim(), 10) : -1; }
      if (!(len > 0)) { const e = s.indexOf('endstream', o.start); len = e < 0 ? 0 : e - o.start; }
      o.raw = bytes.subarray(o.start, o.start + len);
    }
    return map;
  }

  async function streamOf(o, inflate) {
    if (!o || !o.raw) return '';
    const data = /\/FlateDecode/.test(o.dict) ? await inflate(o.raw) : o.raw;
    return latin1(data);
  }

  // ToUnicode: <0013> <0030> и диапазоны <a> <b> <dst>.
  function cmap(text) {
    const map = {}; let bytes = 1;
    const hexU = h => { let s = ''; for (let i = 0; i < h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return s; };
    for (const blk of text.split('beginbfchar').slice(1)) {
      const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g; let m; const part = blk.split('endbfchar')[0];
      while ((m = re.exec(part))) { map[parseInt(m[1], 16)] = hexU(m[2]); bytes = Math.max(bytes, m[1].length / 2); }
    }
    for (const blk of text.split('beginbfrange').slice(1)) {
      const part = blk.split('endbfrange')[0];
      const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g; let m;
      while ((m = re.exec(part))) {
        const a = parseInt(m[1], 16), b = parseInt(m[2], 16); bytes = Math.max(bytes, m[1].length / 2);
        if (m[3][0] === '<') { const base = parseInt(m[3].slice(1, -1), 16); for (let c = a; c <= b && c - a < 65536; c++) map[c] = String.fromCharCode(base + c - a); }
        else (m[3].match(/<([0-9A-Fa-f]+)>/g) || []).forEach((h, i) => { map[a + i] = hexU(h.slice(1, -1)); });
      }
    }
    return { map, bytes };
  }

  // Токены content stream: числа, имена, строки, массивы, операторы.
  function* tokens(s) {
    let i = 0; const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (c === '(') {                                       // литеральная строка
        let depth = 1, out = ''; i++;
        while (i < n && depth) {
          const ch = s[i++];
          if (ch === '\\') {
            const e = s[i++];
            if (/[0-7]/.test(e)) { let o = e; while (o.length < 3 && /[0-7]/.test(s[i])) o += s[i++]; out += String.fromCharCode(parseInt(o, 8)); }
            else out += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[e] ?? (e === '\r' || e === '\n' ? '' : e);
          } else if (ch === '(') { depth++; out += ch; } else if (ch === ')') { if (--depth) out += ch; } else out += ch;
        }
        yield { str: out }; continue;
      }
      if (c === '<' && s[i + 1] !== '<') {                   // hex-строка
        const e = s.indexOf('>', i); let h = s.slice(i + 1, e).replace(/\s/g, ''); if (h.length % 2) h += '0';
        let out = ''; for (let k = 0; k < h.length; k += 2) out += String.fromCharCode(parseInt(h.slice(k, k + 2), 16));
        i = e + 1; yield { str: out }; continue;
      }
      if (c === '[') { i++; yield { op: '[' }; continue; }
      if (c === ']') { i++; yield { op: ']' }; continue; }
      if (c === '<' || c === '>') { i += 2; continue; }      // словари << >> внутри текста не нужны
      let j = i; while (j < n && !/[\s()<>[\]/%]/.test(s[j])) j++;
      if (c === '/') { j = i + 1; while (j < n && !/[\s()<>[\]/%]/.test(s[j])) j++; yield { name: s.slice(i + 1, j) }; i = j; continue; }
      const w = s.slice(i, j); i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) yield { num: +w }; else yield { op: w };
    }
  }

  // Все куски текста страницы с координатами: [{x, y, t}].
  async function pdfText(bytes, inflate = inflateWeb) {
    const s = latin1(bytes);
    if (!s.startsWith('%PDF')) throw new Error('not-pdf');
    const objs = objects(bytes, s);
    const fonts = {};
    for (const o of Object.values(objs)) {
      const fm = o.dict.match(/\/Font\s*<<([\s\S]*?)>>/);
      if (!fm) continue;
      const re = /\/([^\s/]+)\s+(\d+)\s+\d+\s+R/g; let m;
      while ((m = re.exec(fm[1]))) {
        const fo = objs[m[2]]; if (!fo || fonts[m[1]]) continue;
        const tu = fo.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
        fonts[m[1]] = tu ? cmap(await streamOf(objs[tu[1]], inflate)) : { map: {}, bytes: /Type0/.test(fo.dict) ? 2 : 1 };
      }
    }
    const pages = Object.values(objs).filter(o => /\/Type\s*\/Page\b/.test(o.dict));
    const items = [];
    for (const pg of pages.slice(0, 3)) {
      const cm = pg.dict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/);
      if (!cm) continue;
      const refs = (cm[1].match(/(\d+)\s+\d+\s+R/g) || []).map(r => r.split(/\s+/)[0]);
      let content = '';
      for (const r of refs) content += await streamOf(objs[r], inflate) + '\n';
      run(content, fonts, items);
    }
    return items;
  }

  function run(content, fonts, items) {
    let font = { map: {}, bytes: 1 }, tm = [1, 0, 0, 1, 0, 0], lm = [0, 0], lead = 0;
    const stack = []; let arr = null;
    const decode = raw => {
      let t = '';
      if (font.bytes === 2) for (let i = 0; i + 1 < raw.length; i += 2) { const c = raw.charCodeAt(i) * 256 + raw.charCodeAt(i + 1); t += font.map[c] ?? ''; }
      else for (let i = 0; i < raw.length; i++) { const c = raw.charCodeAt(i); t += font.map[c] ?? String.fromCharCode(c); }
      return t;
    };
    const put = t => { if (t) items.push({ x: Math.round(tm[4] * 10) / 10, y: Math.round(tm[5] * 10) / 10, t }); };
    const move = (tx, ty) => { lm = [lm[0] + tx, lm[1] + ty]; tm = [tm[0], tm[1], tm[2], tm[3], lm[0], lm[1]]; };
    for (const tk of tokens(content)) {
      if (arr) { if (tk.op === ']') { stack.push({ arr }); arr = null; } else arr.push(tk); continue; }
      if (tk.op === '[') { arr = []; continue; }
      if (!tk.op) { stack.push(tk); continue; }
      const a = stack.splice(0), num = k => (a[a.length - k] || {}).num || 0;
      switch (tk.op) {
        case 'BT': tm = [1, 0, 0, 1, 0, 0]; lm = [0, 0]; break;
        case 'Tf': { const nm = a.find(x => x.name); font = (nm && fonts[nm.name]) || { map: {}, bytes: 1 }; break; }
        case 'Td': move(num(2), num(1)); break;
        case 'TD': lead = -num(1); move(num(2), num(1)); break;
        case 'TL': lead = num(1); break;
        case 'Tm': tm = a.slice(-6).map(x => x.num || 0); lm = [tm[4], tm[5]]; break;
        case 'T*': move(0, -lead); break;
        case 'Tj': put(decode((a.find(x => x.str !== undefined) || {}).str || '')); break;
        case "'": move(0, -lead); put(decode((a.find(x => x.str !== undefined) || {}).str || '')); break;
        case '"': move(0, -lead); put(decode((a.find(x => x.str !== undefined) || {}).str || '')); break;
        case 'TJ': { const ar = (a.find(x => x.arr) || { arr: [] }).arr; put(ar.filter(x => x.str !== undefined).map(x => decode(x.str)).join('')); break; }
        default: break;
      }
    }
  }

  // ── odcinek: подписи → суммы ──────────────────────────────────────
  const NUM_RE = /^-?\d{1,3}(?:[  ]\d{3})*(?:,\d+)?$|^-?\d+(?:,\d+)?$/;
  const toNum = t => Number(String(t).trim().replace(/[  ]/g, '').replace(',', '.'));
  const isNum = t => NUM_RE.test(String(t).trim());

  // Подпись → поле. Подписи обрезаны по ширине колонки — сравниваем начало.
  const LABELS = [
    ['stawka godzinowa', 'rate'], ['ilość godzin pracy', 'hours'], ['płaca podstawowa', 'base'],
    ['premia zad', 'bonus'], ['ilość godzin noc', 'nightHours'], ['kwota za godziny', 'night'], ['dodatek dark', 'dark'],
    ['ilość godzin urlop', 'urlopHours'], ['za urlop', 'urlop'],
    ['ilość nadgodz', 'ovtHours'], ['kwota za nadgodz', 'ovtAmount'], ['razem nadgodz', 'ovtTotal'],
    ['brutto', 'brutto'], ['podstawa zus', 'zusBase'], ['podstawa f. emeryt', 'emBase'],
    ['f. emerytalny prac', 'zusEm'], ['f. rentowy pracow', 'zusRent'], ['fundusz chorob', 'zusChor'], ['składki pracown', 'zus'],
    ['f. emerytalny płat', 'erEm'], ['f. rentowy płat', 'erRent'], ['fundusz wypad', 'erWyp'], ['zus 51 płat', 'er51'],
    ['fp', 'erFP'], ['fgśp', 'erFGSP'], ['zus 51 - razem', 'zus51'], ['zus 53', 'zus53'],
    ['podstawa podatku', 'pitBase'], ['procent podatku', 'pitPct'], ['podstawa zdrowot', 'healthBase'], ['zus 52', 'health'],
    ['zaliczk', 'pit'], ['zal. pod', 'pit'], ['podatek', 'pit'],
    ['benefit', 'benefit'], ['ekwiwal', 'ekw'], ['ppk', 'ppk'], ['przelew', 'transfer'], ['do wypłaty', 'netto'],
  ];
  const SUM = new Set(['ekw', 'ppk', 'benefit']);             // несколько строк одного вида складываем
  const keyOf = label => { const l = label.toLowerCase().replace(/\s+/g, ' ').trim(); const hit = LABELS.find(([p]) => l === p || l.startsWith(p + (p.length < 4 ? ' ' : '')) || (p.length >= 4 && l.startsWith(p))); return hit ? hit[1] : null; };

  function rows(items) {
    const by = new Map();
    items.forEach(it => { const k = Math.round(it.y * 2) / 2; if (!by.has(k)) by.set(k, []); by.get(k).push(it); });
    return [...by.entries()].sort((a, b) => b[0] - a[0]).map(([y, its]) => ({ y, its: its.sort((a, b) => a.x - b.x) }));
  }

  // Левая колонка (L.p., Lista, Nr akt) и правая (Nazwisko, Imię) — не таблица.
  const TBL_X = [105, 548];
  function parseOdcinek(items) {
    const all = rows(items), out = { f: {}, other: [], ovt: {} };
    const txt = items.map(i => i.t.trim());
    const di = items.findIndex(i => /^data wyp/i.test(i.t.trim()));
    if (di >= 0) {
      const y = items[di].y, d = items.find(i => Math.abs(i.y - y) < 3 && i.x > items[di].x && /^\d{4}-\d{2}-\d{2}$/.test(i.t.trim()));
      if (d) out.payDate = d.t.trim();
    }
    const lp = txt.map(t => t.match(/^LP\s+(\d+)\/(\d{2})\/(\d{4})(\S*)\s*-\s*(.+)$/i)).find(Boolean);
    if (lp) { out.month = `${lp[3]}-${lp[2]}`; out.list = `${lp[1]}/${lp[2]}/${lp[3]}${lp[4]}`; out.listName = lp[5].trim(); out.kind = /korek/i.test(lp[5]) ? 'kor' : 'main'; }
    else {
      const li = txt.map(t => t.match(/^(\d+)\/(\d{2})\/(\d{4})\S*$/)).find(Boolean);
      if (li) { out.month = `${li[3]}-${li[2]}`; out.list = li[0]; out.kind = 'main'; }
    }
    const inTbl = it => it.x >= TBL_X[0] && it.x < TBL_X[1] && it.t.trim();
    let lastOvt = null;
    for (let i = 0; i < all.length - 1; i++) {
      const r = all[i];
      if (r.its.some(it => /podsumowanie/i.test(it.t))) break;     // дальше — повтор итогов
      const labels = r.its.filter(it => inTbl(it) && !isNum(it.t));
      if (!labels.length) continue;
      const nx = all[i + 1];
      if (!(r.y - nx.y > 2 && r.y - nx.y < 16)) continue;
      const vals = nx.its.filter(it => inTbl(it) && isNum(it.t));
      if (!vals.length) continue;
      let pairs;
      if (vals.length === labels.length) pairs = labels.map((l, k) => [l, vals[k]]);
      else {                                                   // колонки по пустым ячейкам строки подписей
        const cells = r.its.filter(it => !it.t.trim() && it.x >= TBL_X[0] - 10).map(it => it.x);
        const cellOf = x => cells.filter(c => c <= x + .5).pop() ?? -1;
        pairs = labels.map(l => [l, vals.find(v => cells.length ? cellOf(v.x) === cellOf(l.x) : Math.abs(v.x - l.x) < 40)]).filter(p => p[1]);
      }
      for (const [l, v] of pairs) {
        const label = l.t.trim(), value = toNum(v.t), k = keyOf(label);
        if (!Number.isFinite(value)) continue;
        if (k === 'ovtHours') { const pct = /\b5\d?\b/.test(label.replace(/^.*nadgodz\.?/i, '')) ? 50 : 100; lastOvt = pct; out.ovt[pct] = { ...(out.ovt[pct] || {}), hours: value }; continue; }
        if (k === 'ovtAmount') { const pct = lastOvt || 100; out.ovt[pct] = { ...(out.ovt[pct] || {}), amount: value }; continue; }
        if (k && SUM.has(k)) out.f[k] = Math.round(((out.f[k] || 0) + value) * 100) / 100;
        else if (k && out.f[k] === undefined) out.f[k] = value;
        else if (!k) out.other.push({ label, value });
      }
    }
    return out;
  }

  // Файл → разобранный odcinek. Ошибки — коды для понятного текста в UI.
  async function readFile(file, inflate) {
    if (!file) throw new Error('no-file');
    if (file.size > 3e6) throw new Error('too-big');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const items = await pdfText(bytes, inflate);
    if (!items.length) throw new Error('no-text');
    const s = parseOdcinek(items);
    if (!s.month || s.f.netto === undefined || s.f.brutto === undefined) throw new Error('not-odcinek');
    return s;
  }

  const Slip = { pdfText, parseOdcinek, readFile, keyOf, toNum, isNum, inflateWeb };
  if (typeof module !== 'undefined' && module.exports) module.exports = Slip;
  else root.Slip = Slip;
})(typeof globalThis !== 'undefined' ? globalThis : this);
