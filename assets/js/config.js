// Публичные настройки Mini App. Секретов здесь быть не должно: anon-ключ
// Supabase публичный по замыслу, запись в таблицы закрыта RLS и идёт только
// через Edge Function «api», которая проверяет подпись Telegram.
window.APP_CONFIG = Object.freeze({
  SB_URL: 'https://mkuwkntdcpfsxhqblkic.supabase.co',
  SB_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rdXdrbnRkY3Bmc3hocWJsa2ljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5NTc3MDQsImV4cCI6MjA5ODUzMzcwNH0.k0_tWR0SgvWKBWmfkb9Z7qRLhHSAvkmmpGnQWEFm2f8',
  API_FN: 'api',                 // имя Edge Function
  BOT_USERNAME: 'AutDdoc_bot',
  CONSENT_VERSION: '2.0',        // подними — согласие спросят заново
});
