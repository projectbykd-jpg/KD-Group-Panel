// Modul "Live Chat Auto-Reply" — bot balas otomatis khusus sesi chat
// DayLiveChat (daylivechat.com, dipakai CS HUGOTOGEL) yang SENGAJA dipilih
// operator lewat panel ini.
//
// PENTING kenapa arsitekturnya begini: DayLiveChat mengunci login akun CS ke
// IP tertentu (fitur keamanan resmi mereka -- terbukti lewat percobaan nyata:
// login dari Cloudflare Worker/Durable Object SELALU ditolak 403 "IP tidak
// diizinkan untuk akun ini", walau kredensial benar), dan tidak ada akses
// admin DayLiveChat di sini untuk melonggarkan itu. Jadi "mata & tangan"
// bot-nya TERPAKSA jalan dari userscript browser (lihat userscripts/) yang
// beroperasi dari IP CS yang SUDAH diizinkan -- BUKAN dari server. Userscript
// itu memakai token login yang SUDAH ADA di localStorage browser (hasil login
// manual CS seperti biasa) + client Socket.IO bawaan halaman itu sendiri,
// jadi TIDAK PERNAH menyimpan password di mana pun.
//
// Modul ini murni penyimpanan (Turso), dipakai dari 2 arah:
//   - Panel (sesi login ADMIN/OPERATOR): lihat/toggle sesi, kelola template.
//   - Userscript (auth via secret LIVECHAT_BOT_KEY, bukan sesi login): sync
//     daftar sesi yang terlihat, tarik sesi mana yang bot_enabled + template,
//     lapor tiap balasan otomatis yang terkirim.
//
// Tabel:
//   - livechat_session : sesi chat yang pernah terlihat userscript + status
//     bot_enabled (di-toggle dari panel) -- HANYA sesi yang diaktifkan
//     operator yang dibalas otomatis, sisanya tetap manual.
//   - livechat_template : daftar kalimat balasan (dipilih ACAK tiap bot
//     membalas -- bot ini khusus pacify member spam/kasar, bukan FAQ, jadi
//     balasannya TIDAK memandang isi keluhan member).
//   - livechat_log      : jejak setiap balasan otomatis yang terkirim.
import { getTurso } from "./turso";
import { tsNow } from "./time";
import { ensureColumns } from "./turso-schema";
import { sharedOnce } from "./shared-once";

/** Satu pembuatan skema bersama + SATU batch CREATE + SATU query kolom (ALTER hanya bila kolom belum ada).
 *  Dulu: 3 CREATE + 5 ALTER yang SELALU gagal "duplicate column" dijalankan satu-satu di tiap isolate dingin, dan dua request
 *  paralel (polling sesi + sinkron userscript) masing-masing mengulang semuanya -> boros subrequest (batas 50) dan menu Sesi Chat error.
 *  Request lain yang ikut menunggu dibatasi 8 dtk (lihat shared-once.ts) supaya tidak menggantung bersama. */
