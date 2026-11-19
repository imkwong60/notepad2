/* 雲端同步設定（可留空 → 純本機離線模式）。
   ⚠ anon key 本來就是公開金鑰，但請務必在 Supabase 對 notepad_data 資料表啟用 RLS 並設定政策。 */
window.APP_CONFIG = {
  SUPABASE_URL: 'https://wanknivxcsrasdkkxmfr.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndhbmtuaXZ4Y3NyYXNka2t4bWZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczMzE4NjcsImV4cCI6MjEwMjkwNzg2N30.tqsFimERtYCxoh8J-8FlqxByWtX2gNnyaGo08jditrs',
  TABLE: 'notepad_data',
  ROW_ID: 'main',
  POLL_MS: 30000
};
