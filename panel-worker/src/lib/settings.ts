// Pengaturan sistem yang bisa diubah ADMIN dari menu Admin > Pengaturan Sistem.
// Disimpan di D1 settings (key "sys_*"). Kode membaca lewat getSys*() dengan
// batas min/max, jadi nilai rusak/di luar batas tidak bisa membuat sistem macet.
// Cache singkat per-isolate (15 dtk) supaya cron/request tidak membaca D1 berulang.

export type SysSettingDef = {
	key: string;
	group: string;
	label: string;
	hint: string;
	unit?: string;
	def: number;
	min: number;
	max: number;
};

export const SYS_SETTINGS: SysSettingDef[] = [
	{ key: "sys_log_retention_days", group: "Log & Retensi", label: "Simpan log aktivitas", hint: "Log lebih lama dari ini dihapus otomatis tiap hari.", unit: "hari", def: 7, min: 1, max: 90 },
	{ key: "sys_errorlog_days", group: "Log & Retensi", label: "Simpan log Error & Bug", hint: "Catatan di Admin > Error & Bug yang terakhir terjadinya lebih lama dari ini dihapus otomatis tiap hari.", unit: "hari", def: 14, min: 1, max: 60 },
	{ key: "sys_errorlog_max_rows", group: "Log & Retensi", label: "Batas baris log Error & Bug", hint: "Galat yang sama digabung jadi satu baris (dengan hitungan). Bila baris melebihi batas ini, yang paling lama (dan sudah Selesai/Diabaikan lebih dulu) dibuang.", unit: "baris", def: 500, min: 50, max: 5000 },
	{ key: "sys_health_cron_stale_min", group: "Log & Retensi", label: "Batas cron dianggap mati (penjaga panel)", hint: "Bila detak cron Cloudflare terakhir lebih lama dari ini, /health?deep=1 menyatakan GAGAL dan workflow GitHub 'Penjaga panel' mengirim peringatan Telegram. Cron normal berdetak tiap menit.", unit: "menit", def: 10, min: 3, max: 120 },
	{ key: "sys_errorlog_alert_gap_min", group: "Notifikasi Telegram Admin", label: "Jeda minimum pesan galat Error & Bug", hint: "Galat BARU (atau yang muncul lagi setelah ditandai Selesai) dikirim paling sering sekali per sekian menit. Galat lain yang muncul selama jeda TIDAK dibuang: dikumpulkan dan dikirim sebagai satu ringkasan begitu jeda lewat.", unit: "menit", def: 10, min: 5, max: 1440 },
	{ key: "sys_tgn_err_block", group: "Notifikasi Telegram Admin", label: "Kirim: galat yang menghambat user", hint: "Galat API / tampilan yang dialami user saat memakai panel. 1 = kirim ke grup Telegram Notifikasi Galat (Admin > Integrasi), 0 = mati (tetap tercatat di panel).", unit: "0/1", def: 1, min: 0, max: 1 },
	{ key: "sys_tgn_err_bg", group: "Notifikasi Telegram Admin", label: "Kirim: galat latar (cron, Toto, Auto Prediksi)", hint: "Galat proses otomatis yang berjalan sendiri, sekali per galat baru (galat yang sama tidak diulang sampai ditandai Selesai). 1 = kirim ke grup Telegram Notifikasi Galat (Admin > Integrasi), 0 = mati (tetap tercatat di panel).", unit: "0/1", def: 1, min: 0, max: 1 },
	{ key: "sys_tgn_autopost", group: "Notifikasi Telegram Admin", label: "Kirim: Auto Posting prediksi gagal", hint: "Sesi prediksi yang tetap GAGAL terkirim ke grup Telegram website setelah semua percobaan ulang habis, lengkap dengan website & alasannya. 1 = kirim ke grup Telegram Notifikasi Galat (Admin > Integrasi), 0 = mati (tetap tercatat di panel).", unit: "0/1", def: 1, min: 0, max: 1 },
	{ key: "sys_tgn_autoinput", group: "Notifikasi Telegram Admin", label: "Kirim: Auto Prediksi gagal (final)", hint: "Job Auto Prediksi yang tetap GAGAL setelah percobaan ulang otomatis habis (perlu input manual). 1 = kirim ke grup Telegram Notifikasi Galat (Admin > Integrasi), 0 = mati (tetap tercatat di panel).", unit: "0/1", def: 1, min: 0, max: 1 },
	{ key: "sys_tgn_toto", group: "Notifikasi Telegram Admin", label: "Kirim: Toto Macau gagal / beda angka", hint: "Draw Toto Macau/5D yang GAGAL dikirim ke Panel-Z setelah percobaan habis, atau angka Panel-Z BEDA dengan admin. 1 = kirim ke grup Telegram Notifikasi Galat (Admin > Integrasi), 0 = mati (tetap tercatat di panel).", unit: "0/1", def: 1, min: 0, max: 1 },
	{ key: "sys_tgn_channel", group: "Notifikasi Telegram Admin", label: "Kirim: channel Telegram berhenti posting", hint: "Posting otomatis ke channel Telegram berhenti karena galat konfigurasi (token, Chat ID, izin admin). Sekali per jenis galat per hari. 1 = kirim ke grup Telegram Notifikasi Galat (Admin > Integrasi), 0 = mati (tetap tercatat di panel).", unit: "0/1", def: 1, min: 0, max: 1 },
	{ key: "sys_tgn_daily", group: "Notifikasi Telegram Admin", label: "Kirim: laporan harian", hint: "Ringkasan KEMARIN: Auto Posting prediksi, Auto Prediksi, Toto Macau, posting channel, dan Error & Bug. 1 = kirim ke grup Telegram Notifikasi Galat (Admin > Integrasi), 0 = mati (tetap tercatat di panel).", unit: "0/1", def: 1, min: 0, max: 1 },
	{ key: "sys_tgn_daily_hour", group: "Notifikasi Telegram Admin", label: "Jam laporan harian", hint: "Laporan harian (ringkasan hari KEMARIN 00:00-23:59) dikirim sekali sehari pada pemeriksaan pertama (tiap 5 menit) setelah jam ini (WIB). 0 = tepat lewat tengah malam (±00:00-00:05), begitu hari sebelumnya selesai.", unit: "jam WIB", def: 0, min: 0, max: 23 },
	{ key: "sys_tgch_daily_cap", group: "Channel Telegram", label: "Batas posting channel Telegram per hari", hint: "Jumlah maksimum artikel yang diposting otomatis ke channel Telegram dalam sehari (WIB). Melebihi ini, sisanya menunggu besok. Dengan jeda 5 menit maksimum hanya 288 per hari, jadi bawaan 500 praktis berarti tanpa batas harian.", unit: "artikel", def: 500, min: 1, max: 1000 },
	{ key: "sys_tgch_gap_min", group: "Channel Telegram", label: "Jeda antar posting channel Telegram", hint: "Jarak minimum antara dua posting otomatis ke channel (supaya tidak membanjiri pengikut). Pengecekan berjalan tiap 5 menit.", unit: "menit", def: 5, min: 5, max: 240 },
	{ key: "sys_tgch_max_age_h", group: "Channel Telegram", label: "Umur maksimum artikel yang diposting ke channel", hint: "Hanya artikel yang tayang di web berita dalam sekian jam terakhir yang diposting ke channel. Mencegah arsip lama membanjiri channel saat fitur baru dinyalakan.", unit: "jam", def: 24, min: 1, max: 168 },
	{ key: "sys_livechat_burst_reset_sec", group: "Live Chat Bot", label: "Jeda antar rentetan pesan (bot)", hint: "Bot membalas SATU kali per rentetan pesan member. Rentetan dianggap selesai bila member diam selama ini; setelah itu balasan berikutnya boleh. Berlaku untuk skrip bot yang dipasang ulang / dimuat ulang.", unit: "detik", def: 90, min: 30, max: 600 },
	{ key: "sys_livechat_grace_sec", group: "Live Chat Bot", label: "Toleransi member baru chat 1x (bot)", hint: "Member yang baru chat sekali belum dianggap spam: bot menunggu sekian detik sebelum membalas.", unit: "detik", def: 30, min: 5, max: 300 },
	{ key: "sys_livechat_stale_min", group: "Live Chat Bot", label: "Batas sinkron bot dianggap mati", hint: "Menu Sesi Chat memberi peringatan bila userscript/bot di tab DayLiveChat belum menyinkronkan data lebih lama dari ini (tab tertutup, bot dimatikan, atau login CS habis). Daftar sesi bisa usang dan bot tidak membalas selama itu.", unit: "menit", def: 3, min: 1, max: 60 },
	{ key: "sys_livechat_prune_hours", group: "Live Chat Bot", label: "Buang sesi chat yang tidak disinkron", hint: "Sesi di menu Sesi Chat yang tidak disinkron bot lebih lama dari ini dibuang otomatis (bot mati / tab DayLiveChat tertutup / kunci lama). Muncul lagi sendiri begitu bot menyinkron.", unit: "jam", def: 6, min: 1, max: 168 },
	{ key: "sys_catchup_minutes", group: "Auto Posting Prediksi", label: "Toleransi susulan sesi", hint: "Sesi yang terlewat masih dikirim selama selisih waktunya tidak melebihi ini.", unit: "menit", def: 25, min: 5, max: 120 },
	{ key: "sys_auto_input_history_days", group: "Auto Prediksi (Input Otomatis)", label: "Riwayat Auto Prediksi disimpan", hint: "Menu Auto Prediksi menampilkan semua job & catatan Auto Check Toto Macau selama N hari terakhir (tidak dibatasi 30 baris). Data yang lebih lama dihapus otomatis tiap hari (job yang masih berjalan tidak disentuh).", unit: "hari", def: 7, min: 1, max: 30 },
	{ key: "sys_auto_input_retry_max", group: "Auto Prediksi (Input Otomatis)", label: "Percobaan ulang otomatis", hint: "Job Auto Prediksi yang GAGAL dicoba ulang otomatis sebanyak ini (tanpa klik user). 0 = mati. Angka yang sudah masuk tidak pernah diinput dobel; hanya Hitung yang dilanjutkan.", unit: "kali", def: 2, min: 0, max: 5 },
	{ key: "sys_auto_input_retry_gap_min", group: "Auto Prediksi (Input Otomatis)", label: "Jeda antar percobaan ulang", hint: "Jarak waktu dari gagal terakhir sampai dicoba lagi (cron berjalan tiap menit).", unit: "menit", def: 2, min: 1, max: 30 },
	{ key: "sys_totomacau_mode", group: "Auto Check Toto Macau", label: "Mode Auto Check Toto Macau", hint: "0 = mati, 1 = hanya baca admin & bandingkan dengan Panel-Z (tidak mengirim), 2 = otomatis mengisi baris Panel-Z (pasaran + tanggal yang sama) yang kosong/xxxx, dan (bila 'Koreksi angka berbeda' = 1) memperbaiki angka yang berbeda dari admin.", unit: "0/1/2", def: 1, min: 0, max: 2 },
	{ key: "sys_totomacau_correct", group: "Auto Check Toto Macau", label: "Koreksi angka berbeda (mode 2)", hint: "1 = angka admin dianggap benar: bila baris Panel-Z sudah berisi angka yang BERBEDA (hasil input manual/auto yang salah), otomatis diperbaiki ke angka admin; angka lama dicatat di log. 0 = angka berbeda tidak ditimpa (hanya ditandai BEDA ANGKA + peringatan). Hanya berlaku di mode 2.", unit: "0/1", def: 1, min: 0, max: 1 },
	{ key: "sys_totomacau_lookback_days", group: "Auto Check Toto Macau", label: "Periksa angka admin sampai (hari)", hint: "Auto Check membaca halaman admin (tombol [ >> ]) mundur sebanyak hari ini dari hari ini, lalu mencocokkan & memperbaiki baris Panel-Z di rentang itu. Makin besar = makin banyak halaman dibaca (lebih lama).", unit: "hari", def: 7, min: 1, max: 14 },
	{ key: "sys_totomacau_max_correct", group: "Auto Check Toto Macau", label: "Batas koreksi massal per putaran", hint: "Bila angka Panel-Z yang BERBEDA dari admin dalam satu putaran lebih banyak dari ini, kemungkinan pemetaan tanggal/pasaran yang keliru (bukan salah ketik): koreksi otomatis ditahan, baris ditandai BEDA ANGKA, dan muncul peringatan. Naikkan hanya bila memang banyak angka salah.", unit: "baris", def: 10, min: 1, max: 100 },
	{ key: "sys_totomacau_before_min", group: "Auto Check Toto Macau", label: "Pemicu aktif sebelum jam draw", hint: "Pemicu otomatis mulai hidup sekian menit SEBELUM jam draw Toto Macau / Macao 5D (00, 13, 15, 16, 19, 21, 22, 23 WIB). Di luar jendela draw pemicu tidak aktif (lihat 'Jeda di luar jam draw').", unit: "menit", def: 2, min: 0, max: 60 },
	{ key: "sys_totomacau_after_min", group: "Auto Check Toto Macau", label: "Pemicu tetap aktif sesudah jam draw", hint: "Pemicu tetap hidup sekian menit SESUDAH jam draw, supaya angka yang diketik admin agak terlambat tetap tertangkap. Makin besar = makin lama aktif tiap draw.", unit: "menit", def: 45, min: 5, max: 180 },
	{ key: "sys_totomacau_fast_min", group: "Auto Check Toto Macau", label: "Jeda pemeriksaan saat aktif", hint: "Selama jendela draw (atau ada baris yang masih menunggu/gagal), pemeriksaan diulang tiap sekian menit.", unit: "menit", def: 3, min: 1, max: 15 },
	{ key: "sys_totomacau_idle_min", group: "Auto Check Toto Macau", label: "Jeda di luar jam draw (0 = mati)", hint: "0 = pemicu TIDAK aktif di luar jendela draw (hemat; baris yang masih menunggu/gagal tetap dipantau tiap 'Jeda saat aktif'). Isi mis. 60 bila ingin sapuan rutin tiap jam sebagai jaring pengaman angka yang diketik sangat terlambat.", unit: "menit", def: 0, min: 0, max: 240 },
	{ key: "sys_login_max_fails", group: "Keamanan Login", label: "Batas salah password", hint: "Akun dikunci sementara setelah salah sebanyak ini berturut-turut.", unit: "kali", def: 5, min: 3, max: 20 },
	{ key: "sys_login_lock_minutes", group: "Keamanan Login", label: "Lama akun terkunci", hint: "Berlaku setelah batas salah password tercapai.", unit: "menit", def: 10, min: 1, max: 120 },
	{ key: "sys_session_ttl_days", group: "Sesi Login", label: "Masa berlaku sesi", hint: "Hanya berlaku untuk sesi BARU (sesi yang sudah ada tidak berubah).", unit: "hari", def: 21, min: 1, max: 60 },
	{ key: "sys_max_sessions", group: "Sesi Login", label: "Maks. sesi per user", hint: "Sesi terlama dicabut bila user punya lebih dari ini.", unit: "sesi", def: 30, min: 1, max: 100 },
	{ key: "sys_invest_limit_2d", group: "AutoCheck Invest (default)", label: "Batas line 2D", hint: "Default untuk user yang belum mengisi sendiri di menu AutoCheck Invest.", unit: "line", def: 20, min: 1, max: 100000 },
	{ key: "sys_invest_limit_3d", group: "AutoCheck Invest (default)", label: "Batas line 3D", hint: "Default untuk user yang belum mengisi sendiri.", unit: "line", def: 250, min: 1, max: 100000 },
	{ key: "sys_invest_limit_4d", group: "AutoCheck Invest (default)", label: "Batas line 4D", hint: "Default untuk user yang belum mengisi sendiri.", unit: "line", def: 1296, min: 1, max: 100000 },
	{ key: "sys_slot_guard_hours", group: "Auto Posting Prediksi", label: "Masa kunci sesi terkirim", hint: "Setelah sesi terkirim/diblokir, sesi itu dikunci selama ini supaya tidak terkirim dobel. Jangan terlalu pendek.", unit: "jam", def: 6, min: 1, max: 24 },
	{ key: "sys_slot_max_attempts", group: "Auto Posting Prediksi", label: "Maks. percobaan sesi gagal", hint: "Setelah gagal sebanyak ini berturut-turut, sesi dikunci dan tidak dicoba lagi hari itu.", unit: "kali", def: 3, min: 1, max: 10 },
	{ key: "sys_autopost_lock_seconds", group: "Auto Posting Prediksi", label: "Kunci anti-tumpang-tindih", hint: "Lama kunci saat satu putaran auto-posting berjalan (mencegah dua putaran sekaligus).", unit: "detik", def: 180, min: 60, max: 600 },
	{ key: "sys_ip_fail_window_min", group: "Keamanan Login", label: "Jendela hitung salah login per IP", hint: "Percobaan login gagal dari satu IP dihitung dalam rentang ini.", unit: "menit", def: 15, min: 5, max: 120 },
	{ key: "sys_ip_max_fails", group: "Keamanan Login", label: "Batas salah login per IP", hint: "IP diblokir sementara bila gagal login sebanyak ini dalam jendela di atas (longgar: satu IP kantor dipakai banyak operator).", unit: "kali", def: 30, min: 5, max: 200 },
	{ key: "sys_lap_stale_pending_min", group: "Laporan Harian (Tarik Data)", label: "Job dianggap gagal start", hint: "Job 'menunggu' yang tidak bergerak selama ini ditandai gagal (GitHub Actions gagal start).", unit: "menit", def: 15, min: 5, max: 120 },
	{ key: "sys_lap_stale_running_min", group: "Laporan Harian (Tarik Data)", label: "Job dianggap macet", hint: "Job 'berjalan' tanpa kabar selama ini ditandai gagal. Sebaiknya lebih besar dari batas gagal start.", unit: "menit", def: 25, min: 5, max: 120 },
	{ key: "sys_lap_dup_job_min", group: "Laporan Harian (Tarik Data)", label: "Cegah job ganda", hint: "Klik TARIK DATA lagi dalam rentang ini memakai job yang masih berjalan, bukan membuat job baru.", unit: "menit", def: 30, min: 5, max: 120 },
	{ key: "sys_fetch_timeout_sec", group: "Jaringan & Cache", label: "Batas tunggu panggilan keluar", hint: "Panggilan ke situs luar (Telegram, Panel-Z, berita, GitHub, dll) yang lebih lama dari ini dibatalkan.", unit: "detik", def: 25, min: 5, max: 60 },
	{ key: "sys_api_timeout_sec", group: "Jaringan & Cache", label: "Batas tunggu permintaan panel", hint: "Permintaan panel (menu, login, tombol) yang menggantung lebih lama dari ini dijawab dengan pesan galat yang jelas, dicatat di Admin > Error & Bug, dan dikabarkan ke Telegram admin -- bukan 'Memuat…' tanpa akhir. Prosesnya tetap diselesaikan di belakang. Harus lebih besar dari proses terlama (tarik laporan / proses BOT).", unit: "detik", def: 100, min: 30, max: 170 },
	{ key: "sys_news_public_cache_sec", group: "Jaringan & Cache", label: "Cache daftar berita publik", hint: "Daftar berita di halaman publik di-cache sebentar supaya ringan. 0 = tanpa cache.", unit: "detik", def: 60, min: 0, max: 3600 },
	{ key: "sys_news_ext_fetch_budget", group: "Bot News", label: "Tarikan sumber luar per putaran", hint: "Batas tarikan feed/redirect eksternal tiap putaran cron (menjaga batas 50 subrequest Cloudflare).", unit: "tarikan", def: 14, min: 3, max: 25 },
	{ key: "sys_news_site_daily_cap", group: "Bot News", label: "Batas artikel situs sendiri per hari", hint: "Jumlah maksimum artikel baru yang tayang di Berita Terkini (situs sendiri) per hari WIB. Lebih sedikit tetapi rapi lebih disukai Google & AdSense daripada ratusan tulisan ulang per hari. Sisanya tetap di antrean (dibersihkan otomatis tiap hari). 0 = tanpa batas. Tidak mengubah batas Blogger (daily_cap di BOT > Setting).", unit: "artikel", def: 40, min: 0, max: 500 },
	{ key: "sys_news_max_run_count", group: "Bot News", label: "Maks. artikel per klik manual", hint: "Batas jumlah artikel yang boleh dibuat dalam satu klik manual (tiap artikel memakai ±4-8 subrequest).", unit: "artikel", def: 5, min: 1, max: 10 },
	{ key: "sys_dash_summary_ttl_sec", group: "Jaringan & Cache", label: "Cache ringkasan Aktivitas", hint: "Ringkasan di menu Aktivitas/Dashboard di-cache sebentar supaya database tidak dibebani. Lebih kecil = lebih real-time.", unit: "detik", def: 25, min: 5, max: 300 },
	{ key: "sys_dash_facet_ttl_sec", group: "Jaringan & Cache", label: "Cache pilihan filter Aktivitas", hint: "Daftar pilihan filter (user, aksi, website) di-cache selama ini.", unit: "detik", def: 60, min: 10, max: 600 },
	{ key: "sys_assistant_max_q", group: "Asisten KD", label: "Panjang pertanyaan maks.", hint: "Pertanyaan yang lebih panjang ditolak (menghemat token).", unit: "karakter", def: 600, min: 200, max: 2000 },
	{ key: "sys_assistant_enabled", group: "Asisten KD", label: "Asisten KD aktif", hint: "1 = widget chat bantuan tampil & menjawab; 0 = dimatikan.", unit: "1/0", def: 1, min: 0, max: 1 },
	{ key: "sys_assistant_per_hour", group: "Asisten KD", label: "Batas pertanyaan per user", hint: "Maks. pertanyaan per user tiap jam (menjaga kuota AI).", unit: "per jam", def: 40, min: 5, max: 500 },
	{ key: "sys_assistant_max_tokens", group: "Asisten KD", label: "Panjang jawaban maks.", hint: "Batas token jawaban asisten (lebih besar = lebih panjang & lebih boros).", unit: "token", def: 800, min: 200, max: 2000 },
];

