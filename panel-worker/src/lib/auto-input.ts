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
import { adminDomain } from "./integrations";
import { getTurso } from "./turso";
import { ensureColumns } from "./turso-schema";
import { getSys } from "./settings";
import { retentionFrom, tsNow, tsPlusMinutes } from "./time";
import { MARKET_TO_PANEL, type Processed } from "./parser";
import { INVEST_PASARAN } from "./invest";
import { PREDICTION_SITE_NAMES } from "./prediction";

export const RUNNING_TTL_MIN = 5;
/** Percobaan ulang otomatis hanya untuk job yang baru (job lama sudah tidak relevan: periode sudah lewat). */
export const RETRY_WINDOW_MIN = 60;
/** Gagal di tahap Hitung yang TIDAK boleh dicoba ulang otomatis: tombol Hitung mungkin sudah ditekan (Hitung dikirim tapi
 *  tombol masih ada / proses terputus) -> mengulang bisa menghitung (membayar) dua kali. Hanya dua kasus Hitung yang pasti
 *  aman diulang: halaman Hitung tidak cocok (Hitung TIDAK dijalankan) atau tidak dikenali (belum ditekan). */
export function noRetrySql(alias = ""): string {
	const a = alias ? alias + "." : "";
	return `(${a}stage = 'hitung' AND ${a}detail NOT LIKE '%Hitung TIDAK dijalankan%' AND ${a}detail NOT LIKE '%halaman Hitung tidak dikenali%')`;
}
/** Job GAGAL yang tidak akan dicoba ulang lagi (peringatan terakhir): percobaan habis, di luar jendela percobaan ulang,
 *  atau termasuk yang tidak boleh diulang. Dulu hanya 'percobaan habis' -> job lain tidak pernah diperingatkan. */
export function finalFailureSql(alias = ""): string {
	const a = alias ? alias + "." : "";
	return `(${a}attempts >= ? OR ${a}created_at < ? OR ${noRetrySql(alias)})`;
}

export type JobStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED";

let tablesEnsured = false;
let ensuring: Promise<void> | null = null;
/** Hanya untuk test (tiap test memakai database baru). */
export function resetAutoInputTablesFlag(): void {
	tablesEnsured = false;
	ensuring = null;
	lastExpireAt = 0;
}
/** Satu pembuatan skema bersama: tiga fungsi yang dipanggil paralel (Promise.all) di isolate dingin dulu masing-masing menjalankan
 *  SELURUH pembuatan skema (penanda baru diset sesudah selesai) -> subrequest dikali tiga -> "Too many subrequests". */
