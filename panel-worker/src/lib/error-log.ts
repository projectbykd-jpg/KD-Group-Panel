// Log Error & Bug (Admin > Error & Bug): semua galat yang tertangkap otomatis dikumpulkan di satu tempat,
// digabung per "sidik jari" (galat yang sama = satu baris + hitungan), supaya admin cukup menyalin satu
// laporan -- tanpa mengirim screenshot/HTML satu per satu.
//
// Prinsip:
//  - recordError() TIDAK PERNAH melempar (pencatat galat tidak boleh jadi sumber galat baru).
//  - Rahasia (password/token/cookie/key) dibuang SEBELUM disimpan (scrub), bukan saat ditampilkan.
//  - Hanya galat tak terduga yang dicatat dari API (bukan pesan validasi biasa seperti "Password salah").
//  - Retensi & batas baris diatur di Admin > Pengaturan Sistem (sys_errorlog_days, sys_errorlog_max_rows).
//  - Tabel dibuat otomatis (CREATE TABLE IF NOT EXISTS) -- tanpa migrasi manual.
import { getSys } from "./settings";
import { alertTgCfg, loadIntegrations } from "./integrations";
import { sendTelegram } from "../senders/telegram";
import { tsNow } from "./time";

export type ErrSource = "api" | "cron" | "browser" | "toto" | "auto-input" | "lainnya";
export type ErrStatus = "open" | "resolved" | "ignored";
export const ERR_SOURCES: readonly ErrSource[] = ["api", "cron", "browser", "toto", "auto-input", "lainnya"];
export const ERR_STATUSES: readonly ErrStatus[] = ["open", "resolved", "ignored"];

export interface ErrInput {
	source: ErrSource;
	message: string;
	detail?: string; // stack / konteks tambahan
	loc?: string; // lokasi: nama aksi API, nama cron, halaman panel, website
	username?: string;
	site?: string;
	level?: "error" | "warn";
}

export interface ErrRow {
	id: number;
	fp: string;
	source: string;
	level: string;
	message: string;
	detail: string;
	loc: string;
	username: string;
	site: string;
	count: number;
	reopened: number;
	first_at: string;
	last_at: string;
	status: string;
}

const MSG_MAX = 400;
const DETAIL_MAX = 1800;

/** Buang rahasia dari teks bebas (pesan galat, stack, URL). Urutan penting: pola spesifik dulu. */
export function scrub(input: unknown, max = MSG_MAX): string {
	let t = String(input ?? "");
	t = t.replace(/\b(set-)?cookie\s*:\s*[^\n]*/gi, "cookie: ***");
	t = t.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***");
	t = t.replace(
		/(["']?)\b(password|passwd|pwd|pass|sandi|token|secret|api[_-]?key|apikey|auth|authorization|cookie|phpsessid|sessionid|session[_-]?token|sessiontoken|key)\1(\s*[:=]\s*)(["']?)[^\s"'&,;}\]]+/gi,
		"$1$2$1$3$4***",
	);
	t = t.replace(/\b(sk|gsk|ghp|gho|github_pat|xox[abp]|AKIA)[-_]?[A-Za-z0-9_-]{10,}/g, "***");
	// string panjang acak (token/hash/id sesi) -- bukan kata biasa
	t = t.replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, "***");
	t = t.replace(/\b[0-9a-f]{32,}\b/gi, "***");
	return t.length > max ? t.slice(0, max) + "…" : t;
}

