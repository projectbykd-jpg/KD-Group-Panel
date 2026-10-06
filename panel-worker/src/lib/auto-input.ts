// Menu "Auto Prediksi" -- setelah KIRIM SEMUA SISTEM, angka result otomatis
// diinput ke admin website (menu NOMOR KELUAR) lalu di-HITUNG.
//
// Worker memakai PHPSESSID admin yang disimpan per user per website (tabel
// auto_input_session) -- sama pola dengan menu INVEST. Eksekusinya ada di
// lib/auto-input-run.ts; modul ini: rencana job dari teks result, saklar
// ON/OFF, penyimpanan sesi, dan riwayat/antrean job.
//
// Menghitung = membayar pemenang -> TIDAK BISA DIBATALKAN. Aturannya kaku:
//   * job yang gagal SETELAH form Kirim dikirim TIDAK PERNAH diulang otomatis;
//   * satu result x satu website hanya boleh jalan SEKALI (UNIQUE di tabel);
//   * ragu = berhenti dan minta input manual.
import { getTurso } from "./turso";
import { tsNow, tsPlusMinutes } from "./time";
import type { Processed } from "./parser";

export const RUNNING_TTL_MIN = 5;

export type JobStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED";

let tablesEnsured = false;
/** Hanya untuk test (tiap test memakai database baru). */
export function resetAutoInputTablesFlag(): void {
	tablesEnsured = false;
}
export async function ensureAutoInputTables(env: Env): Promise<void> {
	if (tablesEnsured) return;
	const db = getTurso(env);
	for (const stmt of [
		`CREATE TABLE IF NOT EXISTS auto_input_config (
			username   TEXT PRIMARY KEY,
			enabled    INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS auto_input_session (
			username   TEXT NOT NULL,
			website    TEXT NOT NULL,
			base_url   TEXT NOT NULL DEFAULT '',
			phpsessid  TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (username, website)
		)`,
		`CREATE TABLE IF NOT EXISTS auto_input_job (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			username    TEXT NOT NULL,
			website     TEXT NOT NULL,
			market      TEXT NOT NULL,
			prizes      TEXT NOT NULL DEFAULT '[]',
			result_date TEXT NOT NULL DEFAULT '',
			result_key  TEXT NOT NULL,
			status      TEXT NOT NULL DEFAULT 'RUNNING',
			stage       TEXT NOT NULL DEFAULT '',
			detail      TEXT NOT NULL DEFAULT '',
			period      TEXT NOT NULL DEFAULT '',
			created_at  TEXT NOT NULL DEFAULT '',
			updated_at  TEXT NOT NULL DEFAULT '',
			UNIQUE (website, result_key)
		)`,
		`CREATE INDEX IF NOT EXISTS ix_auto_input_job_user ON auto_input_job(username, id)`,
	]) {
		await db.prepare(stmt).run();
	}
	tablesEnsured = true;
}

// ---------------------------------------------------------------------------
// Rencana job dari teks result (murni, tanpa DB)
// ---------------------------------------------------------------------------
const MONTHS: Record<string, number> = {
	january: 1, januari: 1, february: 2, februari: 2, march: 3, maret: 3, april: 4, may: 5, mei: 5,
	june: 6, juni: 6, july: 7, juli: 7, august: 8, agustus: 8, september: 9, october: 10, oktober: 10,
	november: 11, nopember: 11, december: 12, desember: 12,
};

