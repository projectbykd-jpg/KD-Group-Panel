---
name: panel-design-direction
description: "Arah desain Day-Group Panel — dark \"premium modern\" + motion bergaya anime.js"
metadata: 
  node_type: memory
  pinned: false
  originSessionId: e25bb91f-1271-4c1d-8610-18c5c58b8ef7
  modified: 2026-09-10T00:33:20.710Z
---

Untuk **Day-Group Panel** (`panel-worker`, Cloudflare Worker), pemilik proyek
(projectbykd@gmail.com) meminta arah desain **dark "premium modern"** —
gaya dashboard SaaS: gradient halus, border tipis tegas, shadow lembut,
tipografi tegas, **efek neon/glow dikurangi** (bukan gaya "gamer glow").
Diterapkan di level design token & class inti di `ui-src/Styles.html` supaya
propagasi ke semua menu ("semua rata"), bukan per-halaman.

Pemilik juga minta **micro-interaction bergaya animejs.com**: staggered
reveal, angka count-up, spring "pop" saat nilai berubah. Diimplementasikan
lewat **anime.js 3.2.2** (CDN cdnjs) + modul `FX` di `ui-src/Scripts.html`.
`FX` otomatis nonaktif kalau anime.js gagal dimuat, `prefers-reduced-motion`,
atau `localStorage.dg_fx === 'off'`. Animasi harus **pendek (<=520ms)** dan
tidak menghalangi kerja CS — panel ini alat produksi 16 operator.

Pemilik lebih suka **semua konfigurasi bisa diedit dari panel**, bukan
mengutak-atik database langsung. Contoh: menu Admin -> "Website" untuk
mengelola `site_accounts` (token/chat id Telegram, login LinkTree & Panel-Z
per website). Kalau menambah tabel/kolom konfigurasi baru, sekalian buatkan
UI CRUD-nya di panel.

Performa lebih penting daripada efek visual — pemilik berkali-kali mengeluh
panel "berat / lag / crash saat scroll". Aturan yang sudah menyakiti:
- **JANGAN** pakai `backdrop-filter: blur()` di elemen besar / sticky
  (header, sidebar, kartu). Browser me-render ulang blur tiap frame saat
  scroll -> tab freeze, apalagi di GPU integrated. `.glass-card` sekarang
  latar solid pekat, tanpa backdrop-filter. (Toast & modal kecil boleh.)
- Animasi anime.js harus **membersihkan inline `transform`/`opacity`** saat
  selesai (`complete` callback) — ratusan `<tr>` dengan transform sisa =
  ratusan layer compositor = scroll berat.
- Animasi baris tabel cuma saat **pertama kali dibuka**, bukan tiap ketik
  di search / ganti halaman.

Tailwind **tidak lagi** pakai Play CDN (`cdn.tailwindcss.com`) karena
compiler runtime + MutationObserver-nya bikin Chrome berat tiap DOM rebuild. Sekarang di-compile sekali saat
`scripts/build-ui.mjs` (devDep `tailwindcss@3`, `tailwind.config.js`,
`ui-src/tw.css`) lalu di-inline **SESUDAH** `Styles.html` — kalau ditaruh
sebelum, custom CSS menang atas utility Tailwind dan layout (mis. header)
berantakan.


## Design System v2 (2026-10) — rombak total tampilan, logika TIDAK diubah

Sumber kebenaran visual TUNGGAL: `ui-src/Redesign.css` (dimuat paling akhir, sesudah
Styles.html + Tailwind). Lapisan lama "PROFESSIONAL AGENT CONSOLE V2" (±480 baris
`!important` ber-ID) dan blok `body.theme-dynamic` (gradien latar + 2 blob blur fixed)
di `Styles.html` SUDAH DIHAPUS -- jangan dikembalikan; itu yang bikin perang CSS.

- Permukaan NETRAL solid (`--ui-bg/surface/surface-2/surface-3`), border 1px, tanpa
  glow/neon/blur. Aksen = warna brand website operator (`--theme-primary` diisi
  `applyWebsiteTheme()`), dipakai hanya untuk nav aktif, tombol primer, fokus, progress.
- Shell: sidebar penuh-tinggi menempel kiri (sticky), top bar sticky solid (judul halaman
  diisi dari menu aktif oleh skrip kecil di akhir `Fixes.html` -- hanya MEMBACA class
  `nav-active`), konten maks 1480px. Scroll = dokumen (bukan kontainer dalam).
- `display` `#app-container` dipaksa `flex !important` inline oleh JS -> tetap model flex.
- Aturan elemen global memakai `:where()` (spesifisitas 0) supaya komponen bisa menimpa.
- Halaman yang dibungkus satu kartu besar berisi judul: bungkus dilepas lewat
  `.glass-card:has(> .page-head)` (jadi kartu tingkat pertama, bukan kotak-dalam-kotak).
- Teks sekunder minimal AA (token `--ui-text-3` = #7f8da4). Teks di atas aksen gelap
  (#06101c) -- sudah dicek ke 12 warna brand (rasio >= 5,1).
- Tetap berlaku: tanpa `backdrop-filter` di elemen besar/sticky (modal boleh, kini
  dimatikan juga), animasi pendek, popup minimalis.
- Uji: jalankan wrangler lokal + Playwright (klik semua nav, CRUD user, parser Result,
  filter, logout) -- 46 skenario lulus, nol error JS.
