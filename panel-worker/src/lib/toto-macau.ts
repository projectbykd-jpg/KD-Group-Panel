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
import { sendCustomPanelZ } from "../senders/panelz";
import { logActivity } from "./activity";

export interface TotoGame {
	game: "m17" | "m51";
	path: string;
	title: RegExp;
	digits: number;
	/** jam (WIB) baris di tabel -> nama pasaran Panel-Z (lihat MARKET_TO_PANEL di parser.ts) */
	slots: Record<number, string>;
}
export const TOTO_GAMES: TotoGame[] = [
	{
		game: "m17",
		path: "admin_angka.php?sar=m17&game=Toto%20Macau",
		title: /Daftar\s+Nomor\s+Toto\s+Macau\b/i,
		digits: 4,
		slots: { 0: "TOTOMACAU-00", 13: "TOTOMACAU-13", 16: "TOTOMACAU-16", 19: "TOTOMACAU-19", 22: "TOTOMACAU-22", 23: "TOTOMACAU-23" },
	},
	{
		game: "m51",
		path: "admin_angka.php?sar=m51&game=Toto%20Macao%205D",
		title: /Daftar\s+Nomor\s+Toto\s+Macao\s+5D\b/i,
		digits: 5,
		slots: { 15: "TOTOMACAU-15-5D", 21: "TOTOMACAU-21-5D" },
	},
];

export const TOTO_FRESH_MIN = 120; // hanya baris yang terbit <= 2 jam lalu
export const TOTO_MAX_ATTEMPTS = 3; // percobaan kirim ke Panel-Z per draw
const READ_BUDGET = 8; // maks halaman admin dibaca per tick (batas 50 subrequest/invocation)

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
		.prepare(`SELECT * FROM toto_macau_log WHERE website IN (${ws.map(() => "?").join(",")}) AND created_at >= ? AND period > 0 ORDER BY id DESC LIMIT 200`)
		.bind(...ws, from)
		.all<Record<string, unknown>>();
	return (res.results ?? []).map(toLog);
}

