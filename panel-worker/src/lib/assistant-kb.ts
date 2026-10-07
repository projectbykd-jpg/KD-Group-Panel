// ============================================================================
// BASIS PENGETAHUAN "ASISTEN KD" (widget chat melayang di panel)
//
// ATURAN WAJIB: setiap menambah / mengubah fitur, menu, tab admin, atau
// pengaturan sistem, PERBARUI file ini di commit yang sama. Asisten hanya
// "tahu" apa yang tertulis di sini; test/assistant-kb.spec.ts MENGGAGALKAN CI
// bila ada menu, tab admin, atau pengaturan sistem yang belum dijelaskan.
// Naikkan ASSISTANT_KB_VERSION setiap kali isi berubah.
// Jangan menulis rahasia (password, key, token) di sini.
// ============================================================================

export const ASSISTANT_KB_VERSION = "2026-10-07.4";

/** Penjelasan per menu. Kunci = id navigasi (nav-<kunci>) di ui-src/Index.html. */
export const KB_PAGES: Record<string, { title: string; text: string }> = {
	home: {
		title: "Dashboard",
		text: "Ringkasan hari ini: jumlah pengiriman Berhasil, Gagal, total Pengiriman, dan Aktivitas. 'Aktivitas terbaru' menampilkan riwayat akun Anda hari ini; 'Akses cepat' membuka menu yang paling sering dipakai. Tombol 'Lihat semua' membuka menu Aktivitas.",
	},
	result: {
		title: "Result",
		text: "Alur harian utama. 1) Salin teks hasil pengeluaran dari Telegram, 2) klik 'Tempel' (atau tempel manual) di kotak 'Teks mentah' — teks otomatis diproses: panel mengenali Pasaran, Prize 1/2/3, Shio, angka 2D, lalu tampil di 'Monitor hasil real-time' dan 'Live preview output'. 3) Pastikan Status 'BENAR', lalu klik 'KIRIM SEMUA SISTEM' (TG = Telegram, LT = LinkTree, PZ = Panel-Z) untuk mengirim ke semua website milik akun Anda. Sistem mencegah pengiriman ganda (duplikat diblokir). Bila salah satu sistem gagal, hasil tiap sistem tampil dan bisa dikirim ulang. 'Kirim manual ke Panel-Z': pilih pasaran + isi angka, klik 'Kirim ke Panel-Z' (tombol 'Tempel Angka' mengambil dari clipboard). 'Salin cepat' menyalin Prize 1/2/3, teks Telegram, Judul LinkTree, Pesan LinkTree, dan teks Panel-Z.",
	},
	prediction: {
		title: "Prediksi",
		text: "Jadwal prediksi per sesi jam (02:35, 06:15, 08:40, 12:40, 16:00, 21:20, 23:25) dan kata-kata penutup (06:15 & 16:00). Per baris: 'Copy' menyalin teks prediksi unik per website; 'Send Auto' mengirim ke semua website milik akun yang belum terkirim hari ini (tanpa duplikat; kolom Status menampilkan 'x dari y website hari ini'). Kartu 'Kata-kata penutup' punya Copy dan Send Auto sendiri dengan pilihan sesi 06:15/16:00. 'Refresh Status' memuat ulang status kirim. Prediksi juga dikirim OTOMATIS oleh Auto Posting (lihat Admin > Maintenance & Log) selama ada operator login; website yang belum punya token Telegram prediksi tidak bisa dikirimi.",
	},
	invest: {
		title: "AutoCheck Invest",
		text: "Memindai semua pasaran di panel agen dan menandai user yang melebihi batas line (2D/3D/4D) hari ini + kemarin. Isi dulu 'Setting panel agen': Base URL, PHPSESSID (wajib; cookie sesi login agen yang masih hidup), koderedis (bila tetap 'session expired'), Cookie mentah (opsional), Limit 2D/3D/4D, dan Daftar pasaran (isi hanya jika scan menghasilkan 0 data). Klik 'Simpan setting', lalu 'Cek koneksi/session' untuk memastikan cookie valid. 'Mulai scan' memulai; 'Lanjutkan scan' meneruskan bila terhenti; 'Reset' mengulang; 'Refresh hasil' memuat hasil terbaru. Hasil muncul di 'User lewat batas'. Bila 'session expired', login ulang ke panel agen dan ambil PHPSESSID baru. Nilai default limit bisa diubah admin di Admin > Pengaturan Sistem.",
	},
	"auto-input": {
		title: "Auto Prediksi",
		text: "Setelah 'KIRIM SEMUA SISTEM' di menu Result, angka result otomatis diinput ke menu 'Nomor Keluar' di admin website lalu di-'Hitung' sesuai pasaran dan jumlah prize. Cara memakai: pada tiap kartu website (hanya website milik akun), tempel PHPSESSID dari Chrome yang sedang login admin website (F12 > Application > Cookies), klik 'Simpan', lalu 'Uji (tanpa kirim)' untuk memastikan sesi hidup sebelum diaktifkan. Tombol 'Aktifkan' di bagian atas menyalakan fitur (status berubah 'AKTIF'). Bila sesi habis, input gagal dan Anda input manual — tempel PHPSESSID baru. Nilai PHPSESSID tidak pernah ditampilkan ulang. Tiap website hanya boleh memakai server admin yang sudah ditetapkan. Tabel di bawah memuat riwayat job (Waktu, Website, Result, Status, Keterangan).",
	},
	"lap-admin": {
		title: "Lap Admin",
		text: "Laporan harian dari panel admin website. Pilih tanggal (Tanggal mulai/selesai, atau tombol Hari ini / Kemarin / 7 hari), klik 'TARIK DATA'. Data ditarik oleh scraper di GitHub Actions (butuh Link Admin + Cookie Admin di menu Setting), progres tampil di 'Progres & riwayat tarik data' dan boleh ditinggal ke menu lain. Hasil: 'Laporan Register' (bisa di-Copy); kartu Total Deposit (total History Operator DIKURANGI operator khusus), Total <operator khusus> seperti Blazz/Khanpay, dan Total Withdraw — sesuai tanggal yang ditarik; Total Selisih, ID Selisih (tombol Copy menyalin daftar ID selisih), WD PGA-IDF; lalu tabel Register (filter Non Referral / With Referral), ID Selisih, Report Agent (filter Action & Operator), Withdraw PGA-IDF, dan Riwayat Koin. Tiap tabel punya pencarian dan tombol Copy. Daftar operator khusus diatur admin di Admin > Pengaturan Sistem. Bila cookie kedaluwarsa, tarik data gagal: ambil Cookie Admin baru dan simpan di Setting. Data lama (sebelum fitur total) menampilkan petunjuk 'klik TARIK DATA'.",
	},
	"lap-motion": {
		title: "Lap Motion",
		text: "Laporan Motion (DP PGA, PGA Pending/Error, PGA Withdraw). Data ditarik lewat Console browser (bukan server) karena Motion sering menolak trafik server: buka panduan 'Lihat cara pakai', buka tab Motion yang sudah login, salin 'Skrip Deposit' (menu RIWAYAT PGA) dan/atau 'Skrip Withdraw' (menu WD REQUEST), tekan F12 > Console, tempel, Enter, isi tanggal, tunggu 'terkirim ke panel OK', lalu klik 'Muat Ulang'. Boleh menjalankan salah satu dulu; data yang belum dijalankan tidak tertimpa kosong. Hasil: kartu ringkasan dan tabel Motion DP PGA, PGA Pending/Error, PGA Withdraw dengan pencarian & Copy.",
	},
	"pga-pending": {
		title: "PGA Pending",
		text: "Daftar live withdraw berstatus PGA Pending dari motionv2.com (WD Request). Tidak ditarik server: jalankan skrip dari panduan 'Cara pakai' di Console tab Motion (menu WD REQUEST), biarkan tab Motion TETAP TERBUKA; daftar di panel update sendiri tiap ±2 detik. Baris yang hilang dari WD Request otomatis hilang. Tabel PGA Pending dan WD Listed punya kotak centang untuk menyalin baris terpilih (Copy menyalin yang dicentang; tanpa centang menyalin semua yang tampil). 'Baris aktif' menunjukkan jumlah data masuk.",
	},
	"lap-mozart": {
		title: "Lap Mozart",
		text: "Laporan Deposit & Withdraw Mozart (m-banking). Mozart diproteksi Cloudflare sehingga data diambil lewat Console tab Mozart: 'Salin Skrip', buka tab Mozart yang sudah login, F12 > Console, tempel, Enter, isi tanggal, tunggu 'terkirim ke panel OK', lalu 'Muat Ulang'. Hasil: kartu (DP Done By Bot, Nominal DP Bot, WD Selesai, Nominal WD Selesai) dan tabel Mozart Deposit/Withdraw per rekening bank dengan total.",
	},
	"lap-setting": {
		title: "Setting (Laporan Harian)",
		text: "Kredensial milik akun Anda untuk menu Laporan Harian: Link Admin + Cookie Admin (nilai PHPSESSID=...; dipakai Lap Admin), Link Motion + Token Motion (header x-access-token) + Vendor ID (Lap Motion), dan akun Mozart. Ambil Cookie/Token dari DevTools (F12). Klik simpan; data tersimpan di database panel dan dipakai semua menu Laporan Harian. Cookie dan token bisa kedaluwarsa — bila tarik data gagal 'cookie kedaluwarsa', ambil yang baru.",
	},
	activity: {
		title: "Aktivitas",
		text: "Riwayat aktivitas (7 hari terakhir; lama retensi diatur admin). Operator melihat aktivitas akunnya sendiri hari ini; Admin melihat semua user. Kartu ringkasan: Aktivitas hari ini, Login, Pengiriman, Berhasil, Gagal. Filter: pencarian teks, User (admin), Aksi, Status, rentang tanggal; klik 'Terapkan' atau 'Reset'. Tabel: Waktu, Username, Aksi, Status (Berhasil/Gagal/Sebagian-Diblokir/Info), Detail, Isi/Data (klik untuk memperluas teks panjang). Pagination di atas tabel.",
	},
	"livechat-sessions": {
		title: "Sesi Chat (Live Chat)",
		text: "Auto-reply DayLiveChat. Bot membalas otomatis member yang spam/kasar HANYA di sesi yang Anda aktifkan; sesi lain tetap dibalas manual oleh CS. Daftar sesi muncul otomatis begitu userscript 'daylivechat-autobot' terpasang di Tampermonkey dan Anda login CS di daylivechat.com/cs/chat. Nyalakan switch 'BOT AKTIF' pada sesi member yang ingin dibalas otomatis. 'Sinkron terakhir' menunjukkan kapan userscript terakhir mengirim data. Cara pasang: pasang ekstensi Tampermonkey, buat script baru dari file userscript panel, isi URL Panel dan Kunci Bot (minta admin), simpan, nyalakan. Hanya ADMIN/OPERATOR.",
	},
	"livechat-templates": {
		title: "Template Balasan (Live Chat)",
		text: "Daftar kalimat balasan yang dipakai bot Live Chat. Tambah, ubah, aktif/nonaktifkan, atau hapus template; urutan (sort) menentukan prioritas. Bot memilih template aktif saat membalas sesi yang BOT AKTIF.",
	},
	admin: {
		title: "Admin",
		text: "Hanya ADMIN. Tab: Users, Website, Sesi Aktif, Auto Posting, Pengaturan Sistem, Maintenance & Log (penjelasan tiap tab ada di bagian Admin).",
	},
	"bot-dashboard": {
		title: "Bot News — Dashboard",
		text: "Khusus role BOT. Ringkasan bot berita: Diposting ke Blogger hari ini, Antre, Total ke Blogger, Total ke Situs Sendiri, Error, dan log artikel terbaru. Toggle 'AUTO-POST' menyalakan posting otomatis terjadwal. 'PROSES' menjalankan sekarang (pilih 'Send ke' dan jumlah artikel). Peringatan merah menunjukkan hal yang perlu dibenahi: Blogger belum terhubung (Hubungkan Ulang) atau tidak ada AI provider aktif (Kelola).",
	},
	"bot-sources": {
		title: "Bot News — Sumber Berita",
		text: "Khusus role BOT. Daftar sumber berita (RSS/Google News) per kategori. Tambah sumber (nama, URL, jenis, kategori), aktif/nonaktifkan, atau hapus. Bot mengambil berita baru dari sumber aktif lalu ditulis ulang oleh AI.",
	},
	"bot-history": {
		title: "Bot News — Riwayat Posting",
		text: "Khusus role BOT. Riwayat artikel yang sudah diproses/diposting beserta statusnya (posted/error/skip) dan tautannya.",
	},
	"bot-fbdirect": {
		title: "Bot News — Template FB",
		text: "Khusus role BOT. Template teks posting Facebook yang dibuat bot; bisa digenerate dan dijalankan langsung.",
	},
	"bot-config": {
		title: "Bot News — Setting",
		text: "Khusus role BOT. Tab: AI Provider (daftar provider: nama, Base URL, API key, model, urutan prioritas, kuota/masa aktif; Tambah Provider; pemakaian terakhir), Konten & Artikel (panjang & gaya), Jadwal Posting, Blogger (hubungkan akun), Sosial & Promo. Simpan lewat tombol SIMPAN SETTING. AI Provider yang aktif di sini juga dipakai Asisten KD.",
	},
};

