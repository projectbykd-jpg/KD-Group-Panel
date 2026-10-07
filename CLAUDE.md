# Aturan WAJIB untuk setiap sesi Claude di repo ini

## 1. Asisten KD (livechat bot panel) HARUS selalu paham semuanya -- lebih pintar dari admin dan dari Claude

Perintah pemilik: **setiap update, di sesi manapun, yang berkaitan dengan panel ini, wajib membuat Asisten KD
(chat melayang kanan-bawah) ikut paham -- lebih paham daripada admin maupun Claude.**

Untuk SETIAP perubahan menu, tombol, kartu, tab Admin, pengaturan, alur kerja, pesan galat, atau cara pasang/pakai:

1. Perbarui `panel-worker/src/lib/assistant-kb.ts` di **commit yang sama** (KB_PAGES / KB_ADMIN_TABS / KB_FAQ /
   KB_GENERAL), lalu naikkan `ASSISTANT_KB_VERSION`.
2. Tambahkan **keluhan/gejala yang mungkin ditanyakan user** ke `KB_FAQ` (gejala -> penyebab -> langkah) dan sinonim awam
   ke `SYNONYMS` bila ada istilah baru.
3. `npm run check` menjalankan `test/assistant-kb.spec.ts` yang MENGGAGALKAN CI bila ada menu, tab admin, judul halaman,
   atau judul kartu yang belum dijelaskan. **Jangan menonaktifkan/melonggarkan test itu -- isi KB-nya.**
4. Jangan menulis rahasia (password/key/token/cookie) di KB.
5. Sebelum mengakhiri sesi: tanyakan pada diri sendiri "kalau user bertanya tentang hal yang baru saya ubah, apakah
   asisten bisa menjawab dengan benar?" -- jika tidak, perbaiki KB-nya dulu.

Detail dan alasan: `claude-memory/assistant-kb-wajib-update.md`.

## 2. Aturan lain pemilik
- Jangan ubah logika bisnis yang sudah jalan (`claude-memory/dont-break-working-logic.md`).
- Desain: tanpa neon/glow, tanpa backdrop-filter di elemen besar, animasi pendek, popup minimal (`claude-memory/panel-*.md`).
- Jangan menyentuh database produksi dari sandbox; jangan memakai/meminta key asli pemilik.
- Setelah perubahan selesai: merge ke `main` dan pantau deploy (otorisasi tetap dari pemilik).