export function ensureAutoInputTables(env: Env): Promise<void> {
	if (tablesEnsured) return Promise.resolve();
	if (!ensuring) {
		ensuring = ensureAutoInputTablesOnce(env).then(
			() => {
				tablesEnsured = true;
			},
			(e) => {
				ensuring = null; // gagal -> request berikutnya boleh mencoba lagi
				throw e;
			},
		);
	}
	return ensuring;
}
async function ensureAutoInputTablesOnce(env: Env): Promise<void> {
	const db = getTurso(env);
	// SATU batch untuk semua CREATE (dulu 12 perintah berurutan = 12+ subrequest di isolate dingin) + SATU query kolom.
	await db.batch([
		db.prepare(`CREATE TABLE IF NOT EXISTS auto_input_config (
			username   TEXT PRIMARY KEY,
			enabled    INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL DEFAULT ''
		)`),
		db.prepare(`CREATE TABLE IF NOT EXISTS auto_input_session (
			username   TEXT NOT NULL,
			website    TEXT NOT NULL,
			base_url   TEXT NOT NULL DEFAULT '',
			phpsessid  TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (username, website)
		)`),
		db.prepare(`CREATE TABLE IF NOT EXISTS auto_input_job (
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
		)`),
		db.prepare(`CREATE INDEX IF NOT EXISTS ix_auto_input_job_user ON auto_input_job(username, id)`),
		db.prepare(`CREATE INDEX IF NOT EXISTS ix_auto_input_job_retry ON auto_input_job(status, updated_at)`),
		// Total Omset/Referal/Menang (menu Prediksi admin) per job SELESAI -- tabel tersendiri supaya tampilan Result hanya membaca N baris terakhir.
		db.prepare(`CREATE TABLE IF NOT EXISTS auto_input_totals (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			job_id      INTEGER NOT NULL UNIQUE,
			username    TEXT NOT NULL,
			website     TEXT NOT NULL,
			market      TEXT NOT NULL,
			prizes      TEXT NOT NULL DEFAULT '[]',
			result_date TEXT NOT NULL DEFAULT '',
			period      TEXT NOT NULL DEFAULT '',
			omset       TEXT NOT NULL DEFAULT '',
			referal     TEXT NOT NULL DEFAULT '',
			menang      TEXT NOT NULL DEFAULT '',
			note        TEXT NOT NULL DEFAULT '',
			at          TEXT NOT NULL DEFAULT ''
		)`),
		db.prepare(`CREATE INDEX IF NOT EXISTS ix_auto_input_totals_user ON auto_input_totals(username, id)`),
	]);
	await ensureColumns(db, {
		auto_input_job: [
			// attempts = jumlah percobaan ULANG otomatis yang sudah dilakukan (0 = hanya percobaan awal).
			["attempts", "INTEGER NOT NULL DEFAULT 0"],
			// alerted = 1 setelah popup peringatan 'gagal & perlu dicek' ditampilkan ke user (supaya tidak muncul berulang).
			["alerted", "INTEGER NOT NULL DEFAULT 0"],
			// hidden = 1: disembunyikan user (sudah beres / ditangani manual). Baris tetap ada sebagai pagar anti-input-ganda.
			["hidden", "INTEGER NOT NULL DEFAULT 0"],
			// tg_sent = 1 setelah kegagalan final dikabarkan ke Telegram admin (lib/admin-notify).
			["tg_sent", "INTEGER NOT NULL DEFAULT 0"],
		],
		// Pasaran yang TIDAK di-auto untuk akun ini (JSON array nama pasaran ternormalisasi). Kosong = semua pasaran auto.
		auto_input_config: [["disabled_markets", "TEXT NOT NULL DEFAULT '[]'"]],
		// Pantau Omset untuk pasaran yang dihitung MANUAL: rkey = kunci result (anti-dobel), pending = 1 selama menunggu angka diinput &
		// dihitung di admin, manual = 1 untuk baris jenis ini, code = kode pasaran (pNNNN) hasil penemuan pertama, next_at/until_at = jadwal cek & batas tunggu.
		auto_input_totals: [
			["rkey", "TEXT NOT NULL DEFAULT ''"],
			["pending", "INTEGER NOT NULL DEFAULT 0"],
			["manual", "INTEGER NOT NULL DEFAULT 0"],
			["code", "TEXT NOT NULL DEFAULT ''"],
			["next_at", "TEXT NOT NULL DEFAULT ''"],
			["until_at", "TEXT NOT NULL DEFAULT ''"],
		],
	});
	// Index kolom baru (setelah kolomnya ada): cron tiap menit hanya membaca baris MENUNGGU, bukan seluruh tabel.
	await db.batch([
		db.prepare(`CREATE INDEX IF NOT EXISTS ix_auto_input_totals_pending ON auto_input_totals(pending, next_at)`),
		db.prepare(`CREATE INDEX IF NOT EXISTS ix_auto_input_totals_rkey ON auto_input_totals(website, rkey)`),
	]);
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
	return (await getConfig(env, username)).enabled;
}
/** Saklar + daftar pasaran yang dimatikan dalam SATU query (dulu dua query terpisah di tiap buka menu). */
export async function getConfig(env: Env, username: string): Promise<{ enabled: boolean; disabledMarkets: string[] }> {
	await ensureAutoInputTables(env);
	const row = await getTurso(env)
		.prepare(`SELECT enabled, disabled_markets FROM auto_input_config WHERE username = ?`)
		.bind(username)
		.first<Record<string, unknown>>();
	let disabledMarkets: string[] = [];
	try {
		disabledMarkets = cleanMarketList(JSON.parse(String(row?.disabled_markets ?? "[]")));
	} catch {
		/* kosong */
	}
	return { enabled: !!Number(row?.enabled ?? 0), disabledMarkets };
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
// Pasaran yang tidak di-auto (GLOBAL, diatur admin). Pasaran di daftar ini dilewati SEJAK AWAL: tidak dibuat job, tidak dicoba
// ulang, tidak memicu peringatan gagal -- operator menginput manual seperti biasa.
// ---------------------------------------------------------------------------
const MAX_DISABLED = 100;
export function cleanMarketList(v: unknown): string[] {
	const arr = Array.isArray(v) ? v : [];
	const out = new Set<string>();
	for (const x of arr) {
		const m = normMarket(String(x ?? ""));
		if (m && m !== "UNKNOWN" && m.length <= 40) out.add(m);
		if (out.size >= MAX_DISABLED) break;
	}
	return [...out].sort();
}
/** Daftar GLOBAL pasaran yang tidak di-auto: diatur ADMIN saja (Data Master `md_ai_off_markets`), berlaku untuk semua user.
 *  Diisi `loadMasterData` (dipanggil di tiap request & cron) lewat `setGlobalOffMarkets`. */
let globalOffMarkets: string[] = [];
export function setGlobalOffMarkets(v: unknown): void {
	globalOffMarkets = cleanMarketList(v);
}
export function getGlobalOffMarkets(): string[] {
	return globalOffMarkets;
}
/** Parameter `username` dipertahankan agar pemanggil lama tetap valid; daftarnya sekarang sama untuk semua akun. */
export async function getDisabledMarkets(_env: Env, _username?: string): Promise<string[]> {
	return globalOffMarkets;
}
/** Bersihkan daftar lama per-akun (sebelum jadi global) setelah dipindahkan. */
export async function clearLegacyDisabled(env: Env, username: string): Promise<void> {
	await ensureAutoInputTables(env);
	await getTurso(env)
		.prepare(`UPDATE auto_input_config SET disabled_markets = '[]', updated_at = ? WHERE username = ?`)
		.bind(tsNow(), username)
		.run();
}
/** Semua nama pasaran yang dikenal panel (daftar Invest + peta Panel-Z) -- sumber daftar saklar supaya lengkap walau belum pernah ada job. */
export function catalogMarkets(): string[] {
	const out = new Set<string>();
	for (const [, name] of INVEST_PASARAN) out.add(normMarket(name));
	for (const k of Object.keys(MARKET_TO_PANEL)) out.add(normMarket(k));
	out.delete("");
	return [...out];
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

/**
 * Admin hanya boleh di domain suksesbogil.com (https). Satu host melayani BANYAK website (tiap website
 * punya akun agen sendiri), jadi host menentukan "server" tempat website itu berada, bukan identitasnya;
 * identitas dijaga lewat pengecekan nama website di sidebar (lihat runAutoInput).
 */
export const ADMIN_DOMAIN_DEFAULT = "suksesbogil.com";

/** Server (host) admin tiap website, dari daftar pemilik panel. Kode website di panel = kode singkat. */
export const SITE_HOST_DEFAULT: Record<string, string[]> = {
	"ag.suksesbogil.com": ["AXIS", "DODO", "XO", "SENJA", "HUGO", "RETRO"],
	"agwl5.suksesbogil.com": ["LIMA", "SOHO"],
	"agwl12.suksesbogil.com": ["YEL", "FOLA"],
};
export const SITE_HOST: Record<string, string> = {}; // kode website -> host (diisi dari Data Master / bawaan)
export function setSiteHosts(map: Record<string, string[]>): void {
	for (const k of Object.keys(SITE_HOST)) delete SITE_HOST[k];
	for (const [host, codes] of Object.entries(map)) for (const c of codes) SITE_HOST[c] = host;
}
setSiteHosts(SITE_HOST_DEFAULT);

/** "HUGOTOGEL" / "hugo" -> "HUGO" (kode singkat panel); null kalau tidak dikenal. */
export function siteCode(website: string): string | null {
	const w = String(website).trim().toUpperCase();
	if (PREDICTION_SITE_NAMES[w]) return w;
	return Object.keys(PREDICTION_SITE_NAMES).find((k) => PREDICTION_SITE_NAMES[k] === w) ?? (SITE_HOST[w] ? w : null);
}

/** Nama merek penuh ("SENJATOGEL") dari kode website panel ("SENJA"); null kalau tidak dikenal. */
export function siteBrand(website: string): string | null {
	const k = siteCode(website);
	return k ? (PREDICTION_SITE_NAMES[k] ?? null) : null;
}

export function defaultAdminBase(website: string): string {
	const k = siteCode(website);
	return k && SITE_HOST[k] ? `https://${SITE_HOST[k]}/` : "";
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
	if (host !== adminDomain() && !host.endsWith("." + adminDomain())) {
		return `host ${host} bukan admin yang diizinkan (hanya *.${adminDomain()})`;
	}
	const k = siteCode(w);
	const want = k ? SITE_HOST[k] : undefined;
	if (want && host !== want) return `${w} harus memakai ${want}, bukan ${host}`;
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
	/** Percobaan ulang otomatis yang sudah dilakukan. */
	attempts: number;
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
		attempts: Number(r.attempts ?? 0) || 0,
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

/** Penanda ringkas Total Omset/Referal/Menang di kolom Keterangan Riwayat Job (rapi & mudah dibaca). */
const TOTALS_TAG_RE = /\s*\[Omset[^\]]*\]\s*$/;
export function withTotalsText(detail: string, totals: { omset: string; referal: string; menang: string } | null | undefined, note = ""): string {
	const base = String(detail ?? "").replace(TOTALS_TAG_RE, "");
	const tag = totals ? `[Omset ${totals.omset} · Referal ${totals.referal} · Menang ${totals.menang}]` : `[Omset belum terbaca${note ? ": " + note.slice(0, 160) : ""}]`;
	return `${base} ${tag}`;
}

/** Perbarui Keterangan job SELESAI setelah "Ambil ulang" berhasil membaca angkanya. */
export async function setJobTotalsText(env: Env, jobId: number, totals: { omset: string; referal: string; menang: string }): Promise<void> {
	const db = getTurso(env);
	const row = await db.prepare(`SELECT detail FROM auto_input_job WHERE id = ? AND status = 'DONE'`).bind(jobId).first<{ detail: string }>();
	if (!row) return;
	await db.prepare(`UPDATE auto_input_job SET detail = ? WHERE id = ?`).bind(withTotalsText(row.detail, totals).slice(0, 600), jobId).run();
}

export interface TotalsRow {
	id: number;
	jobId: number;
	website: string;
	market: string;
	prizes: string[];
	period: string;
	omset: string;
	referal: string;
	menang: string;
	/** alasan gagal baca (kosong bila angka terbaca) */
	note: string;
	at: string;
	/** true selama menunggu pasaran manual diinput & dihitung di admin */
	pending: boolean;
	/** true = pasaran yang dihitung manual (bukan hasil Auto Prediksi) */
	manual: boolean;
}

/** Simpan hasil baca menu Prediksi untuk job SELESAI (ulang = timpa). totals null = gagal baca, `note` berisi alasannya. */
export async function saveTotals(
	env: Env,
	job: { id: number; username: string; website: string; market: string; prizes: string[]; resultDate: string },
	period: string,
	totals: { omset: string; referal: string; menang: string } | null | undefined,
	note: string,
): Promise<void> {
	await ensureAutoInputTables(env);
	await getTurso(env)
		.prepare(
			`INSERT INTO auto_input_totals (job_id, username, website, market, prizes, result_date, period, omset, referal, menang, note, at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(job_id) DO UPDATE SET period = excluded.period, omset = excluded.omset, referal = excluded.referal, menang = excluded.menang, note = excluded.note, at = excluded.at`,
		)
		.bind(job.id, job.username, job.website, job.market, JSON.stringify(job.prizes), job.resultDate, period, totals?.omset ?? "", totals?.referal ?? "", totals?.menang ?? "", totals ? "" : note.slice(0, 300), tsNow())
		.run();
}

const TOTALS_ROW_CAP = 60; // pengaman jumlah baris yang dikirim ke browser (bukan pengaturan)

function rowToTotals(r: Record<string, unknown>): TotalsRow {
	let prizes: string[] = [];
	try {
		const a = JSON.parse(String(r.prizes ?? "[]"));
		if (Array.isArray(a)) prizes = a.map(String);
	} catch {
		/* kosong */
	}
	return {
		id: Number(r.id),
		jobId: Number(r.job_id),
		website: String(r.website ?? ""),
		market: String(r.market ?? ""),
		prizes,
		period: String(r.period ?? ""),
		omset: String(r.omset ?? ""),
		referal: String(r.referal ?? ""),
		menang: String(r.menang ?? ""),
		note: String(r.note ?? ""),
		at: String(r.at ?? ""),
		pending: Number(r.pending ?? 0) === 1,
		manual: Number(r.manual ?? 0) === 1,
	};
}

/** Baris Total Omset/Referal/Menang terbaru milik akun ini -- membaca PERSIS sebanyak batas (index username,id), bukan memindai riwayat. */
export async function listTotals(env: Env, username: string): Promise<TotalsRow[]> {
	await ensureAutoInputTables(env);
	const res = await getTurso(env)
		.prepare(`SELECT id, job_id, website, market, prizes, period, omset, referal, menang, note, at, pending, manual FROM auto_input_totals WHERE username = ? ORDER BY id DESC LIMIT ?`)
		.bind(username, TOTALS_ROW_CAP)
		.all<Record<string, unknown>>();
	return (res.results ?? []).map(rowToTotals);
}

export async function getTotalsRow(env: Env, username: string, id: number): Promise<TotalsRow | null> {
	await ensureAutoInputTables(env);
	const r = await getTurso(env)
		.prepare(`SELECT id, job_id, website, market, prizes, period, omset, referal, menang, note, at, pending, manual FROM auto_input_totals WHERE id = ? AND username = ?`)
		.bind(id, username)
		.first<Record<string, unknown>>();
	return r ? rowToTotals(r) : null;
}

// ---------------------------------------------------------------------------
// Pasaran yang dihitung MANUAL di admin (tidak di-auto): panel tetap memantau Omset
// ---------------------------------------------------------------------------
export interface ManualTotalsRow {
	id: number;
	username: string;
	website: string;
	market: string;
	prizes: string[];
	resultDate: string;
	rkey: string;
	code: string;
	untilAt: string;
	period: string;
}

/**
 * Jadwalkan pemantauan Total Omset/Referal/Menang untuk hasil yang TIDAK dihitung Auto Prediksi. Tanpa PHPSESSID tersimpan tidak ada yang bisa dibaca:
 * baris langsung selesai dengan alasannya. Satu baris per (website, hasil) -- kirim ulang teks yang sama tidak membuat baris ganda.
 */
export async function scheduleManualTotals(
	env: Env,
	username: string,
	website: string,
	plan: Extract<AutoInputPlan, { ok: true }>,
	hasSession: boolean,
): Promise<{ status: "dijadwalkan" | "sudah" | "tanpa-sesi"; id: number }> {
	await ensureAutoInputTables(env);
	const db = getTurso(env);
	const w = String(website).trim().toUpperCase();
	const dup = await db.prepare(`SELECT id FROM auto_input_totals WHERE website = ? AND rkey = ? AND username = ? LIMIT 1`).bind(w, plan.key, username).first<{ id: number }>();
	if (dup) return { status: "sudah", id: Number(dup.id) };
	const wait = await getSys(env, "sys_totals_wait_min");
	const now = tsNow();
	const fakeJobId = -(Date.now() * 1000 + Math.floor(Math.random() * 1000)); // negatif = bukan job Auto Prediksi; unik per baris
	const ins = await db
		.prepare(
			`INSERT INTO auto_input_totals (job_id, username, website, market, prizes, result_date, period, omset, referal, menang, note, at, rkey, pending, manual, code, next_at, until_at)
			 VALUES (?, ?, ?, ?, ?, ?, '', '', '', '', ?, ?, ?, ?, 1, '', ?, ?)`,
		)
		.bind(fakeJobId, username, w, plan.market, JSON.stringify(plan.prizes), plan.date, hasSession ? "" : `PHPSESSID ${w} belum disimpan — Omset tidak bisa dicek otomatis`, now, plan.key, hasSession ? 1 : 0, now, tsPlusMinutes(wait))
		.run();
	return { status: hasSession ? "dijadwalkan" : "tanpa-sesi", id: Number(ins.meta.last_row_id) };
}

const MANUAL_COLS = `id, username, website, market, prizes, result_date, rkey, code, until_at, period, next_at`;

async function claimManualRow(env: Env, r: Record<string, unknown>): Promise<ManualTotalsRow | null> {
	const db = getTurso(env);
	const poll = await getSys(env, "sys_totals_poll_min");
	const c = await db
		.prepare(`UPDATE auto_input_totals SET next_at = ? WHERE id = ? AND pending = 1 AND next_at = ?`)
		.bind(tsPlusMinutes(poll), Number(r.id), String(r.next_at))
		.run();
	if (c.meta.changes !== 1) return null; // diambil tick/klik lain
	let prizes: string[] = [];
	try {
		const a = JSON.parse(String(r.prizes ?? "[]"));
		if (Array.isArray(a)) prizes = a.map(String);
	} catch {
		/* kosong */
	}
	return { id: Number(r.id), username: String(r.username), website: String(r.website), market: String(r.market), prizes, resultDate: String(r.result_date ?? ""), rkey: String(r.rkey ?? ""), code: String(r.code ?? ""), untilAt: String(r.until_at ?? ""), period: String(r.period ?? "") };
}

/** Ambil SATU baris pantauan yang sudah waktunya dicek, atomik (dua tick bersamaan tidak mengambil baris yang sama). */
export async function claimDueManualTotals(env: Env): Promise<ManualTotalsRow | null> {
	await ensureAutoInputTables(env);
	const r = await getTurso(env)
		.prepare(`SELECT ${MANUAL_COLS} FROM auto_input_totals WHERE pending = 1 AND next_at <= ? ORDER BY next_at ASC LIMIT 1`)
		.bind(tsNow())
		.first<Record<string, unknown>>();
	return r ? claimManualRow(env, r) : null;
}

/** Cek LANGSUNG satu baris milik akun ini (dipicu browser tepat sesudah KIRIM SEMUA), tanpa menunggu jadwal cron. */
export async function claimManualTotalsById(env: Env, username: string, id: number): Promise<ManualTotalsRow | null> {
	await ensureAutoInputTables(env);
	const r = await getTurso(env)
		.prepare(`SELECT ${MANUAL_COLS} FROM auto_input_totals WHERE id = ? AND username = ? AND pending = 1 AND manual = 1`)
		.bind(id, username)
		.first<Record<string, unknown>>();
	return r ? claimManualRow(env, r) : null;
}

export async function setManualTotalsState(env: Env, id: number, patch: { code?: string; note?: string }): Promise<void> {
	const db = getTurso(env);
	if (patch.code !== undefined) await db.prepare(`UPDATE auto_input_totals SET code = ? WHERE id = ?`).bind(patch.code, id).run();
	if (patch.note !== undefined) await db.prepare(`UPDATE auto_input_totals SET note = ? WHERE id = ? AND pending = 1`).bind(patch.note.slice(0, 300), id).run();
}

/**
 * Selesaikan pantauan: simpan angka (atau alasan), lalu catat di Riwayat Job (Keterangan) sebagai job SELESAI dengan kunci "<hasil>#manual" --
 * kunci beda dari result asli, jadi pagar anti-input-ganda Auto Prediksi untuk hasil yang sama tidak terpakai.
 */
export async function finishManualTotals(
	env: Env,
	row: ManualTotalsRow,
	period: string,
	totals: { omset: string; referal: string; menang: string } | null,
	note: string,
): Promise<void> {
	const db = getTurso(env);
	const now = tsNow();
	await db
		.prepare(`UPDATE auto_input_totals SET pending = 0, period = ?, omset = ?, referal = ?, menang = ?, note = ?, at = ? WHERE id = ?`)
		.bind(period, totals?.omset ?? "", totals?.referal ?? "", totals?.menang ?? "", totals ? "" : note.slice(0, 300), now, row.id)
		.run();
	const base = `Dihitung manual (pasaran tidak di-auto): ${row.market} angka ${row.prizes.join("/")}${period ? ` periode ${period}` : ""}.`;
	await db
		.prepare(
			`INSERT OR IGNORE INTO auto_input_job (username, website, market, prizes, result_date, result_key, status, stage, detail, period, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'DONE', 'selesai', ?, ?, ?, ?)`,
		)
		.bind(row.username, row.website, row.market, JSON.stringify(row.prizes), row.resultDate, row.rkey + "#manual", withTotalsText(base, totals, note).slice(0, 600), period, now, now)
		.run();
}

/** "Ambil ulang" pada baris manual: pantau lagi dari sekarang (cron yang membaca). */
export async function rearmManualTotals(env: Env, id: number): Promise<void> {
	const wait = await getSys(env, "sys_totals_wait_min");
	await getTurso(env)
		.prepare(`UPDATE auto_input_totals SET pending = 1, note = '', next_at = ?, until_at = ? WHERE id = ? AND manual = 1`)
		.bind(tsNow(), tsPlusMinutes(wait), id)
		.run();
}

/** Tahap terakhir yang dicapai (dipakai kalau eksekusi mati di tengah). */
export async function setStage(env: Env, jobId: number, stage: string, period = ""): Promise<void> {
	await getTurso(env)
		.prepare(`UPDATE auto_input_job SET stage = ?, period = CASE WHEN ? <> '' THEN ? ELSE period END, updated_at = ? WHERE id = ?`)
		.bind(stage, period, period, tsNow(), jobId)
		.run();
}

/** Worker bisa mati di tengah job. RUNNING yang basi jadi GAGAL -- tidak pernah diulang otomatis.
 * Paling sering sekali per 60 dtk per isolate: dulu 3 UPDATE ke Turso di SETIAP buka menu / poll / tick cron. */
let lastExpireAt = 0;
async function expireRunning(env: Env): Promise<void> {
	if (Date.now() - lastExpireAt < 60_000) return;
	lastExpireAt = Date.now();
	const db = getTurso(env);
	const now = tsNow();
	const old = tsPlusMinutes(-RUNNING_TTL_MIN);
	// Tiga UPDATE dalam SATU batch (1 subrequest, bukan 3). Urutan penting: yang paling spesifik dulu.
	await db.batch([
		// Antre tapi tidak pernah dijalankan (halaman panel ditutup sebelum sempat memanggil): belum menyentuh admin.
		db
			.prepare(
				`UPDATE auto_input_job SET status = 'FAILED', stage = 'cek', updated_at = ?,
			   detail = 'Tidak sempat dijalankan (halaman panel ditutup / koneksi putus) — admin belum disentuh, aman klik COBA LAGI.'
			 WHERE status = 'QUEUED' AND updated_at < ?`,
			)
			.bind(now, old),
		// Berjalan tapi putus. Tahap 'cek' = belum ada yang diubah; tahap lain = angka MUNGKIN sudah masuk.
		db
			.prepare(
				`UPDATE auto_input_job SET status = 'FAILED', updated_at = ?,
			   detail = 'Terputus sebelum mengubah apa pun — aman klik COBA LAGI.'
			 WHERE status = 'RUNNING' AND stage IN ('', 'cek') AND updated_at < ?`,
			)
			.bind(now, old),
		db
			.prepare(
				`UPDATE auto_input_job SET status = 'FAILED', updated_at = ?,
			   detail = 'Proses terputus di tengah jalan — CEK MANUAL di admin website (angka mungkin sudah masuk).'
			 WHERE status = 'RUNNING' AND updated_at < ?`,
			)
			.bind(now, old),
	]);
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

/** Riwayat job N hari terakhir (WIB, mulai 00:00 hari ke-N lalu) -- BUKAN "30 terakhir": dulu hari yang ramai mendorong job
 * lama keluar dari tabel sebelum 7 hari. N diatur admin (sys_auto_input_history_days, bawaan 7). Batas baris hanya pengaman. */
export async function listJobs(env: Env, username: string, days?: number): Promise<JobRow[]> {
	await ensureAutoInputTables(env);
	await expireRunning(env);
	const n = days ?? (await getSys(env, "sys_auto_input_history_days"));
	const from = retentionFrom(n);
	// Hanya kolom yang dipakai tampilan (dulu SELECT * s.d. 2000 baris penuh -> respons Turso raksasa yang terpotong di tengah:
	// "Unterminated string in JSON"). detail dipangkas 700 karakter (cuplikan diagnosa tetap muat); batas baris 1200 terbaru.
	const res = await getTurso(env)
		.prepare(
			`SELECT id, username, website, market, prizes, result_date, status, stage, substr(detail, 1, 700) AS detail, period, created_at, updated_at, attempts
			 FROM auto_input_job WHERE username = ? AND hidden = 0 AND created_at >= ? ORDER BY id DESC LIMIT 1200`,
		)
		.bind(username, from)
		.all<Record<string, unknown>>();
	return (res.results ?? []).map(rowToJob);
}

/**
 * Sembunyikan job pilihan user (sudah beres / ditangani manual): hilang dari daftar, tidak dicoba ulang otomatis, tidak memunculkan peringatan.
 * SENGAJA tidak menghapus barisnya: UNIQUE (website, result_key) tetap menjadi pagar anti-input-ganda ke admin; baris dipangkas otomatis setelah N hari.
 * Hanya milik user sendiri; job yang masih berjalan/antre dilewati.
 */
export async function hideJobs(env: Env, username: string, ids: number[]): Promise<{ hidden: number; skipped: number }> {
	await ensureAutoInputTables(env);
	const list = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 300);
	if (!list.length) return { hidden: 0, skipped: 0 };
	const r = await getTurso(env)
		.prepare(`UPDATE auto_input_job SET hidden = 1 WHERE username = ? AND hidden = 0 AND status NOT IN ('RUNNING', 'QUEUED') AND id IN (${list.map(() => "?").join(",")})`)
		.bind(username, ...list)
		.run();
	return { hidden: r.meta.changes, skipped: list.length - r.meta.changes };
}

/** Hapus job yang lebih lama dari N hari (batas sama dengan riwayat yang ditampilkan). Job yang masih RUNNING tidak disentuh. */
export async function pruneAutoInputJobs(env: Env, days?: number): Promise<number> {
	await ensureAutoInputTables(env);
	const n = days ?? (await getSys(env, "sys_auto_input_history_days"));
	const from = retentionFrom(n);
	const r = await getTurso(env).prepare(`DELETE FROM auto_input_job WHERE created_at < ? AND status <> 'RUNNING'`).bind(from).run();
	await getTurso(env).prepare(`DELETE FROM auto_input_totals WHERE at < ?`).bind(from).run();
	return r.meta.changes;
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

/**
 * Job GAGAL yang sudah waktunya dicoba ulang otomatis: status FAILED, percobaan ulang < batas, dan sudah `gapMin` menit sejak
 * gagal terakhir (updated_at). Hanya akun yang fiturnya masih AKTIF. Terlama dulu.
 */
export async function dueRetryJobs(env: Env, maxRetries: number, gapMin: number, limit: number): Promise<JobRow[]> {
	await ensureAutoInputTables(env);
	await expireRunning(env);
	if (maxRetries <= 0) return [];
	const res = await getTurso(env)
		.prepare(
			`SELECT j.* FROM auto_input_job j JOIN auto_input_config c ON c.username = j.username AND c.enabled = 1
			 WHERE j.status = 'FAILED' AND j.updated_at >= ? AND j.updated_at <= ? AND j.hidden = 0 AND j.attempts < ? AND j.created_at >= ? AND NOT ${noRetrySql("j")}
			 ORDER BY j.updated_at ASC, j.id ASC LIMIT ?`,
		)
		// batas bawah updated_at (= awal jendela; updated_at >= created_at selalu) membuat rentang index ix_auto_input_job_retry
		// sempit: dulu tiap menit membaca SEMUA job GAGAL selama masa simpan riwayat (kuota baca Turso, 17 Okt 2026).
		.bind(tsPlusMinutes(-RETRY_WINDOW_MIN), tsPlusMinutes(-gapMin), maxRetries, tsPlusMinutes(-RETRY_WINDOW_MIN), limit)
		.all<Record<string, unknown>>();
	return (res.results ?? []).map(rowToJob);
}

/** Ambil hak percobaan ulang (FAILED -> RUNNING, attempts+1), atomik: dua tick bersamaan tidak menjalankan job yang sama. */
export async function claimRetry(env: Env, jobId: number, maxRetries: number, gapMin: number): Promise<JobRow | null> {
	const db = getTurso(env);
	const r = await db
		.prepare(`UPDATE auto_input_job SET status = 'RUNNING', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'FAILED' AND attempts < ? AND updated_at <= ?`)
		.bind(tsNow(), jobId, maxRetries, tsPlusMinutes(-gapMin))
		.run();
	if (r.meta.changes !== 1) return null;
	const row = await db.prepare(`SELECT * FROM auto_input_job WHERE id = ?`).bind(jobId).first<Record<string, unknown>>();
	return row ? rowToJob(row) : null;
}

export interface FailedAlert {
	id: number;
	website: string;
	market: string;
	prizes: string[];
	stage: string;
	detail: string;
	attempts: number;
}

/** Job GAGAL yang percobaan otomatisnya sudah HABIS (peringatan terakhir) dan belum pernah ditampilkan ke user. Hanya job BARU (gagal dalam 6 jam terakhir) -- riwayat gagal yang lama tidak pernah memicu peringatan. */
export async function pendingFailureAlerts(env: Env, username: string, maxRetries: number): Promise<FailedAlert[]> {
	await ensureAutoInputTables(env); // tanpa expireRunning: dipoll tiap 20 dtk, cukup cron/menu yang merapikan job basi
	const res = await getTurso(env)
		.prepare(`SELECT * FROM auto_input_job WHERE username = ? AND hidden = 0 AND status = 'FAILED' AND ${finalFailureSql()} AND alerted = 0 AND updated_at >= ? AND created_at >= ? ORDER BY id ASC LIMIT 20`)
		.bind(username, Math.max(0, maxRetries), tsPlusMinutes(-RETRY_WINDOW_MIN), tsPlusMinutes(-6 * 60), tsPlusMinutes(-6 * 60))
		.all<Record<string, unknown>>();
	return (res.results ?? []).map(rowToJob).map((j) => ({ id: j.id, website: j.website, market: j.market, prizes: j.prizes, stage: j.stage, detail: j.detail, attempts: j.attempts }));
}

export async function ackFailureAlerts(env: Env, username: string, ids: number[]): Promise<void> {
	const list = ids.filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
	if (!list.length) return;
	await ensureAutoInputTables(env);
	await getTurso(env)
		.prepare(`UPDATE auto_input_job SET alerted = 1 WHERE username = ? AND id IN (${list.map(() => "?").join(",")})`)
		.bind(username, ...list)
		.run();
}
