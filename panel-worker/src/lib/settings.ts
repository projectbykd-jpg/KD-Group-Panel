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
	{ key: "sys_login_max_fails", group: "Keamanan Login", label: "Batas salah password", hint: "Akun dikunci sementara setelah salah sebanyak ini berturut-turut.", unit: "kali", def: 5, min: 3, max: 20 },
	{ key: "sys_login_lock_minutes", group: "Keamanan Login", label: "Lama akun terkunci", hint: "Berlaku setelah batas salah password tercapai.", unit: "menit", def: 10, min: 1, max: 120 },
	{ key: "sys_session_ttl_days", group: "Sesi Login", label: "Masa berlaku sesi", hint: "Hanya berlaku untuk sesi BARU (sesi yang sudah ada tidak berubah).", unit: "hari", def: 21, min: 1, max: 60 },
	{ key: "sys_max_sessions", group: "Sesi Login", label: "Maks. sesi per user", hint: "Sesi terlama dicabut bila user punya lebih dari ini.", unit: "sesi", def: 30, min: 1, max: 100 },
	{ key: "sys_invest_limit_2d", group: "AutoCheck Invest (default)", label: "Batas line 2D", hint: "Default untuk user yang belum mengisi sendiri di menu AutoCheck Invest.", unit: "line", def: 20, min: 1, max: 100000 },
	{ key: "sys_invest_limit_3d", group: "AutoCheck Invest (default)", label: "Batas line 3D", hint: "Default untuk user yang belum mengisi sendiri.", unit: "line", def: 250, min: 1, max: 100000 },
	{ key: "sys_invest_limit_4d", group: "AutoCheck Invest (default)", label: "Batas line 4D", hint: "Default untuk user yang belum mengisi sendiri.", unit: "line", def: 1296, min: 1, max: 100000 },
	{ key: "sys_assistant_enabled", group: "Asisten KD", label: "Asisten KD aktif", hint: "1 = widget chat bantuan tampil & menjawab; 0 = dimatikan.", unit: "1/0", def: 1, min: 0, max: 1 },
	{ key: "sys_assistant_fallback", group: "Asisten KD", label: "Cadangan ke provider bot", hint: "1 = bila key khusus asisten gagal, boleh memakai AI Provider menu BOT; 0 = key khusus saja (kuota provider lain aman).", unit: "1/0", def: 0, min: 0, max: 1 },
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