const ensureTables = sharedOnce((env) => ensureTablesOnce(env), 8000);
/** Hanya untuk test. */
export function resetLivechatTablesFlag(): void {
	ensureTables.reset();
}
async function ensureTablesOnce(env: Env): Promise<void> {
	const db = getTurso(env);
	await db.batch([
		db.prepare(`CREATE TABLE IF NOT EXISTS livechat_session (
			session_key TEXT PRIMARY KEY,
			queue_code TEXT NOT NULL DEFAULT '',
			customer_name TEXT NOT NULL DEFAULT '',
			divisi TEXT NOT NULL DEFAULT '',
			last_message TEXT NOT NULL DEFAULT '',
			last_sender TEXT NOT NULL DEFAULT '',
			bot_enabled INTEGER NOT NULL DEFAULT 0,
			last_seen_at TEXT NOT NULL DEFAULT '',
			bot_updated_at TEXT NOT NULL DEFAULT ''
		)`),
		db.prepare(`CREATE TABLE IF NOT EXISTS livechat_template (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			reply_text TEXT NOT NULL DEFAULT '',
			active INTEGER NOT NULL DEFAULT 1,
			sort_order INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL DEFAULT ''
		)`),
		db.prepare(`CREATE TABLE IF NOT EXISTS livechat_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_key TEXT NOT NULL DEFAULT '',
			customer_message TEXT NOT NULL DEFAULT '',
			matched_template_id INTEGER,
			reply_text TEXT NOT NULL DEFAULT '',
			sent_at TEXT NOT NULL DEFAULT ''
		)`),
	] as never);
	// Tabel versi lama belum punya kolom baru (CREATE IF NOT EXISTS tidak mengubah tabel yang sudah ada).
	await ensureColumns(db, {
		livechat_session: [
			["queue_code", "TEXT NOT NULL DEFAULT ''"],
			["last_seen_at", "TEXT NOT NULL DEFAULT ''"],
			// Pemisahan per pengguna panel: '' = data lama (kunci bot bersama), selain itu username (huruf kecil).
			["owner", "TEXT NOT NULL DEFAULT ''"],
		],
		livechat_template: [["owner", "TEXT NOT NULL DEFAULT ''"]],
		livechat_log: [["owner", "TEXT NOT NULL DEFAULT ''"]],
	});
	// Index per pemilik: userscript menarik sesi + template tiap 5 dtk dan menyinkron Kotak Masuk; tanpa index setiap
	// panggilan memindai SELURUH tabel (ikut menghabiskan kuota baca Turso yang lalu memblokir semua baca, 17 Okt 2026).
	await db.batch([
		db.prepare(`CREATE INDEX IF NOT EXISTS ix_livechat_session_owner ON livechat_session(owner, bot_enabled)`),
		db.prepare(`CREATE INDEX IF NOT EXISTS ix_livechat_template_owner ON livechat_template(owner, active, sort_order)`),
		db.prepare(`CREATE INDEX IF NOT EXISTS ix_livechat_log_owner ON livechat_log(owner, id)`),
	] as never);
}

export interface LivechatSessionRow {
	session_key: string;
	owner: string;
	queue_code: string;
	customer_name: string;
	divisi: string;
	last_message: string;
	last_sender: string;
	bot_enabled: number;
	last_seen_at: string;
	bot_updated_at: string;
}

export interface LivechatTemplateRow {
	id: number;
	owner?: string;
	reply_text: string;
	active: number;
	sort_order: number;
	updated_at: string;
}

// --- Pemisahan per pengguna ---
// Setiap pengguna panel punya Kunci Bot sendiri (lihat api/livechat.ts). Semua sesi/template/log punya `owner`
// (username huruf kecil; '' = data lama dari kunci bersama). session_key di tabel adalah PRIMARY KEY global, jadi
// untuk owner non-lama disimpan sebagai "owner:idAsli" supaya id yang sama dari akun DayLiveChat berbeda tidak
// saling menimpa. Userscript selalu melihat id asli (tanpa prefiks).
const innerKey = (owner: string, id: string): string => (owner ? `${owner}:${id}` : id);
const rawKey = (owner: string, key: string): string => (owner && key.startsWith(owner + ":") ? key.slice(owner.length + 1) : key);
const inList = (owners: string[]): string => owners.map(() => "?").join(",");

// --- Sesi chat ---

/** Dipanggil panel: sesi milik `owners` saja (pengguna biasa = dirinya; ADMIN juga data lama ''). */
export async function listSessions(env: Env, owners: string[]): Promise<LivechatSessionRow[]> {
	await ensureTables(env);
	const r = await getTurso(env)
		.prepare(`SELECT session_key, owner, queue_code, customer_name, divisi, substr(last_message, 1, 300) AS last_message, last_sender, bot_enabled, last_seen_at, bot_updated_at FROM livechat_session WHERE owner IN (${inList(owners)}) ORDER BY bot_enabled DESC, last_seen_at DESC LIMIT 200`)
		.bind(...owners)
		.all<LivechatSessionRow>();
	return r.results;
}

/** Buang SEMUA sesi milik `owners` (dipakai saat Kunci Bot diganti: sesi dari kunci lama tidak boleh tersisa; sesi baru muncul lagi
 *  begitu bot dengan kunci baru menyinkron). Template & log tidak disentuh. */
export async function clearSessions(env: Env, owners: string[]): Promise<void> {
	await ensureTables(env);
	await getTurso(env).prepare(`DELETE FROM livechat_session WHERE owner IN (${inList(owners)})`).bind(...owners).run();
}
/** Buang sesi milik `owners` yang tidak disinkron sejak `cutoffTs` (bot mati lama -> daftar usang, bot juga tidak membalas).
 *  Mengembalikan jumlah baris yang dibuang. Satu perintah DELETE; dipanggil dari daftar hanya bila ada baris basi. */