/** "06 October 2026" / "6 Oktober 2026" di mana pun dalam teks -> "2026-10-06" (atau null). */
export function parseResultDate(text: string): string | null {
	const re = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(String(text ?? "")))) {
		const mon = MONTHS[m[2].toLowerCase()];
		if (!mon) continue;
		const d = Number(m[1]);
		const y = Number(m[3]);
		const t = new Date(Date.UTC(y, mon - 1, d));
		if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mon - 1 || t.getUTCDate() !== d) continue;
		return `${y}-${String(mon).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
	}
	return null;
}

export function normMarket(m: string): string {
	return String(m ?? "").toUpperCase().replace(/\s+/g, " ").trim();
}

export type AutoInputPlan =
	| { ok: true; market: string; prizes: string[]; date: string; key: string }
	| { ok: false; reason: string };

/**
 * Apakah result ini boleh diinput otomatis? Aturannya konservatif: ragu = TIDAK
 * (operator input manual seperti biasa), karena salah input tidak bisa ditarik.
 */
export function planAutoInput(rawText: string, p: Processed): AutoInputPlan {
	const market = normMarket(p.market);
	if (!p.prize1) return { ok: false, reason: "Prize 1 tidak terbaca" };
	if (!market || market === "UNKNOWN") return { ok: false, reason: "Pasaran tidak terbaca" };
	if (/^(TOTOMACAU|TOTO MACAU|KING KONG)/.test(market)) {
		return { ok: false, reason: "Pasaran " + market + " tidak lewat menu Nomor Keluar biasa" };
	}
	if (p.status !== "BENAR") return { ok: false, reason: "Shio di teks tidak cocok dengan angka — periksa dulu" };
	const date = parseResultDate(rawText);
	if (!date) return { ok: false, reason: "Tanggal result tidak terbaca di teks" };
	if (p.prize3 && !p.prize2) return { ok: false, reason: "Prize 3 ada tapi Prize 2 kosong" };
	const prizes = [p.prize1, p.prize2, p.prize3].filter(Boolean);
	return { ok: true, market, prizes, date, key: `${market}|${date}|${prizes.join("-")}` };
}

// ---------------------------------------------------------------------------
// Saklar ON/OFF per user (default OFF)
// ---------------------------------------------------------------------------
export async function getEnabled(env: Env, username: string): Promise<boolean> {
	await ensureAutoInputTables(env);
	const row = await getTurso(env)
		.prepare(`SELECT enabled FROM auto_input_config WHERE username = ?`)
		.bind(username)
		.first<Record<string, unknown>>();
	return !!Number(row?.enabled ?? 0);
}

export async function setEnabled(env: Env, username: string, enabled: boolean): Promise<void> {
	await ensureAutoInputTables(env);
	await getTurso(env)
		.prepare(
			`INSERT INTO auto_input_config (username, enabled, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(username) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
		)
		.bind(username, enabled ? 1 : 0, tsNow())
		.run();
}

// ---------------------------------------------------------------------------
// Sesi admin per website (PHPSESSID)
// ---------------------------------------------------------------------------
export interface AdminSession {
	website: string;
	baseUrl: string;
	phpsessid: string;
}

/** "PHPSESSID=abc; foo=1" / "abc" -> "abc". Kosong kalau bentuknya tidak masuk akal. */
export function parsePhpSessId(raw: string): string {
	const s = String(raw ?? "").trim();
	const m = s.match(/PHPSESSID\s*=\s*([A-Za-z0-9,-]{10,})/i);
	return m ? m[1] : /^[A-Za-z0-9,-]{10,}$/.test(s) ? s : "";
}

/**
 * Cookie yang dikirim browser ke admin BUKAN cuma PHPSESSID (juga lastuser,
 * <agen>=<WEBSITE>.COM, <agen>koderedis -- terlihat di request asli). Operator boleh
 * menempel SATU token PHPSESSID, atau seluruh isi header Cookie; yang disimpan adalah
 * "nama=nilai; nama=nilai" bersih. Karakter selain yang wajar ditolak (anti header injection).
 */
export function parseCookieInput(raw: string): string {
	const s = String(raw ?? "").trim().replace(/^cookie\s*:\s*/i, "");
	if (!s) return "";
	const bare = parsePhpSessId(s);
	if (bare && !s.includes(";") && !/PHPSESSID/i.test(s)) return "PHPSESSID=" + bare;
	const pairs: string[] = [];
	for (const part of s.split(";")) {
		const t = part.trim();
		if (!t) continue;
		if (!/^[A-Za-z0-9_.-]{1,64}=[A-Za-z0-9_.,%+\-]{0,200}$/.test(t)) return "";
		pairs.push(t);
	}
	const sid = pairs.find((p) => /^PHPSESSID=/i.test(p));
	if (!sid || !parsePhpSessId(sid)) return "";
	return pairs.join("; ");
}

/** Nilai header Cookie dari yang tersimpan (data lama hanya berisi token polos). */
export function cookieHeader(stored: string): string {
	return stored.includes("=") ? stored : "PHPSESSID=" + stored;
}

/** 4 karakter terakhir PHPSESSID untuk ditampilkan (tidak pernah nilai penuh). */
export function sessionHint(stored: string): string {
	const sid = parsePhpSessId(cookieHeader(stored));
	return sid ? "••••" + sid.slice(-4) : "";
}

