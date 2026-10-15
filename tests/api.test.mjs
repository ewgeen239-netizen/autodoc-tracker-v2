// node tests/api.test.mjs — Edge Function «api» с заглушками Deno и базы.
// Проверяет главное в безопасности: без верной подписи Telegram записи нет.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const BOT_TOKEN = '123456:TEST';
const NEW_TOKEN = '777777:NEWBOT';
const env = { BOT_TOKEN, BOT_TOKENS: ' ' + NEW_TOKEN + ', ', PROJECT_URL: 'https://db.test', SERVICE_ROLE_KEY: 'svc' };
let handler; const calls = [];
globalThis.Deno = { env: { get: k => env[k] }, serve: fn => { handler = fn; } };
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
  return new Response(String(url).includes('select=') ? '[]' : '', { status: 201 });
};
await import('../supabase/functions/api/index.ts');

function initData(user, authDate = Math.floor(Date.now() / 1000), token = BOT_TOKEN) {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: 'q1', user: JSON.stringify(user) });
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}
const post = (body) => handler(new Request('https://fn.test/api', { method: 'POST', body: JSON.stringify(body) }));
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const me = { id: 777, first_name: 'Ewa' };

await t('подпись чужим токеном — 401 с причиной', async () => {
  const r = await post({ initData: initData(me, undefined, '999:OTHER'), action: 'hello' });
  assert.equal(r.status, 401); assert.equal((await r.json()).reason, 'bad_signature');
});
await t('подпись вторым ботом из BOT_TOKENS принимается', async () => {
  const r = await post({ initData: initData({ ...me, id: 790 }, undefined, NEW_TOKEN), action: 'ping' });
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.uid, '790'); assert.equal(j.tokens, 2);
});
await t('просроченный initData — 401', async () => {
  const r = await post({ initData: initData(me, Math.floor(Date.now() / 1000) - 90000), action: 'hello' });
  assert.equal(r.status, 401); assert.equal((await r.json()).reason, 'expired');
});
await t('подменённый user после подписи — 401', async () => {
  const good = new URLSearchParams(initData(me));
  good.set('user', JSON.stringify({ id: 1, first_name: 'Hacker' }));
  const r = await post({ initData: good.toString(), action: 'hello' });
  assert.equal(r.status, 401);
});
await t('верная подпись — uid берётся из подписи', async () => {
  const r = await post({ initData: initData(me), action: 'hello' });
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.uid, '777'); assert.match(j.pub, /^[0-9a-f]{16}$/);
});
await t('rank: премия с обецностью ×1,25 проходит', async () => {
  const r = await post({ initData: initData({ ...me, id: 791 }), action: 'rank', row: { month: new Date().toISOString().slice(0, 7), peaks: 1000, hours: 16, shifts: 2, bonus: 1000 * 0.74 * 1.25 } });
  assert.equal(r.status, 200);
});
await t('rank: неправдоподобная премия — 422', async () => {
  const r = await post({ initData: initData({ ...me, id: 778 }), action: 'rank', row: { month: new Date().toISOString().slice(0, 7), peaks: 100, hours: 8, shifts: 1, bonus: 5000 } });
  assert.equal(r.status, 422);
});
await t('rank: пишет доверенный uid, а не присланный', async () => {
  calls.length = 0;
  const r = await post({ initData: initData({ ...me, id: 779 }), action: 'rank', row: { uid: '1', month: new Date().toISOString().slice(0, 7), peaks: 1000, hours: 16, shifts: 2, bonus: 100, name: '<b>x</b>', team: 'dark', group: 'B' } });
  assert.equal(r.status, 200);
  const w = calls.find(c => c.url.includes('/leaderboard'));
  assert.equal(w.body.uid, '779'); assert.equal(w.body.name, 'bx/b');
  assert.equal(w.body.team, 'dark'); assert.equal(w.body.grp, 'B');
});
await t('profile: плохая смена — 400, хорошая — rebuild', async () => {
  assert.equal((await post({ initData: initData({ ...me, id: 780 }), action: 'profile', team: 'red', group: 'A' })).status, 400);
  calls.length = 0;
  const r = await post({ initData: initData({ ...me, id: 781 }), action: 'profile', team: 'dark', group: 'B', off: ['2026-10-20', 'drop table'] });
  assert.equal(r.status, 200);
  const w = calls.find(c => c.url.includes('/bot_users'));
  assert.equal(w.body.rebuild, true); assert.deepEqual(w.body.off, ['2026-10-20']);
});
await t('частые запросы — 429', async () => {
  const d = initData({ ...me, id: 782 });
  await post({ initData: d, action: 'consent' });
  assert.equal((await post({ initData: d, action: 'consent' })).status, 429);
});
await t('payday: дата зарплаты пишется с доверенным uid, мусор — 400', async () => {
  const now = new Date(), W = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const day = now.toISOString().slice(0, 10);
  assert.equal((await post({ initData: initData({ ...me, id: 783 }), action: 'payday', month: W, paid_on: '2020-01-01' })).status, 400);
  assert.equal((await post({ initData: initData({ ...me, id: 784 }), action: 'payday', month: W, paid_on: '2026-02-31' })).status, 400);
  calls.length = 0;
  const r = await post({ initData: initData({ ...me, id: 785 }), action: 'payday', month: W, paid_on: day, uid: '1' });
  assert.equal(r.status, 200);
  const w = calls.find(c => c.url.includes('/paydays'));
  assert.equal(w.body.uid, '785'); assert.equal(w.body.paid_on, day); assert.equal(w.body.kind, 'main');
  calls.length = 0;
  assert.equal((await post({ initData: initData({ ...me, id: 786 }), action: 'payday', month: W, paid_on: '' })).status, 200);
  assert.equal(calls.find(c => c.url.includes('/paydays')).method, 'DELETE');
});
await t('paydays: наружу только счётчики по датам', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('/paydays')
    ? [{ month: '2026-09', paid_on: '2026-10-09' }, { month: '2026-09', paid_on: '2026-10-09' }, { month: '2026-09', paid_on: '2026-10-08' }] : []), { status: 200 });
  try {
    const r = await post({ initData: initData({ ...me, id: 787 }), action: 'paydays' });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.deepEqual(j.reports, { '2026-09': { '2026-10-09': 2, '2026-10-08': 1 } });
    assert.ok(!JSON.stringify(j).includes('uid'));
  } finally { globalThis.fetch = real; }
});
console.log(`\n${n} проверок пройдено`);
