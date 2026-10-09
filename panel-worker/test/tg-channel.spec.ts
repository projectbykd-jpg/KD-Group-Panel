import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { botCfgSet, ensureNewsCategoryColumns, publicNewsRssXml, resetNewsColumnsGuard, tgPromoUrl } from "../src/lib/bot-news";
import { explainTgError, tgChannelPost, tgChannelRun, tgChannelTest } from "../src/lib/tg-channel";
import { saveIntegrations, resetIntegrationsCache } from "../src/lib/integrations";
import { resetSysCache, saveSys } from "../src/lib/settings";
import { botNewsSaveConfig } from "../src/api/bot";
import { checkLogin } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { fakeEnv, fakeTurso } from "./helpers/fake-env";

const TOKEN = "123456789:AAEhBOweik6ad9r_QXMENQjcrEZhGbbpR_H";
const CHAT = "-1003703936630";
const TG_URL = "https://t.me/+sYImonGOJnxkNGFl";
let ctx: ReturnType<typeof fakeEnv>;
const sent: { method: string; body: URLSearchParams }[] = [];

const wib = (minAgo: number) => new Date(Date.now() + 7 * 3600_000 - minAgo * 60_000).toISOString().slice(0, 19).replace("T", " ");

function stub(handler: (method: string, body: URLSearchParams) => { status?: number; body?: unknown }) {
	vi.stubGlobal("fetch", async (url: string, init: { body: URLSearchParams }) => {
		const method = String(url).split("/").pop()!;
		sent.push({ method, body: init.body });
		const r = handler(method, init.body);
		return new Response(JSON.stringify(r.body ?? { ok: true }), { status: r.status ?? 200 });
	});
}
async function article(id: number, extra: Partial<{ title: string; excerpt: string; image: string; siteMinAgo: number; tg: string }> = {}) {
	turso.current!.raw
		.prepare(`INSERT INTO news_article (id, source, title, url, url_hash, excerpt, image_url, status, found_at, category, site_posted_at, tg_posted_at) VALUES (?, 's', ?, ?, ?, ?, ?, 'posted', '2026-10-09 00:00:00', 'nasional', ?, ?)`)
		.run(id, extra.title ?? `Judul ${id}`, `https://src.test/${id}`, `h${id}`, extra.excerpt ?? "Ringkasan singkat berita.", extra.image ?? "https://img.test/a.jpg", wib(extra.siteMinAgo ?? 30), extra.tg ?? "");
}
const rowTg = (id: number) => (turso.current!.raw.prepare(`SELECT tg_posted_at FROM news_article WHERE id = ?`).get(id) as { tg_posted_at: string }).tg_posted_at;

beforeEach(async () => {
	turso.current = fakeTurso();
	ctx = fakeEnv();
	sent.length = 0;
	resetSysCache();
	resetIntegrationsCache();
	resetNewsColumnsGuard();
	await ensureNewsCategoryColumns(ctx.env);
	await saveIntegrations(ctx.env, { int_tgch_token: TOKEN });
	resetIntegrationsCache();
	await botCfgSet(ctx.env, { tg_channel_enabled: "1", tg_channel_id: CHAT, tg_channel_url: TG_URL, fb_page_url: "https://fb.test/p", wa_channel_url: "https://whatsapp.com/channel/x" });
});
afterEach(() => vi.unstubAllGlobals());

