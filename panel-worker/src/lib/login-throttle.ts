// Batas percobaan login GAGAL per alamat IP (di luar kunci per-akun yang
// sudah ada di checkLogin). Tanpa ini, satu IP bisa menebak password tanpa
// henti dengan berganti-ganti username, dan bebas memicu kunci 10 menit di
// akun mana pun (termasuk ADMIN) berulang-ulang.
//
// Disimpan di D1 (bukan KV) karena kuota tulis KV Free cuma 1000/hari.
// Tabel dibuat otomatis (CREATE TABLE IF NOT EXISTS, sekali per isolate) --
// tidak perlu migrasi manual; migration/007_login_throttle.sql hanya dokumentasi.

const WINDOW_MS = 15 * 60 * 1000;
// 16 operator bisa saja keluar lewat satu IP kantor yang sama, jadi batasnya
// sengaja longgar: 30 kali salah dalam 15 menit dari satu IP baru diblokir.
const MAX_FAILS = 30;

let tableReady = false;
async function ensureTable(env: Env): Promise<void> {
	if (tableReady) return;
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS login_throttle (
			ip TEXT PRIMARY KEY,
			fails INTEGER NOT NULL DEFAULT 0,
			window_start INTEGER NOT NULL
		)`,
	).run();
	tableReady = true;
}

/** Sisa menit blokir untuk IP ini, atau 0 kalau boleh mencoba login. */
export async function loginBlockedMinutes(env: Env, ip: string): Promise<number> {
	if (!ip) return 0;
	try {
		await ensureTable(env);
		const row = await env.DB.prepare(`SELECT fails, window_start FROM login_throttle WHERE ip = ?`)
			.bind(ip)
			.first<{ fails: number; window_start: number }>();
		if (!row) return 0;
		const left = row.window_start + WINDOW_MS - Date.now();
		if (left <= 0 || row.fails < MAX_FAILS) return 0;
		return Math.max(1, Math.ceil(left / 60000));
	} catch (e) {
		// Throttle hanya lapisan tambahan -- kalau D1 bermasalah, login tetap jalan.
		console.error("login throttle read error", e);
		return 0;
	}
}

export async function recordLoginFailure(env: Env, ip: string): Promise<void> {
	if (!ip) return;
	const now = Date.now();
	try {
		await ensureTable(env);
		await env.DB.prepare(
			`INSERT INTO login_throttle (ip, fails, window_start) VALUES (?, 1, ?)
			 ON CONFLICT(ip) DO UPDATE SET
				fails = CASE WHEN window_start + ? <= ? THEN 1 ELSE fails + 1 END,
				window_start = CASE WHEN window_start + ? <= ? THEN ? ELSE window_start END`,
		)
			.bind(ip, now, WINDOW_MS, now, WINDOW_MS, now, now)
			.run();
	} catch (e) {
		console.error("login throttle write error", e);
	}
}

export async function clearLoginFailures(env: Env, ip: string): Promise<void> {
	if (!ip) return;
	try {
		await ensureTable(env);
		await env.DB.prepare(`DELETE FROM login_throttle WHERE ip = ?`).bind(ip).run();
	} catch (e) {
		console.error("login throttle clear error", e);
	}
}

export const LOGIN_THROTTLE = { WINDOW_MS, MAX_FAILS };
