-- Pembatas percobaan login gagal per IP (lihat src/lib/login-throttle.ts).
--
-- TIDAK WAJIB dijalankan manual: tabel ini dibuat otomatis oleh Worker saat
-- login pertama sesudah deploy. File ini ada supaya skema tetap terdokumentasi.
CREATE TABLE IF NOT EXISTS login_throttle (
  ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
