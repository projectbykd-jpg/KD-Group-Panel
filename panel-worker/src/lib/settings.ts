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
	{ key: "sys_catchup_minutes", group: "Auto Posting Prediksi", label: "Toleransi susulan sesi", hint: "Sesi yang terlewat masih dikirim selama selisih waktunya tidak melebihi ini.", unit: "menit", def: 25, min: 5, max: 120 },
	{ key: "sys_auto_input_history_days", group: "Auto Prediksi (Input Otomatis)", label: "Riwayat job ditampilkan", hint: "Menu Auto Prediksi menampilkan semua job selama N hari terakhir (tidak lagi dibatasi 30 baris). Tidak ada job yang dihapus otomatis.", unit: "hari", def: 7, min: 1, max: 30 },
	{ key: "sys_auto_input_retry_max", group: "Auto Prediksi (Input Otomatis)", label: "Percobaan ulang otomatis", hint: "Job Auto Prediksi yang GAGAL dicoba ulang otomatis sebanyak ini (tanpa klik user). 0 = mati. Angka yang sudah masuk tidak pernah diinput dobel; hanya Hitung yang dilanjutkan.", unit: "kali", def: 2, min: 0, max: 5 },
	{ key: "sys_auto_input_retry_gap_min", group: "Auto Prediksi (Input Otomatis)", label: "Jeda antar percobaan ulang", hint: "Jarak waktu dari gagal terakhir sampai dicoba lagi (cron berjalan tiap menit).", unit: "menit", def: 2, min: 1, max: 30 },
	{ key: "sys_totomacau_mode", group: "Auto Check Toto Macau", label: "Mode Auto Check Toto Macau", hint: "0 = mati, 1 = hanya baca admin & bandingkan dengan Panel-Z (tidak mengirim), 2 = ikut mengisi baris Panel-Z (pasaran + tanggal yang sama) yang MASIH KOSONG. Angka yang sudah ada & berbeda tidak pernah ditimpa.", unit: "0/1/2", def: 1, min: 0, max: 2 },
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
	{ key: "sys_news_public_cache_sec", group: "Jaringan & Cache", label: "Cache daftar berita publik", hint: "Daftar berita di halaman publik di-cache sebentar supaya ringan. 0 = tanpa cache.", unit: "detik", def: 60, min: 0, max: 3600 },
	{ key: "sys_news_ext_fetch_budget", group: "Bot News", label: "Tarikan sumber luar per putaran", hint: "Batas tarikan feed/redirect eksternal tiap putaran cron (menjaga batas 50 subrequest Cloudflare).", unit: "tarikan", def: 14, min: 3, max: 25 },
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
