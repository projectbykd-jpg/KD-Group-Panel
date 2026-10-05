// Akses D1: profil user + settings/maintenance. Port getUserProfile_ / getMaintenanceSettings_.
import { parseMenus, type MenuKey } from "./menus";

export interface UserProfile {
	id: number;
	username: string;
	role: string; // ADMIN | OPERATOR | VIEWER
	status: string; // AKTIF | NONAKTIF | TERKUNCI
	displayName: string;
	websites: string[]; // UPPERCASE
	permissions: { telegram: boolean; linktree: boolean; panelz: boolean };
	passwordHash: string;
	failedLogin: number;
	lockedUntil: string | null; // "yyyy-MM-dd HH:mm:ss" GMT+7 atau null
	menus: MenuKey[] | null; // null = default semua menu role-nya (lihat lib/menus.ts)
}

const USER_PROFILE_COLUMNS = `id, username, password_hash, websites,
	        perm_telegram, perm_linktree, perm_panelz,
	        role, status, display_name, failed_login, locked_until, menus`;

// Kolom users.menus ditambahkan sesudah database produksi berjalan. Daripada
// butuh migrasi manual, kolom dibuat otomatis saat query pertama menemukan
// kolom itu belum ada (sekali per isolate), lalu query diulang.
let menusColumnReady = false;
export async function ensureUserMenusColumn(env: Env): Promise<void> {
	if (menusColumnReady) return;
	try {
		await env.DB.prepare(`ALTER TABLE users ADD COLUMN menus TEXT NOT NULL DEFAULT ''`).run();
	} catch {
		/* kolom sudah ada */
	}
	menusColumnReady = true;
}
export async function withUserMenusColumn<T>(env: Env, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		if (!/no such column: menus/i.test(String(e instanceof Error ? e.message : e))) throw e;
		menusColumnReady = false;
		await ensureUserMenusColumn(env);
		return fn();
	}
}

function rowToProfile(row: Record<string, unknown>): UserProfile {
	let sites: string[] = [];
	try {
		sites = JSON.parse(String(row.websites ?? "[]"));
	} catch {
		sites = String(row.websites ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}

	return {
		id: Number(row.id),
		username: String(row.username ?? ""),
		role: String(row.role ?? "OPERATOR").toUpperCase(),
		status: String(row.status ?? "AKTIF").toUpperCase(),
		displayName: String(row.display_name || row.username || ""),
		websites: sites.map((s) => String(s).trim().toUpperCase()).filter(Boolean),
		permissions: {
			telegram: !!row.perm_telegram,
			linktree: !!row.perm_linktree,
			panelz: !!row.perm_panelz,
		},
		passwordHash: String(row.password_hash ?? ""),
		failedLogin: Number(row.failed_login ?? 0),
		lockedUntil: (row.locked_until as string) || null,
		menus: parseMenus(row.menus),
	};
}

export async function getUserProfile(env: Env, username: string): Promise<UserProfile | null> {
	const lc = String(username ?? "").trim().toLowerCase();
	if (!lc) return null;
	const row = await withUserMenusColumn(env, () =>
		env.DB.prepare(`SELECT ${USER_PROFILE_COLUMNS} FROM users WHERE username_lc = ?`)
			.bind(lc)
			.first<Record<string, unknown>>(),
	);
	return row ? rowToProfile(row) : null;
}

/**
 * Versi BANYAK-SEKALIGUS dari getUserProfile — satu query `IN (...)` untuk
 * semua username, bukan 1 query per username. Dipakai di tempat yang dulu
 * meloop `await getUserProfile()` (N+1): autoPostWebsites (jalan tiap menit
 * lewat cron) & adminListActiveSessions. Hasilnya di-key pakai username
 * huruf kecil, sama seperti kolom `username_lc` yang dicocokkan.
 */
export async function getUserProfiles(env: Env, usernames: string[]): Promise<Map<string, UserProfile>> {
	const out = new Map<string, UserProfile>();
	const lcs = [...new Set(usernames.map((u) => String(u ?? "").trim().toLowerCase()).filter(Boolean))];
	if (!lcs.length) return out;
	// SQLite membatasi jumlah variabel per statement -> pecah agar tetap aman
	// walau daftar usernya panjang (batas D1/SQLite default 100 variabel).
	for (let i = 0; i < lcs.length; i += 50) {
		const chunk = lcs.slice(i, i + 50);
		const res = await withUserMenusColumn(env, () =>
			env.DB.prepare(`SELECT ${USER_PROFILE_COLUMNS} FROM users WHERE username_lc IN (${chunk.map(() => "?").join(",")})`)
				.bind(...chunk)
				.all<Record<string, unknown>>(),
		);
		for (const row of res.results ?? []) {
			const p = rowToProfile(row);
			out.set(p.username.toLowerCase(), p);
		}
	}
	return out;
}

// Index tambahan yang baru ditambahkan BELAKANGAN (migration/001_init.sql &
// 004_sessions_fallback.sql sudah terlanjur jalan di database produksi).
// Dipanggil dari cron (lihat scheduled() di index.ts), bukan dari request user,
// dan dijaga flag per-isolate -> tidak ada biaya tambahan di jalur request.
// CREATE INDEX IF NOT EXISTS aman dipanggil berkali-kali.
let perfIndexesEnsured = false;
export async function ensurePerfIndexes(env: Env): Promise<void> {
	if (perfIndexesEnsured) return;
	for (const stmt of [
		// Dashboard & halaman Aktivitas untuk non-admin SELALU menyaring
		// "username = ? AND ts (hari ini)" -- index gabungan ini melayani kedua
		// syarat sekaligus, sedangkan ix_activity_user lama hanya bisa username
		// (tanggalnya tetap harus dipindai satu per satu).
		`CREATE INDEX IF NOT EXISTS ix_activity_user_ts ON activity_log(username, ts)`,
		// capUserSessions() jalan TIAP LOGIN: "WHERE username = ? ORDER BY created_at DESC".
		`CREATE INDEX IF NOT EXISTS ix_sessions_username ON sessions(username, created_at)`,
	]) {
		try {
			await env.DB.prepare(stmt).run();
		} catch {
			/* index sudah ada / tabel belum dibuat -> abaikan */
		}
	}
	perfIndexesEnsured = true;
}

export interface Maintenance {
	enabled: boolean;
	message: string;
}

export async function getMaintenance(env: Env): Promise<Maintenance> {
	const res = await env.DB.prepare(
		`SELECT key, value FROM settings WHERE key IN ('maintenance','maintenance_message')`,
	).all<{ key: string; value: string }>();
	const m: Record<string, string> = {};
	for (const r of res.results ?? []) m[r.key] = r.value;
	return {
		enabled: String(m.maintenance ?? "").toUpperCase() === "TRUE",
		message: m.maintenance_message || "Panel sedang dalam pemeliharaan.",
	};
}
