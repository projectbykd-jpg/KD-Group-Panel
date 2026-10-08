// Auto-check TOTO MACAU (4D, 6 draw/hari) & TOTO MACAO 5D (2 draw/hari) lalu posting ke Panel-Z.
//
// Sumber = halaman "Daftar Nomor ... Yang Keluar" di admin website (admin_angka.php?sar=m17 / m51), dibuka dengan
// PHPSESSID yang SUDAH disimpan tiap user di menu Auto Prediksi. Angka di tabel itu sudah dimasukkan & sudah
// dihitung admin (kolom Hitung = Yes) -> kita hanya MEMBACA lalu meneruskan ke Panel-Z (jalur yang sama dengan menu Result).
//
// Siapa yang dipakai: user dengan fitur Auto Prediksi AKTIF, akun AKTIF (ADMIN/OPERATOR), izin Panel-Z, menu Result diizinkan,
// dan website-nya ada di akun itu + punya sesi tersimpan + Panel-Z terisi. Satu website diproses SEKALI per draw
// (sesi user pertama yang masih hidup; kalau habis, user berikutnya).
//
// Mode (Admin > Pengaturan Sistem): 0 mati | 1 catat saja (bawaan) | 2 catat + kirim ke Panel-Z.
//
// Pengaman: kunci unik (website, game, periode) -> satu draw tidak pernah terkirim dua kali; hanya baris "Hitung: Yes" yang
// sudah terbit dalam 2 jam terakhir; angka harus tepat 4 digit (Toto Macau) / 5 digit (5D); jam baris harus jam draw yang dikenal;
// halaman harus benar-benar halaman game yang diminta (bukan redirect). Ada yang meleset -> tidak dikirim, dicatat, dan
// (kalau percobaan habis / sesi mati) user diberi popup peringatan.
import { getTurso } from "./turso";
import { tsNow, tsPlusMinutes } from "./time";
import { getSys } from "./settings";
import { getUserProfiles } from "./db";
import { hasMenu } from "./menus";
import { getSiteAccounts, type PanelZCfg } from "./site";
import { getSessions, type AdminSession } from "./auto-input";
import { adminReq, htmlText, type Fetcher } from "./auto-input-run";
import { openPanelZ, parsePanelZRows, type PanelZHandle } from "../senders/panelz";
import { logActivity } from "./activity";

export interface TotoGame {
	game: "m17" | "m51";
	/** nama game di tautan pagination admin (&game=...) */
	name: string;
	path: string;
	title: RegExp;
	digits: number;
	/** jam (WIB) baris di tabel -> nama pasaran Panel-Z (lihat MARKET_TO_PANEL di parser.ts) */
	slots: Record<number, string>;
}
export const TOTO_GAMES: TotoGame[] = [
	{
		game: "m17",
		name: "Toto Macau",
		path: "admin_angka.php?sar=m17&game=Toto%20Macau",
		title: /Daftar\s+Nomor\s+Toto\s+Macau\b/i,
		digits: 4,
		slots: { 0: "TOTOMACAU-00", 13: "TOTOMACAU-13", 16: "TOTOMACAU-16", 19: "TOTOMACAU-19", 22: "TOTOMACAU-22", 23: "TOTOMACAU-23" },
	},
	{
		game: "m51",
		name: "Toto Macao 5D",
		path: "admin_angka.php?sar=m51&game=Toto%20Macao%205D",
		title: /Daftar\s+Nomor\s+Toto\s+Macao\s+5D\b/i,
		digits: 5,
		slots: { 15: "TOTOMACAU-15-5D", 21: "TOTOMACAU-21-5D" },
	},
];

export const TOTO_FRESH_MIN = 120; // hanya baris yang terbit <= 2 jam lalu
export const TOTO_MAX_ATTEMPTS = 3; // percobaan kirim ke Panel-Z per draw
const SUBREQ_BUDGET = 30; // batas panggilan jaringan per putaran (batas 50 subrequest per invocation)
const ADMIN_PAGE_SIZE = 20; // admin_angka.php menampilkan 20 baris per halaman (tombol [ >> ] = start=20&end=40 ...)
const ADMIN_MAX_PAGES = 5;
const PANELZ_PAGES_CAP = 12;

export interface TotoRow {
	no: number;
	date: string; // yyyy-MM-dd
	time: string; // HH:mm:ss
	hour: number;
	period: number;
	number: string;
	hitung: string;
}

/** Baca baris tabel. HTML admin TIDAK rapi (baris tanpa </tr>, <form> di dalam <tr>) -> dibaca per rangkaian <td>, bukan per <tr>. */
export function parseTotoRows(html: string): TotoRow[] {
	const out: TotoRow[] = [];
	const re =
		/<td[^>]*>\s*(\d{1,4})\s*<\/td>\s*<td[^>]*>\s*(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*<\/td>\s*<td[^>]*>\s*(\d+)\s*<\/td>\s*<td[^>]*>\s*(\d+)\s*<\/td>\s*<td[^>]*>\s*([A-Za-z]+)\s*<\/td>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		out.push({
			no: Number(m[1]),
			date: `${m[4]}-${m[3]}-${m[2]}`,
			time: `${m[5]}:${m[6]}:${m[7]}`,
			hour: Number(m[5]),
			period: Number(m[8]),
			number: m[9],
			hitung: m[10].toLowerCase(),
		});
	}
	return out;
}