/** Penjelasan tab menu Admin. Kunci = data-admin-tab di ui-src/Index.html. */
export const KB_ADMIN_TABS: Record<string, { title: string; text: string }> = {
	users: {
		title: "Users",
		text: "Kelola akun: Tambah User / edit / hapus / buka kunci. Isi username, nama, password, role (ADMIN, OPERATOR, VIEWER, BOT), status (AKTIF, NONAKTIF, TERKUNCI), website yang boleh dipakai (kode seperti HUGO,FOLA), akses menu (centang menu yang boleh; semua dicentang = semua menu role-nya), serta izin Telegram/LinkTree/Panel-Z. Mengubah password, menonaktifkan, me-rename, atau menghapus akun otomatis mencabut semua sesinya. Tombol kunci = reset login gagal dan buka kunci akun. Kolom 'Menu' menunjukkan jumlah menu yang diizinkan. Tabel bisa dicari/filter role & status dan digulir ke bawah.",
	},
	sites: {
		title: "Website",
		text: "Kelola data tiap website: nama tampilan, token & chat ID Telegram (result) dan Telegram prediksi, email & password LinkTree, serta URL/user/password Panel-Z. Website baru harus punya kode yang dikenali sistem. Data ini dipakai saat 'KIRIM SEMUA SISTEM' dan Auto Posting. Jangan bagikan isi kolom password.",
	},
	sesi: {
		title: "Sesi Aktif",
		text: "Daftar user yang sedang login (jumlah sesi, waktu login, sesi berakhir) dan kolom 'Auto Post' (ikut auto posting prediksi atau tidak). Tombol 'Refresh sesi' memuat ulang.",
	},
	autopost: {
		title: "Auto Posting",
		text: "Mengaktifkan/menonaktifkan auto posting prediksi: selama ada operator login, prediksi tiap sesi jam dan kata-kata penutup dikirim otomatis ke website milik operator itu (Smart Lock mencegah dobel). Digerakkan cron eksternal yang memanggil 'URL CRON' tiap menit. Tombol: URL CRON, Jalankan Sekarang, Aktifkan/Nonaktifkan.",
	},
	lapops: {
		title: "Pengaturan Sistem",
		text: "Dua bagian. (1) 'Pengaturan Sistem': nilai angka dengan batas aman yang dipakai server — lama simpan log aktivitas, toleransi susulan auto-post, batas salah password & lama kunci akun, masa berlaku sesi & maks sesi per user, default limit AutoCheck Invest 2D/3D/4D, dan pengaturan Asisten KD (aktif/nonaktif, batas pertanyaan per jam, panjang jawaban, cadangan ke provider bot). Di bagian atas ada kartu 'Asisten KD': isi API KEY KHUSUS asisten (Base URL, Model, API key; contoh Groq https://api.groq.com/openai/v1 + llama-3.3-70b-versatile) supaya kuota terpisah dari AI Provider Bot News; tombol Simpan, Tes Koneksi, Hapus Key (key tidak pernah ditampilkan ulang). Di kartu yang sama ada pilihan provider cadangan dari menu BOT (Otomatis = Groq dulu); cadangan hanya dipakai bila pengaturan 'Cadangan ke provider bot' = 1 (bawaan 0 = key khusus saja). Klik SIMPAN (tombol DEFAULT mengembalikan nilai bawaan di form sebelum disimpan). Nilai di luar rentang dijepit otomatis; berlaku ±15 detik. (2) 'Lap Admin · Operator Khusus': daftar operator (label + nama operator) yang dipisahkan dari Total Deposit di Lap Admin, mis. Blazz, Khanpay. Nama operator cocok bila mengandung teks itu (tidak peka huruf besar/kecil), maks 10. Hanya ADMIN yang bisa menyimpan.",
	},
	maintenance: {
		title: "Maintenance & Log",
		text: "Mode Maintenance: saat aktif operator tidak bisa login atau mengirim (admin tetap bisa); isi pesan lalu simpan. Retensi Activity Log: log lebih lama dari batas (default 7 hari, diatur di Pengaturan) dihapus otomatis tiap hari; 'Bersihkan sekarang' memangkas langsung.",
	},
};