/** Hanya tiga admin ini yang boleh disentuh (sekaligus mencegah panel dipakai menembak host lain). */
export const ADMIN_HOSTS = ["ag.suksesbogil.com", "agwl12.suksesbogil.com", "agwl5.suksesbogil.com"] as const;
/**
 * Kode website di panel adalah kode SINGKAT (HUGO, FOLA, SOHO -- lihat sites.ts), nama
 * panjangnya cuma label. Keduanya dikenali. Website lain cukup memakai salah satu host
 * di atas yang BUKAN milik tiga website ini.
 */
const SITE_ALIAS: Record<string, string> = {
	HUGO: "HUGO", HUGOTOGEL: "HUGO",
	FOLA: "FOLA", FOLATOTO: "FOLA",
	SOHO: "SOHO", SOHOTOGEL: "SOHO",
};
const SITE_HOST: Record<string, string> = {
	HUGO: "ag.suksesbogil.com",
	FOLA: "agwl12.suksesbogil.com",
	SOHO: "agwl5.suksesbogil.com",
};
const SITE_BRAND: Record<string, string> = { HUGO: "HUGOTOGEL", FOLA: "FOLATOTO", SOHO: "SOHOTOGEL" };

/** Nama merek yang tampil di header admin ("HUGOTOGEL.COM"), null untuk website tak dikenal. */
export function siteBrand(website: string): string | null {
	const k = SITE_ALIAS[String(website).trim().toUpperCase()];
	return k ? SITE_BRAND[k] : null;
}

export function defaultAdminBase(website: string): string {
	const k = SITE_ALIAS[String(website).trim().toUpperCase()];
	return k ? `https://${SITE_HOST[k]}/` : "";
}

/** null = URL ini sah untuk website ini; selain itu alasan penolakan. */
export function adminBaseProblem(website: string, base: string): string | null {
	const w = String(website).trim().toUpperCase();
	let host = "";
	try {
		const u = new URL(base);
		if (u.protocol !== "https:") return "harus https";
		host = u.hostname.toLowerCase();
	} catch {
		return "bukan URL yang valid";
	}
	if (!(ADMIN_HOSTS as readonly string[]).includes(host)) {
		return `host ${host} bukan salah satu admin yang diizinkan (${ADMIN_HOSTS.join(", ")})`;
	}
	const want = SITE_HOST[SITE_ALIAS[w] ?? ""];
	if (want && host !== want) return `${w} harus memakai ${want}, bukan ${host}`;
	if (!want && Object.values(SITE_HOST).includes(host)) return `${host} milik website lain, bukan ${w}`;
	return null;
}

