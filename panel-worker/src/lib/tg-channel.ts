// Auto Posting ke CHANNEL TELEGRAM: artikel yang sudah tayang di web berita (site_posted_at) dikirim ke channel lewat Bot API resmi
// (sendPhoto + caption, jatuh ke sendMessage bila gambar tak bisa diambil Telegram). Dijalankan cron */5 (index.ts).
//
// Pengaturan:
//  - BOT > Setting > Sosial & Promo: aktif, Chat ID channel, link promosi channel (bot_kv: tg_channel_enabled / tg_channel_id / tg_channel_url)
//  - Admin > Integrasi: token bot channel (kosong = token bot Notifikasi Galat)
//  - Admin > Pengaturan Sistem > Channel Telegram: batas harian, jeda antar posting, umur maksimum artikel
//
// Aman diulang: artikel DIKLAIM dulu (tg_posted_at diisi) baru dikirim -> tak pernah dobel; gagal sementara melepas klaim,
// gagal permanen menandai 'error'. Masalah konfigurasi (token/Chat ID/izin bot) TIDAK menandai artikel; terlihat di BOT > Setting.
import { logActivity } from "./activity";
import { botCfg, botCfgSet, ensureNewsCategoryColumns, newsCategoryLabel, tgPromoUrl } from "./bot-news";
import { loadIntegrations, newsSiteUrl, tgChannelToken } from "./integrations";
import { getSys } from "./settings";
import { tsNow } from "./time";
import { getTurso } from "./turso";
import { sendTelegram, sendTelegramPhoto, sendTelegramRich } from "../senders/telegram";
import type { TgSendOpts } from "../senders/telegram";

const CAPTION_MAX = 1024; // batas caption foto Telegram

export const TG_CHAT_RE = /^(-100\d{5,20}|-?\d{5,20}|@[A-Za-z0-9_]{5,32})$/;

/** Ubah galat mentah Telegram jadi penjelasan + langkah perbaikan (bahasa awam). */
export function explainTgError(raw: string): string {
	const t = String(raw || "");
	if (/Unauthorized|401/.test(t)) return "Token bot ditolak Telegram (salah/dicabut). Periksa token di Admin > Integrasi (Channel Telegram) atau Notifikasi Galat.";
	if (/chat not found/i.test(t)) return "Chat ID tidak ditemukan. Pastikan Chat ID channel benar (diawali -100…) dan bot sudah ditambahkan sebagai admin channel.";
	if (/not enough rights|have no rights|CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN|need administrator rights/i.test(t)) return "Bot belum boleh memposting. Di channel: Admin > pilih bot > aktifkan izin 'Post Messages'.";
	if (/bot is not a member|bot was kicked|kicked from/i.test(t)) return "Bot bukan anggota/admin channel itu. Tambahkan bot sebagai admin channel.";
	if (/Too Many Requests|retry after/i.test(t)) return "Telegram membatasi kecepatan kirim sementara; akan dicoba lagi otomatis.";
	if (/Token\/Chat ID kosong/i.test(t)) return "Token bot atau Chat ID channel belum diisi.";
	if (/wrong file identifier|failed to get HTTP URL|wrong type of the web page|IMAGE_PROCESS_FAILED|PHOTO_/i.test(t)) return "Telegram tidak bisa mengambil gambar artikel (dikirim tanpa foto).";
	return t.replace(/^Tele Error:\s*/, "").slice(0, 240);
}

const photoProblem = (r: string) => /wrong file identifier|failed to get HTTP URL|wrong type of the web page|IMAGE_PROCESS_FAILED|PHOTO_|wrong remote file identifier/i.test(r);
const configProblem = (r: string) => /Unauthorized|401|chat not found|not enough rights|have no rights|CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN|bot is not a member|bot was kicked|kicked from|Token\/Chat ID kosong|need administrator rights/i.test(r);
const transientProblem = (r: string) => /Too Many Requests|retry after|"error_code":\s*5\d\d|fetch failed|network|timeout|timed out|Internal Server Error/i.test(r);

export interface TgArticle {
	id: number;
	title: string;
	excerpt: string;
	image_url: string;
	category: string;
}