/** Penjelasan umum, peran, dan pemecahan masalah. */
export const KB_GENERAL = `
PANEL: KD-Group Panel — panel operasional untuk operator website togel grup KD. Dibuat oleh KD.
LOGIN: Masuk dengan username & password dari admin. Salah password beberapa kali berturut-turut mengunci akun sementara (batas & lama diatur admin); minta admin 'buka kunci'. Sesi berlaku beberapa hari; bila 'Sesi tidak valid', login ulang. Tombol 'Keluar' di kanan atas.
ROLE: ADMIN (semua menu + menu Admin), OPERATOR (menu kerja harian sesuai akses yang diatur admin), VIEWER (hanya baca/terbatas), BOT (khusus modul Bot News, terkunci dari menu lain). Admin bisa membatasi menu per user. Bila sebuah menu tidak terlihat, artinya tidak diizinkan untuk akun itu — minta admin.
TAMPILAN: sidebar kiri berisi menu per grup (Utama, Laporan Harian, Live Chat, Admin); di HP memakai bilah bawah. Logo website akun tampil di kanan atas. Warna aksen mengikuti website akun.
MAINTENANCE: bila mode maintenance aktif, operator tidak bisa kirim/login; hanya admin.
UMUM PENYEBAB GAGAL: (1) cookie/PHPSESSID/token kedaluwarsa — ambil yang baru dari browser yang sedang login; (2) website belum punya token Telegram/LinkTree/Panel-Z di Admin > Website; (3) akun tidak punya akses website/menu; (4) kuota/layanan pihak ketiga (Telegram, GitHub Actions) sedang bermasalah — coba lagi nanti; (5) data duplikat diblokir sengaja agar tidak terkirim dua kali.
KEAMANAN: jangan membagikan password, cookie, token, atau API key kepada siapa pun termasuk asisten ini; asisten tidak butuh dan tidak boleh meminta data itu.
ASISTEN KD: widget chat melayang di kanan bawah, tersedia untuk SEMUA role (termasuk BOT). Tombol '−' menyembunyikan ke tepi kanan; tombol tab kecil di tepi memunculkannya lagi. Asisten hanya memberi panduan (tidak menjalankan aksi) dan memakai API key khusus yang diisi admin di Admin > Pengaturan Sistem (cadangan: AI Provider di Bot > Setting).
`.trim();

