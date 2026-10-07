// Sesi token disimpan di KV (binding SESS) untuk lookup cepat + di tabel D1
// `sessions` sebagai sumber daftar sesi aktif.
//
// KENAPA D1 juga: (1) kuota KV Free 1000 write/hari — kalau jebol, SESS.put
// gagal dan tak ada yang bisa login; D1 jadi cadangan. (2) kuota KV *list*
// Free 1000/hari — `SESS.list` dulu dipanggil tiap tick cron auto-post +
// tiap buka menu SESI AKTIF, gampang jebol -> daftar sesi kosong / error.
// Sekarang daftar sesi aktif dibaca dari D1 (lihat listActiveSessions),
// tanpa SESS.list sama sekali.

// Sesi hidup 21 hari (dulu 180) — cukup panjang untuk CS yang login rutin,
// cukup pendek supaya sesi yang ditinggalkan tidak menumpuk berbulan-bulan.

// Maksimal token per user. Login ke-N+1 membuang token terlama. Mencegah
// riwayat login (ganti browser/HP, clear cookie) menumpuk jadi puluhan.


import { getSys } from "./settings";

export interface SessionRecord {
	username: string;
	createdAt: number;
	expiresAt: number;
}

export async function createSession(env: Env, username: string): Promise<string> {
	const token =
		"dg_" +
		crypto.randomUUID().replace(/-/g, "") +
		crypto.randomUUID().replace(/-/g, "").slice(0, 24);
	const TTL_SECONDS = (await getSys(env, "sys_session_ttl_days")) * 86400;
	const rec: SessionRecord = {
		username,
		createdAt: Date.now(),
		expiresAt: Date.now() + TTL_SECONDS * 1000,
	};
	// D1 selalu ditulis (kuota write 100k/hari, longgar) — jadi sumber daftar sesi.
	try {
		await env.DB.prepare(
			`INSERT OR REPLACE INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		)
			.bind(token, username, rec.createdAt, rec.expiresAt)
			.run();
		await capUserSessions(env, username);
	} catch {
		/* kalau D1 gagal, KV di bawah masih jadi andalan */
	}
	try {
		await env.SESS.put(token, JSON.stringify(rec), { expirationTtl: TTL_SECONDS });
	} catch {
		/* kuota KV habis -> tetap OK, loadSession akan baca D1 */
	}
	return token;
}

// Sisakan hanya MAX_SESSIONS_PER_USER token terbaru milik user; sisanya
// dihapus dari D1 dan (best-effort) dari KV.
async function capUserSessions(env: Env, username: string, keepArg?: number): Promise<void> {
	const keep = keepArg ?? (await getSys(env, "sys_max_sessions"));
	const old = await env.DB.prepare(
		`SELECT token FROM sessions WHERE username = ?
		 ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
	)
		.bind(username, keep)
		.all<{ token: string }>();
	const tokens = (old.results ?? []).map((r) => r.token);
	if (!tokens.length) return;
	try {
		await env.DB.prepare(
			`DELETE FROM sessions WHERE token IN (${tokens.map(() => "?").join(",")})`,
		)
			.bind(...tokens)
			.run();
	} catch {
		/* abaikan */
	}
	for (const t of tokens) {
		try {
			await env.SESS.delete(t);
		} catch {
			/* abaikan (kuota KV delete) */
		}
	}
}

// Cabut SEMUA sesi milik satu username (D1 + KV). Dipakai saat akun dihapus,
// di-rename, dinonaktifkan, atau password-nya di-reset admin. Tanpa ini token
// lama tetap hidup: akun yang dibuat ulang dengan username sama ikut mewarisi
// sesi lama, dan sesi yatim menumpuk di daftar "Sesi Aktif".
// `exceptToken` = sesi admin yang sedang memproses (supaya tidak menendang diri
// sendiri saat mengganti password akunnya sendiri).
export async function revokeUserSessions(env: Env, username: string, exceptToken = ""): Promise<number> {
	const lc = String(username ?? "").trim().toLowerCase();
	if (!lc) return 0;
	let tokens: string[] = [];
	try {
		const res = await env.DB.prepare(`SELECT token FROM sessions WHERE lower(username) = ?`)
			.bind(lc)
			.all<{ token: string }>();
		tokens = (res.results ?? []).map((r) => r.token).filter((t) => t && t !== exceptToken);
	} catch {
		return 0;
	}
	if (!tokens.length) return 0;
	for (let i = 0; i < tokens.length; i += 50) {
		const chunk = tokens.slice(i, i + 50);
		try {
			await env.DB.prepare(`DELETE FROM sessions WHERE token IN (${chunk.map(() => "?").join(",")})`)
				.bind(...chunk)
				.run();
		} catch {
			/* abaikan -- KV di bawah tetap dibersihkan */
		}
	}
	for (const t of tokens) {
		try {
			await env.SESS.delete(t);
		} catch {
			/* abaikan (kuota KV delete) */
		}
	}
	return tokens.length;
}

// Daftar sesi aktif (username unik + jumlah token + login pertama + kedaluwarsa
// terakhir), dibaca dari D1 — TIDAK memakai SESS.list (hemat kuota KV list).
export async function listActiveSessions(env: Env): Promise<
	{ username: string; count: number; firstLoginMs: number; lastExpiresMs: number }[]
> {
	const now = Date.now();
	const res = await env.DB.prepare(
		`SELECT username, COUNT(*) AS count, MIN(created_at) AS first_login, MAX(expires_at) AS last_expires
		 FROM sessions WHERE expires_at > ? GROUP BY username ORDER BY username`,
	)
		.bind(now)
		.all<{ username: string; count: number; first_login: number; last_expires: number }>();
	return (res.results ?? []).map((r) => ({
		username: r.username,
		count: Number(r.count || 0),
		firstLoginMs: Number(r.first_login || 0),
		lastExpiresMs: Number(r.last_expires || 0),
	}));
}

export async function pruneExpiredSessions(env: Env): Promise<void> {
	try {
		await env.DB.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(Date.now()).run();
		// Rapikan tumpukan token lama: sisakan MAX_SESSIONS_PER_USER terbaru/user.
		const many = await env.DB.prepare(
			`SELECT username FROM sessions GROUP BY username HAVING COUNT(*) > ?`,
		)
			.bind(await getSys(env, "sys_max_sessions"))
			.all<{ username: string }>();
		for (const r of many.results ?? []) await capUserSessions(env, r.username);
	} catch {
		/* abaikan */
	}
}

// Sekali seumur hidup: cermin sesi lama yang hanya ada di KV -> tabel D1
// `sessions`, supaya menu SESI AKTIF & auto-post langsung mengenalinya tanpa
// user login ulang. Self-guarded lewat KV flag -> hanya jalan sekali.
export async function migrateKvSessionsOnce(env: Env): Promise<void> {
	try {
		if (await env.SESS.get("migrated:sessions:v1")) return;
		const list = await env.SESS.list({ prefix: "dg_" });
		const now = Date.now();
		const stmts = [];
		for (const k of list.keys) {
			const raw = await env.SESS.get(k.name);
			if (!raw) continue;
			try {
				const rec = JSON.parse(raw) as Partial<SessionRecord>;
				if (rec.username && Number(rec.expiresAt) > now) {
					stmts.push(
						env.DB.prepare(
							`INSERT OR IGNORE INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)`,
						).bind(k.name, rec.username, Number(rec.createdAt || now), Number(rec.expiresAt)),
					);
				}
			} catch {
				/* skip token rusak */
			}
		}
		for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
		// Tanpa TTL: dulu flag kedaluwarsa setelah 1 tahun lalu migrasi (list + get satu-satu semua token) jalan lagi tiap tick cron
		// dan menghabiskan batas subrequest.
		await env.SESS.put("migrated:sessions:v1", "1");
	} catch {
		/* dicoba lagi nanti */
	}
}

export async function loadSession(env: Env, token: string): Promise<SessionRecord | null> {
	token = String(token ?? "").trim();
	if (!token.startsWith("dg_")) return null;

	let raw: string | null = null;
	try {
		raw = await env.SESS.get(token);
	} catch {
		/* KV error -> coba D1 */
	}
	if (raw) {
		try {
			const rec = JSON.parse(raw) as SessionRecord;
			if (!rec.expiresAt || rec.expiresAt <= Date.now()) {
				// KV can expire before the D1 fallback record is pruned. Do not
				// immediately kill a session here; verify D1 first.
				const row = await env.DB.prepare(
					`SELECT username, created_at, expires_at FROM sessions WHERE token = ?`,
				).bind(token).first<{ username: string; created_at: number; expires_at: number }>();
				if (row && row.expires_at > Date.now()) {
					return { username: row.username, createdAt: row.created_at, expiresAt: row.expires_at };
				}
				try { await env.SESS.delete(token); } catch { /* abaikan */ }
				if (row) {
					try { await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run(); } catch { /* abaikan */ }
				}
				return null;
			}
			return rec;
		} catch {
			return null;
		}
	}

	// KV miss -> cek fallback D1
	const row = await env.DB.prepare(
		`SELECT username, created_at, expires_at FROM sessions WHERE token = ?`,
	)
		.bind(token)
		.first<{ username: string; created_at: number; expires_at: number }>();
	if (!row) return null;
	if (!row.expires_at || row.expires_at <= Date.now()) {
		await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
		return null;
	}
	return { username: row.username, createdAt: row.created_at, expiresAt: row.expires_at };
}

export async function deleteSession(env: Env, token: string): Promise<void> {
	if (!token) return;
	try {
		await env.SESS.delete(token);
	} catch {
		/* abaikan */
	}
	try {
		await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
	} catch {
		/* abaikan */
	}
}
