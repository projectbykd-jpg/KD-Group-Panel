// Notifikasi admin ke Telegram (grup Notifikasi Galat di Admin > Integrasi) -- SATU antrean untuk semua kejadian penting,
// supaya tidak ada yang hilang diam-diam:
//  - galat Error & Bug yang tertahan jeda minimum (dulu DIBUANG, sekarang dikirim sebagai ringkasan begitu jeda lewat)
//  - galat latar (cron / Toto / Auto Prediksi) -- dulu tidak pernah ke Telegram
//  - Auto Prediksi GAGAL final (percobaan ulang habis), Toto Macau GAGAL final / BEDA ANGKA, Auto Posting prediksi
//    gagal ke grup website setelah percobaan habis, channel Telegram berhenti posting
//  - laporan harian (ringkasan kemarin) sekali sehari
// Setiap kejadian punya kunci unik (dedupe) -> dikirim tepat sekali. Antrean dikirim tiap tick cron 5 menit, digabung
// dalam satu pesan (dipotong < 4096 karakter). Telegram gagal -> dicoba lagi tick berikutnya (maks 5x), tidak dibuang diam-diam.
// Tiap kategori bisa dimatikan di Admin > Pengaturan Sistem > Notifikasi Telegram Admin (1 = kirim, 0 = mati).
import { getSys } from "./settings";
import { alertTgCfg, loadIntegrations } from "./integrations";
import { deliverAlert } from "./error-log";
import { getTurso } from "./turso";
import { tsNow, tsPlusMinutes } from "./time";
import { TOTO_MAX_ATTEMPTS } from "./toto-macau";

export type NotifyKind = "err" | "err-bg" | "autopost" | "autoinput" | "toto" | "channel" | "daily";

/** Kategori -> pengaturan on/off di Admin > Pengaturan Sistem. */
export const NOTIFY_TOGGLE: Record<NotifyKind, string> = {
	err: "sys_tgn_err_block",
	"err-bg": "sys_tgn_err_bg",
	autopost: "sys_tgn_autopost",
	autoinput: "sys_tgn_autoinput",
	toto: "sys_tgn_toto",
	channel: "sys_tgn_channel",
	daily: "sys_tgn_daily",
};
const KIND_TITLE: Record<NotifyKind, string> = {
	err: "⚠️ Error (menghambat user)",
	"err-bg": "🛠 Error latar (cron / proses otomatis)",
	autopost: "📤 Auto Posting prediksi GAGAL",
	autoinput: "🎯 Auto Prediksi GAGAL (percobaan habis)",
	toto: "🎰 Toto Macau perlu dicek",
	channel: "📢 Channel Telegram berhenti posting",
	daily: "📊 Laporan harian",
};
const ORDER: NotifyKind[] = ["err", "autopost", "autoinput", "toto", "channel", "err-bg", "daily"];
const MAX_TRIES = 5;
const MSG_LIMIT = 3800; // Telegram 4096, sisakan ruang header

