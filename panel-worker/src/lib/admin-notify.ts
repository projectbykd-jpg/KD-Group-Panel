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
import { ensureColumns } from "./turso-schema";
import { ensureAutoInputTables } from "./auto-input";
import { tsNow, tsPlusMinutes } from "./time";
import { TOTO_MAX_ATTEMPTS } from "./toto-macau";
import { finalFailureSql, RETRY_WINDOW_MIN } from "./auto-input";

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
	err: "⚠️ Error — menghambat user",
	"err-bg": "🛠 Error latar",
	autopost: "📤 Auto Posting prediksi gagal",
	autoinput: "🎯 Auto Prediksi gagal — input manual",
	toto: "🎰 Toto Macau perlu dicek",
	channel: "📢 Channel Telegram berhenti posting",
	daily: "",
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

/** Isi satu kejadian. r = alasan (kejadian dengan alasan sama digabung jadi satu blok), m = kelompok di dalam alasan
 *  (mis. pasaran), s = subjek (mis. website), t = teks bebas, html = isi HTML yang sudah aman (hanya laporan harian). */
export interface NotifyItem { r?: string; m?: string; s?: string; t?: string; html?: string }

const cut = (v: unknown, n: number) => (v == null ? undefined : String(v).slice(0, n));
function encodeItem(it: string | NotifyItem): string {
	if (typeof it === "string") return JSON.stringify({ t: it.slice(0, 700) });
	return JSON.stringify({ r: cut(it.r, 300), m: cut(it.m, 80), s: cut(it.s, 200), t: cut(it.t, 700), html: cut(it.html, 3000) });
}
export function decodeItem(text: string): NotifyItem {
	try {
		const o = JSON.parse(text);
		if (o && typeof o === "object") return o as NotifyItem;
	} catch {
		/* teks lama (sebelum format terstruktur) */
	}
	return { t: text };
}
export const escHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Buang awalan/akhiran teknis dari alasan Auto Prediksi supaya yang tampil hanya intinya. */
export function cleanReason(r: string): string {
	return String(r || "")
		.replace(/^\s*\[Percobaan ulang \d+\/\d+\]\s*/i, "")
		.replace(/\s*\((?:dicoba lagi otomatis[^)]*|percobaan otomatis habis[^)]*)\)\s*$/i, "")
		.replace(/\s*\(judul '[^']*' tidak ada\)/i, "")
		.replace(/\s*Diterima: HTTP[\s\S]*$/i, "") // cuplikan diagnosa per website: tetap di panel, tidak di Telegram (agar bisa digabung)
		.trim() || "gagal (tanpa keterangan)";
}

/** Masukkan kejadian ke antrean (sekali per kunci). Tidak pernah melempar. Mengembalikan true bila baru masuk. */
export async function enqueueNotify(env: Env, kind: NotifyKind, key: string, item: string | NotifyItem): Promise<boolean> {
	return (await enqueueNotifyResult(env, kind, key, item)) === "queued";
}
/** Seperti enqueueNotify, tetapi membedakan 'sengaja dilewati' (kategori mati / belum diatur / sudah ada) dari 'error'
 *  (database gagal) -- pemindai hanya menandai kejadian 'sudah dikabarkan' bila BUKAN error, supaya kabarnya tidak hilang. */
export async function enqueueNotifyResult(env: Env, kind: NotifyKind, key: string, item: string | NotifyItem): Promise<"queued" | "skipped" | "error"> {
	try {
		if (!(await notifyEnabled(env, kind))) return "skipped";
		// Telegram admin belum diatur -> jangan menumpuk (kalau tidak, begitu Token diisi grup dibanjiri kejadian berhari-hari);
		// kejadiannya tetap terlihat di panel (Error & Bug, Auto Prediksi, Riwayat).
		await loadIntegrations(env);
		const c = alertTgCfg();
		if (!c.token || !c.chatId) return "skipped";
		await ensureTable(env);
		const r = await env.DB.prepare(`INSERT OR IGNORE INTO admin_notify (nkey, kind, text, created_at) VALUES (?, ?, ?, ?)`)
			.bind(String(key).slice(0, 300), kind, encodeItem(item), tsNow())
			.run();
		return (r.meta?.changes ?? 0) > 0 ? "queued" : "skipped";
	} catch {
		return "error";
	}
}

interface Pending { id: number; kind: NotifyKind; text: string; tries: number }

/** Susun pesan HTML dari antrean: per kategori, kejadian dengan alasan sama digabung (alasan ditulis SEKALI, lalu daftar
 *  website per kelompok). Dipotong rapi agar < batas Telegram; kelompok yang tidak muat tetap menunggu pesan berikutnya. */
