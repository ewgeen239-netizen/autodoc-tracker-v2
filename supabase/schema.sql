-- ═══════════════════════════════════════════════════════════════════
--  AutoDoc Tracker v2 — схема базы.
--  Supabase → SQL Editor → вставить → Run. Скрипт идемпотентный:
--  повторный запуск ничего не стирает и доводит старую базу до новой.
--
--  Кто куда пишет:
--    leaderboard, consents       — только Edge Function «api» (service_role),
--                                  после проверки подписи Telegram;
--    bot_users, shifts,
--    notify_log, ics_tokens      — бот и Edge Function (service_role);
--    paydays, indirect           — только Edge Function (даты зарплаты, Indirect).
--  Анон-ключ (он публичный, лежит в Mini App) может только читать
--  рейтинг, и то без Telegram ID.
-- ═══════════════════════════════════════════════════════════════════


-- 1. РЕЙТИНГ ─────────────────────────────────────────────────────────
create table if not exists public.leaderboard (
  uid        text        not null,
  month      text        not null,           -- 'YYYY-MM'
  name       text,
  emoji      text,
  photo_url  text,
  bonus      numeric     default 0,
  peaks      integer     default 0,
  hours      numeric     default 0,
  shifts     integer     default 0,
  ppc        numeric     default 0,
  updated_at timestamptz default now(),
  primary key (uid, month)
);
-- pub — непрозрачный id для подсветки «это ты» (HMAC от uid на сервере).
alter table public.leaderboard add column if not exists pub text;
-- смена и группа — для бейджа «DARK A» в рейтинге
alter table public.leaderboard add column if not exists team text;
alter table public.leaderboard add column if not exists grp  text;
create index if not exists leaderboard_month_bonus_idx on public.leaderboard (month, bonus desc);

alter table public.leaderboard enable row level security;
drop policy if exists "leaderboard read"   on public.leaderboard;
drop policy if exists "leaderboard insert" on public.leaderboard;
drop policy if exists "leaderboard update" on public.leaderboard;
create policy "leaderboard read" on public.leaderboard for select using (true);

-- Telegram ID наружу не отдаём: анону — только безопасные колонки.
revoke select on public.leaderboard from anon, authenticated;
grant select (pub, month, name, emoji, photo_url, bonus, peaks, hours, shifts, ppc, team, grp, updated_at)
  on public.leaderboard to anon, authenticated;


-- 2. СОГЛАСИЯ ────────────────────────────────────────────────────────
create table if not exists public.consents (
  uid         text        not null,
  version     text        not null,
  name        text,
  tg_username text,
  ua          text,
  accepted_at timestamptz default now(),
  primary key (uid, version)
);
alter table public.consents enable row level security;


-- 3. ПОЛЬЗОВАТЕЛИ БОТА + НАСТРОЙКИ ОПОВЕЩЕНИЙ ────────────────────────
create table if not exists public.bot_users (
  uid        text        primary key,
  name       text,
  username   text,
  active     boolean     default true,         -- false — заблокировал бота
  started_at timestamptz default now()
);
alter table public.bot_users add column if not exists team       text;               -- dark | orange | green
alter table public.bot_users add column if not exists grp        text;               -- A..F
alter table public.bot_users add column if not exists team_at    timestamptz;
alter table public.bot_users add column if not exists notify     jsonb default '{"h12":true,"h1":true,"peaks":true,"pay":true}'::jsonb;
alter table public.bot_users add column if not exists rebuild    boolean default false; -- пересобрать смены
alter table public.bot_users add column if not exists off        jsonb default '[]'::jsonb; -- дни отпуска из приложения
alter table public.bot_users add column if not exists updated_at timestamptz default now();
create index if not exists bot_users_rebuild_idx on public.bot_users (rebuild) where rebuild;
alter table public.bot_users enable row level security;


-- 4. СМЕНЫ (собираются ботом из schedule.json + ручные правки админа) ─
create table if not exists public.shifts (
  uid        text        not null,
  day        date        not null,              -- дата начала смены
  starts     time        not null,
  ends       time        not null,              -- меньше starts → через полночь
  kind       text        not null default 'DARK',
  note       text,
  source     text        not null default 'auto',   -- auto | admin
  updated_at timestamptz default now(),
  primary key (uid, day)
);
create index if not exists shifts_day_idx on public.shifts (day);
alter table public.shifts enable row level security;


-- 5. ЖУРНАЛ ОПОВЕЩЕНИЙ: каждое уходит ровно один раз, даже после рестарта
create table if not exists public.notify_log (
  uid     text        not null,
  key     text        not null,                 -- '2026-10-14:h12', 'pay:2026-10' …
  sent_at timestamptz default now(),
  primary key (uid, key)
);
create index if not exists notify_log_sent_idx on public.notify_log (sent_at);
alter table public.notify_log enable row level security;


-- 6. ССЫЛКИ НА КАЛЕНДАРЬ (.ics) ──────────────────────────────────────
create table if not exists public.ics_tokens (
  uid        text        primary key,
  token      text        not null unique,
  created_at timestamptz default now()
);
alter table public.ics_tokens enable row level security;


-- 7. ДАТЫ ЗАРПЛАТЫ ──────────────────────────────────────────────────
-- Когда пришла зарплата: только дата, без сумм. Из дат всех людей
-- приложение строит прогноз следующей зарплаты. Читает и пишет только
-- Edge Function (service role), наружу отдаются счётчики по датам.
create table if not exists public.paydays (
  uid        text        not null,
  month      text        not null,              -- месяц работы 'YYYY-MM'
  kind       text        not null default 'main',  -- main | kor
  paid_on    date        not null,
  updated_at timestamptz default now(),
  primary key (uid, month, kind)
);
create index if not exists paydays_month_idx on public.paydays (month);
alter table public.paydays enable row level security;


-- 8. ПРЕМИЯ INDIRECT ─────────────────────────────────────────────────
-- Сумма премии Indirect из pasku и часы на Indirect за месяц. Из этого
-- считается средняя ставка Indirect за час по складу. Пишет и читает только
-- Edge Function; наружу — только средние по месяцу, без uid.
create table if not exists public.indirect (
  uid        text        not null,
  month      text        not null,              -- 'YYYY-MM'
  amount     numeric     not null,              -- zł брутто
  hours      numeric     not null,
  updated_at timestamptz default now(),
  primary key (uid, month)
);
create index if not exists indirect_month_idx on public.indirect (month);
alter table public.indirect enable row level security;


-- 6b. Смена в рейтинге для тех, кто уже выбрал её в боте или приложении
update public.leaderboard l set team = b.team, grp = b.grp
from public.bot_users b
where b.uid = l.uid and l.team is null and b.team is not null;


-- 7. СИД: всех из рейтинга — в реестр бота ───────────────────────────
insert into public.bot_users (uid, name, active)
select distinct on (uid) uid, name, true from public.leaderboard order by uid, updated_at desc
on conflict (uid) do nothing;


-- 8. УБОРКА от игровой версии (раскомментируй, если игры больше не нужны)
-- drop table if exists public.durak_rooms, public.sol_leaderboard, public.game_stats, public.wallets cascade;
-- drop function if exists public.bump_game_stats(jsonb), public.wallet_apply(jsonb), public.sol_to_game_stats();


-- 9. ПРОВЕРКА: у всех таблиц rls_on = true; политика есть только у leaderboard.
select c.relname as table_name, c.relrowsecurity as rls_on,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('leaderboard', 'consents', 'bot_users', 'shifts', 'notify_log', 'ics_tokens', 'paydays', 'indirect')
order by c.relname;