// per database (bukan flag global): tiap D1 baru -- mis. di tes -- tetap dibuatkan tabelnya
let ready = new WeakSet<object>();
export function resetAdminNotifyGuard(): void {
	ready = new WeakSet<object>();
}
async function ensureTable(env: Env): Promise<void> {
	if (ready.has(env.DB)) return;
	await env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS admin_notify (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			nkey TEXT NOT NULL UNIQUE,
			kind TEXT NOT NULL,
			text TEXT NOT NULL,
			created_at TEXT NOT NULL,
			sent_at TEXT NOT NULL DEFAULT '',
			tries INTEGER NOT NULL DEFAULT 0
		)`,
	).run();
	await env.DB.prepare(`CREATE INDEX IF NOT EXISTS ix_admin_notify_pending ON admin_notify (sent_at, id)`).run();
	ready.add(env.DB);
}

export async function notifyEnabled(env: Env, kind: NotifyKind): Promise<boolean> {
	return (await getSys(env, NOTIFY_TOGGLE[kind])) === 1;
}

/** Masukkan kejadian ke antrean (sekali per kunci). Tidak pernah melempar. Mengembalikan true bila baru masuk. */
export async function enqueueNotify(env: Env, kind: NotifyKind, key: string, text: string): Promise<boolean> {
	try {
		if (!(await notifyEnabled(env, kind))) return false;
		// Telegram admin belum diatur -> jangan menumpuk (kalau tidak, begitu Token diisi grup dibanjiri kejadian berhari-hari);
		// kejadiannya tetap terlihat di panel (Error & Bug, Auto Prediksi, Riwayat).
		await loadIntegrations(env);
		const c = alertTgCfg();
		if (!c.token || !c.chatId) return false;
		await ensureTable(env);
		const r = await env.DB.prepare(`INSERT OR IGNORE INTO admin_notify (nkey, kind, text, created_at) VALUES (?, ?, ?, ?)`)
			.bind(String(key).slice(0, 300), kind, String(text).slice(0, 700), tsNow())
			.run();
		return (r.meta?.changes ?? 0) > 0;
	} catch {
		return false;
	}
}

interface Pending { id: number; kind: NotifyKind; text: string; tries: number }

/** Susun pesan dari item antrean: dikelompokkan per kategori, dipotong rapi agar < batas Telegram. */
export function buildDigest(items: Pending[]): { text: string; ids: number[] } {
	const ids: number[] = [];
	let out = "🔔 KD-Group Panel — notifikasi";
	for (const kind of ORDER) {
		const group = items.filter((i) => i.kind === kind);
		if (!group.length) continue;
		const head = `\n\n${KIND_TITLE[kind]}${group.length > 1 ? ` (${group.length})` : ""}`;
		if (out.length + head.length > MSG_LIMIT) break;
		out += head;
		for (const it of group) {
			const line = kind === "daily" ? "\n" + it.text : "\n• " + it.text;
			if (out.length + line.length > MSG_LIMIT) break;
			out += line;
			ids.push(it.id);
		}
	}
	return { text: out, ids };
}

/** Galat Error & Bug menghormati jeda minimum (Pengaturan Sistem); kategori lain langsung dikirim. */
async function errGapOpen(env: Env): Promise<boolean> {
	const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'errlog_alert_at'`).first<{ value: string }>();
	return Date.now() - Number(row?.value || 0) >= (await getSys(env, "sys_errorlog_alert_gap_min")) * 60_000;
}