const esc = (t: string) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (t: string) => esc(t).replace(/"/g, "&quot;");
const cut = (t: string, n: number) => (t.length <= n ? t : t.slice(0, Math.max(0, n - 1)).replace(/\s+\S*$/, "") + "…");

export interface TgPost {
	/** Caption/teks berformat HTML (judul tebal, ringkasan, tautan baca, hashtag, footer). */
	html: string;
	/** Versi polos (tanpa tag) untuk cadangan bila Telegram menolak format. */
	plain: string;
	/** Tombol URL di bawah posting: [Baca selengkapnya] + [Gabung Channel | WhatsApp | Facebook]. */
	buttons: { text: string; url: string }[][];
}

/**
 * Template posting channel: bersih ala media profesional -- judul tebal, ringkasan singkat, satu tautan baca, dua-tiga tagar,
 * footer kecil; tanpa deretan emoji, tanpa HURUF BESAR, tanpa URL mentah panjang (tautan ada di teks bertautan & tombol).
 * Teks terlihat dijaga <= 1024 karakter (batas caption foto Telegram); ringkasan yang dipotong, bukan tautan/footer.
 */
export function tgChannelPost(r: Pick<TgArticle, "title" | "excerpt" | "category">, link: string, cfg: Record<string, string>): TgPost {
	const tg = tgPromoUrl(cfg);
	const wa = /^https?:\/\//i.test((cfg.wa_channel_url || "").trim()) ? cfg.wa_channel_url.trim() : "";
	const fb = /^https?:\/\//i.test((cfg.fb_page_url || "").trim()) ? cfg.fb_page_url.trim() : "";
	const title = cut(String(r.title || "").trim(), 200);
	const catTag = String(r.category || "").replace(/[^A-Za-z0-9]/g, "");
	const tags = [...(catTag ? ["#" + newsCategoryLabel(r.category).replace(/[^A-Za-z0-9]/g, "")] : []), "#BeritaTerkini", "#LapakStore88"].slice(0, 3).join("  ");
	const readText = "Baca selengkapnya →";
	const footPlain = tg ? "LapakStore88 News · Gabung channel" : "LapakStore88 News";
	const fixed = title.length + readText.length + tags.length + footPlain.length + 8; // 4 pemisah baris kosong (2 karakter masing-masing)
	let ex = String(r.excerpt || "").trim().replace(/\s+/g, " ");
	if (ex === title) ex = "";
	const room = Math.min(1024 - fixed - 2, 420);
	ex = ex && room > 60 ? cut(ex, room) : "";
	const readHtml = `<a href="${escAttr(link)}">${readText}</a>`;
	const footHtml = tg ? `<i>LapakStore88 News</i> · <a href="${escAttr(tg)}">Gabung channel</a>` : `<i>LapakStore88 News</i>`;
	const html = [`<b>${esc(title)}</b>`, ...(ex ? [esc(ex)] : []), readHtml, tags, footHtml].join("\n\n");
	const plain = [title, ...(ex ? [ex] : []), `${readText} ${link}`, tags, tg ? `LapakStore88 News · Gabung channel: ${tg}` : "LapakStore88 News"].join("\n\n");
	const buttons: TgPost["buttons"] = [[{ text: "Baca selengkapnya", url: link }]];
	const social = [...(tg ? [{ text: "Gabung Channel", url: tg }] : []), ...(wa ? [{ text: "WhatsApp", url: wa }] : []), ...(fb ? [{ text: "Facebook", url: fb }] : [])];
	if (social.length) buttons.push(social);
	return { html, plain, buttons };
}

const wibCutoff = (hours: number) => new Date(Date.now() + 7 * 3600_000 - hours * 3600_000).toISOString().slice(0, 19).replace("T", " ");
const wibToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const parseWib = (s: string) => Date.parse(String(s).replace(" ", "T") + "+07:00");

async function setLastError(env: Env, cfg: Record<string, string>, msg: string): Promise<void> {
	const v = msg ? `${tsNow()} | ${msg}`.slice(0, 300) : "";
	if ((cfg.tg_channel_last_error || "").slice(22) === v.slice(22) && v) return; // pesan sama: jangan tulis ulang tiap 5 menit
	if (!v && !cfg.tg_channel_last_error) return;
	await botCfgSet(env, { tg_channel_last_error: v });
}

export interface TgRunResult {
	posted: number;
	message: string;
	ok?: boolean;
}

/** Kirim paling banyak 1 artikel. `force` (tombol KIRIM SEKARANG) melewati saklar aktif & jeda antar posting, tetapi tetap menghormati batas harian & umur artikel. */
export async function tgChannelRun(env: Env, opts: { force?: boolean } = {}): Promise<TgRunResult> {
	await loadIntegrations(env);
	const cfg = await botCfg(env);
	const force = !!opts.force;
	if (!force && cfg.tg_channel_enabled !== "1") return { posted: 0, message: "Posting channel Telegram nonaktif." };
	const chatId = String(cfg.tg_channel_id || "").trim();
	const token = tgChannelToken();
	if (!chatId) return { posted: 0, message: "Chat ID channel belum diisi (BOT > Setting > Sosial & Promo)." };
	if (!token) return { posted: 0, message: "Token bot belum diisi (Admin > Integrasi > Channel Telegram)." };
	await ensureNewsCategoryColumns(env);
	const db = getTurso(env);
	if (!force) {
		const last = await db.prepare(`SELECT MAX(tg_posted_at) AS m FROM news_article WHERE tg_posted_at LIKE '20%'`).first<{ m: string | null }>();
		const lastMs = last?.m ? parseWib(last.m) : 0;
		// Toleransi 90 dtk: cron berdetak tiap 5 menit dan jam posting tercatat beberapa detik SETELAH detak sebelumnya, jadi tanpa
		// toleransi jeda 5 menit selalu "kurang sedikit" dan posting baru jalan di detak berikutnya (efektif 10 menit).
		if (lastMs && Date.now() - lastMs < (await getSys(env, "sys_tgch_gap_min")) * 60_000 - 90_000) return { posted: 0, message: "Menunggu jeda antar posting." };
	}
	const done = await db.prepare(`SELECT COUNT(*) AS c FROM news_article WHERE substr(tg_posted_at,1,10) = ? AND tg_posted_at LIKE '20%'`).bind(wibToday()).first<{ c: number }>();
	if (Number(done?.c ?? 0) >= (await getSys(env, "sys_tgch_daily_cap"))) return { posted: 0, message: "Batas posting channel hari ini tercapai." };
	const cutoff = wibCutoff(await getSys(env, "sys_tgch_max_age_h"));
	const row = await db
		.prepare(
			`SELECT id, title, excerpt, image_url, category FROM news_article
			 WHERE site_posted_at != '' AND site_posted_at >= ? AND tg_posted_at = ''
			 ORDER BY site_posted_at DESC, id DESC LIMIT 1`,
		)
		.bind(cutoff)
		.first<TgArticle>();
	if (!row) return { posted: 0, message: "Tidak ada artikel baru untuk channel." };
	const id = Number(row.id);
	const claim = await db.prepare(`UPDATE news_article SET tg_posted_at = ? WHERE id = ? AND tg_posted_at = ''`).bind(tsNow(), id).run();
	if (!claim.meta.changes) return { posted: 0, message: "Artikel sedang diproses proses lain." };
	const release = (v: string) => db.prepare(`UPDATE news_article SET tg_posted_at = ? WHERE id = ?`).bind(v, id).run();
	try {
		const link = `${newsSiteUrl()}/berita/artikel/?id=${id}`;
		const post = tgChannelPost(row, link, cfg);
		const tgCfg = { token, chatId };
		const img = String(row.image_url || "");
		const rich: TgSendOpts = { parseMode: "HTML", buttons: post.buttons };
		const plainOpts: TgSendOpts = { buttons: post.buttons };
		let res = /^https?:\/\//i.test(img) ? await sendTelegramPhoto(tgCfg, img, post.html, rich) : "photo-skip";
		// Telegram menolak format (jarang) -> kirim ulang polos, jangan hilangkan artikel
		if (/can't parse entities/i.test(res)) res = await sendTelegramPhoto(tgCfg, img, post.plain.slice(0, 1024), plainOpts);
		if (res !== "Terkirim" && (res === "photo-skip" || photoProblem(res))) {
			res = await sendTelegramRich(tgCfg, post.html, rich);
			if (/can't parse entities/i.test(res)) res = await sendTelegramRich(tgCfg, post.plain, plainOpts);
		}
		if (res === "Terkirim") {
			await setLastError(env, cfg, "");
			return { posted: 1, ok: true, message: `Terkirim ke channel: ${String(row.title).slice(0, 80)}` };
		}
		const why = explainTgError(res);
		if (configProblem(res) || transientProblem(res)) {
			await release(""); // coba lagi nanti
			if (configProblem(res)) await setLastError(env, cfg, why);
			return { posted: 0, ok: false, message: why };
		}
		await release("error");
		await logActivity(env, "SISTEM", "CHANNEL TELEGRAM GAGAL", `Artikel #${id}: ${why}`.slice(0, 300), "GAGAL", "").catch(() => {});
		return { posted: 0, ok: false, message: why };
	} catch (e) {
		await release("").catch(() => {});
		return { posted: 0, ok: false, message: e instanceof Error ? e.message : String(e) };
	}
}

/** Tombol TES: kirim satu pesan uji ke channel (Chat ID dari form atau yang tersimpan) dan jelaskan hasilnya. */
export async function tgChannelTest(env: Env, chatIdInput = ""): Promise<{ ok: boolean; message: string }> {
	await loadIntegrations(env);
	const cfg = await botCfg(env);
	const chatId = chatIdInput.trim() || String(cfg.tg_channel_id || "").trim();
	const token = tgChannelToken();
	if (!chatId) return { ok: false, message: "Isi Chat ID channel dulu (angka diawali -100…)." };
	if (!TG_CHAT_RE.test(chatId)) return { ok: false, message: "Format Chat ID tidak valid. Contoh: -1001234567890 atau @namakanal." };
	if (!token) return { ok: false, message: "Token bot belum diisi di Admin > Integrasi > Channel Telegram (atau token Notifikasi Galat)." };
	const r = await sendTelegram("✅ Tes dari panel KD-Group: bot terhubung ke channel ini dan siap memposting berita otomatis.", { token, chatId });
	if (r === "Terkirim") return { ok: true, message: "Pesan uji terkirim ke channel. Cek channel Anda." };
	return { ok: false, message: explainTgError(r.split(token).join("***")) };
}
