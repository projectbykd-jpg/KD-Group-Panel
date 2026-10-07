# Agent Live Chat Auto-Reply (tanpa browser / Tampermonkey)

Program kecil yang melakukan pekerjaan yang sama dengan userscript `daylivechat-autobot`, tetapi **tanpa browser**:
login ke DayLiveChat dengan akun CS, mengikuti chat lewat Socket.IO, dan membalas otomatis di sesi yang kamu nyalakan
di panel (**Live Chat → Sesi Chat**). Template, aturan spam, dan jeda balasan **sama persis** dengan userscript.

## Syarat penting
- **Harus dijalankan di komputer/jaringan yang IP-nya sudah diizinkan DayLiveChat** (tempat CS biasa login).
  DayLiveChat mengunci login CS ke IP tertentu; dari server/cloud login akan ditolak 403.
- Komputer harus **menyala terus** selama bot dipakai (PC kantor/CS, atau VPS yang IP-nya didaftarkan ke DayLiveChat).
- Node.js 18+ (disarankan LTS) — https://nodejs.org

## Pasang (sekali)
1. Salin folder `livechat-agent` ke komputer itu.
2. Salin `.env.example` menjadi `.env`, lalu isi:
   - `BOT_KEY` — kunci bot (minta ke admin panel)
   - `LC_EMAIL`, `LC_PASSWORD` — akun CS DayLiveChat
   File `.env` hanya ada di komputer ini; password **tidak pernah dikirim ke panel**. Jangan membagikannya.
3. Windows: klik dua kali **`start.bat`** (memasang dependensi otomatis, lalu menjalankan; hidup lagi sendiri bila berhenti).
   Lainnya: `npm install` lalu `node agent.mjs`.
4. Di panel buka **Live Chat → Sesi Chat**: sesi muncul otomatis; nyalakan switch pada sesi yang mau dibalas.

Agar jalan otomatis saat komputer menyala (Windows): Task Scheduler → *Create Task* → Trigger *At log on* →
Action: jalankan `start.bat`.

## Perhatian
- **Jangan menjalankan agent ini dan userscript Tampermonkey sekaligus** untuk akun yang sama (balasan bisa ganda).
- Bila DayLiveChat hanya mengizinkan satu sesi login per akun, login agent bisa mengeluarkan CS dari sesi browser-nya.
  Pakai akun CS khusus bot bila memungkinkan.
- Login yang gagal berulang akan dijeda otomatis (15 dtk → maks 5 mnt) supaya akun tidak terkunci.
- Pesan "Login ditolak 403 … IP" berarti komputer ini belum diizinkan DayLiveChat.
- Pesan "token tidak ditemukan di balasan" berarti format login berubah — kirim daftar field yang ditampilkan ke pengembang.