export function buildKnowledgeText(): string {
	const pages = Object.entries(KB_PAGES).map(([k, v]) => `## MENU ${v.title} (id: ${k})\n${v.text}`);
	const tabs = Object.entries(KB_ADMIN_TABS).map(([k, v]) => `## ADMIN › ${v.title} (tab: ${k})\n${v.text}`);
	return [KB_GENERAL, ...pages, ...tabs].join("\n\n");
}

// ---------------------------------------------------------------------------
// Pemilihan bagian yang relevan (hemat token: provider gratis seperti Groq
// punya batas token/menit kecil, jadi tidak seluruh manual dikirim tiap tanya).
// Selalu dikirim: info umum + indeks 1 baris tiap menu/tab. Ditambah teks
// lengkap 3 bagian paling cocok dengan pertanyaan (+ riwayat singkat).
// ---------------------------------------------------------------------------
const STOP = new Set("yang dan di ke dari untuk dengan atau ini itu apa bagaimana gimana cara bisa tidak kok mau saya aku kita dong nih ya sih kalau agar supaya pada akan sudah belum lagi juga tapi karena adalah dalam oleh the".split(" "));
// kata awam -> id bagian (menambah skor)
const SYNONYMS: [RegExp, string[]][] = [
	[/kirim|send|telegram|linktree|panel-?z|duplikat|tempel|paste/, ["result", "prediction"]],
	[/prediksi|penutup|jadwal|sesi jam/, ["prediction", "autopost", "auto-input"]],
	[/cookie|phpsessid|session|expired|kedaluwarsa|token/, ["lap-setting", "auto-input", "invest", "lap-admin"]],
	[/tarik|scrape|register|selisih|operator|blazz|khanpay|deposit|withdraw|total/, ["lap-admin", "lapops"]],
	[/motion|pga/, ["lap-motion", "pga-pending"]],
	[/mozart/, ["lap-mozart"]],
	[/user|akun|password|role|akses|kunci|terkunci|hapus|tambah/, ["users"]],
	[/website|situs|token telegram|chat id/, ["sites"]],
	[/log|riwayat|aktivitas|filter/, ["activity", "maintenance"]],
	[/maintenance|retensi/, ["maintenance"]],
	[/pengaturan|setting|batas|limit|durasi|sesi login/, ["lapops", "lap-setting", "invest"]],
	[/bot|berita|blogger|artikel|rss|sumber|facebook|fb|ai provider|api key|groq/, ["bot-dashboard", "bot-sources", "bot-config", "bot-history", "bot-fbdirect"]],
	[/live ?chat|balas|template|userscript|tampermonkey/, ["livechat-sessions", "livechat-templates"]],
	[/dashboard|beranda|ringkasan/, ["home"]],
	[/invest|line|pasaran/, ["invest"]],
];

