-- Hak akses menu per user (diatur di Admin -> Users), lihat src/lib/menus.ts.
--   ''          = default: semua menu yang diizinkan role-nya
--   '["result"]' = hanya menu yang tercantum (Dashboard selalu ada)
--
-- TIDAK WAJIB dijalankan manual: Worker menambah kolom ini sendiri saat query
-- pertama menemukan kolomnya belum ada (withUserMenusColumn di src/lib/db.ts).
ALTER TABLE users ADD COLUMN menus TEXT NOT NULL DEFAULT '';
