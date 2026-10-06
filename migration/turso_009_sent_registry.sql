-- Tabel anti-duplikat kirim result di Turso. Kode (src/lib/registry.ts) memakai
-- Turso, tapi skemanya sebelumnya hanya ada di D1 (001_init.sql). Worker juga
-- membuatnya sendiri saat pertama dipakai; file ini hanya dokumentasi/manual.
-- Aman dijalankan ulang (IF NOT EXISTS).
--
-- Catatan: invest_config.pasaran_json (JSON daftar pasaran) ditambahkan lewat
-- ALTER lazy di src/lib/invest.ts (ensureInvestPasaranColumn). JANGAN diulang
-- manual -- ALTER ... ADD COLUMN gagal kalau kolomnya sudah ada.

CREATE TABLE IF NOT EXISTS sent_registry (
  hash       TEXT NOT NULL,
  website    TEXT NOT NULL,
  sent_at    TEXT NOT NULL DEFAULT '',
  username   TEXT NOT NULL DEFAULT '',
  market     TEXT NOT NULL DEFAULT '',
  telegram   INTEGER NOT NULL DEFAULT 0,
  linktree   INTEGER NOT NULL DEFAULT 0,
  panelz     INTEGER NOT NULL DEFAULT 0,
  content    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (hash, website)
);
CREATE INDEX IF NOT EXISTS ix_sent_registry_sent_at ON sent_registry(sent_at);