/** Menit sejak baris terbit (WIB). */
function ageMin(row: TotoRow, nowMs: number): number {
	const t = Date.parse(`${row.date}T${row.time}Z`); // tabel & jam panel sama-sama WIB -> bandingkan pada dinding waktu yang sama
	return (nowMs + 7 * 3600_000 - t) / 60_000;
}

// ---------------------------------------------------------------------------
// Tabel log (Turso)
// ---------------------------------------------------------------------------
let ensured = false;
export function resetTotoTablesFlag(): void {
	ensured = false;
}
async function ensureTables(env: Env): Promise<void> {
	if (ensured) return;
	const db = getTurso(env);
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS toto_macau_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				website TEXT NOT NULL,
				game TEXT NOT NULL,
				period INTEGER NOT NULL,
				slot_key TEXT NOT NULL DEFAULT '',
				market TEXT NOT NULL DEFAULT '',
				number TEXT NOT NULL DEFAULT '',
				row_at TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'RECORDED',
				attempts INTEGER NOT NULL DEFAULT 0,
				username TEXT NOT NULL DEFAULT '',
				detail TEXT NOT NULL DEFAULT '',
				alerted INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT '',
				updated_at TEXT NOT NULL DEFAULT '',
				UNIQUE (website, game, period)
			)`,
		)
		.run();
	await db.prepare(`CREATE INDEX IF NOT EXISTS ix_toto_log_slot ON toto_macau_log(website, game, slot_key)`).run();
	await db
		.prepare(`CREATE TABLE IF NOT EXISTS toto_macau_event (id INTEGER PRIMARY KEY AUTOINCREMENT, website TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'info', level TEXT NOT NULL DEFAULT 'INFO', msg TEXT NOT NULL DEFAULT '')`)
		.run();
	ensured = true;
}

export interface TotoLogRow {
	id: number;
	website: string;
	game: string;
	period: number;
	slotKey: string;
	market: string;
	number: string;
	rowAt: string;
	status: string;
	attempts: number;
	username: string;
	detail: string;
	createdAt: string;
}
const toLog = (r: Record<string, unknown>): TotoLogRow => ({
	id: Number(r.id),
	website: String(r.website ?? ""),
	game: String(r.game ?? ""),
	period: Number(r.period ?? 0),
	slotKey: String(r.slot_key ?? ""),
	market: String(r.market ?? ""),
	number: String(r.number ?? ""),
	rowAt: String(r.row_at ?? ""),
	status: String(r.status ?? ""),
	attempts: Number(r.attempts ?? 0),
	username: String(r.username ?? ""),
	detail: String(r.detail ?? ""),
	createdAt: String(r.created_at ?? ""),
});

export async function listTotoLog(env: Env, websites: string[], days = 3): Promise<TotoLogRow[]> {
	await ensureTables(env);
	const ws = [...new Set(websites.map((w) => String(w).trim().toUpperCase()).filter(Boolean))];
	if (!ws.length) return [];
	const from = tsPlusMinutes(-days * 24 * 60);
	const res = await getTurso(env)
		.prepare(`SELECT * FROM toto_macau_log WHERE website IN (${ws.map(() => "?").join(",")}) AND created_at >= ? AND period > 0 ORDER BY id DESC LIMIT 500`)
		.bind(...ws, from)
		.all<Record<string, unknown>>();
	return (res.results ?? []).map(toLog);
}

/** Peringatan terakhir: draw GAGAL (percobaan habis), sesi/Panel-Z tidak terbaca, atau angka Panel-Z BEDA dengan admin (6 jam terakhir, belum pernah ditampilkan). */
export async function pendingTotoAlerts(env: Env, websites: string[]): Promise<TotoLogRow[]> {
	await ensureTables(env);
	const ws = [...new Set(websites.map((w) => String(w).trim().toUpperCase()).filter(Boolean))];
	if (!ws.length) return [];
	const res = await getTurso(env)
		.prepare(
			`SELECT * FROM toto_macau_log WHERE website IN (${ws.map(() => "?").join(",")}) AND ((status = 'FAILED' AND attempts >= ?) OR status = 'CONFLICT') AND alerted = 0 AND updated_at >= ? ORDER BY id ASC LIMIT 20`,
		)
		.bind(...ws, TOTO_MAX_ATTEMPTS, tsPlusMinutes(-6 * 60))
		.all<Record<string, unknown>>();
	return (res.results ?? []).map(toLog);
}
export async function ackTotoAlerts(env: Env, ids: number[]): Promise<void> {
	const list = ids.filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
	if (!list.length) return;
	await ensureTables(env);
	await getTurso(env)
		.prepare(`UPDATE toto_macau_log SET alerted = 1 WHERE id IN (${list.map(() => "?").join(",")})`)
		.bind(...list)
		.run();
}

// ---------------------------------------------------------------------------
// Rekonsiliasi: admin AG/AGWL  <->  Panel-Z, per website, per (pasaran, TANGGAL)
// ---------------------------------------------------------------------------
export type PanelOpen = (cfg: PanelZCfg, opts?: { sinceDate?: string; maxPages?: number }) => Promise<PanelZHandle | string>;
export interface TotoDeps {
	fetchFn?: Fetcher;
	panel?: PanelOpen;
	nowMs?: number;
}
export interface TotoSummary {
	websites: number;
	posted: number;
	already: number;
	pending: number;
	conflict: number;
	missing: number;
	failed: number;
	net: boolean;
	message: string;
	/** website yang diperiksa pada panggilan ini (dipakai workflow GitHub untuk lanjut ke website berikutnya) */
	sites: string[];
	/** ada baris yang antre karena jatah panggilan habis -> panggil lagi untuk website yang sama */
	more: boolean;
	/** dari 'posted': baris yang sebelumnya berisi angka SALAH lalu dikoreksi ke angka admin */
	corrected: number;
}

/** Ada draw yang terbit 3..45 menit lalu? Saat itu putaran tiap 3 menit; selain itu tiap 30 menit. */
export function passIntervalMin(nowMs: number): number {
	const d = new Date(nowMs + 7 * 3600_000);
	const minOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
	for (const g of TOTO_GAMES) {
		for (const hs of Object.keys(g.slots)) {
			let diff = minOfDay - Number(hs) * 60;
			if (diff < 0) diff += 24 * 60;
			if (diff >= 3 && diff <= 45) return 3;
		}
	}
	return 30;
}


// ---------------------------------------------------------------------------
// Log kegiatan ("sedang apa sekarang") -- ditampilkan langsung di kartu Auto Check Toto Macau
// ---------------------------------------------------------------------------
export type EvLevel = "INFO" | "OK" | "WARN" | "ERR";
export interface TotoEvent {
	id: number;
	website: string;
	ts: string;
	kind: string; // start | end | info
	level: EvLevel;
	msg: string;
}
const EV_KEEP = 400; // simpan 400 kejadian terakhir
const evStmt = (env: Env, website: string, kind: string, level: EvLevel, msg: string): LogStmt =>
	getTurso(env)
		.prepare(`INSERT INTO toto_macau_event (website, ts, kind, level, msg) VALUES (?, ?, ?, ?, ?)`)
		.bind(website, tsNow(), kind, level, msg.slice(0, 300));
/** Tulis satu kejadian langsung (dipakai di titik yang tidak punya batch sendiri). */
export async function logTotoEvent(env: Env, website: string, kind: string, level: EvLevel, msg: string): Promise<void> {
	try {
		await ensureTables(env);
		const db = getTurso(env);
		const stmts = [evStmt(env, website, kind, level, msg)];
		if (kind === "end") stmts.push(db.prepare(`DELETE FROM toto_macau_event WHERE id <= (SELECT MAX(id) FROM toto_macau_event) - ?`).bind(EV_KEEP));
		await db.batch(stmts);
	} catch {
		/* log kegiatan tidak boleh menggagalkan proses */
	}
}
export async function listTotoEvents(env: Env, websites: string[], limit = 60): Promise<{ events: TotoEvent[]; running: boolean; lastAt: string }> {
	await ensureTables(env);
	const ws = [...new Set(websites.map((w) => String(w).trim().toUpperCase()).filter(Boolean))];
	if (!ws.length) return { events: [], running: false, lastAt: "" };
	const res = await getTurso(env)
		.prepare(`SELECT * FROM toto_macau_event WHERE website IN (${ws.map(() => "?").join(",")}) OR website = '' ORDER BY id DESC LIMIT ?`)
		.bind(...ws, limit)
		.all<Record<string, unknown>>();
	const events = (res.results ?? []).map((r) => ({ id: Number(r.id), website: String(r.website ?? ""), ts: String(r.ts ?? ""), kind: String(r.kind ?? ""), level: String(r.level ?? "INFO") as EvLevel, msg: String(r.msg ?? "") }));
	// "sedang berjalan" = kejadian terbaru milik sebuah website adalah 'start'/'info' (belum 'end') dan masih segar (<3 menit)
	const fresh = tsPlusMinutes(-3);
	const latestByWeb = new Map<string, TotoEvent>();
	for (const e of events) if (e.website && !latestByWeb.has(e.website)) latestByWeb.set(e.website, e);
	const running = [...latestByWeb.values()].some((e) => e.kind !== "end" && e.ts >= fresh);
	return { events, running, lastAt: events[0]?.ts ?? "" };
}

type Cand = { username: string; sess: AdminSession };
const dayOf = (nowMs: number, back = 0): string => new Date(nowMs + 7 * 3600_000 - back * 86400_000).toISOString().slice(0, 10);

async function candidates(env: Env, only?: string[]): Promise<Map<string, Cand[]>> {
	const db = getTurso(env);
	const en = await db.prepare(`SELECT username FROM auto_input_config WHERE enabled = 1 ORDER BY username`).all<{ username: string }>();
	let names = (en.results ?? []).map((r) => String(r.username));
	if (only) names = names.filter((n) => only.some((o) => o.toLowerCase() === n.toLowerCase()));
	const out = new Map<string, Cand[]>();
	if (!names.length) return out;
	const profiles = await getUserProfiles(env, names);
	for (const u of names) {
		const p = profiles.get(u.toLowerCase());
		if (!p || p.status !== "AKTIF") continue;
		if (p.role !== "ADMIN" && p.role !== "OPERATOR") continue;
		// aturan yang sama dengan KIRIM KE PANEL-Z di menu Result
		if (!p.permissions.panelz || !hasMenu(p, "result") || !hasMenu(p, "auto-input")) continue;
		for (const s of await getSessions(env, p.username)) {
			if (!s.phpsessid || !p.websites.includes(s.website)) continue;
			(out.get(s.website) ?? out.set(s.website, []).get(s.website)!).push({ username: p.username, sess: s });
		}
	}
	return out;
}

async function upsertLog(
	env: Env,
	a: { website: string; game: string; period: number; slotKey: string; market: string; number: string; rowAt: string; status: string; detail: string; username: string },
	buf?: LogStmt[],
): Promise<void> {
	const now = tsNow();
	const db = getTurso(env);
	const stmt = db
		.prepare(
			`INSERT INTO toto_macau_log (website, game, period, slot_key, market, number, row_at, status, attempts, username, detail, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
			 ON CONFLICT(website, game, period) DO UPDATE SET status = excluded.status, detail = excluded.detail, number = excluded.number, market = excluded.market, username = excluded.username, updated_at = excluded.updated_at`,
		)
		.bind(a.website, a.game, a.period, a.slotKey, a.market, a.number, a.rowAt, a.status, a.username, a.detail.slice(0, 300), now, now);
	if (buf) buf.push(stmt);
	else await stmt.run();
}

const gameLabel = (g: TotoGame): string => (g.game === "m17" ? "Toto Macau" : "Toto Macao 5D");
type LogStmt = ReturnType<ReturnType<typeof getTurso>["prepare"]>;
/** Tulis semua catatan sekaligus: tiap panggilan Turso = 1 subrequest (batas 50 per invocation), jadi digabung jadi 1 batch. */
async function flushLog(env: Env, buf: LogStmt[], budget: { used: number }): Promise<void> {
	if (!buf.length) return;
	const db = getTurso(env);
	for (let i = 0; i < buf.length; i += 40) {
		budget.used++;
		await db.batch(buf.slice(i, i + 40));
	}
	buf.length = 0;
}

async function recordFailure(env: Env, website: string, game: string, dayKey: string, username: string, why: string): Promise<void> {
	// periode negatif = catatan "gagal baca" per hari & game (tidak bentrok dengan periode asli); attempts naik tiap putaran gagal
	const pseudo = -Number(dayKey.replace(/\D/g, "")) || -1;
	const now = tsNow();
	const db = getTurso(env);
	await db
		.prepare(
			`INSERT INTO toto_macau_log (website, game, period, slot_key, market, number, row_at, status, attempts, username, detail, created_at, updated_at)
			 VALUES (?, ?, ?, ?, '', '', '', 'FAILED', 1, ?, ?, ?, ?)
			 ON CONFLICT(website, game, period) DO UPDATE SET attempts = attempts + 1, detail = excluded.detail, updated_at = excluded.updated_at`,
		)
		.bind(website, game, pseudo, dayKey, username, why.slice(0, 300), now, now)
		.run();
	const row = await db.prepare(`SELECT attempts FROM toto_macau_log WHERE website = ? AND game = ? AND period = ?`).bind(website, game, pseudo).first<{ attempts: number }>();
	if (Number(row?.attempts) === TOTO_MAX_ATTEMPTS) {
		await logActivity(env, username, "TOTO MACAU AUTO", `[${website}] ${game} gagal: ${why}`, "GAGAL", "").catch(() => {});
	}
}

interface AdminRow extends TotoRow {
	game: TotoGame;
	market: string;
}

/** Satu website: baca admin (m17 & m51), baca Panel-Z, cocokkan per (pasaran, tanggal), isi yang kosong (mode 2). */
async function reconcileWebsite(
	env: Env,
	website: string,
	cands: Cand[],
	pz: PanelZCfg,
	mode: number,
	deps: { f: Fetcher; panel: PanelOpen; nowMs: number; correct: boolean; lookback: number; maxCorrect: number },
	budget: { used: number },
	sum: TotoSummary,
): Promise<void> {
	const db = getTurso(env);
	const buf: LogStmt[] = [];
	const today = dayOf(deps.nowMs);
	const since = dayOf(deps.nowMs, deps.lookback);
	const adminRows: AdminRow[] = [];
	let reader = cands[0].username;

	for (const game of TOTO_GAMES) {
		let html = "";
		let lastErr = "";
		let ok = false;
		for (const c of cands) {
			budget.used++;
			sum.net = true;
			try {
				html = await adminReq(deps.f, c.sess, game.path);
				reader = c.username;
				ok = true;
				break;
			} catch (e) {
				lastErr = e instanceof Error ? e.message : String(e);
			}
		}
		if (!ok) {
			buf.push(evStmt(env, website, "info", "ERR", `Admin ${gameLabel(game)}: sesi habis / halaman tidak terbuka — tempel PHPSESSID baru di menu Auto Prediksi`));
			await recordFailure(env, website, game.game, today, cands[0].username, `Sesi admin ${website} habis atau halaman tidak bisa dibuka — tempel PHPSESSID baru di menu Auto Prediksi (${lastErr})`);
			sum.failed++;
			continue;
		}
		if (!game.title.test(htmlText(html))) {
			await recordFailure(env, website, game.game, today, reader, "Halaman yang terbuka bukan daftar nomor game ini (bentuk halaman berubah?).");
			sum.failed++;
			continue;
		}
		const rows = parseTotoRows(html);
		buf.push(evStmt(env, website, "info", rows.length ? "INFO" : "ERR", `Admin ${gameLabel(game)}: ${rows.length} baris terbaca (akun ${reader})`));
		if (!rows.length) {
			await recordFailure(env, website, game.game, today, reader, "Tabel angka tidak terbaca (bentuk halaman berubah?).");
			sum.failed++;
			continue;
		}
		// halaman admin berikutnya ([ >> ]) selama baris paling lama di halaman terakhir masih dalam rentang
		const sessOk = cands.find((c) => c.username === reader)!.sess;
		const all = new Map(rows.map((r) => [r.period, r]));
		let pageRows = rows;
		for (let pg = 1; pg < ADMIN_MAX_PAGES; pg++) {
			const oldest = pageRows.reduce((m, r) => (m && m < r.date ? m : r.date), "");
			if (!oldest || oldest < since || pageRows.length < ADMIN_PAGE_SIZE) break;
			budget.used++;
			try {
				pageRows = parseTotoRows(await adminReq(deps.f, sessOk, `admin_angka.php?start=${pg * ADMIN_PAGE_SIZE}&end=${(pg + 1) * ADMIN_PAGE_SIZE}&sar=${game.game}&game=${encodeURIComponent(game.name)}`));
			} catch (e) {
				buf.push(evStmt(env, website, "info", "WARN", `Admin ${gameLabel(game)}: halaman ${pg + 1} gagal dibaca (${e instanceof Error ? e.message : String(e)}) — memakai halaman yang sudah terbaca`));
				break;
			}
			if (!pageRows.length) break;
			for (const r of pageRows) if (!all.has(r.period)) all.set(r.period, r);
			buf.push(evStmt(env, website, "info", "INFO", `Admin ${gameLabel(game)}: halaman ${pg + 1} dibaca (${pageRows.length} baris, terlama ${pageRows.reduce((m, r) => (m && m < r.date ? m : r.date), "")})`));
		}
		for (const r of all.values()) {
			if (r.hitung !== "yes" || r.date < since || r.date > today) continue; // belum dihitung admin / terlalu lama / tanggal aneh
			const market = game.slots[r.hour];
			const bad = !market ? `jam ${r.hour} bukan jam draw yang dikenal` : !new RegExp(`^\\d{${game.digits}}$`).test(r.number) ? `angka "${r.number}" bukan ${game.digits} digit` : "";
			if (bad) {
				await upsertLog(env, { website, game: game.game, period: r.period, slotKey: `${r.date} ${String(r.hour).padStart(2, "0")}`, market: market ?? "", number: r.number, rowAt: `${r.date} ${r.time}`, status: "SKIPPED", detail: "Dilewati: " + bad, username: reader }, buf);
				continue;
			}
			adminRows.push({ ...r, game, market });
		}
	}
	buf.push(evStmt(env, website, "info", "INFO", `${adminRows.length} angka admin siap dicocokkan (Hitung=Yes, 3 hari terakhir)`));
	if (!adminRows.length) {
		await flushLog(env, buf, budget);
		return;
	}
	await flushLog(env, buf, budget); // kejadian awal tampil di layar sebelum membuka Panel-Z
	adminRows.sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));

	// Panel-Z: masuk sekali, baca daftar result.
	sum.net = true;
	const panel = await deps.panel(pz, { sinceDate: since, maxPages: PANELZ_PAGES_CAP });
	budget.used += typeof panel === "string" ? 2 : (panel.fetches ?? 2);
	if (typeof panel === "string") {
		buf.push(evStmt(env, website, "info", "ERR", `Panel-Z tidak bisa dibuka: ${panel}`));
		await recordFailure(env, website, "pz", today, reader, `Panel-Z tidak bisa dibuka: ${panel}`);
		sum.failed++;
		await flushLog(env, buf, budget);
		return;
	}
	const zRows = parsePanelZRows(panel.html);
	buf.push(evStmt(env, website, "info", zRows.length ? "INFO" : "ERR", `Panel-Z dibuka: ${panel.fetches ? panel.fetches - 1 : 1} halaman daftar Result, ${zRows.length} baris Toto Macau terbaca`));
	if (!zRows.length) {
		await recordFailure(env, website, "pz", today, reader, "Daftar result Panel-Z tidak terbaca (bentuk halaman berubah / belum ada baris Toto Macau).");
		sum.failed++;
		await flushLog(env, buf, budget);
		return;
	}

	await flushLog(env, buf, budget);
	const posted: { a: AdminRow; rowId: string; old: string }[] = [];
	// satu kali baca status lama semua baris (hemat subrequest)
	budget.used++;
	const curRes = await db
		.prepare(`SELECT game, period, status, attempts, updated_at FROM toto_macau_log WHERE website = ? AND period > 0 AND created_at >= ?`)
		.bind(website, tsPlusMinutes(-(deps.lookback + 2) * 24 * 60))
		.all<{ game: string; period: number; status: string; attempts: number; updated_at: string }>();
	const curMap = new Map((curRes.results ?? []).map((r) => [`${r.game}|${r.period}`, r]));
	// Pengaman koreksi massal: bila terlalu banyak angka Panel-Z yang berbeda sekaligus, itu tanda pemetaan keliru (bukan salah ketik) -> jangan ditimpa
	const diffCount = adminRows.filter((a) => {
		const t = zRows.filter((z) => z.market === a.market && z.date === a.date);
		return t.length === 1 && t[0].filled && t[0].value !== a.number;
	}).length;
	const bulkHold = deps.correct && diffCount > deps.maxCorrect;
	if (bulkHold) buf.push(evStmt(env, website, "info", "ERR", `${diffCount} angka Panel-Z berbeda dari admin (batas koreksi massal ${deps.maxCorrect}) — kemungkinan pemetaan tanggal/pasaran keliru; TIDAK dikoreksi otomatis, cek manual`));
	const correctNow = deps.correct && !bulkHold;
	for (const a of adminRows) {
		const base = { website, game: a.game.game, period: a.period, slotKey: `${a.date} ${String(a.hour).padStart(2, "0")}`, market: a.market, number: a.number, rowAt: `${a.date} ${a.time}`, username: reader };
		const targets = zRows.filter((z) => z.market === a.market && z.date === a.date);
		if (targets.length !== 1) {
			const have = [...new Set(zRows.filter((z) => z.market === a.market).map((z) => z.date))].slice(0, 5).join(", ") || "tidak ada";
			await upsertLog(env, { ...base, status: "MISSING", detail: targets.length ? `Baris ganda (${targets.length}x) untuk ${a.market} ${a.date} di Panel-Z — tidak diisi` : `Baris ${a.market} tanggal ${a.date} belum ada di Panel-Z (Panel-Z membuat baris tiap hari pukul 00:25) — diisi otomatis begitu baris muncul. Tanggal terbaca untuk pasaran ini: ${have}; total ${zRows.length} baris Toto Macau terbaca` }, buf);
			sum.missing++;
			buf.push(evStmt(env, website, "info", "WARN", `${a.market} ${a.date}: baris belum ada di Panel-Z → menunggu (admin ${a.number})`));
			continue;
		}
		const z = targets[0];
		const cur = curMap.get(`${a.game.game}|${a.period}`);
		if (cur?.status === "SENDING" && String(cur.updated_at) > tsPlusMinutes(-10)) continue; // putaran lain sedang mengirim baris ini
		if (z.filled && z.value === a.number) {
			await upsertLog(env, { ...base, status: cur?.status === "SENT" ? "SENT" : "VERIFIED", detail: cur?.status === "SENT" ? "Terkirim & terbaca di Panel-Z" : "Panel-Z sudah berisi angka yang sama" }, buf);
			sum.already++;
			buf.push(evStmt(env, website, "info", "OK", `${a.market} ${a.date}: sudah sama dengan admin (${a.number})`));
			continue;
		}
		const wrong = z.filled && z.value !== a.number; // angka admin dianggap benar: angka Panel-Z yang berbeda = salah
		if (wrong && !correctNow) {
			await upsertLog(env, { ...base, status: "CONFLICT", detail: `BEDA: Panel-Z berisi ${z.value}, admin ${a.number} — tidak ditimpa, cek manual` }, buf);
			sum.conflict++;
			buf.push(evStmt(env, website, "info", "ERR", `${a.market} ${a.date}: BEDA — Panel-Z ${z.value}, admin ${a.number} (tidak ditimpa)`));
			continue;
		}
		// baris ada & (kosong ATAU berisi angka salah yang harus dikoreksi)
		if (mode !== 2) {
			await upsertLog(env, { ...base, status: "PENDING", detail: "Belum terisi di Panel-Z (mode 1: belum dikirim)" }, buf);
			sum.pending++;
			buf.push(evStmt(env, website, "info", "INFO", `${a.market} ${a.date}: kosong, admin ${a.number} — mode 1, tidak dikirim`));
			continue;
		}
		let resetAttempts = false;
		if (cur?.status === "FAILED" && Number(cur.attempts) >= TOTO_MAX_ATTEMPTS) {
			if (String(cur.updated_at) > tsPlusMinutes(-60)) {
				sum.failed++;
				continue;
			}
			resetAttempts = true; // sudah >60 menit sejak gagal terakhir: baris masih kosong/salah -> mulai siklus percobaan baru
		} else if (wrong && (cur?.status === "SENT" || cur?.status === "VERIFIED") && Number(cur.attempts) >= TOTO_MAX_ATTEMPTS) {
			resetAttempts = true; // angka yang tadinya benar diubah orang lain: koreksi lagi (siklus baru; terlihat di log bila terus bolak-balik)
		}
		if (budget.used >= SUBREQ_BUDGET) {
			await upsertLog(env, { ...base, status: "PENDING", detail: "Antre — dikirim pada putaran berikutnya" }, buf);
			sum.pending++;
			sum.more = true;
			buf.push(evStmt(env, website, "info", "INFO", `${a.market} ${a.date}: antre — dikirim pada putaran berikutnya`));
			continue;
		}
		// klaim atomik: hanya satu putaran yang berhasil mengubah ke SENDING (upsert + klaim dalam satu batch)
		const pre: LogStmt[] = [];
		await upsertLog(env, { ...base, status: "PENDING", detail: "Mengirim ke Panel-Z…" }, pre);
		pre.push(evStmt(env, website, "info", "INFO", wrong ? `${a.market} ${a.date}: Panel-Z berisi ${z.value} ≠ admin ${a.number} → KOREKSI ke ${a.number}…` : `${a.market} ${a.date}: baris kosong → mengirim ${a.number} ke Panel-Z…`));
		if (resetAttempts) pre.push(db.prepare(`UPDATE toto_macau_log SET attempts = 0 WHERE website = ? AND game = ? AND period = ?`).bind(website, a.game.game, a.period));
		pre.push(
			db
				.prepare(`UPDATE toto_macau_log SET status = 'SENDING', attempts = attempts + 1, updated_at = ? WHERE website = ? AND game = ? AND period = ? AND status <> 'SENDING' AND attempts < ?`)
				.bind(tsNow(), website, a.game.game, a.period, TOTO_MAX_ATTEMPTS),
		);
		budget.used++;
		const claim = await db.batch(pre);
		if (claim[claim.length - 1].meta.changes !== 1) continue; // evStmt di batch yang sama tidak mengubah baris -> indeks terakhir tetap klaim
		budget.used++;
		const r = await panel.push(z.id, a.number);
		if (/Berhasil/i.test(r)) posted.push({ a, rowId: z.id, old: wrong ? z.value : "" });
		else {
			buf.push(db.prepare(`UPDATE toto_macau_log SET status = 'FAILED', detail = ?, updated_at = ? WHERE website = ? AND game = ? AND period = ?`).bind(("Panel-Z: " + r).slice(0, 300), tsNow(), website, a.game.game, a.period));
			await logActivity(env, reader, "TOTO MACAU AUTO", `[${website}] ${a.market} ${a.date} — Panel-Z: ${r}`, "GAGAL", `Angka: ${a.number}`).catch(() => {});
			sum.failed++;
			buf.push(evStmt(env, website, "info", "ERR", `${a.market} ${a.date}: gagal kirim ke Panel-Z — ${r}`));
		}
	}

	// Baca ulang Panel-Z: angka yang baru dikirim HARUS tampil di baris yang benar.
	if (posted.length) {
		budget.used += 2; // baca ulang halaman yang memuat baris terkirim (biasanya 1-2 halaman)
		let after: PanelZRow2[] = [];
		try {
			after = parsePanelZRows(await panel.reload(posted.map((x) => x.rowId)));
		} catch {
			after = [];
		}
		for (const { a, rowId, old } of posted) {
			const z = after.find((x) => x.id === rowId);
			const okRead = !!z && z.filled && z.value === a.number;
			buf.push(
				db
					.prepare(`UPDATE toto_macau_log SET status = ?, detail = ?, updated_at = ? WHERE website = ? AND game = ? AND period = ?`)
					.bind(okRead ? "SENT" : "FAILED", okRead ? (old ? `DIKOREKSI: Panel-Z berisi ${old}, diperbaiki ke angka admin ${a.number} & terverifikasi (dibaca ulang)` : "Terkirim ke Panel-Z & terverifikasi (dibaca ulang)") : "Terkirim tetapi angka belum tampil di baris Panel-Z — cek manual", tsNow(), website, a.game.game, a.period),
			);
			await logActivity(env, reader, "TOTO MACAU AUTO", `[${website}] ${a.market} ${a.date} — ${okRead ? "terkirim & terverifikasi di Panel-Z" : "terkirim tapi belum terbaca di Panel-Z"}`, okRead ? "BERHASIL" : "GAGAL", `Angka: ${a.number}`).catch(() => {});
			buf.push(evStmt(env, website, "info", okRead ? "OK" : "ERR", `${a.market} ${a.date}: ${okRead ? (old ? `DIKOREKSI ${old} → ${a.number} — terbaca ulang di Panel-Z` : `TERKIRIM ${a.number} — terbaca ulang di Panel-Z`) : `terkirim ${a.number} tetapi belum tampil di Panel-Z — cek manual`}`));
			if (okRead) {
				sum.posted++;
				if (old) sum.corrected++;
			} else sum.failed++;
		}
	}
	await flushLog(env, buf, budget);
}
type PanelZRow2 = ReturnType<typeof parsePanelZRows>[number];

async function passMark(env: Env, website: string): Promise<void> {
	const now = tsNow();
	await getTurso(env)
		.prepare(
			`INSERT INTO toto_macau_log (website, game, period, slot_key, status, created_at, updated_at) VALUES (?, 'pass', 0, '', 'PASS', ?, ?)
			 ON CONFLICT(website, game, period) DO UPDATE SET updated_at = excluded.updated_at`,
		)
		.bind(website, now, now)
		.run();
}

const HOT_MIN = 360; // baris yang menunggu (belum dibuat Panel-Z / belum terkirim) dipantau rapat selama 6 jam sejak pertama tercatat

/** Website yang punya baris menunggu/gagal dalam 6 jam terakhir -> dicek tiap 3 menit sampai beres (hanya bermakna di mode 2). */
async function hotWebsites(env: Env, mode: number): Promise<Set<string>> {
	if (mode < 2) return new Set();
	const res = await getTurso(env)
		.prepare(`SELECT DISTINCT website FROM toto_macau_log WHERE period > 0 AND status IN ('MISSING','PENDING','SENDING','FAILED') AND row_at >= ?`)
		.bind(tsPlusMinutes(-HOT_MIN))
		.all<{ website: string }>();
	return new Set((res.results ?? []).map((r) => String(r.website)));
}

/**
 * Dipanggil cron Cloudflare tiap menit: memicu workflow GitHub Actions (toto-macau.yml) sesuai jeda -- 3 menit bila ada draw baru (3..45 menit
 * setelah jam draw) atau ada baris yang masih menunggu, selain itu 30 menit. Jadwal `schedule` GitHub sendiri sering telat, jadi pemicu utama di sini.
 * Murah: 1 baca D1 pada tick biasa. true = workflow dipicu (tick ini memakai jatah subrequest).
 */
export async function totoDispatchTick(env: Env, dispatch: () => Promise<void>, nowMs: number = Date.now()): Promise<boolean> {
	const mode = await getSys(env, "sys_totomacau_mode");
	if (mode <= 0) return false;
	const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'toto_dispatch_at'`).first<{ value: string }>();
	const last = Number(row?.value || 0);
	if (nowMs - last < 3 * 60_000 - 20_000) return false;
	await ensureTables(env);
	const hot = (await hotWebsites(env, mode)).size > 0;
	const interval = (hot ? 3 : passIntervalMin(nowMs)) * 60_000;
	if (nowMs - last < interval - 20_000) return false;
	await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('toto_dispatch_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(nowMs)).run();
	try {
		await dispatch();
		await logTotoEvent(env, "", "info", "INFO", `Cron memicu GitHub Actions (${hot ? "ada baris menunggu" : interval <= 3 * 60_000 ? "ada draw baru" : "sapuan rutin"})`);
	} catch (e) {
		console.error("toto dispatch error", e instanceof Error ? e.message : e);
		await logTotoEvent(env, "", "info", "ERR", "Gagal memicu GitHub Actions: " + (e instanceof Error ? e.message : String(e)).slice(0, 200));
	}
	return true;
}

