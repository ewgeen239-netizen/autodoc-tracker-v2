// node tests/slip.test.mjs — чтение odcinka płacowego из PDF.
// PDF собирается здесь же, как его печатает Streamsoft: шрифт Type0/Identity-H
// с ToUnicode, поток Flate, таблица «строка подписей → строка сумм».
// Цифры выдуманные: настоящие odcinki в репозиторий не кладём.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const S = require('../assets/js/slip.js');
const C = require('../assets/js/core.js');
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const inflate = b => zlib.inflateSync(b);

const hex = txt => [...txt].map(c => c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('');
const cell = (x, y, txt) => `BT\r0 0 0 rg\r/F3 8 Tf\r0.05 Tc\r${x} ${y} Td <${hex(txt)}> Tj\rET\r\n`;
const XS = [116, 177, 238, 299, 360, 420, 481];
function tableRows(y, labels, values) {
  let s = '';
  labels.forEach((l, i) => { s += cell(XS[i], y, ' ') + cell(XS[i] + 5, y, l); });
  values.forEach((v, i) => { s += cell(XS[i] + 40, y - 8, v); });
  return s;
}
function buildPdf(content) {
  const cmap = '/CIDInit /ProcSet findresource begin\r\nbegincmap\r\n1 begincodespacerange\r\n <0000> <FFFF>\r\nendcodespacerange\r\n'
    + '1 beginbfrange\r\n <0020> <017F> <0020>\r\nendbfrange\r\nendcmap\r\n';
  const body = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const cm = zlib.deflateSync(Buffer.from(cmap, 'latin1'));
  const parts = [
    '%PDF-1.4\r\n1 0 obj\r\n<<\r\n/Type /Catalog\r\n/Pages 2 0 R\r\n>>\r\nendobj\r\n',
    '6 0 obj\r\n<<\r\n/Type /Page\r\n/MediaBox [0 0 839 595]\r\n/Parent 2 0 R\r\n/Contents 7 0 R\r\n>>\r\nendobj\r\n',
    '7 0 obj\r\n<<\r\n/Length 8 0 R\r\n/Filter /FlateDecode\r\n>>\r\nstream\r\n', body, '\r\nendstream\r\nendobj\r\n',
    `8 0 obj\r\n${body.length}\r\nendobj\r\n`,
    '2 0 obj\r\n<<\r\n/Type /Pages\r\n/Count 1\r\n/Kids [6 0 R]\r\n/Resources 5 0 R\r\n>>\r\nendobj\r\n',
    '5 0 obj\r\n<<\r\n/Font <<\r\n/F3 12 0 R>>\r\n>>\r\nendobj\r\n',
    '12 0 obj\r\n<</Type/Font/Subtype/Type0/Name/F3/BaseFont/TimesNewRoman/Encoding/Identity-H/ToUnicode 23 0 R>>\r\nendobj\r\n',
    `23 0 obj\r\n<<\r\n/Length ${cm.length}\r\n/Filter /FlateDecode\r\n>>\r\nstream\r\n`, cm, '\r\nendstream\r\nendobj\r\n%%EOF\r\n',
  ];
  return new Uint8Array(Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p, 'latin1') : p))));
}

const night = '873,82';
const content =
  cell(458, 542, 'Data wypłaty: ') + cell(506, 542, '2026-11-10') + cell(418, 520, 'LP 1/10/2026A - GŁÓWNA') +
  cell(40, 476, 'L.p.') + cell(553, 476, 'Nazwisko:') + cell(588, 476, ' TESTOWY') +
  tableRows(476, ['Stawka godzinowa', 'Ilość godzin pracy', 'Płaca podstawowa', 'Premia zad. - obec.', 'Ilość godzin nocn', 'Kwota za godziny ', 'Ilość nadgodz. 50'],
    ['30,00', '160,00', '4 800,00', '500,00', '160,00', night, '4,00']) +
  tableRows(460, ['Kwota za nadgodzi', 'Brutto', 'Podstawa ZUS', 'Składki pracowni', 'Podstawa zdrowot', 'Zus 52 - Kwota zd', 'BENEFIT (Zus i Pit'],
    ['180,00', '6 353,82', '6 353,82', '871,11', '5 482,71', '493,44', '10,00']) +
  tableRows(444, ['Podstawa podatku', 'Procent podatku', 'Ekwiwal. za odzież', 'Ekwiwal. za pranie', 'Siła wyższa', 'Przelew', 'Do wypłaty'],
    ['5 483,00', '12,00', '12,00', '10,95', '0,00', '5 002,22', '5 002,22']) +
  cell(44, 389, '   Podsumowanie') + tableRows(389, ['Brutto'], ['99 999,00']);