export async function pruneStaleSessions(env: Env, owners: string[], cutoffTs: string): Promise<void> {
	await ensureTables(env);
	await getTurso(env)
		.prepare(`DELETE FROM livechat_session WHERE owner IN (${inList(owners)}) AND last_seen_at < ?`)
		.bind(...owners, cutoffTs)
		.run();
}

/** Toggle "Aktifkan Bot" per sesi -- hanya sesi milik `owners`; SATU-SATUNYA cara sesi jadi bot_enabled=1. */
export async function setSessionBot(env: Env, owners: string[], sessionKey: string, enabled: boolean): Promise<void> {
	await ensureTables(env);
	await getTurso(env)
		.prepare(`UPDATE livechat_session SET bot_enabled = ?, bot_updated_at = ? WHERE session_key = ? AND owner IN (${inList(owners)})`)
		.bind(enabled ? 1 : 0, tsNow(), sessionKey, ...owners)
		.run();
}

/**
 * Dipanggil userscript (auth via Kunci Bot milik satu pengguna) tiap beberapa detik: upsert daftar sesi yang terlihat
 * lewat GET /api/chats/inbox. HANYA menyentuh sesi milik `owner` itu -- sinkron satu akun CS tidak boleh mematikan atau
 * menghapus sesi akun lain. Untuk sesi yang MASIH ada di Kotak Masuk, bot_enabled tidak disentuh (hanya setSessionBot);
 * sesi yang SUDAH TIDAK ADA lagi di Kotak Masuk dimatikan otomatis lalu barisnya dibuang.
 */
export async function syncSessionsFromScript(
	env: Env,
	owner: string,
	rows: Array<{ sessionKey: string; queueCode?: string; customerName?: string; divisi?: string; lastMessage?: string; lastSender?: string }>,
): Promise<{ synced: number }> {
	await ensureTables(env);
	const db = getTurso(env);
	const now = tsNow();
	let n = 0;
	const keys: string[] = [];
	const stmts: ReturnType<typeof db.prepare>[] = [];
	for (const row of rows) {
		const id = String(row.sessionKey || "").trim();
		if (!id) continue;
		const key = innerKey(owner, id);
		keys.push(key);
		stmts.push(
			db
				.prepare(
					`INSERT INTO livechat_session (session_key, owner, queue_code, customer_name, divisi, last_message, last_sender, bot_enabled, last_seen_at, bot_updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, '')
				 ON CONFLICT(session_key) DO UPDATE SET
					queue_code = excluded.queue_code,
					customer_name = excluded.customer_name,
					divisi = excluded.divisi,
					last_message = excluded.last_message,
					last_sender = excluded.last_sender,
					last_seen_at = excluded.last_seen_at`,
				)
				.bind(
					key,
					owner,
					String(row.queueCode ?? "").slice(0, 100),
					String(row.customerName ?? "").slice(0, 200),
					String(row.divisi ?? "").slice(0, 100),
					String(row.lastMessage ?? "").slice(0, 2000),
					String(row.lastSender ?? "").slice(0, 30),
					now,
				) as never,
		);
		n++;
	}
	// Satu round-trip per 25 baris (dulu satu per baris -> N+1 ke Turso tiap sinkron).
	for (let i = 0; i < stmts.length; i += 25) await db.batch(stmts.slice(i, i + 25) as never);
	// `rows` SELALU daftar LENGKAP Kotak Masuk akun itu (termasuk kosong). Sesi MILIK OWNER INI yang tidak ada lagi:
	// matikan bot-nya dulu, lalu buang barisnya.
	if (keys.length) {
		const ph = inList(keys);
		await db
			.prepare(`UPDATE livechat_session SET bot_enabled = 0, bot_updated_at = ? WHERE owner = ? AND bot_enabled = 1 AND session_key NOT IN (${ph})`)
			.bind(now, owner, ...keys)
			.run();
		await db.prepare(`DELETE FROM livechat_session WHERE owner = ? AND bot_enabled = 0 AND session_key NOT IN (${ph})`).bind(owner, ...keys).run();
	} else {
		await db.prepare(`UPDATE livechat_session SET bot_enabled = 0, bot_updated_at = ? WHERE owner = ? AND bot_enabled = 1`).bind(now, owner).run();
		await db.prepare(`DELETE FROM livechat_session WHERE owner = ? AND bot_enabled = 0`).bind(owner).run();
	}
	return { synced: n };
}

