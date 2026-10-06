-- Auto Prediksi (input Nomor Keluar + Hitung otomatis). TIDAK WAJIB dijalankan
-- manual: Worker membuat tabel ini sendiri (ensureAutoInputTables, lib/auto-input.ts).
CREATE TABLE IF NOT EXISTS auto_input_config (
  username   TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS auto_input_session (
  username   TEXT NOT NULL,
  website    TEXT NOT NULL,
  base_url   TEXT NOT NULL DEFAULT '',
  phpsessid  TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (username, website)
);
CREATE TABLE IF NOT EXISTS auto_input_job (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL,
  website     TEXT NOT NULL,
  market      TEXT NOT NULL,
  prizes      TEXT NOT NULL DEFAULT '[]',
  result_date TEXT NOT NULL DEFAULT '',
  result_key  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'RUNNING',
  stage       TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  period      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT '',
  UNIQUE (website, result_key)
);
CREATE INDEX IF NOT EXISTS ix_auto_input_job_user ON auto_input_job(username, id);