const BY_KEY = new Map(SYS_SETTINGS.map((d) => [d.key, d]));
const TTL_MS = 15_000;
let cache: { at: number; map: Map<string, number> } | null = null;

export function clampSys(def: SysSettingDef, v: unknown): number {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) return def.def;
	return Math.min(def.max, Math.max(def.min, n));
}

async function loadAll(env: Env): Promise<Map<string, number>> {
	if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
	const map = new Map<string, number>();
	try {
		const rows = await env.DB.prepare(`SELECT key, value FROM settings WHERE key LIKE 'sys\\_%' ESCAPE '\\'`).all<{ key: string; value: string }>();
		for (const r of rows.results ?? []) {
			const d = BY_KEY.get(r.key);
			if (d && String(r.value ?? "").trim() !== "") map.set(r.key, clampSys(d, r.value));
		}
	} catch {
		/* tabel settings belum siap -> pakai default */
	}
	cache = { at: Date.now(), map };
	return map;
}

export async function getSys(env: Env, key: string): Promise<number> {
	const d = BY_KEY.get(key);
	if (!d) throw new Error("Pengaturan tidak dikenal: " + key);
	return (await loadAll(env)).get(key) ?? d.def;
}

/** Nilai dari cache saja, TANPA menyentuh database (untuk batas waktu: database yang menggantung tidak boleh ikut
 *  menggantungkan batas waktunya sendiri). Cache kosong -> nilai bawaan. */
export function getSysCached(key: string): number {
	const d = BY_KEY.get(key);
	if (!d) throw new Error("Pengaturan tidak dikenal: " + key);
	return cache?.map.get(key) ?? d.def;
}

export async function getAllSys(env: Env): Promise<{ def: SysSettingDef; value: number }[]> {
	const m = await loadAll(env);
	return SYS_SETTINGS.map((def) => ({ def, value: m.get(def.key) ?? def.def }));
}

export async function saveSys(env: Env, values: Record<string, unknown>): Promise<string[]> {
	const changed: string[] = [];
	for (const d of SYS_SETTINGS) {
		if (!(d.key in values)) continue;
		const v = clampSys(d, values[d.key]);
		await env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
			.bind(d.key, String(v))
			.run();
		changed.push(`${d.label}=${v}`);
	}
	cache = null;
	return changed;
}

export function resetSysCache(): void {
	cache = null;
}