await t('PDF: текст с координатами через ToUnicode', async () => {
  const items = await S.pdfText(buildPdf(content), inflate);
  assert.ok(items.some(i => i.t === 'Data wypłaty: ' && i.x === 458 && i.y === 542));
  assert.ok(items.some(i => i.t === 'LP 1/10/2026A - GŁÓWNA'));
});

await t('odcinek: подписи и суммы по колонкам, итоги «Podsumowanie» не мешают', async () => {
  const s = S.parseOdcinek(await S.pdfText(buildPdf(content), inflate));
  assert.equal(s.month, '2026-10'); assert.equal(s.kind, 'main'); assert.equal(s.payDate, '2026-11-10');
  assert.equal(s.list, '1/10/2026A');
  assert.equal(s.f.rate, 30); assert.equal(s.f.hours, 160); assert.equal(s.f.base, 4800); assert.equal(s.f.bonus, 500);
  assert.equal(s.f.night, 873.82); assert.equal(s.f.brutto, 6353.82);          // не 99 999 из итогов
  assert.equal(s.f.zus, 871.11); assert.equal(s.f.health, 493.44); assert.equal(s.f.benefit, 10);
  assert.equal(s.f.ekw, 22.95);                                                // одежда + стирка
  assert.equal(s.f.netto, 5002.22);
  assert.deepEqual(s.ovt, { 50: { hours: 4, amount: 180 } });
  assert.deepEqual(s.other, [{ label: 'Siła wyższa', value: 0 }]);
});

await t('odcinek → проверка: ZUS, здоровье, ночные, сверхурочные сходятся', async () => {
  const s = S.parseOdcinek(await S.pdfText(buildPdf(content), inflate));
  const r = C.slipCheck([s], { young: true });
  const lv = title => r.items.find(i => i.title === title).level;
  assert.equal(lv('ZUS 13,71%'), 'ok');
  assert.equal(lv('Składka zdrowotna 9%'), 'ok');
  assert.equal(lv('Ночная доплата 20%'), 'ok');
  assert.equal(lv('Сверхурочные +50%'), 'ok');
  assert.equal(lv('PIT 0 zł'), 'ok');
  assert.equal(r.level, 'ok');
});

await t('korekta и не-odcinek', async () => {
  const kor = cell(418, 520, 'LP 9/05/2026A - KOREKTA 2') + cell(458, 542, 'Data wypłaty: ') + cell(506, 542, '2026-06-19') +
    tableRows(476, ['Premia zad. - obec.', 'Brutto', 'Do wypłaty'], ['126,01', '126,01', '98,94']);
  const s = S.parseOdcinek(await S.pdfText(buildPdf(kor), inflate));
  assert.equal(s.kind, 'kor'); assert.equal(s.month, '2026-05'); assert.equal(s.f.bonus, 126.01);
  await assert.rejects(S.pdfText(new Uint8Array(Buffer.from('hello')), inflate), /not-pdf/);
  const empty = { size: 10, arrayBuffer: async () => buildPdf(cell(100, 100, 'Faktura')).slice().buffer };
  await assert.rejects(S.readFile(empty, inflate), /not-odcinek/);
});

console.log(`\n${n} проверок пройдено`);