/** Peringatan terakhir: draw GAGAL (percobaan habis) / sesi semua website habis, dalam 6 jam terakhir, belum pernah ditampilkan. */
export async function pendingTotoAlerts(env: Env, websites: string[]): Promise<TotoLogRow[]> {
	await ensureTables(env);
	const ws = [...new Set(websites.map((w) => String(w).trim().toUpperCase()).filter(Boolean))];
	if (!ws.length) return [];
	const res = await getTurso(env)
		.prepare(
			`SELECT * FROM toto_macau_log WHERE website IN (${ws.map(() => "?").join(",")}) AND status = 'FAILED' AND attempts >= ? AND alerted = 0 AND created_at >= ? ORDER BY id ASC LIMIT 20`,
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
// Tick
// ---------------------------------------------------------------------------
export interface TotoDeps {
	fetchFn?: Fetcher;
	send?: (market: string, number: string, cfg: PanelZCfg) => Promise<string>;
	nowMs?: number;
}

/** Tanggal (WIB) slot jam `hour` yang sedang dicek: bila jam itu belum lewat hari ini berarti slot kemarin (mis. jam 23 dicek pukul 00:05). */
export function slotDate(nowMs: number, hour: number): string {
	const d = new Date(nowMs + 7 * 3600_000);
	const minOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
	return new Date(d.getTime() - (hour * 60 > minOfDay ? 24 * 3600_000 : 0)).toISOString().slice(0, 10);
}

/** Game yang sedang "jatuh tempo": ada jam draw yang terlewat 3..110 menit lalu (WIB). */
export function dueGames(nowMs: number): { game: TotoGame; hour: number }[] {
	const d = new Date(nowMs + 7 * 3600_000);
	const minOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
	const out: { game: TotoGame; hour: number }[] = [];
	for (const g of TOTO_GAMES) {
		for (const hs of Object.keys(g.slots)) {
			const h = Number(hs);
			let diff = minOfDay - h * 60;
			if (diff < 0) diff += 24 * 60; // jam 00 setelah tengah malam / draw kemarin
			// 3..40 menit setelah jam draw: tiap menit (angka admin biasanya terbit ±10 menit setelah jam); sesudahnya tiap 5 menit sampai 110.
			if (diff >= 3 && diff <= 110 && (diff <= 40 || d.getUTCMinutes() % 5 === 0)) out.push({ game: g, hour: h });
		}
	}
	return out;
}

type Cand = { username: string; sess: AdminSession };

/**
 * Satu putaran. Return true bila melakukan panggilan jaringan (supaya pemanggil melewatkan pump lain pada tick yang sama).
 */
export async function totoMacauTick(env: Env, deps: TotoDeps = {}): Promise<boolean> {
	const mode = await getSys(env, "sys_totomacau_mode");
	if (mode <= 0) return false;
	const nowMs = deps.nowMs ?? Date.now();
	const due = dueGames(nowMs);
	if (!due.length) return false;
	await ensureTables(env);
	const f: Fetcher = deps.fetchFn ?? ((u, i) => fetch(u, i));
	const send = deps.send ?? sendCustomPanelZ;
	const db = getTurso(env);

	// Kandidat: user yang fiturnya aktif + izin Panel-Z + menu Result (aturan yang sama dengan KIRIM KE PANEL-Z di menu Result).
	const en = await db.prepare(`SELECT username FROM auto_input_config WHERE enabled = 1 ORDER BY username`).all<{ username: string }>();
	const names = (en.results ?? []).map((r) => String(r.username));
	if (!names.length) return false;
	const profiles = await getUserProfiles(env, names);
	const byWebsite = new Map<string, Cand[]>();
	for (const u of names) {
		const p = profiles.get(u.toLowerCase());
		if (!p || p.status !== "AKTIF") continue;
		if (p.role !== "ADMIN" && p.role !== "OPERATOR") continue;
		if (!p.permissions.panelz || !hasMenu(p, "result") || !hasMenu(p, "auto-input")) continue;
		for (const s of await getSessions(env, p.username)) {
			if (!s.phpsessid || !p.websites.includes(s.website)) continue;
			(byWebsite.get(s.website) ?? byWebsite.set(s.website, []).get(s.website)!).push({ username: p.username, sess: s });
		}
	}
	if (!byWebsite.size) return false;
	const accounts = await getSiteAccounts(env, [...byWebsite.keys()]);

	let reads = 0;
	let net = false;
	const nowTs = tsNow();
	for (const [website, cands] of byWebsite) {
		const acc = accounts.get(website);
		if (!acc || !acc.panelz.url || !acc.panelz.user) continue; // tanpa Panel-Z tidak ada yang bisa diposting
		for (const { game, hour } of due) {
			if (reads >= READ_BUDGET) return net;
			// Sudah ada catatan terkirim/tercatat untuk slot jam ini hari ini? (cek murah sebelum membuka halaman admin)
			const dayKey = slotDate(nowMs, hour);
			const slotKey = `${dayKey} ${String(hour).padStart(2, "0")}`;
			const have = await db
				.prepare(`SELECT status, attempts FROM toto_macau_log WHERE website = ? AND game = ? AND slot_key = ? AND period > 0`)
				.bind(website, game.game, slotKey)
				.first<{ status: string; attempts: number }>();
			if (have) {
				const done = have.status === "SENT" || have.status === "SKIPPED" || (have.status === "RECORDED" && mode === 1) || (have.status === "FAILED" && Number(have.attempts) >= TOTO_MAX_ATTEMPTS);
				if (done) continue;
			}

			// Sesi/halaman sudah gagal berulang untuk slot ini -> jangan dihantam tiap menit; coba lagi tiap 10 menit.
			const pseudoKey = -Number(slotKey.replace(/\D/g, "")) || -1;
			const bad = await db
				.prepare(`SELECT attempts, updated_at FROM toto_macau_log WHERE website = ? AND game = ? AND period = ?`)
				.bind(website, game.game, pseudoKey)
				.first<{ attempts: number; updated_at: string }>();
			if (bad && Number(bad.attempts) >= TOTO_MAX_ATTEMPTS && String(bad.updated_at) > tsPlusMinutes(-10)) continue;

			// Baca halaman admin dengan sesi user pertama yang masih hidup.
			let html = "";
			let reader = "";
			let lastErr = "";
			for (const c of cands) {
				reads++;
				net = true;
				try {
					html = await adminReq(f, c.sess, game.path);
					reader = c.username;
					break;
				} catch (e) {
					lastErr = e instanceof Error ? e.message : String(e);
				}
			}
			if (!reader) {
				await recordSessionFailure(env, website, game, slotKey, cands[0].username, `Sesi admin ${website} habis atau halaman tidak bisa dibuka — tempel PHPSESSID baru di menu Auto Prediksi (${lastErr})`);
				continue;
			}
			if (!game.title.test(htmlText(html))) {
				await recordSessionFailure(env, website, game, slotKey, reader, "Halaman yang terbuka bukan daftar nomor game ini (bentuk halaman berubah?).");
				continue;
			}
			const rows = parseTotoRows(html).slice(0, 4);
			if (!rows.length) {
				await recordSessionFailure(env, website, game, slotKey, reader, "Tabel angka tidak terbaca (bentuk halaman berubah?).");
				continue;
			}
			for (const row of rows.reverse()) {
				if (row.hour !== hour) continue; // baris ini bukan slot yang sedang dicek (slot lain ditangani putarannya sendiri)
				if (ageMin(row, nowMs) > TOTO_FRESH_MIN || ageMin(row, nowMs) < -5) continue;
				await handleRow({ env, db, website, game, row, reader, acc: acc.panelz, mode, send, nowTs });
			}
		}
	}
	return net;
}

async function recordSessionFailure(env: Env, website: string, game: TotoGame, slotKey: string, username: string, why: string): Promise<void> {
	// periode negatif = catatan "gagal baca" per slot (unik per slot, tidak bentrok dengan periode asli)
	const pseudo = -Number(slotKey.replace(/\D/g, "")) || -1;
	const now = tsNow();
	const db = getTurso(env);
	const r = await db
		.prepare(
			`INSERT INTO toto_macau_log (website, game, period, slot_key, market, number, row_at, status, attempts, username, detail, created_at, updated_at)
			 VALUES (?, ?, ?, ?, '', '', '', 'FAILED', 1, ?, ?, ?, ?)
			 ON CONFLICT(website, game, period) DO UPDATE SET attempts = attempts + 1, detail = excluded.detail, updated_at = excluded.updated_at`,
		)
		.bind(website, game.game, pseudo, slotKey, username, why.slice(0, 300), now, now)
		.run();
	void r;
	const row = await db.prepare(`SELECT attempts FROM toto_macau_log WHERE website = ? AND game = ? AND period = ?`).bind(website, game.game, pseudo).first<{ attempts: number }>();
	if (Number(row?.attempts) === TOTO_MAX_ATTEMPTS) {
		await logActivity(env, username, "TOTO MACAU AUTO", `[${website}] ${game.game} gagal dibaca: ${why}`, "GAGAL", "").catch(() => {});
	}
}

async function handleRow(a: {
	env: Env;
	db: ReturnType<typeof getTurso>;
	website: string;
	game: TotoGame;
	row: TotoRow;
	reader: string;
	acc: PanelZCfg;
	mode: number;
	send: NonNullable<TotoDeps["send"]>;
	nowTs: string;
}): Promise<void> {
	const { env, db, website, game, row, reader, acc, mode, send } = a;
	const market = game.slots[row.hour];
	const slotKey = `${row.date} ${String(row.hour).padStart(2, "0")}`;
	const now = tsNow();
	const log = async (status: string, detail: string, attempts = 0): Promise<void> => {
		await db
			.prepare(`UPDATE toto_macau_log SET status = ?, detail = ?, attempts = ?, username = ?, updated_at = ? WHERE website = ? AND game = ? AND period = ?`)
			.bind(status, detail.slice(0, 300), attempts, reader, now, website, game.game, row.period)
			.run();
	};
	const activity = (status: string, detail: string) => logActivity(env, reader, "TOTO MACAU AUTO", `[${website}] ${market} periode ${row.period} — ${detail}`, status, `Angka: ${row.number}`).catch(() => {});

	if (row.hitung !== "yes") return; // belum dihitung admin -> tunggu tick berikutnya (tidak diklaim)
	const bad = !market ? `jam ${row.hour} bukan jam draw yang dikenal` : !new RegExp(`^\\d{${game.digits}}$`).test(row.number) ? `angka "${row.number}" bukan ${game.digits} digit` : "";

	// Klaim atomik: baris unik (website, game, periode) -> tidak pernah diproses dobel walau tick tumpang tindih.
	const ins = await db
		.prepare(
			`INSERT OR IGNORE INTO toto_macau_log (website, game, period, slot_key, market, number, row_at, status, attempts, username, detail, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
		)
		.bind(website, game.game, row.period, slotKey, market ?? "", row.number, `${row.date} ${row.time}`, bad ? "SKIPPED" : "RECORDED", reader, bad ? "Dilewati: " + bad : "Tercatat", now, now)
		.run();
	const fresh = ins.meta.changes > 0;
	if (bad) {
		if (fresh) await activity("GAGAL", "dilewati: " + bad);
		return;
	}
	const cur = await db
		.prepare(`SELECT status, attempts FROM toto_macau_log WHERE website = ? AND game = ? AND period = ?`)
		.bind(website, game.game, row.period)
		.first<{ status: string; attempts: number }>();
	if (!cur) return;
	if (fresh && mode === 1) {
		await activity("INFO", `terbaca ${row.number} (mode catat saja, belum dikirim ke Panel-Z)`);
		return;
	}
	if (mode !== 2) return;
	if (cur.status === "SENT" || cur.status === "SKIPPED") return;
	if (cur.status === "FAILED" && Number(cur.attempts) >= TOTO_MAX_ATTEMPTS) return;

	// Klaim kirim: hanya satu pemanggil yang berhasil mengubah RECORDED/FAILED(<3) menjadi SENDING.
	const claim = await db
		.prepare(`UPDATE toto_macau_log SET status = 'SENDING', attempts = attempts + 1, updated_at = ? WHERE website = ? AND game = ? AND period = ? AND status IN ('RECORDED','FAILED') AND attempts < ?`)
		.bind(now, website, game.game, row.period, TOTO_MAX_ATTEMPTS)
		.run();
	if (claim.meta.changes !== 1) return;
	const attempts = Number(cur.attempts) + 1;
	const r = await send(market!, row.number, acc);
	if (/Berhasil/i.test(r)) {
		await log("SENT", "Terkirim ke Panel-Z", attempts);
		await activity("BERHASIL", `terkirim ke Panel-Z (${row.number})`);
	} else {
		await log("FAILED", r, attempts);
		await activity("GAGAL", `Panel-Z: ${r}` + (attempts >= TOTO_MAX_ATTEMPTS ? " — percobaan habis, CEK MANUAL" : " — dicoba lagi"));
	}
}