/**
 * Satu putaran rekonsiliasi. `only` = batasi ke username tertentu (tombol "Cek & Isi Sekarang"); `force` = abaikan jeda antar putaran.
 */
export async function totoMacauRun(env: Env, opts: { only?: string[]; exclude?: string[]; force?: boolean; maxSites?: number } & TotoDeps = {}): Promise<TotoSummary> {
	const sum: TotoSummary = { websites: 0, posted: 0, already: 0, pending: 0, conflict: 0, missing: 0, failed: 0, net: false, message: "", sites: [], more: false, corrected: 0 };
	const mode = await getSys(env, "sys_totomacau_mode");
	if (mode <= 0) {
		sum.message = "Auto Check Toto Macau dimatikan (Pengaturan Sistem).";
		return sum;
	}
	await ensureTables(env);
	const nowMs = opts.nowMs ?? Date.now();
	const f: Fetcher = opts.fetchFn ?? ((u, i) => fetch(u, i));
	const panel: PanelOpen = opts.panel ?? openPanelZ;
	const byWebsite = await candidates(env, opts.only);
	if (!byWebsite.size) {
		sum.message = "Tidak ada website yang memenuhi syarat (Auto Prediksi AKTIF, izin Panel-Z, menu Result, PHPSESSID tersimpan).";
		return sum;
	}
	const accounts = await getSiteAccounts(env, [...byWebsite.keys()]);
	// urutan: yang terakhir diperiksa paling lama didahulukan
	const db = getTurso(env);
	const marks = await db.prepare(`SELECT website, updated_at FROM toto_macau_log WHERE game = 'pass' AND period = 0`).all<{ website: string; updated_at: string }>();
	const last = new Map((marks.results ?? []).map((m) => [String(m.website), String(m.updated_at)]));
	const hot = await hotWebsites(env, mode);
	const baseInterval = passIntervalMin(nowMs);
	const due = [...byWebsite.keys()]
		.filter((w) => {
			const acc = accounts.get(w);
			return !!acc && !!acc.panelz.url && !!acc.panelz.user;
		})
		.filter((w) => !opts.exclude?.some((x) => x.toUpperCase() === w.toUpperCase()))
		.filter((w) => opts.force || !last.get(w) || last.get(w)! <= tsPlusMinutes(-(hot.has(w) ? 3 : baseInterval)))
		.sort((x, y) => (last.get(x) ?? "").localeCompare(last.get(y) ?? ""))
		.slice(0, opts.maxSites ?? 4);
	const correct = mode === 2 && (await getSys(env, "sys_totomacau_correct")) === 1;
	const lookback = await getSys(env, "sys_totomacau_lookback_days");
	const maxCorrect = await getSys(env, "sys_totomacau_max_correct");
	const budget = { used: 0 };
	for (const website of due) {
		if (budget.used >= SUBREQ_BUDGET) break;
		sum.websites++;
		sum.sites.push(website);
		const before = { ...sum };
		await logTotoEvent(env, website, "start", "INFO", `Mulai memeriksa ${website} (${opts.force ? "diminta manual" : "terjadwal"}, mode ${mode})`);
		await passMark(env, website);
		let crashed = "";
		try {
			await reconcileWebsite(env, website, byWebsite.get(website)!, accounts.get(website)!.panelz, mode, { f, panel, nowMs, correct, lookback, maxCorrect }, budget, sum);
		} catch (e) {
			crashed = e instanceof Error ? e.message : String(e);
		}
		const d = (k: "posted" | "already" | "pending" | "conflict" | "missing" | "failed"): number => sum[k] - before[k];
		await logTotoEvent(
			env,
			website,
			"end",
			crashed || d("failed") || d("conflict") ? "ERR" : d("posted") ? "OK" : "INFO",
			crashed ? `Berhenti karena galat: ${crashed}` : `Selesai ${website}: ${d("posted")} dikirim (${sum.corrected - before.corrected} dikoreksi), ${d("already")} sudah ada, ${d("pending")} belum terisi, ${d("missing")} menunggu baris, ${d("conflict")} beda, ${d("failed")} gagal`,
		);
	}
	sum.message = sum.websites
		? `${sum.websites} website diperiksa: ${sum.posted} dikirim (${sum.corrected} dikoreksi), ${sum.already} sudah ada, ${sum.pending} belum terisi, ${sum.conflict} beda, ${sum.missing} baris tidak ada, ${sum.failed} gagal.`
		: "Belum waktunya putaran berikutnya.";
	return sum;
}

/** Dipanggil cron tiap menit. true = ada panggilan jaringan. */
export async function totoMacauTick(env: Env, deps: TotoDeps = {}): Promise<boolean> {
	return (await totoMacauRun(env, deps)).net;
}
