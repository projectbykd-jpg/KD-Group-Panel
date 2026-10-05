-- OPSIONAL & MANUAL -- TIDAK dijalankan otomatis oleh deploy / tes.
--
-- Tabel di bawah adalah SISA di D1 (day_database) sesudah data berat
-- dipindah ke Turso (scripts/migrate-to-turso.mjs). Worker sudah TIDAK
-- membacanya lagi: semua query lap_*, invest_* dan sent_registry memakai
-- getTurso(env) (src/lib/turso.ts, tanpa fallback ke D1) dan tidak ada
-- index runtime yang menyentuhnya. Isinya cuma salinan lama dari sebelum
-- pindah ke Turso, dan hanya memakan kuota penyimpanan D1.
--
-- DROP TABLE tidak bisa dibatalkan. BACKUP dulu dari folder panel-worker/:
--   npx wrangler d1 export day_database --remote --output d1-backup-sebelum-drop.sql
-- Sesudah backup tersimpan aman, jalankan:
--   npx wrangler d1 execute day_database --remote --file ../migration/manual/drop_legacy_d1_tables.sql
--
-- Yang TETAP dipakai di D1 (JANGAN dihapus): users, sessions, settings,
-- activity_log, site_accounts, prediction_registry, prediction_content,
-- login_throttle.
DROP TABLE IF EXISTS invest_raw;
DROP TABLE IF EXISTS invest_result;
DROP TABLE IF EXISTS invest_state;
DROP TABLE IF EXISTS invest_config;
DROP TABLE IF EXISTS lap_job;
DROP TABLE IF EXISTS lap_result;
DROP TABLE IF EXISTS lap_credentials;
DROP TABLE IF EXISTS sent_registry;