/** Dipanggil userscript: id sesi (asli) yang boleh dioperasikan bot + template aktif -- hanya milik `owner`. */
export async function pullEnabledSessions(
	env: Env,
	owner: string,
	opts: { includeLegacyTemplates?: boolean } = {},
): Promise<{ enabledKeys: string[]; templates: LivechatTemplateRow[] }> {
	await ensureTables(env);
	const db = getTurso(env);
	const sessions = await db.prepare(`SELECT session_key FROM livechat_session WHERE owner = ? AND bot_enabled = 1`).bind(owner).all<{ session_key: string }>();
	// Panel menampilkan template lama (owner '') ke ADMIN; bot milik ADMIN harus memakai template yang sama dengan yang ia lihat,
	// kalau tidak bot "aktif" tetapi tidak punya balasan dan diam. Pengguna lain TIDAK pernah memakai template lama.
	const owners = opts.includeLegacyTemplates && owner !== "" ? [owner, ""] : [owner];
	const templates = await db
		.prepare(`SELECT id, reply_text, active, sort_order, updated_at FROM livechat_template WHERE owner IN (${inList(owners)}) AND active = 1 ORDER BY sort_order ASC, id ASC`)
		.bind(...owners)
		.all<LivechatTemplateRow>();
	return { enabledKeys: sessions.results.map((r) => rawKey(owner, r.session_key)), templates: templates.results };
}

// --- Template balasan (daftar acak, tanpa memandang isi keluhan member) ---

export async function listTemplates(env: Env, owners: string[]): Promise<LivechatTemplateRow[]> {
	await ensureTables(env);
	const r = await getTurso(env)
		.prepare(`SELECT * FROM livechat_template WHERE owner IN (${inList(owners)}) ORDER BY sort_order ASC, id ASC`)
		.bind(...owners)
		.all<LivechatTemplateRow>();
	return r.results;
}

/** Template baru dimiliki `owner`; mengubah template hanya boleh bila pemiliknya termasuk `owners`. */
export async function saveTemplate(
	env: Env,
	owner: string,
	owners: string[],
	data: { id?: number; replyText: string; active?: boolean; sortOrder?: number },
): Promise<void> {
	await ensureTables(env);
	const db = getTurso(env);
	const replyText = String(data.replyText ?? "").trim();
	if (!replyText) throw new Error("Isi balasan wajib diisi.");
	const active = data.active === false ? 0 : 1;
	const sortOrder = Number.isFinite(data.sortOrder) ? Number(data.sortOrder) : 0;
	if (data.id) {
		await db
			.prepare(`UPDATE livechat_template SET reply_text = ?, active = ?, sort_order = ?, updated_at = ? WHERE id = ? AND owner IN (${inList(owners)})`)
			.bind(replyText, active, sortOrder, tsNow(), data.id, ...owners)
			.run();
	} else {
		await db
			.prepare(`INSERT INTO livechat_template (owner, reply_text, active, sort_order, updated_at) VALUES (?, ?, ?, ?, ?)`)
			.bind(owner, replyText, active, sortOrder, tsNow())
			.run();
	}
}

export async function deleteTemplate(env: Env, owners: string[], id: number): Promise<void> {
	await ensureTables(env);
	await getTurso(env).prepare(`DELETE FROM livechat_template WHERE id = ? AND owner IN (${inList(owners)})`).bind(id, ...owners).run();
}

// --- Audit ---

export async function logAutoReply(env: Env, owner: string, sessionKey: string, customerMessage: string, matchedTemplateId: number | null, replyText: string): Promise<void> {
	await ensureTables(env);
	await getTurso(env)
		.prepare(`INSERT INTO livechat_log (owner, session_key, customer_message, matched_template_id, reply_text, sent_at) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind(owner, sessionKey, customerMessage.slice(0, 2000), matchedTemplateId, replyText.slice(0, 2000), tsNow())
		.run();
}

export async function recentLogs(env: Env, owners: string[], limit = 100): Promise<Array<Record<string, unknown>>> {
	await ensureTables(env);
	const r = await getTurso(env)
		.prepare(`SELECT id, session_key, substr(customer_message, 1, 300) AS customer_message, matched_template_id, substr(reply_text, 1, 300) AS reply_text, sent_at FROM livechat_log WHERE owner IN (${inList(owners)}) ORDER BY id DESC LIMIT ?`)
		.bind(...owners, Math.min(500, Math.max(1, limit)))
		.all();
	return r.results;
}