function hash(str: string): string {
	// cyrb53: cukup untuk sidik jari (bukan keamanan)
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** Galat yang sama (beda angka/ID/tanggal saja) harus jadi satu baris. */
export function fingerprint(source: string, loc: string, message: string): string {
	const norm = String(message)
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, "URL")
		.replace(/["'`][^"'`]{0,80}["'`]/g, "S")
		.replace(/\b[0-9a-f]{8,}\b/g, "H")
		.replace(/\d+/g, "#")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);
	return source + ":" + hash(source + "|" + loc + "|" + norm);
}

const NOISE = [
	/ResizeObserver loop/i,
	/^script error\.?$/i,
	/chrome-extension:|moz-extension:|safari-extension:/i,
	// jaringan user putus bukan bug panel
	/failed to fetch|networkerror|load failed|network request failed|the operation was aborted|aborterror|tidak dapat menghubungi server|tidak ada koneksi/i,
];
export function isNoise(message: string, detail = ""): boolean {
	return NOISE.some((re) => re.test(message) || re.test(detail.slice(0, 400)));
}

const INFRA =
	/D1_|SQLITE|libsql|turso|too many subrequests|exceeded|network connection lost|fetch failed|internal error|cannot read propert|is not a function|is not defined|is not iterable|undefined|unexpected (token|end)|JSON|out of memory|stream|invalid url|illegal invocation/i;
const CODE_ERRORS = new Set(["TypeError", "ReferenceError", "RangeError", "SyntaxError", "URIError", "EvalError"]);

/** Hanya galat TAK TERDUGA yang dicatat dari API; pesan validasi/izin buatan sendiri (Error biasa berbahasa manusia) dilewati. */
export function isUnexpectedError(e: unknown): boolean {
	if (!(e instanceof Error)) return true;
	if (CODE_ERRORS.has(e.name) || CODE_ERRORS.has(e.constructor?.name)) return true;
	return INFRA.test(e.message);
}

const ready = new WeakSet<object>();
async function ensureTable(env: Env): Promise<void> {
	if (ready.has(env.DB)) return;
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS error_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			fp TEXT NOT NULL UNIQUE,
			source TEXT NOT NULL,
			level TEXT NOT NULL DEFAULT 'error',
			message TEXT NOT NULL,
			detail TEXT NOT NULL DEFAULT '',
			loc TEXT NOT NULL DEFAULT '',
			username TEXT NOT NULL DEFAULT '',
			site TEXT NOT NULL DEFAULT '',
			count INTEGER NOT NULL DEFAULT 1,
			reopened INTEGER NOT NULL DEFAULT 0,
			first_at TEXT NOT NULL,
			last_at TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'open'
		)`,
	).run();
	await env.DB.prepare(`CREATE INDEX IF NOT EXISTS ix_error_log_last ON error_log (last_at)`).run();
	ready.add(env.DB);
}

// Pengaman kuota tulis D1: galat yang sama beruntun (mis. polling yang rusak) dicatat paling sering sekali per 30 dtk.
const THROTTLE_MS = 30_000;
const lastWrite = new Map<string, number>();
let writes = 0;
export function resetErrorThrottle(): void {
	lastWrite.clear();
	writes = 0;
}

/** Notifikasi Telegram hanya bila Token + Chat ID diisi admin dan jeda minimum sudah lewat (anti-banjir). */
async function alertState(env: Env, force: boolean): Promise<"ok" | "belum-diatur" | "jeda"> {
	await loadIntegrations(env);
	const c = alertTgCfg();
	if (!c.token || !c.chatId) return "belum-diatur";
	if (force) return "ok"; // uji galat palsu: abaikan jeda minimum supaya hasilnya pasti
	const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'errlog_alert_at'`).first<{ value: string }>();
	return Date.now() - Number(row?.value || 0) >= (await getSys(env, "sys_errorlog_alert_gap_min")) * 60_000 ? "ok" : "jeda";
}
async function sendAlert(env: Env, kind: string, e: { source: string; loc: string; message: string }): Promise<string> {
	// tanda dulu, baru kirim: dua galat bersamaan tidak jadi dua pesan
	await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('errlog_alert_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(Date.now())).run();
	return sendTelegram(`⚠️ Error ${kind} — KD-Group Panel\n(${e.source}) ${e.loc || "-"}\n${e.message.slice(0, 300)}\n\nBuka Admin › Error & Bug untuk detail.`, alertTgCfg());
}

export interface RecordResult {
	/** "" = tidak ada notifikasi (galat berulang / bukan baru); selain itu hasil percobaan notifikasi Telegram */
	alert: "" | "terkirim" | "belum-diatur" | "jeda" | "gagal";
	detail?: string;
}

/** Catat satu galat. Tidak pernah melempar. `force` (hanya uji galat palsu) mengabaikan throttle & jeda notifikasi. */
export async function recordError(env: Env, input: ErrInput, opts: { force?: boolean } = {}): Promise<RecordResult> {
	const force = !!opts.force;
	try {
		const message = scrub(input.message).trim() || "(tanpa pesan)";
		const detail = scrub(input.detail ?? "", DETAIL_MAX);
		if (isNoise(message, detail)) return { alert: "" };
		const source = ERR_SOURCES.includes(input.source) ? input.source : "lainnya";
		const loc = scrub(input.loc ?? "", 120);
		const fp = fingerprint(source, loc, message);
		const now = Date.now();
		const prev = lastWrite.get(fp);
		if (!force && prev && now - prev < THROTTLE_MS) return { alert: "" };
		lastWrite.set(fp, now);
		if (lastWrite.size > 500) lastWrite.clear();
		await ensureTable(env);
		let alertKind = "";
		let skip: RecordResult["alert"] = "";
		const st = await alertState(env, force).catch(() => "jeda" as const);
		if (st === "ok") {
			const prev = await env.DB.prepare(`SELECT status FROM error_log WHERE fp = ?`).bind(fp).first<{ status: string }>();
			if (!prev) alertKind = "baru";
			else if (prev.status === "resolved") alertKind = "muncul lagi";
		} else skip = st;
		const ts = tsNow();
		await env.DB.prepare(
			`INSERT INTO error_log (fp, source, level, message, detail, loc, username, site, count, reopened, first_at, last_at, status)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, 'open')
			 ON CONFLICT(fp) DO UPDATE SET
				count = count + 1,
				last_at = excluded.last_at,
				detail = CASE WHEN excluded.detail != '' THEN excluded.detail ELSE detail END,
				username = CASE WHEN excluded.username != '' THEN excluded.username ELSE username END,
				site = CASE WHEN excluded.site != '' THEN excluded.site ELSE site END,
				reopened = reopened + CASE WHEN status = 'resolved' THEN 1 ELSE 0 END,
				status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END`,
		)
			.bind(
				fp,
				source,
				input.level === "warn" ? "warn" : "error",
				message,
				detail,
				loc,
				scrub(input.username ?? "", 60),
				scrub(input.site ?? "", 60),
				ts,
				ts,
			)
			.run();
		let result: RecordResult = { alert: "" };
		if (alertKind) {
			const r = await sendAlert(env, alertKind, { source, loc, message });
			result = r === "Terkirim" ? { alert: "terkirim" } : { alert: "gagal", detail: r };
		} else if (skip) result = { alert: skip };
		// batas baris: dicek tiap 25 tulisan (bukan tiap galat) supaya hemat
		if (++writes % 25 === 0) await capRows(env);
		return result;
	} catch {
		/* pencatat galat tidak boleh menimbulkan galat baru */
		return { alert: "" };
	}
}

/** Tombol "Uji galat palsu": satu galat uji BARU tiap ditekan (yang lama dihapus) -> rantai catat + notifikasi Telegram teruji penuh. */
export async function recordTestError(env: Env): Promise<RecordResult> {
	try {
		await ensureTable(env);
		await env.DB.prepare(`DELETE FROM error_log WHERE loc = 'uji-galat'`).run();
	} catch {
		/* dicatat saja */
	}
	return recordError(env, { source: "lainnya", loc: "uji-galat", level: "warn", message: "UJI galat palsu dari admin — aman dihapus", detail: "Dibuat oleh tombol Uji Galat Palsu di Admin > Error & Bug." }, { force: true });
}

async function capRows(env: Env): Promise<void> {
	const max = await getSys(env, "sys_errorlog_max_rows");
	await env.DB.prepare(
		`DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY (status='open') DESC, last_at DESC LIMIT ?)`,
	)
		.bind(max)
		.run();
}

export interface ErrList {
	rows: ErrRow[];
	counts: { open: number; resolved: number; ignored: number; total: number };
	retentionDays: number;
}

export async function listErrors(env: Env, opts: { status?: string; source?: string; limit?: number } = {}): Promise<ErrList> {
	await ensureTable(env);
	const where: string[] = [];
	const args: unknown[] = [];
	if (opts.status && ERR_STATUSES.includes(opts.status as ErrStatus)) {
		where.push("status = ?");
		args.push(opts.status);
	}
	if (opts.source && ERR_SOURCES.includes(opts.source as ErrSource)) {
		where.push("source = ?");
		args.push(opts.source);
	}
	const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 300)));
	const rows = await env.DB.prepare(
		`SELECT id, fp, source, level, message, detail, loc, username, site, count, reopened, first_at, last_at, status
		 FROM error_log ${where.length ? "WHERE " + where.join(" AND ") : ""}
		 ORDER BY (status='open') DESC, last_at DESC LIMIT ?`,
	)
		.bind(...args, limit)
		.all<ErrRow>();
	const c = await env.DB.prepare(`SELECT status, COUNT(*) n FROM error_log GROUP BY status`).all<{ status: string; n: number }>();
	const counts = { open: 0, resolved: 0, ignored: 0, total: 0 };
	for (const r of c.results ?? []) {
		const n = Number(r.n) || 0;
		if (r.status === "open" || r.status === "resolved" || r.status === "ignored") counts[r.status] = n;
		counts.total += n;
	}
	return { rows: rows.results ?? [], counts, retentionDays: await getSys(env, "sys_errorlog_days") };
}

function cleanIds(ids: unknown): number[] {
	if (!Array.isArray(ids)) return [];
	return [...new Set(ids.map((x) => Math.floor(Number(x))).filter((n) => Number.isFinite(n) && n > 0))].slice(0, 500);
}

export async function setErrorStatus(env: Env, ids: unknown, status: string): Promise<number> {
	if (!ERR_STATUSES.includes(status as ErrStatus)) throw new Error("Status tidak valid.");
	const list = cleanIds(ids);
	if (!list.length) return 0;
	await ensureTable(env);
	const r = await env.DB.prepare(`UPDATE error_log SET status = ? WHERE id IN (${list.map(() => "?").join(",")})`)
		.bind(status, ...list)
		.run();
	return r.meta?.changes ?? 0;
}

/** ids kosong + scope "done" = hapus semua yang sudah Selesai/Diabaikan. */
export async function deleteErrors(env: Env, ids: unknown, scope = ""): Promise<number> {
	await ensureTable(env);
	if (scope === "done") {
		const r = await env.DB.prepare(`DELETE FROM error_log WHERE status != 'open'`).run();
		return r.meta?.changes ?? 0;
	}
	const list = cleanIds(ids);
	if (!list.length) return 0;
	const r = await env.DB.prepare(`DELETE FROM error_log WHERE id IN (${list.map(() => "?").join(",")})`)
		.bind(...list)
		.run();
	return r.meta?.changes ?? 0;
}

/** Cron harian: hapus yang terakhir terjadi lebih dari N hari lalu + pangkas ke batas baris. */
export async function pruneErrorLog(env: Env): Promise<number> {
	await ensureTable(env);
	const days = await getSys(env, "sys_errorlog_days");
	const cutoff = new Date(Date.now() + 7 * 3600_000 - days * 86400_000).toISOString().slice(0, 10) + " 00:00:00";
	const r = await env.DB.prepare(`DELETE FROM error_log WHERE last_at < ?`).bind(cutoff).run();
	await capRows(env);
	return r.meta?.changes ?? 0;
}

/** Cadangan: handler `.catch` untuk cron -- catat + tetap tulis ke console (wrangler tail). */
export function cronFail(env: Env, name: string): (e: unknown) => Promise<void> {
	return async (e) => {
		console.error(name + " error", e);
		await recordError(env, {
			source: "cron",
			loc: name,
			message: e instanceof Error ? e.message : String(e),
			detail: e instanceof Error ? e.stack : "",
		});
	};
}