/** Kirim antrean. Dipanggil cron tiap 5 menit. Mengembalikan jumlah item terkirim. */
export async function flushNotify(env: Env): Promise<number> {
	await ensureTable(env);
	await loadIntegrations(env);
	const cfg = alertTgCfg();
	if (!cfg.token || !cfg.chatId) return 0; // belum diatur: tetap di antrean, terkirim begitu Token & Chat ID diisi
	const rows = await env.DB.prepare(`SELECT id, kind, text, tries FROM admin_notify WHERE sent_at = '' ORDER BY id ASC LIMIT 60`).all<Pending>();
	let items = (rows.results ?? []).map((r) => ({ ...r, id: Number(r.id), tries: Number(r.tries) }));
	if (!items.length) return 0;
	const gapOpen = await errGapOpen(env);
	if (!gapOpen) items = items.filter((i) => i.kind !== "err" && i.kind !== "err-bg");
	if (!items.length) return 0;
	const { text, ids } = buildDigest(items);
	if (!ids.length) return 0;
	const sentErr = items.some((i) => ids.includes(i.id) && (i.kind === "err" || i.kind === "err-bg"));
	const { result } = await deliverAlert(env, text);
	const ph = ids.map(() => "?").join(",");
	if (result === "Terkirim") {
		await env.DB.prepare(`UPDATE admin_notify SET sent_at = ? WHERE id IN (${ph})`).bind(tsNow(), ...ids).run();
		if (sentErr) {
			await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('errlog_alert_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
				.bind(String(Date.now()))
				.run();
		}
		return ids.length;
	}
	// gagal: hitung percobaan; setelah MAX_TRIES ditandai GAGAL (tetap terlihat di tabel, tidak dikirim berulang selamanya)
	await env.DB.prepare(`UPDATE admin_notify SET tries = tries + 1 WHERE id IN (${ph})`).bind(...ids).run();
	await env.DB.prepare(`UPDATE admin_notify SET sent_at = 'GAGAL' WHERE sent_at = '' AND tries >= ?`).bind(MAX_TRIES).run();
	return 0;
}

// ---------------------------------------------------------------------------
// Pemindai: kegagalan FINAL Auto Prediksi & Toto Macau (sebelumnya hanya popup di panel, tidak ke Telegram)
// ---------------------------------------------------------------------------
let scanCols = false;
export function resetNotifyScanGuard(): void {
	scanCols = false;
}
async function ensureScanCols(env: Env): Promise<void> {
	if (scanCols) return;
	const db = getTurso(env);
	for (const t of ["auto_input_job", "toto_macau_log"]) {
		try {
			await db.prepare(`ALTER TABLE ${t} ADD COLUMN tg_sent INTEGER NOT NULL DEFAULT 0`).run();
		} catch (e) {
			const m = e instanceof Error ? e.message : String(e);
			if (!/duplicate column|no such table/i.test(m)) throw e;
		}
	}
	scanCols = true;
}

export async function scanFinalFailures(env: Env): Promise<number> {
	const wantAi = await notifyEnabled(env, "autoinput");
	const wantToto = await notifyEnabled(env, "toto");
	if (!wantAi && !wantToto) return 0;
	await ensureScanCols(env);
	const db = getTurso(env);
	const since = tsPlusMinutes(-6 * 60); // hanya kejadian baru; riwayat lama tidak membanjiri saat fitur pertama aktif
	let n = 0;
	if (wantAi) {
		const max = await getSys(env, "sys_auto_input_retry_max");
		const r = await db
			.prepare(`SELECT id, website, market, stage, detail, attempts FROM auto_input_job WHERE status = 'FAILED' AND hidden = 0 AND attempts >= ? AND tg_sent = 0 AND updated_at >= ? ORDER BY id ASC LIMIT 20`)
			.bind(max, since)
			.all<Record<string, unknown>>()
			.catch(() => ({ results: [] as Record<string, unknown>[] }));
		const ids: number[] = [];
		for (const j of r.results ?? []) {
			const txt = `${j.website} · ${j.market}: ${String(j.detail || "gagal").slice(0, 200)} (tahap ${j.stage || "-"}, ${j.attempts}x dicoba ulang) — input manual di admin website.`;
			if (await enqueueNotify(env, "autoinput", `ai:${j.id}`, txt)) n++;
			ids.push(Number(j.id));
		}
		if (ids.length) await db.prepare(`UPDATE auto_input_job SET tg_sent = 1 WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
	}
	if (wantToto) {
		const r = await db
			.prepare(`SELECT id, website, game, market, number, status, detail, attempts, row_at FROM toto_macau_log WHERE ((status = 'FAILED' AND attempts >= ?) OR status = 'CONFLICT') AND tg_sent = 0 AND updated_at >= ? ORDER BY id ASC LIMIT 20`)
			.bind(TOTO_MAX_ATTEMPTS, since)
			.all<Record<string, unknown>>()
			.catch(() => ({ results: [] as Record<string, unknown>[] }));
		const ids: number[] = [];
		for (const t of r.results ?? []) {
			const market = String(t.market || (t.game === "m51" ? "TOTO MACAO 5D" : "TOTO MACAU"));
			const what = t.status === "CONFLICT" ? "BEDA ANGKA" : "GAGAL";
			const txt = `${t.website} · ${market} ${String(t.row_at || "").slice(0, 16)} [${what}]${t.number ? " angka admin " + t.number : ""}: ${String(t.detail || "").slice(0, 200)}`;
			if (await enqueueNotify(env, "toto", `toto:${t.id}:${t.status}`, txt)) n++;
			ids.push(Number(t.id));
		}
		if (ids.length) await db.prepare(`UPDATE toto_macau_log SET tg_sent = 1 WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
	}
	return n;
}

// ---------------------------------------------------------------------------
// Laporan harian: ringkasan KEMARIN (WIB), dikirim sekali setelah jam yang diatur admin
// ---------------------------------------------------------------------------
function wibNow(nowMs: number): { date: string; hour: number } {
	const d = new Date(nowMs + 7 * 3600_000);
	return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}
function yesterday(date: string): string {
	return new Date(Date.parse(date + "T00:00:00Z") - 86400_000).toISOString().slice(0, 10);
}
async function safe(label: string, fn: () => Promise<string>): Promise<string> {
	try {
		return await fn();
	} catch {
		return `${label}: tidak terbaca`;
	}
}
const cnt = (rows: { s: string; n: number }[] | undefined, s: string) => Number((rows ?? []).find((r) => String(r.s) === s)?.n ?? 0);

export async function buildDailyReport(env: Env, day: string): Promise<string> {
	const db = getTurso(env);
	const tursoOn = !!(String(env.TURSO_URL ?? "").trim() && String(env.TURSO_TOKEN ?? "").trim());
	const lines: string[] = [`Tanggal ${day} (WIB)`];
	lines.push(
		await safe("Auto Posting prediksi", async () => {
			const r = await env.DB.prepare(`SELECT status AS s, COUNT(*) AS n FROM prediction_registry WHERE date_key = ? GROUP BY status`).bind(day).all<{ s: string; n: number }>();
			const ok = cnt(r.results, "BERHASIL"), bad = cnt(r.results, "GAGAL");
			return `📤 Auto Posting prediksi: ${ok} terkirim${bad ? `, ${bad} GAGAL` : ""}`;
		}),
	);
	if (tursoOn) {
		lines.push(
			await safe("Auto Prediksi", async () => {
				const r = await db.prepare(`SELECT status AS s, COUNT(*) AS n FROM auto_input_job WHERE substr(created_at,1,10) = ? GROUP BY status`).bind(day).all<{ s: string; n: number }>();
				const done = cnt(r.results, "DONE"), fail = cnt(r.results, "FAILED"), skip = cnt(r.results, "SKIPPED");
				return `🎯 Auto Prediksi: ${done} berhasil${fail ? `, ${fail} GAGAL` : ""}${skip ? `, ${skip} dilewati` : ""}`;
			}),
		);
		lines.push(
			await safe("Toto Macau", async () => {
				const r = await db.prepare(`SELECT status AS s, COUNT(*) AS n FROM toto_macau_log WHERE period > 0 AND substr(row_at,1,10) = ? GROUP BY status`).bind(day).all<{ s: string; n: number }>();
				const ok = cnt(r.results, "SENT") + cnt(r.results, "VERIFIED");
				const fail = cnt(r.results, "FAILED"), conf = cnt(r.results, "CONFLICT");
				const wait = cnt(r.results, "MISSING") + cnt(r.results, "PENDING") + cnt(r.results, "SENDING");
				return `🎰 Toto Macau: ${ok} terisi/terverifikasi${fail ? `, ${fail} GAGAL` : ""}${conf ? `, ${conf} BEDA ANGKA` : ""}${wait ? `, ${wait} masih menunggu` : ""}`;
			}),
		);
		lines.push(
			await safe("Channel Telegram", async () => {
				const r = await db.prepare(`SELECT COUNT(*) AS n FROM news_article WHERE tg_posted_at LIKE ?`).bind(day + "%").first<{ n: number }>();
				return `📢 Channel Telegram: ${Number(r?.n ?? 0)} posting`;
			}),
		);
	}
	lines.push(
		await safe("Error & Bug", async () => {
			const r = await env.DB.prepare(
				`SELECT SUM(CASE WHEN status = 'open' AND impact = 'blocking' THEN 1 ELSE 0 END) AS ob,
				        SUM(CASE WHEN status = 'open' AND impact != 'blocking' THEN 1 ELSE 0 END) AS og,
				        SUM(CASE WHEN substr(first_at,1,10) = ? THEN 1 ELSE 0 END) AS nw
				 FROM error_log`,
			).bind(day).first<{ ob: number; og: number; nw: number }>();
			return `🐞 Error & Bug: ${Number(r?.nw ?? 0)} galat baru kemarin; terbuka sekarang ${Number(r?.ob ?? 0)} menghambat, ${Number(r?.og ?? 0)} latar`;
		}),
	);
	return lines.join("\n");
}

/** Antre laporan harian sekali per hari setelah jam yang diatur (bawaan 07 WIB). */
export async function queueDailyReport(env: Env, nowMs = Date.now()): Promise<boolean> {
	if (!(await notifyEnabled(env, "daily"))) return false;
	const { date, hour } = wibNow(nowMs);
	if (hour < (await getSys(env, "sys_tgn_daily_hour"))) return false;
	await ensureTable(env);
	const key = "daily:" + date;
	const has = await env.DB.prepare(`SELECT 1 AS x FROM admin_notify WHERE nkey = ?`).bind(key).first();
	if (has) return false;
	return enqueueNotify(env, "daily", key, await buildDailyReport(env, yesterday(date)));
}

/** Satu tick cron 5 menit: pindai kegagalan final, antre laporan harian, lalu kirim antrean. */
export async function adminNotifyTick(env: Env): Promise<number> {
	await scanFinalFailures(env).catch(() => 0);
	await queueDailyReport(env).catch(() => false);
	return flushNotify(env);
}

/** Retensi antrean: terkirim/gagal disimpan 14 hari; yang tak terkirim lebih dari 3 hari dibuang. */
export async function pruneAdminNotify(env: Env): Promise<void> {
	await ensureTable(env);
	await env.DB.prepare(`DELETE FROM admin_notify WHERE sent_at != '' AND created_at < ?`).bind(tsPlusMinutes(-14 * 24 * 60)).run();
	// belum terkirim > 3 hari (mis. Telegram mati lama): kabar basi, buang daripada membanjiri saat pulih
	await env.DB.prepare(`DELETE FROM admin_notify WHERE sent_at = '' AND created_at < ?`).bind(tsPlusMinutes(-3 * 24 * 60)).run();
}
