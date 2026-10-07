---
name: assistant-kb-wajib-update
description: "Asisten KD (chat melayang) hanya tahu isi src/lib/assistant-kb.ts -- WAJIB diperbarui di setiap perubahan fitur"
metadata:
  node_type: memory
  pinned: true
---

Pemilik meminta **Asisten KD** (widget chat melayang di kanan bawah panel, memakai
AI Provider dari menu BOT, mis. Groq) harus **selalu lebih paham panel daripada
pemiliknya**.

Aturan untuk setiap sesi/PR berikutnya:

1. Setiap menambah/mengubah/menghapus **menu, tombol penting, tab Admin, pengaturan
   sistem (`src/lib/settings.ts`), alur kerja**, perbarui
   `panel-worker/src/lib/assistant-kb.ts` (KB_PAGES / KB_ADMIN_TABS / KB_GENERAL) di
   **commit yang sama**, lalu naikkan `ASSISTANT_KB_VERSION`.
2. `panel-worker/test/assistant-kb.spec.ts` menggagalkan CI bila ada menu sidebar
   (`id="nav-*"` di `ui-src/Index.html`) atau tab admin (`data-admin-tab`) yang belum
   dijelaskan -- jangan menonaktifkan test itu, isi KB-nya.
3. Jangan menulis rahasia (password/key/token/cookie) di KB. Asisten hanya memberi
   panduan teks; tidak menjalankan aksi.
4. Hemat token: hanya bagian relevan yang dikirim ke AI (`selectKnowledge`). Tambahkan
   sinonim di `SYNONYMS` bila ada istilah awam baru.