export function buildDigest(items: Pending[], nowMs = Date.now()): { text: string; ids: number[] } {
	const ids: number[] = [];
	const hhmm = new Date(nowMs + 7 * 3600_000).toISOString().slice(11, 16);
	let out = `🔔 <b>KD-Group Panel</b> · ${hhmm} WIB`;
	let full = false;
	for (const kind of ORDER) {
		if (full) break;
		const group = items.filter((i) => i.kind === kind).map((i) => ({ ...i, it: decodeItem(i.text) }));
		if (!group.length) continue;
		if (kind === "daily") {
			for (const g of group) {
				const block = "\n\n" + (g.it.html ?? escHtml(g.it.t ?? ""));
				if (out.length + block.length > MSG_LIMIT) { full = true; break; }
				out += block;
				ids.push(g.id);
			}
			continue;
		}
		let sect = `\n\n<b>${KIND_TITLE[kind]}</b>${group.length > 1 ? ` (${group.length})` : ""}`;
		const sectIds: number[] = [];
		// kelompokkan per alasan (urutan kemunculan pertama dipertahankan)
		const byReason = new Map<string, typeof group>();
		for (const g of group) {
			const k = g.it.r ?? "\u0000" + g.id; // tanpa alasan = baris sendiri
			byReason.set(k, [...(byReason.get(k) ?? []), g]);
		}
		for (const [k, rows] of byReason) {
			let block = "";
			if (k.startsWith("\u0000")) {
				const it = rows[0].it;
				block = "\n• " + escHtml(it.t ?? [it.s, it.m].filter(Boolean).join(" · "));
			} else {
				block = `\n<i>${escHtml(k)}</i>`;
				const byM = new Map<string, string[]>();
				for (const r of rows) {
					const m = r.it.m ?? "";
					byM.set(m, [...(byM.get(m) ?? []), r.it.s ?? r.it.t ?? ""]);
				}
				for (const [m, subs] of byM) {
					const list = escHtml([...new Set(subs.filter(Boolean))].join(", "));
					block += m ? `\n   ▸ <b>${escHtml(m)}</b>: ${list}` : subs.map((x) => `\n   ▸ ${escHtml(x)}`).join("");
				}
			}
			if (out.length + sect.length + block.length > MSG_LIMIT) { full = true; break; }
			sect += block;
			sectIds.push(...rows.map((r) => r.id));
		}
		if (sectIds.length) {
			out += sect;
			ids.push(...sectIds);
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
	const { result } = await deliverAlert(env, text, true, true);
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
	// auto_input_job.tg_sent sudah dijamin ensureAutoInputTables; di sini toto_macau_log (SATU query kolom, ALTER hanya bila perlu).
	try {
		await ensureColumns(getTurso(env), { toto_macau_log: [["tg_sent", "INTEGER NOT NULL DEFAULT 0"]] });
	} catch (e) {
		if (!/no such table/i.test(e instanceof Error ? e.message : String(e))) throw e;
	}
	scanCols = true;
}

export async function scanFinalFailures(env: Env): Promise<number> {
	const wantAi = await notifyEnabled(env, "autoinput");
	const wantToto = await notifyEnabled(env, "toto");
	if (!wantAi && !wantToto) return 0;
	await ensureAutoInputTables(env);
	await ensureScanCols(env);
	const db = getTurso(env);
	const since = tsPlusMinutes(-6 * 60); // hanya kejadian baru; riwayat lama tidak membanjiri saat fitur pertama aktif
	let n = 0;
	if (wantAi) {
		const max = await getSys(env, "sys_auto_input_retry_max");
		const r = await db
			.prepare(`SELECT id, website, market, stage, detail, attempts FROM auto_input_job WHERE status = 'FAILED' AND hidden = 0 AND ${finalFailureSql()} AND tg_sent = 0 AND updated_at >= ? ORDER BY id ASC LIMIT 20`)
			.bind(max, tsPlusMinutes(-RETRY_WINDOW_MIN), since)
			.all<Record<string, unknown>>()
			.catch(() => ({ results: [] as Record<string, unknown>[] }));
		const ids: number[] = [];
		for (const j of r.results ?? []) {
			const item = { r: cleanReason(String(j.detail || "")), m: String(j.market || "-"), s: String(j.website || "-") };
			const res = await enqueueNotifyResult(env, "autoinput", `ai:${j.id}`, item);
			if (res === "queued") n++;
			if (res !== "error") ids.push(Number(j.id)); // database gagal -> jangan tandai, coba lagi tick berikutnya
		}
		if (ids.length) await db.prepare(`UPDATE auto_input_job SET tg_sent = 1 WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
	}
	if (wantToto) {
		const r = await db
			// bentuk status IN + rentang updated_at -> memakai index ix_toto_log_state (dulu memindai seluruh log tiap 5 menit)
			.prepare(`SELECT id, website, game, market, number, status, detail, attempts, row_at FROM toto_macau_log WHERE status IN ('FAILED', 'CONFLICT') AND updated_at >= ? AND (status = 'CONFLICT' OR attempts >= ?) AND tg_sent = 0 ORDER BY id ASC LIMIT 20`)
			.bind(since, TOTO_MAX_ATTEMPTS)
			.all<Record<string, unknown>>()
			.catch(() => ({ results: [] as Record<string, unknown>[] }));
		const ids: number[] = [];
		for (const t of r.results ?? []) {
			const market = String(t.market || (t.game === "m51" ? "TOTO MACAO 5D" : "TOTO MACAU"));
			const what = t.status === "CONFLICT" ? "Beda angka dengan admin" : "Angka belum masuk ke Panel-Z";
			const item = {
				r: `${what}${t.detail ? " — " + String(t.detail).slice(0, 200) : ""}`,
				m: `${market} ${String(t.row_at || "").slice(5, 16)}`.trim(),
				s: `${t.website}${t.number ? " (admin " + t.number + ")" : ""}`,
			};
			const res = await enqueueNotifyResult(env, "toto", `toto:${t.id}:${t.status}`, item);
			if (res === "queued") n++;
			if (res !== "error") ids.push(Number(t.id));
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
const HARI = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
export function tanggalIndo(day: string): string {
	const d = new Date(day + "T00:00:00Z");
	return `${HARI[d.getUTCDay()]}, ${d.getUTCDate()} ${BULAN[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const fmt = (n: number) => n.toLocaleString("id-ID");
const pct = (bad: number, total: number) => (total ? ` (${Math.round((bad * 100) / total)}%)` : "");
/** Satu baris laporan: ikon status (✅ bersih / ⚠️ ada masalah) + label tebal + isi. */
const row = (icon: string, label: string, body: string, ok: boolean) => `${ok ? "✅" : "⚠️"} ${icon} <b>${escHtml(label)}</b> — ${body}`;
async function safe(label: string, fn: () => Promise<string>): Promise<string> {
	try {
		return await fn();
	} catch {
		return `❔ <b>${escHtml(label)}</b> — tidak terbaca`;
	}
}
const cnt = (rows: { s: string; n: number }[] | undefined, s: string) => Number((rows ?? []).find((r) => String(r.s) === s)?.n ?? 0);

/** Laporan harian (HTML aman: semua angka dari query, label tetap). Satu bagian gagal dibaca tidak menggagalkan laporan. */
export async function buildDailyReport(env: Env, day: string): Promise<string> {
	const db = getTurso(env);
	const tursoOn = !!(String(env.TURSO_URL ?? "").trim() && String(env.TURSO_TOKEN ?? "").trim());
	const ops: string[] = [];
	ops.push(
		await safe("Auto Posting prediksi", async () => {
			const r = await env.DB.prepare(`SELECT status AS s, COUNT(*) AS n FROM prediction_registry WHERE date_key = ? GROUP BY status`).bind(day).all<{ s: string; n: number }>();
			const ok = cnt(r.results, "BERHASIL"), bad = cnt(r.results, "GAGAL");
			return row("📤", "Auto Posting prediksi", `${fmt(ok)} terkirim${bad ? ` · <b>${fmt(bad)} gagal</b>${pct(bad, ok + bad)}` : ""}`, !bad);
		}),
	);
	if (tursoOn) {
		ops.push(
			await safe("Auto Prediksi", async () => {
				const r = await db.prepare(`SELECT status AS s, COUNT(*) AS n FROM auto_input_job WHERE substr(created_at,1,10) = ? AND result_key NOT LIKE 'manual:%' GROUP BY status`).bind(day).all<{ s: string; n: number }>();
				const done = cnt(r.results, "DONE"), fail = cnt(r.results, "FAILED"), skip = cnt(r.results, "SKIPPED");
				return row("🎯", "Auto Prediksi", `${fmt(done)} berhasil${fail ? ` · <b>${fmt(fail)} gagal</b>${pct(fail, done + fail)}` : ""}${skip ? ` · ${fmt(skip)} dilewati` : ""}`, !fail);
			}),
		);
		ops.push(
			await safe("Toto Macau", async () => {
				const r = await db.prepare(`SELECT status AS s, COUNT(*) AS n FROM toto_macau_log WHERE period > 0 AND substr(row_at,1,10) = ? GROUP BY status`).bind(day).all<{ s: string; n: number }>();
				const ok = cnt(r.results, "SENT") + cnt(r.results, "VERIFIED");
				const fail = cnt(r.results, "FAILED"), conf = cnt(r.results, "CONFLICT");
				const wait = cnt(r.results, "MISSING") + cnt(r.results, "PENDING") + cnt(r.results, "SENDING");
				const bits = [`${fmt(ok)} terisi`];
				if (fail) bits.push(`<b>${fmt(fail)} gagal</b>`);
				if (conf) bits.push(`<b>${fmt(conf)} beda angka</b>`);
				if (wait) bits.push(`${fmt(wait)} menunggu`);
				return row("🎰", "Toto Macau", bits.join(" · "), !fail && !conf);
			}),
		);
	}
	const news: string[] = [];
	if (tursoOn) {
		news.push(
			await safe("BOT News", async () => {
				const r = await db
					.prepare(
						`SELECT
							SUM(CASE WHEN substr(found_at,1,10) = ?1 THEN 1 ELSE 0 END) AS found,
							SUM(CASE WHEN site_posted_at != '' AND substr(site_posted_at,1,10) = ?1 THEN 1 ELSE 0 END) AS site,
							SUM(CASE WHEN status = 'posted' AND substr(posted_at,1,10) = ?1 THEN 1 ELSE 0 END) AS blogger,
							SUM(CASE WHEN fb_direct_posted_at NOT IN ('', 'error') AND substr(fb_direct_posted_at,1,10) = ?1 THEN 1 ELSE 0 END) AS fb,
							SUM(CASE WHEN tg_posted_at LIKE '20%' AND substr(tg_posted_at,1,10) = ?1 THEN 1 ELSE 0 END) AS tg,
							SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS queue
						 FROM news_article`,
					)
					.bind(day)
					.first<Record<string, number | null>>();
				const n = (k: string) => Number(r?.[k] ?? 0);
				return [
					`📰 <b>BOT News</b> — ${fmt(n("found"))} artikel baru terkumpul · antrean sekarang ${fmt(n("queue"))}`,
					`   ▸ Website: <b>${fmt(n("site"))}</b> · Blogger: <b>${fmt(n("blogger"))}</b>`,
					`   ▸ Template FB: <b>${fmt(n("fb"))}</b> · Channel Telegram: <b>${fmt(n("tg"))}</b>`,
				].join("\n");
			}),
		);
	}
	const errs = await safe("Error & Bug", async () => {
		const r = await env.DB.prepare(
			`SELECT SUM(CASE WHEN status = 'open' AND impact = 'blocking' THEN 1 ELSE 0 END) AS ob,
			        SUM(CASE WHEN status = 'open' AND impact != 'blocking' THEN 1 ELSE 0 END) AS og,
			        SUM(CASE WHEN substr(first_at,1,10) = ? THEN 1 ELSE 0 END) AS nw
			 FROM error_log`,
		).bind(day).first<{ ob: number; og: number; nw: number }>();
		const ob = Number(r?.ob ?? 0), og = Number(r?.og ?? 0), nw = Number(r?.nw ?? 0);
		return row("🐞", "Error & Bug", `${fmt(nw)} baru · terbuka: ${ob ? `<b>${fmt(ob)} menghambat</b>, ` : ""}${fmt(og)} latar`, !ob);
	});
	return [
		`📊 <b>Laporan harian</b>`,
		`<i>${tanggalIndo(day)} (WIB)</i>`,
		"",
		...ops,
		...(news.length ? ["", ...news] : []),
		"",
		errs,
	].join("\n");
}

/** Antre laporan harian sekali per hari setelah jam yang diatur (bawaan 00 WIB = begitu hari kemarin selesai). */
export async function queueDailyReport(env: Env, nowMs = Date.now()): Promise<boolean> {
	if (!(await notifyEnabled(env, "daily"))) return false;
	const { date, hour } = wibNow(nowMs);
	if (hour < (await getSys(env, "sys_tgn_daily_hour"))) return false;
	await ensureTable(env);
	const key = "daily:" + date;
	const has = await env.DB.prepare(`SELECT 1 AS x FROM admin_notify WHERE nkey = ?`).bind(key).first();
	if (has) return false;
	return enqueueNotify(env, "daily", key, { html: await buildDailyReport(env, yesterday(date)) });
}

/** Tombol admin "Kirim Laporan Harian": kirim LANGSUNG laporan satu tanggal (bawaan kemarin), tanpa antrean & tanpa
 *  menunggu jam laporan. Tidak mengubah jadwal laporan otomatis. Mengembalikan hasil Telegram ("Terkirim" / galat). */
export async function sendDailyReportNow(env: Env, day?: string, nowMs = Date.now()): Promise<{ result: string; day: string }> {
	const d = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : yesterday(wibNow(nowMs).date);
	await loadIntegrations(env);
	const c = alertTgCfg();
	if (!c.token || !c.chatId) return { result: "belum-diatur", day: d };
	const html = (await buildDailyReport(env, d)) + "\n\n<i>Dikirim ulang dari panel.</i>";
	const { result } = await deliverAlert(env, html, false, true);
	return { result, day: d };
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