const visible = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("template posting channel Telegram", () => {
	const cfg = { tg_channel_url: TG_URL, wa_channel_url: "https://wa.test/c", fb_page_url: "https://fb.test/p" };
	const LINK = "https://web.test/berita/artikel/?id=7";
	it("bersih: judul tebal, ringkasan, satu tautan baca, tagar, footer; tombol Baca + Channel/WhatsApp/Facebook", () => {
		const p = tgChannelPost({ title: "Judul Berita", excerpt: "Ringkasan singkat.", category: "bola" }, LINK, cfg);
		expect(p.html).toContain("<b>Judul Berita</b>");
		expect(p.html).toContain(`<a href="${LINK}">Baca selengkapnya →</a>`);
		expect(p.html).toContain("#Bola");
		expect(p.html).toContain("#BeritaTerkini");
		expect(p.html).toContain(`<a href="${TG_URL}">Gabung channel</a>`);
		expect(p.html).not.toMatch(/https?:\/\/[^"<]*\s/); // tidak ada URL mentah di teks (hanya di atribut href)
		expect(p.buttons[0]).toEqual([{ text: "Baca selengkapnya", url: LINK }]);
		expect(p.buttons[1].map((b) => b.text)).toEqual(["Gabung Channel", "WhatsApp", "Facebook"]);
		expect(p.html).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u); // tanpa emoji (kesan profesional, bukan alay)
		expect(p.html).not.toMatch(/[A-Z]{6,}/); // tanpa huruf besar semua
	});
	it("teks yang terlihat <= 1024 walau judul & ringkasan panjang; tautan & footer tidak ikut terpotong", () => {
		const p = tgChannelPost({ title: "T".repeat(300), excerpt: "kata ".repeat(400), category: "umum" }, LINK, cfg);
		expect(visible(p.html).length).toBeLessThanOrEqual(1024);
		expect(p.html).toContain(LINK);
		expect(p.html).toContain("Gabung channel");
	});
	it("karakter HTML di judul/ringkasan di-escape (tidak merusak format, tidak bisa menyisipkan tag)", () => {
		const p = tgChannelPost({ title: 'Harga <b>naik</b> & "turun"', excerpt: "A < B > C", category: "umum" }, LINK, cfg);
		expect(p.html).toContain("<b>Harga &lt;b&gt;naik&lt;/b&gt; &amp; \"turun\"</b>");
		expect(p.html).toContain("A &lt; B &gt; C");
	});
	it("tanpa link Telegram/WA/FB: tidak ada tombol sosial & footer polos; link tidak valid diabaikan", () => {
		const p = tgChannelPost({ title: "A", excerpt: "", category: "umum" }, "https://w/1", {});
		expect(p.buttons).toHaveLength(1);
		expect(p.html).not.toContain("Gabung");
		expect(tgChannelPost({ title: "A", excerpt: "", category: "umum" }, "https://w/1", { wa_channel_url: "javascript:x" }).buttons).toHaveLength(1);
		expect(tgPromoUrl({ tg_channel_url: "javascript:alert(1)" })).toBe("");
		expect(tgPromoUrl({ tg_channel_url: TG_URL })).toBe(TG_URL);
	});
});

describe("posting otomatis ke channel", () => {
	it("mengirim artikel terbaru sebagai foto + caption, menandainya, dan tidak mengulang", async () => {
		await article(1, { siteMinAgo: 50 });
		await article(2, { siteMinAgo: 20, title: "Berita Terbaru" });
		stub(() => ({}));
		const r = await tgChannelRun(ctx.env);
		expect(r.posted).toBe(1);
		expect(sent).toHaveLength(1);
		expect(sent[0].method).toBe("sendPhoto");
		expect(sent[0].body.get("chat_id")).toBe(CHAT);
		expect(sent[0].body.get("photo")).toBe("https://img.test/a.jpg");
		expect(sent[0].body.get("caption")).toContain("<b>Berita Terbaru</b>");
		expect(sent[0].body.get("caption")).toContain(TG_URL);
		expect(sent[0].body.get("parse_mode")).toBe("HTML");
		const kb = JSON.parse(String(sent[0].body.get("reply_markup"))).inline_keyboard;
		expect(kb[0][0].text).toBe("Baca selengkapnya");
		expect(kb[0][0].url).toMatch(/\/berita\/artikel\/\?id=2$/);
		expect(kb[1].map((b: { text: string }) => b.text)).toEqual(["Gabung Channel", "WhatsApp", "Facebook"]);
		expect(rowTg(2)).toMatch(/^20/);
		expect(rowTg(1)).toBe("");
		// jeda antar posting (bawaan 10 menit): tick berikutnya menunggu
		const again = await tgChannelRun(ctx.env);
		expect(again.posted).toBe(0);
		expect(again.message).toMatch(/jeda/i);
		expect(sent).toHaveLength(1);
	});
	it("nonaktif -> tidak mengirim; tombol KIRIM SEKARANG (force) tetap jalan", async () => {
		await botCfgSet(ctx.env, { tg_channel_enabled: "0" });
		await article(3);
		stub(() => ({}));
		expect((await tgChannelRun(ctx.env)).posted).toBe(0);
		expect(sent).toHaveLength(0);
		expect((await tgChannelRun(ctx.env, { force: true })).posted).toBe(1);
	});
	it("artikel terlalu lama (di luar umur maksimum) tidak diposting; yang belum tayang di web juga tidak", async () => {
		await article(4, { siteMinAgo: 60 * 30 }); // 30 jam
		turso.current!.raw.prepare(`INSERT INTO news_article (id, source, title, url, url_hash, status, found_at, site_posted_at) VALUES (5,'s','Belum tayang','https://x/5','h5','new','2026-10-09 00:00:00','')`).run();
		stub(() => ({}));
		const r = await tgChannelRun(ctx.env);
		expect(r.posted).toBe(0);
		expect(sent).toHaveLength(0);
	});
	it("batas harian dihormati", async () => {
		await saveSys(ctx.env, { sys_tgch_daily_cap: 1 });
		resetSysCache();
		await article(6, { siteMinAgo: 90, tg: wib(0) });
		await article(7, { siteMinAgo: 10 });
		stub(() => ({}));
		const r = await tgChannelRun(ctx.env, { force: true });
		expect(r.posted).toBe(0);
		expect(r.message).toMatch(/Batas/);
	});
	it("foto tak bisa diambil Telegram -> dikirim sebagai teks (artikel tidak hilang)", async () => {
		await article(8);
		stub((m) => (m === "sendPhoto" ? { status: 400, body: { ok: false, description: "Bad Request: wrong file identifier/HTTP URL specified" } } : {}));
		const r = await tgChannelRun(ctx.env);
		expect(r.posted).toBe(1);
		expect(sent.map((s) => s.method)).toEqual(["sendPhoto", "sendMessage"]);
		expect(sent[1].body.get("text")).toContain("Judul 8");
	});
	it("Telegram menolak format HTML -> dikirim ulang polos (artikel tetap terkirim, tombol tetap ada)", async () => {
		await article(13);
		stub((m, b) => (b.get("parse_mode") === "HTML" ? { status: 400, body: { ok: false, description: "Bad Request: can't parse entities: Unsupported start tag" } } : {}));
		const r = await tgChannelRun(ctx.env);
		expect(r.posted).toBe(1);
		expect(sent.map((x) => x.method)).toEqual(["sendPhoto", "sendPhoto"]);
		expect(sent[1].body.get("parse_mode")).toBeNull();
		expect(sent[1].body.get("caption")).not.toContain("<b>");
		expect(sent[1].body.get("reply_markup")).toBeTruthy();
	});
	it("artikel tanpa gambar -> sendMessage langsung", async () => {
		await article(9, { image: "" });
		stub(() => ({}));
		await tgChannelRun(ctx.env);
		expect(sent.map((s) => s.method)).toEqual(["sendMessage"]);
	});
	it("masalah konfigurasi (bot bukan admin): artikel TIDAK ditandai, galat tampil di Setting & tidak ditulis ulang tiap tick; pulih setelah diperbaiki", async () => {
		await article(10);
		stub(() => ({ status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot is not a member of the channel chat" } }));
		const r = await tgChannelRun(ctx.env);
		expect(r.posted).toBe(0);
		expect(r.message).toMatch(/admin channel/i);
		expect(rowTg(10)).toBe("");
		const kv = () => (turso.current!.raw.prepare(`SELECT v FROM bot_kv WHERE k = 'tg_channel_last_error'`).get() as { v: string } | undefined)?.v ?? "";
		expect(kv()).toMatch(/admin channel/i);
		stub(() => ({}));
		expect((await tgChannelRun(ctx.env)).posted).toBe(1);
		expect(kv()).toBe("");
	});
	it("Telegram 429/5xx -> dicoba lagi nanti (tidak ditandai error)", async () => {
		await article(11);
		stub(() => ({ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 5" } }));
		const r = await tgChannelRun(ctx.env);
		expect(r.posted).toBe(0);
		expect(rowTg(11)).toBe("");
	});
	it("galat permanen lain menandai 'error' supaya tidak diulang tanpa henti", async () => {
		await article(12);
		stub(() => ({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: message is too long" } }));
		await tgChannelRun(ctx.env);
		expect(rowTg(12)).toBe("error");
	});
	it("token kosong & chat id kosong ditolak dengan petunjuk", async () => {
		ctx.db.prepare(`DELETE FROM settings WHERE key = 'int_tgch_token'`).run(); // kolom rahasia kosong di form = "tidak diubah", jadi hapus langsung
		resetIntegrationsCache();
		const r = await tgChannelRun(ctx.env, { force: true });
		expect(r.message).toMatch(/Token/);
		await botCfgSet(ctx.env, { tg_channel_id: "" });
		expect((await tgChannelRun(ctx.env, { force: true })).message).toMatch(/Chat ID/);
	});
});

describe("tes channel & penjelasan galat", () => {
	it("tes sukses/gagal; token tidak pernah bocor di pesan", async () => {
		stub(() => ({}));
		expect((await tgChannelTest(ctx.env)).ok).toBe(true);
		stub(() => ({ status: 400, body: { ok: false, description: `Bad Request: chat not found ${TOKEN}` } }));
		const r = await tgChannelTest(ctx.env, "-100999999999");
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/Chat ID/);
		expect(r.message).not.toContain("AAEhBOweik6ad9r");
		expect((await tgChannelTest(ctx.env, "bukan id")).message).toMatch(/Format Chat ID/);
	});
	it("penjelasan galat umum", () => {
		expect(explainTgError('Tele Error: {"description":"Unauthorized"}')).toMatch(/Token/);
		expect(explainTgError("Bad Request: not enough rights to send")).toMatch(/Post Messages/);
	});
});

describe("simpan pengaturan channel (BOT > Setting) tervalidasi", () => {
	async function botToken() {
		ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES ('Bot1','bot1',?, 'BOT','AKTIF')`).run(await hashPassword("pw"));
		return ((await checkLogin(ctx.env, "Bot1", "pw", "")) as { sessionToken: string }).sessionToken;
	}
	it("menolak Chat ID dan link yang tidak valid; menerima yang benar", async () => {
		const t = await botToken();
		await expect(botNewsSaveConfig(ctx.env, t, { tg_channel_id: "abc def" })).rejects.toThrow(/Chat ID/);
		await expect(botNewsSaveConfig(ctx.env, t, { tg_channel_url: "https://evil.example/x" })).rejects.toThrow(/t\.me/);
		const ok = await botNewsSaveConfig(ctx.env, t, { tg_channel_id: CHAT, tg_channel_url: TG_URL, tg_channel_enabled: "1" });
		expect(ok.config).toMatchObject({ tg_channel_id: CHAT, tg_channel_url: TG_URL, tg_channel_enabled: true });
	});
});

describe("token & promosi di jalur lain", () => {
	it("token channel kosong -> memakai token bot Notifikasi Galat", async () => {
		ctx.db.prepare(`DELETE FROM settings WHERE key = 'int_tgch_token'`).run();
		await saveIntegrations(ctx.env, { int_alert_tg_token: "987654321:AAEhBOweik6ad9r_QXMENQjcrEZhGbbpR_H" });
		resetIntegrationsCache();
		await article(20);
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			urls.push(String(url));
			return new Response("{}", { status: 200 });
		});
		expect((await tgChannelRun(ctx.env)).posted).toBe(1);
		expect(urls[0]).toContain("/bot987654321:");
	});
	it("umpan RSS (dipakai Make untuk Facebook) memuat link channel Telegram di caption", async () => {
		await article(21);
		const xml = await publicNewsRssXml(ctx.env);
		expect(xml).toContain("Gabung Channel Telegram kami");
		expect(xml).toContain(TG_URL);
		await botCfgSet(ctx.env, { tg_channel_url: "" });
		expect(await publicNewsRssXml(ctx.env)).not.toContain("Channel Telegram");
	});
});