export function normalizeAdminBase(raw: string): string {
	let s = String(raw ?? "").trim().split("#")[0].split("?")[0];
	if (!s) return "";
	if (!/^https?:\/\//i.test(s)) s = "https://" + s;
	try {
		const u = new URL(s);
		return u.origin + "/";
	} catch {
		return "";
	}
}

export async function getSessions(env: Env, username: string): Promise<AdminSession[]> {
	await ensureAutoInputTables(env);
	const res = await getTurso(env)
		.prepare(`SELECT website, base_url, phpsessid FROM auto_input_session WHERE username = ? ORDER BY website`)
		.bind(username)
		.all<Record<string, unknown>>();
	return (res.results ?? []).map((r) => ({
		website: String(r.website),
		baseUrl: String(r.base_url || ""),
		phpsessid: String(r.phpsessid || ""),
	}));
}

export async function getSession(env: Env, username: string, website: string): Promise<AdminSession | null> {
	const w = String(website).trim().toUpperCase();
	return (await getSessions(env, username)).find((s) => s.website === w) ?? null;
}

/** Simpan sesi satu website. phpsessid kosong = pertahankan yang lama (form tidak mengirim ulang nilai rahasia). */
export async function saveSession(env: Env, username: string, website: string, baseUrl: string, phpsessidRaw: string): Promise<void> {
	await ensureAutoInputTables(env);
	const w = String(website).trim().toUpperCase();
	const base = normalizeAdminBase(baseUrl) || defaultAdminBase(w);
	const bad = base ? adminBaseProblem(w, base) : "kosong";
	if (bad) throw new Error(`URL admin ${w} ditolak: ${bad}.`);
	const old = await getSession(env, username, w);
	let sid = old?.phpsessid ?? "";
	if (String(phpsessidRaw ?? "").trim()) {
		sid = parseCookieInput(phpsessidRaw);
		if (!sid) throw new Error(`Cookie ${w} tidak valid — tempel "PHPSESSID=xxxx" (atau seluruh isi header Cookie) dari Chrome.`);
	}
	await getTurso(env)
		.prepare(
			`INSERT INTO auto_input_session (username, website, base_url, phpsessid, updated_at) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(username, website) DO UPDATE SET base_url = excluded.base_url, phpsessid = excluded.phpsessid, updated_at = excluded.updated_at`,
		)
		.bind(username, w, base, sid, tsNow())
		.run();
}

export async function deleteSession(env: Env, username: string, website: string): Promise<void> {
	await ensureAutoInputTables(env);
	await getTurso(env)
		.prepare(`DELETE FROM auto_input_session WHERE username = ? AND website = ?`)
		.bind(username, String(website).trim().toUpperCase())
		.run();
}

// ---------------------------------------------------------------------------
// Job = satu result x satu website. UNIQUE(website, result_key) => tidak pernah dobel.
// ---------------------------------------------------------------------------
export interface JobRow {
	id: number;
	username: string;
	website: string;
	market: string;
	prizes: string[];
	resultDate: string;
	status: JobStatus;
	stage: string;
	detail: string;
	period: string;
	createdAt: string;
	updatedAt: string;
}

function rowToJob(r: Record<string, unknown>): JobRow {
	let prizes: string[] = [];
	try {
		const a = JSON.parse(String(r.prizes ?? "[]"));
		if (Array.isArray(a)) prizes = a.map(String);
	} catch {
		/* kosong */
	}
	return {
		id: Number(r.id),
		username: String(r.username ?? ""),
		website: String(r.website ?? ""),
		market: String(r.market ?? ""),
		prizes,
		resultDate: String(r.result_date ?? ""),
		status: String(r.status ?? "RUNNING") as JobStatus,
		stage: String(r.stage ?? ""),
		detail: String(r.detail ?? ""),
		period: String(r.period ?? ""),
		createdAt: String(r.created_at ?? ""),
		updatedAt: String(r.updated_at ?? ""),
	};
}

/**
 * Ambil hak menjalankan job ini. true = baru, silakan jalan. false = result ini
 * untuk website ini sudah pernah dijalankan (status lama dikembalikan di `existing`).
 */
export async function startJob(
	env: Env,
	username: string,
	website: string,
	plan: Extract<AutoInputPlan, { ok: true }>,
): Promise<{ id: number } | { existing: JobRow }> {
	await ensureAutoInputTables(env);
	await expireRunning(env);
	const db = getTurso(env);
	const now = tsNow();
	const w = String(website).trim().toUpperCase();
	const r = await db
		.prepare(
			`INSERT OR IGNORE INTO auto_input_job
			   (username, website, market, prizes, result_date, result_key, status, stage, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', 'cek', ?, ?)`,
		)
		.bind(username, w, plan.market, JSON.stringify(plan.prizes), plan.date, plan.key, now, now)
		.run();
	if (r.meta.changes > 0) return { id: r.meta.last_row_id };
	const ex = await db
		.prepare(`SELECT * FROM auto_input_job WHERE website = ? AND result_key = ?`)
		.bind(w, plan.key)
		.first<Record<string, unknown>>();
	return { existing: rowToJob(ex ?? {}) };
}

export async function finishJob(
	env: Env,
	jobId: number,
	status: Exclude<JobStatus, "QUEUED" | "RUNNING">,
	stage: string,
	detail: string,
	period = "",
): Promise<void> {
	await getTurso(env)
		.prepare(`UPDATE auto_input_job SET status = ?, stage = ?, detail = ?, period = ?, updated_at = ? WHERE id = ?`)
		.bind(status, stage.slice(0, 20), detail.slice(0, 600), period, tsNow(), jobId)
		.run();
}

/** Tahap terakhir yang dicapai (dipakai kalau eksekusi mati di tengah). */
export async function setStage(env: Env, jobId: number, stage: string, period = ""): Promise<void> {
	await getTurso(env)
		.prepare(`UPDATE auto_input_job SET stage = ?, period = CASE WHEN ? <> '' THEN ? ELSE period END, updated_at = ? WHERE id = ?`)
		.bind(stage, period, period, tsNow(), jobId)
		.run();
}

/** Worker bisa mati di tengah job. RUNNING yang basi jadi GAGAL -- tidak pernah diulang otomatis. */
async function expireRunning(env: Env): Promise<void> {
	const db = getTurso(env);
	const now = tsNow();
	const old = tsPlusMinutes(-RUNNING_TTL_MIN);
	// Antre tapi tidak pernah dijalankan (halaman panel ditutup sebelum sempat memanggil): belum menyentuh admin.
	await db
		.prepare(
			`UPDATE auto_input_job SET status = 'FAILED', stage = 'cek', updated_at = ?,
			   detail = 'Tidak sempat dijalankan (halaman panel ditutup / koneksi putus) — admin belum disentuh, aman klik COBA LAGI.'
			 WHERE status = 'QUEUED' AND updated_at < ?`,
		)
		.bind(now, old)
		.run();
	// Berjalan tapi putus. Tahap 'cek' = belum ada yang diubah; tahap lain = angka MUNGKIN sudah masuk.
	await db
		.prepare(
			`UPDATE auto_input_job SET status = 'FAILED', updated_at = ?,
			   detail = 'Terputus sebelum mengubah apa pun — aman klik COBA LAGI.'
			 WHERE status = 'RUNNING' AND stage IN ('', 'cek') AND updated_at < ?`,
		)
		.bind(now, old)
		.run();
	await db
		.prepare(
			`UPDATE auto_input_job SET status = 'FAILED', updated_at = ?,
			   detail = 'Proses terputus di tengah jalan — CEK MANUAL di admin website (angka mungkin sudah masuk).'
			 WHERE status = 'RUNNING' AND updated_at < ?`,
		)
		.bind(now, old)
		.run();
}

/**
 * Ambil hak menjalankan job yang sudah antre (QUEUED -> RUNNING), atomik: pemanggilan ganda
 * (klik dobel / retry jaringan) tidak pernah menjalankan job dua kali.
 */
export async function claimJob(env: Env, username: string, jobId: number): Promise<JobRow | null> {
	await ensureAutoInputTables(env);
	const db = getTurso(env);
	const r = await db
		.prepare(`UPDATE auto_input_job SET status = 'RUNNING', updated_at = ? WHERE id = ? AND username = ? AND status = 'QUEUED'`)
		.bind(tsNow(), jobId, username)
		.run();
	if (r.meta.changes !== 1) return null;
	const row = await db.prepare(`SELECT * FROM auto_input_job WHERE id = ?`).bind(jobId).first<Record<string, unknown>>();
	return row ? rowToJob(row) : null;
}

export async function listJobs(env: Env, username: string, limit = 30): Promise<JobRow[]> {
	await ensureAutoInputTables(env);
	await expireRunning(env);
	const res = await getTurso(env)
		.prepare(`SELECT * FROM auto_input_job WHERE username = ? ORDER BY id DESC LIMIT ?`)
		.bind(username, limit)
		.all<Record<string, unknown>>();
	return (res.results ?? []).map(rowToJob);
}

/**
 * Job yang gagal SEBELUM menyentuh admin (stage 'cek') dihapus supaya result yang
 * sama bisa dicoba lagi (mis. setelah PHPSESSID diganti). Yang sudah sampai tahap
 * Kirim/Hitung TIDAK boleh -- harus dicek manual.
 */
export async function clearRetryable(env: Env, username: string, jobId: number): Promise<void> {
	await ensureAutoInputTables(env);
	const db = getTurso(env);
	const row = await db
		.prepare(`SELECT * FROM auto_input_job WHERE id = ? AND username = ?`)
		.bind(jobId, username)
		.first<Record<string, unknown>>();
	if (!row) throw new Error("Job tidak ditemukan.");
	const j = rowToJob(row);
	if (!((j.status === "FAILED" || j.status === "SKIPPED") && (j.stage === "" || j.stage === "cek"))) {
		throw new Error("Job ini sudah sampai tahap mengubah data di admin — cek manual di admin website, jangan diulang otomatis.");
	}
	await db.prepare(`DELETE FROM auto_input_job WHERE id = ?`).bind(jobId).run();
}
