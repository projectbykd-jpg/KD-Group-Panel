-- Kolom news_article yang sudah ada di Turso produksi tetapi belum tercatat di
-- migrasi mana pun (ditambahkan otomatis oleh ensureNewsCategoryColumns /
-- ensureFbTemplateColumn di src/lib/bot-news.ts, atau manual untuk
-- fb_direct_posted_at). File ini DOKUMENTASI skema + dipakai unit test;
-- JANGAN dijalankan ulang di produksi (ALTER ... ADD COLUMN gagal kalau kolom
-- sudah ada).
ALTER TABLE news_article ADD COLUMN meta_description TEXT NOT NULL DEFAULT '';
ALTER TABLE news_article ADD COLUMN views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE news_article ADD COLUMN claimed_at TEXT NOT NULL DEFAULT '';
ALTER TABLE news_article ADD COLUMN fb_direct_posted_at TEXT NOT NULL DEFAULT '';
ALTER TABLE news_article ADD COLUMN fb_template_caption TEXT NOT NULL DEFAULT '';