function firstSentence(t: string, max = 120): string {
	const s = t.split(/(?<=[.!?])\s/)[0] || t;
	return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function selectKnowledge(question: string, history: string[] = [], top = 3): string {
	const q = (question + " " + history.slice(-2).join(" ")).toLowerCase();
	const words = [...new Set(q.split(/[^a-z0-9\-]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
	const entries: { id: string; tab: boolean; title: string; text: string }[] = [
		...Object.entries(KB_PAGES).map(([id, v]) => ({ id, tab: false, title: v.title, text: v.text })),
		...Object.entries(KB_ADMIN_TABS).map(([id, v]) => ({ id, tab: true, title: v.title, text: v.text })),
	];
	const boost = new Map<string, number>();
	for (const [re, ids] of SYNONYMS) if (re.test(q)) for (const id of ids) boost.set(id, (boost.get(id) ?? 0) + 3);
	const scored = entries
		.map((e) => {
			const hay = (e.title + " " + e.text).toLowerCase();
			const titleLc = e.title.toLowerCase();
			let sc = boost.get(e.id) ?? 0;
			for (const w of words) {
				if (titleLc.includes(w)) sc += 3;
				else if (hay.includes(w)) sc += 1;
			}
			return { e, sc };
		})
		.filter((x) => x.sc > 0)
		.sort((a, b) => b.sc - a.sc)
		.slice(0, top);
	const index = entries.map((e) => `- ${e.tab ? "Admin › " : ""}${e.title}: ${firstSentence(e.text)}`).join("\n");
	const detail = scored.map(({ e }) => `## ${e.tab ? "ADMIN › " : "MENU "}${e.title}\n${e.text}`).join("\n\n");
	return `${KB_GENERAL}\n\nINDEKS MENU:\n${index}\n\nPENJELASAN LENGKAP BAGIAN YANG RELEVAN:\n${detail || "(tidak ada yang cocok — tanyakan balik menu mana yang dimaksud)"}`;
}
