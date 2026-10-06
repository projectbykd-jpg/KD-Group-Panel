import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import {
	aiClearAllCooldowns,
	aiCooldown,
	aiGenerate,
	aiLoadProviders,
	aiNextReadyInMs,
	aiResetCooldowns,
	AiTimeoutError,
	AiUnavailableError,
	cooldownMsFor,
	legacyProviders,
	maskKey,
	normalizeBaseUrl,
	parseUsage,
	pickWriterModel,
	providerStatus,
	type AiProvider,
} from "../src/lib/ai-provider";
import { botCfg, botCfgSet, extractArticleImages, extractArticleText, geminiRewrite, insertImagesBetweenParagraphs } from "../src/lib/bot-news";
import { botAiDelete, botAiList, botAiReorder, botAiSave, botAiTopUp } from "../src/api/bot";
import { checkLogin } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { fakeEnv, fakeTurso } from "./helpers/fake-env";

const env = {} as Env;
const EMPTY = { used: 0, calls: 0, estimated: 0, failed: 0, todayTokens: 0, todayCalls: 0, lastAt: "", lastErr: "", lastErrAt: "" };

function prov(over: Partial<AiProvider> = {}): AiProvider {
	return {
		id: "a", name: "A", base_url: "https://a.test/v1", key: "sk-aaaaaaaaaaaaaaaa", model: "m-a", enabled: true,
		quota: 0, activated: "", valid_days: 0, used_adjust: 0, created_at: "", ...over,
	};
}

type Reply = { status?: number; body: unknown };
function mockFetch(handler: (url: string, body: any) => Reply) {
	const calls: { url: string; body: any }[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		calls.push({ url, body });
		const r = handler(url, body);
		return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
	});
	return calls;
}
const chatOk = (content: string, total = 1234) => ({ body: { model: "x", choices: [{ message: { content } }], usage: { prompt_tokens: 1000, completion_tokens: total - 1000, total_tokens: total } } });
const usageRows = () => turso.current!.raw.prepare(`SELECT provider, total_tokens, ok, purpose FROM ai_usage ORDER BY id`).all() as Record<string, unknown>[];

beforeEach(() => {
	turso.current = fakeTurso();
	vi.unstubAllGlobals();
	aiResetCooldowns();
});

describe("helper", () => {
	it("masker key tidak pernah membuka key utuh", () => {
		expect(maskKey("sk-qwen-3a7ac2bd3573cc6ef4483ba2")).toBe("sk-qwen…3ba2");
		expect(maskKey("")).toBe("");
	});
	it("base URL dirapikan & wajib https", () => {
		expect(normalizeBaseUrl("https://bandelbanget.xyz/v1/")).toBe("https://bandelbanget.xyz/v1");
		expect(normalizeBaseUrl("https://x.test/v1/chat/completions")).toBe("https://x.test/v1");
		expect(() => normalizeBaseUrl("http://x.test/v1")).toThrow(/https/);
		expect(() => normalizeBaseUrl("")).toThrow(/wajib/);
	});
	it("usage dibaca dari format OpenAI maupun input/output", () => {
		expect(parseUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })).toEqual({ prompt: 10, completion: 5, total: 15 });
		expect(parseUsage({ usage: { input_tokens: 7, output_tokens: 3 } })).toEqual({ prompt: 7, completion: 3, total: 10 });
		expect(parseUsage({})).toBeNull();
	});
	it("pilih model penulis, buang whisper/embedding/compound", () => {
		expect(pickWriterModel(["whisper-large", "compound-mini", "text-embedding-3", "deepseek-v4-flash"], new Set())).toBe("deepseek-v4-flash");
	});
});

describe("status kuota & masa aktif", () => {
	const NOW = Date.parse("2026-10-10T05:00:00Z"); // 12:00 WIB
	it("kuota 100 juta: sisa, persen, peringatan <10%", () => {
		const st = providerStatus(prov({ quota: 100_000_000 }), { ...EMPTY, used: 95_000_000 }, NOW);
		expect(st.remaining).toBe(5_000_000);
		expect(st.pctUsed).toBe(95);
		expect(st.usable).toBe(true);
		expect(st.warn).toMatch(/10%/);
	});
	it("kuota habis -> tidak dipakai", () => {
		const st = providerStatus(prov({ quota: 1000, used_adjust: 400 }), { ...EMPTY, used: 600 }, NOW);
		expect(st.exhausted).toBe(true);
		expect(st.state).toBe("exhausted");
		expect(st.usable).toBe(false);
	});
	it("28 hari sejak aktif (WIB)", () => {
		const p = prov({ activated: "2026-10-01", valid_days: 28 });
		expect(providerStatus(p, EMPTY, NOW).expiresAt).toBe("2026-10-29");
		expect(providerStatus(p, EMPTY, NOW).daysLeft).toBe(19);
		expect(providerStatus(p, EMPTY, Date.parse("2026-10-28T16:59:00Z")).expired).toBe(false); // 23:59 WIB hari ke-28
		expect(providerStatus(p, EMPTY, Date.parse("2026-10-28T17:00:00Z")).expired).toBe(true); // 29-10 00:00 WIB
	});
	it("dimatikan / belum lengkap -> tidak dipakai", () => {
		expect(providerStatus(prov({ enabled: false }), EMPTY).state).toBe("disabled");
		expect(providerStatus(prov({ model: "" }), EMPTY).state).toBe("incomplete");
	});
});

describe("migrasi key Groq/Gemini lama", () => {
	it("dipindah sekali ke daftar (Groq dulu), field lama dikosongkan", async () => {
		await botCfgSet(env, { groq_key: "gsk_1, gsk_2", gemini_key: "AIza1", groq_model: "llama-x", gemini_model: "gemini-flash-latest" });
		const cfg = await botCfg(env);
		const list = await aiLoadProviders(env, cfg);
		expect(list.map((p) => p.id)).toEqual(["groq-1", "groq-2", "gemini-1"]);
		expect(list[0]).toMatchObject({ base_url: "https://api.groq.com/openai/v1", key: "gsk_1", model: "llama-x" });
		expect(list[2]).toMatchObject({ base_url: "https://generativelanguage.googleapis.com/v1beta/openai", key: "AIza1" });
		const after = await botCfg(env);
		expect(after.groq_key).toBe("");
		expect(after.gemini_key).toBe("");
		// Panggilan kedua membaca daftar yang sudah tersimpan (tidak migrasi ulang).
		await botCfgSet(env, { groq_key: "gsk_baru" });
		expect((await aiLoadProviders(env, await botCfg(env))).length).toBe(3);
	});
	it("legacyProviders kosong kalau tidak ada key", () => {
		expect(legacyProviders({})).toEqual([]);
	});
});

describe("aiGenerate: urutan prioritas & fallback", () => {
	async function setProviders(list: AiProvider[]) {
		await botCfgSet(env, { ai_providers: JSON.stringify(list) });
		return botCfg(env);
	}

	it("pakai provider pertama; token dari respons tercatat", async () => {
		const cfg = await setProviders([prov(), prov({ id: "b", name: "B", base_url: "https://b.test/v1" })]);
		const calls = mockFetch(() => chatOk("halo", 1500));
		const r = await aiGenerate(env, cfg, { purpose: "t", messages: [{ role: "user", content: "x" }] }, (t) => t);
		expect(r.value).toBe("halo");
		expect(calls.map((c) => c.url)).toEqual(["https://a.test/v1/chat/completions"]);
		expect(usageRows()).toEqual([{ provider: "A", total_tokens: 1500, ok: 1, purpose: "t" }]);
	});

	it("provider gagal -> provider berikutnya; dimatikan & kuota habis dilewati", async () => {
		const cfg = await setProviders([
			prov({ id: "off", name: "Off", enabled: false }),
			prov({ id: "a", name: "A" }),
			prov({ id: "full", name: "Full", base_url: "https://full.test/v1", quota: 10, used_adjust: 10 }),
			prov({ id: "b", name: "B", base_url: "https://b.test/v1" }),
		]);
		const calls = mockFetch((url) => (url.startsWith("https://a.test") ? { status: 500, body: { error: { message: "down" } } } : chatOk("dari B")));
		const r = await aiGenerate(env, cfg, { purpose: "t", messages: [{ role: "user", content: "x" }] }, (t) => t);
		expect(r.value).toBe("dari B");
		expect(r.call.providerName).toBe("B");
		expect(calls.map((c) => new URL(c.url).host)).toEqual(["a.test", "b.test"]);
		expect(usageRows().map((x) => [x.provider, x.ok])).toEqual([["A", 0], ["B", 1]]);
	});

	it("hasil ditolak validasi -> provider berikutnya dicoba", async () => {
		const cfg = await setProviders([prov(), prov({ id: "b", name: "B", base_url: "https://b.test/v1" })]);
		mockFetch((url) => chatOk(url.startsWith("https://a.test") ? "pendek" : "panjang sekali"));
		const r = await aiGenerate(env, cfg, { purpose: "t", messages: [{ role: "user", content: "x" }] }, (t) => {
			if (t.length < 8) throw new Error("terlalu pendek");
			return t;
		});
		expect(r.value).toBe("panjang sekali");
	});

	it("model hilang (404) -> tanya /models, pakai pengganti & simpan", async () => {
		const cfg = await setProviders([prov({ model: "model-lama" })]);
		mockFetch((url, body) => {
			if (url.endsWith("/models")) return { body: { data: [{ id: "whisper-1" }, { id: "llama-baru" }] } };
			return body.model === "model-lama" ? { status: 404, body: { error: { message: "The model `model-lama` does not exist" } } } : chatOk("ok");
		});
		const r = await aiGenerate(env, cfg, { purpose: "t", messages: [{ role: "user", content: "x" }] }, (t) => t);
		expect(r.call.model).toBe("x");
		expect(JSON.parse((await botCfg(env)).ai_providers)[0].model).toBe("llama-baru");
	});

	it("server menolak response_format -> diulang tanpa JSON mode", async () => {
		const cfg = await setProviders([prov()]);
		const calls = mockFetch((_u, body) =>
			body.response_format ? { status: 400, body: { error: { message: "response_format is not supported" } } } : chatOk("{}"),
		);
		await aiGenerate(env, cfg, { purpose: "t", messages: [{ role: "user", content: "x" }], json: true }, (t) => t);
		expect(calls.map((c) => !!c.body.response_format)).toEqual([true, false]);
	});

	it("tidak ada provider aktif -> AiUnavailableError tanpa panggilan jaringan", async () => {
		const cfg = await setProviders([prov({ enabled: false })]);
		const calls = mockFetch(() => chatOk("x"));
		await expect(aiGenerate(env, cfg, { purpose: "t", messages: [] }, (t) => t)).rejects.toThrow(/Tidak ada AI provider/);
		expect(calls).toEqual([]);
	});
});

describe("tulis ulang artikel memakai bahan sumber", () => {
	it("prompt membawa teks sumber & target panjang; artikel pendek ditolak lalu provider berikut dipakai", async () => {
		await botCfgSet(env, {
			ai_providers: JSON.stringify([prov(), prov({ id: "b", name: "B", base_url: "https://b.test/v1" })]),
			para_min: "12",
			para_max: "12",
		});
		const longBody = Array.from({ length: 12 }, (_, i) => `<p>${"Kalimat panjang tentang kejadian penting hari ini. ".repeat(8)} ${i}</p>`).join("");
		const prompts: string[] = [];
		mockFetch((url, body) => {
			prompts.push(body.messages[0].content);
			const html = url.startsWith("https://a.test") ? "<p>terlalu pendek</p>" : longBody;
			return chatOk(JSON.stringify({ title: "Judul Baru Yang Berbeda Total", body_html: html, meta_description: "m", category: "umum", keywords: ["a"] }));
		});
		const rw = await geminiRewrite(env, await botCfg(env), { title: "Judul asli", excerpt: "ringkas", source: "Sumber", url: "https://s.test/a", sourceText: "FAKTA-SUMBER-XYZ" });
		expect(rw.title).toBe("Judul Baru Yang Berbeda Total");
		expect(prompts[0]).toContain("FAKTA-SUMBER-XYZ");
		expect(prompts[0]).toMatch(/MINIMAL 780 kata/);
		expect(prompts).toHaveLength(2);
	});
});

describe("gambar tambahan", () => {
	const page = `<html><head><meta property="og:image" content="https://cdn.test/hero.jpg?w=1200"></head><body>
		<header><img src="/logo.png"></header>
		<article>${"<p>Paragraf isi artikel yang cukup panjang untuk dibaca pembaca setia kami.</p>".repeat(30)}
			<img src="https://cdn.test/hero.jpg?w=600">
			<img data-src="https://cdn.test/foto-1.jpg" src="data:image/gif;base64,AAA">
			<img src="https://cdn.test/icon-share.png">
			<img src="https://cdn.test/kecil.jpg" width="80" height="80">
			<img srcset="https://cdn.test/foto-2-400.jpg 400w, https://cdn.test/foto-2-1200.jpg 1200w">
			<img src="/foto-3.webp">
			<img src="https://cdn.test/foto-1.jpg?v=2">
			<a href="https://news.test/artikel-lain"><img src="https://cdn.test/thumb-baca-juga.jpg"></a>
			<a href="https://cdn.test/foto-4-besar.jpg"><img src="https://cdn.test/foto-4.jpg"></a>
			<aside><img src="https://cdn.test/sidebar.jpg"></aside>
		</article></body></html>`;
	it("ambil foto isi saja (lazy-load, srcset, relatif), tanpa logo/ikon/kecil/duplikat", () => {
		expect(extractArticleImages(page, "https://news.test/a/1", 5, ["https://cdn.test/hero.jpg?w=1200"])).toEqual([
			"https://cdn.test/foto-1.jpg",
			"https://cdn.test/foto-2-1200.jpg",
			"https://news.test/foto-3.webp",
			"https://cdn.test/foto-4.jpg",
		]);
	});
	it("teks sumber diambil dari paragraf isi", () => {
		expect(extractArticleText(page, 200)).toMatch(/^Paragraf isi artikel/);
	});
	it("foto disisipkan merata di antara paragraf, tidak sesudah paragraf terakhir", () => {
		const html = Array.from({ length: 9 }, (_, i) => `<p>p${i + 1}</p>`).join("");
		const out = insertImagesBetweenParagraphs(html, ["https://x/1.jpg", "https://x/2.jpg"], 'Judul "A"', "Detik");
		expect(out.match(/<figure/g)).toHaveLength(2);
		expect(out.indexOf("1.jpg")).toBeGreaterThan(out.indexOf("p3</p>"));
		expect(out.indexOf("2.jpg")).toBeGreaterThan(out.indexOf("p6</p>"));
		expect(out.trim().endsWith("<p>p9</p>")).toBe(true);
		expect(out).toContain('alt="Judul &quot;A&quot; (2)"');
		expect(out).toContain("Foto: Detik");
	});
});

describe("endpoint panel AI provider", () => {
	async function adminToken() {
		const { env: e, db } = fakeEnv();
		db.prepare(`INSERT INTO users (username, username_lc, password_hash, role) VALUES ('Bos','bos',?, 'ADMIN')`).run(await hashPassword("pw"));
		const login = (await checkLogin(e, "Bos", "pw", "")) as { sessionToken: string };
		return { e, token: login.sessionToken };
	}

	it("tambah, edit tanpa ganti key, urutkan, top-up, hapus -- key tidak pernah keluar utuh", async () => {
		const { e, token } = await adminToken();
		let r = await botAiSave(e, token, { name: "DattioAI", base_url: "https://bandelbanget.xyz/v1/", key: "sk-qwen-rahasia-sekali-123456", model: "deepseek-v4-flash", quota: "100.000.000", valid_days: "28" });
		r = await botAiSave(e, token, { name: "Cadangan", base_url: "https://b.test/v1", key: "sk-b-xxxxxxxxxxxx", model: "glm-5.3" });
		expect(r.providers.map((p) => p.name)).toEqual(["DattioAI", "Cadangan"]);
		expect(JSON.stringify(r)).not.toContain("rahasia-sekali");
		const d = r.providers[0];
		expect(d).toMatchObject({ base_url: "https://bandelbanget.xyz/v1", quota: 100_000_000, valid_days: 28, usable: true, key_mask: "sk-qwen…3456" });
		expect(d.activated).toMatch(/^\d{4}-\d{2}-\d{2}$/);

		// Edit tanpa mengisi key -> key lama tetap.
		r = await botAiSave(e, token, { id: d.id, name: "Dattio", key: "", model: "kimi-k3" });
		expect(JSON.parse((await botCfg(env)).ai_providers)[0]).toMatchObject({ name: "Dattio", model: "kimi-k3", key: "sk-qwen-rahasia-sekali-123456" });

		r = await botAiReorder(e, token, { ids: [r.providers[1].id] });
		expect(r.providers.map((p) => p.name)).toEqual(["Cadangan", "Dattio"]);
		expect(r.active_id).toBe(r.providers[0].id);

		r = await botAiTopUp(e, token, { id: d.id, add_tokens: "50000000" });
		expect(r.providers.find((p) => p.id === d.id)!.quota).toBe(150_000_000);

		r = await botAiDelete(e, token, { id: d.id });
		expect(r.providers.map((p) => p.name)).toEqual(["Cadangan"]);
		expect((await botAiList(e, token)).providers).toHaveLength(1);
	});

	it("validasi input: key wajib untuk provider baru, base URL https", async () => {
		const { e, token } = await adminToken();
		await expect(botAiSave(e, token, { name: "X", base_url: "https://x.test/v1", model: "m" })).rejects.toThrow(/API key wajib/);
		await expect(botAiSave(e, token, { name: "X", base_url: "http://x.test/v1", key: "k", model: "m" })).rejects.toThrow(/https/);
	});
});

describe("proses artikel ujung-ke-ujung (situs sendiri)", () => {
	it("artikel tersimpan dgn gambar utama + foto tambahan, AI membaca teks sumber, token tercatat", async () => {
		const { botNewsRun } = await import("../src/lib/bot-news");
		await botCfgSet(env, {
			ai_providers: JSON.stringify([prov({ name: "DattioAI" })]),
			site_per_run: "1",
			per_run: "0",
			attribution: "1",
		});
		turso.current!.raw
			.prepare(`INSERT INTO news_article (id, source, url, url_hash, title, excerpt, image_url, status, found_at, category) VALUES (1, 'Detik', 'https://news.test/a/1', 'h1', 'Banjir melanda kota', 'ringkas', '', 'new', '2026-10-05 10:00:00', 'umum')`)
			.run();
		const paras = Array.from({ length: 14 }, (_, i) => `<p>Paragraf ${i + 1}: ${"Isi berita panjang dengan fakta penting dari lapangan. ".repeat(6)}</p>`).join("");
		let prompt = "";
		// Panggilan AI dijawab mockFetch; halaman sumber (HTML) dijawab stub di bawah.
		mockFetch((_url, body) => {
			prompt = body.messages[0].content;
			return chatOk(JSON.stringify({ title: "Air Merendam Ratusan Rumah Warga", body_html: paras, meta_description: "m", category: "umum", keywords: ["banjir"] }), 4321);
		});
		const pageHtml = `<html><head><meta property="og:image" content="https://cdn.test/hero.jpg"></head><body><article>
			<p>Hujan deras sejak pagi membuat sungai meluap dan merendam permukiman warga di tiga kecamatan.</p>
			${"<p>Warga mengungsi ke balai desa sambil menunggu bantuan logistik dari pemerintah daerah setempat.</p>".repeat(20)}
			<img src="https://cdn.test/foto-a.jpg"><img src="https://cdn.test/foto-b.jpg"><img src="https://cdn.test/foto-c.jpg"><img src="https://cdn.test/foto-d.jpg">
		</article></body></html>`;
		const realFetch = globalThis.fetch;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
			String(input) === "https://news.test/a/1" ? new Response(pageHtml, { status: 200 }) : realFetch(input, init),
		);
		const r = await botNewsRun(env, { force: true, mode: "site" });
		expect(r.siteOnly).toBe(1);
		const row = turso.current!.raw.prepare(`SELECT status, rewritten_html, image_url FROM news_article WHERE id = 1`).get() as Record<string, string>;
		expect(row.status).toBe("site");
		expect(row.image_url).toBe("https://cdn.test/hero.jpg");
		const html = row.rewritten_html;
		expect(html.indexOf("hero.jpg")).toBeLessThan(html.indexOf("Paragraf 1:"));
		// Bawaan 4 gambar per artikel = 1 utama + 3 foto isi, disebar di antara paragraf.
		expect(html.match(/<figure/g)).toHaveLength(3);
		expect(html).toContain("foto-a.jpg");
		expect(html).not.toContain("foto-d.jpg");
		expect(html).toContain("Foto: Detik");
		expect(prompt).toContain("merendam permukiman warga");
		expect(usageRows()).toEqual([{ provider: "DattioAI", total_tokens: 4321, ok: 1, purpose: "news-rewrite" }]);
		// Panjang bawaan dinaikkan sekali (12-18 paragraf).
		const cfg = await botCfg(env);
		expect([cfg.para_min, cfg.para_max, cfg.images_per_article, cfg.content_v2]).toEqual(["12", "18", "4", "1"]);
	});

	it("tanpa AI provider aktif: antrean tidak disentuh sama sekali", async () => {
		const { botNewsRun } = await import("../src/lib/bot-news");
		await botCfgSet(env, { ai_providers: "[]", site_per_run: "1", per_run: "0" });
		turso.current!.raw
			.prepare(`INSERT INTO news_article (id, source, url, url_hash, title, status, found_at) VALUES (2, 'X', 'https://news.test/2', 'h2', 'Judul', 'new', '2026-10-05 10:00:00')`)
			.run();
		const calls = mockFetch(() => chatOk("x"));
		const r = await botNewsRun(env, { force: true, mode: "site" });
		expect(r.message).toMatch(/Tidak ada AI provider aktif/);
		expect(calls).toEqual([]);
		expect((turso.current!.raw.prepare(`SELECT status FROM news_article WHERE id = 2`).get() as { status: string }).status).toBe("new");
	});
});

describe("provider lambat / batas output", () => {
	it("Groq 'Request too large' -> diulang sekali dgn max_tokens separuh", async () => {
		await botCfgSet(env, { ai_providers: JSON.stringify([prov()]) });
		const sent: number[] = [];
		mockFetch((_u, body) => {
			sent.push(body.max_tokens);
			return body.max_tokens > 4096
				? { status: 429, body: { error: { message: "Request too large for model `qwen/qwen3.8-27b` ... on output tokens" } } }
				: chatOk("ok");
		});
		const r = await aiGenerate(env, await botCfg(env), { purpose: "t", messages: [{ role: "user", content: "x" }], maxTokens: 8192 }, (t) => t);
		expect(r.value).toBe("ok");
		expect(sent).toEqual([8192, 4096]);
	});

	it("server diam -> berhenti menunggu & pindah ke provider berikutnya dgn pesan jelas", async () => {
		const { networkErrorText } = await import("../src/lib/ai-provider");
		const ff = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET", message: "socket hang up" } });
		expect(networkErrorText(ff)).toBe("fetch failed -- ECONNRESET -- socket hang up");

		await botCfgSet(env, { ai_providers: JSON.stringify([prov({ name: "Lambat" }), prov({ id: "b", name: "B", base_url: "https://b.test/v1" })]) });
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).startsWith("https://a.test")) {
				// Tidak pernah membalas sampai dibatalkan.
				return new Promise<Response>((_res, rej) =>
					init!.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))),
				);
			}
			return new Response(JSON.stringify(chatOk("dari B").body), { status: 200 });
		});
		const r = await aiGenerate(env, await botCfg(env), { purpose: "t", messages: [{ role: "user", content: "x" }], firstByteMs: 30 }, (t) => t);
		expect(r.call.providerName).toBe("B");
		const row = turso.current!.raw.prepare(`SELECT provider, ok, err, estimated, total_tokens FROM ai_usage ORDER BY id`).all()[0] as Record<string, unknown>;
		expect(row).toMatchObject({ provider: "Lambat", ok: 0, estimated: 1 });
		expect(String(row.err)).toMatch(/belum mulai membalas setelah 0 detik/);
		expect(Number(row.total_tokens)).toBeGreaterThan(0); // prompt tetap ditagih provider -> ikut dihitung
	});
});

/** Jawaban SSE: potongan dikirim satu per satu dgn jeda `gapMs`; `stallAfter` = berhenti total sesudah potongan ke-n. */
function sseResponse(pieces: string[], opts: { gapMs?: number; usage?: object; stallAfter?: number; signal?: AbortSignal } = {}) {
	const enc = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		async start(ctl) {
			opts.signal?.addEventListener("abort", () => ctl.error(Object.assign(new Error("aborted"), { name: "AbortError" })));
			for (let i = 0; i < pieces.length; i++) {
				if (opts.stallAfter != null && i >= opts.stallAfter) return; // diam selamanya
				await new Promise((r) => setTimeout(r, opts.gapMs ?? 0));
				// Satu event sengaja dipecah di tengah baris untuk menguji penyambungan buffer.
				const line = `data: ${JSON.stringify({ model: "deepseek-v4-flash", choices: [{ delta: { content: pieces[i] } }] })}\n\n`;
				ctl.enqueue(enc.encode(line.slice(0, 10)));
				ctl.enqueue(enc.encode(line.slice(10)));
			}
			if (opts.usage) ctl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage: opts.usage })}\n\n`));
			ctl.enqueue(enc.encode("data: [DONE]\n\n"));
			ctl.close();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("jawaban streaming (provider lambat tapi tetap menulis)", () => {
	const msgs = [{ role: "user", content: "tulis artikel" }];

	it("total waktu > batas diam tetap diterima selama potongan terus datang; token dari server tercatat", async () => {
		await botCfgSet(env, { ai_providers: JSON.stringify([prov({ name: "DattioAI" })]) });
		const sent: any[] = [];
		vi.stubGlobal("fetch", async (_i: RequestInfo | URL, init?: RequestInit) => {
			sent.push(JSON.parse(String(init!.body)));
			return sseResponse(["Para", "graf ", "satu."], { gapMs: 25, usage: { prompt_tokens: 9000, completion_tokens: 4000, total_tokens: 13000 }, signal: init!.signal! });
		});
		// Batas diam 40 ms, tapi total jawaban ~75 ms -> tidak boleh diputus.
		const r = await aiGenerate(env, await botCfg(env), { purpose: "t", messages: msgs, firstByteMs: 200, idleMs: 40 }, (t) => t);
		expect(r.value).toBe("Paragraf satu.");
		expect(r.call).toMatchObject({ totalTokens: 13000, estimated: false, model: "deepseek-v4-flash" });
		expect(sent[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
		expect(usageRows()).toEqual([{ provider: "DattioAI", total_tokens: 13000, ok: 1, purpose: "t" }]);
	});

	it("server berhenti di tengah jawaban -> diputus, potongan yang sudah diterima ikut dihitung", async () => {
		await botCfgSet(env, { ai_providers: JSON.stringify([prov({ name: "DattioAI" })]) });
		vi.stubGlobal("fetch", async (_i: RequestInfo | URL, init?: RequestInit) =>
			sseResponse(["x".repeat(400), "y".repeat(400), "tidak pernah"], { stallAfter: 2, signal: init!.signal! }),
		);
		const err = await aiGenerate(env, await botCfg(env), { purpose: "t", messages: msgs, firstByteMs: 200, idleMs: 30 }, (t) => t).catch((e) => e);
		expect(String(err.message)).toMatch(/berhenti mengirim jawaban selama 0 detik/);
		const row = turso.current!.raw.prepare(`SELECT ok, estimated, completion_tokens FROM ai_usage`).get() as Record<string, number>;
		expect(row).toMatchObject({ ok: 0, estimated: 1 });
		expect(row.completion_tokens).toBeGreaterThanOrEqual(100); // >= 400 karakter / 4
	});

	it("provider menolak stream_options -> diulang tanpa itu (tetap stream)", async () => {
		await botCfgSet(env, { ai_providers: JSON.stringify([prov()]) });
		const sent: any[] = [];
		vi.stubGlobal("fetch", async (_i: RequestInfo | URL, init?: RequestInit) => {
			const b = JSON.parse(String(init!.body));
			sent.push(b);
			if (b.stream_options) return new Response(JSON.stringify({ error: { message: "Unrecognized request argument: stream_options" } }), { status: 400 });
			return sseResponse(["ok"], { signal: init!.signal! });
		});
		const r = await aiGenerate(env, await botCfg(env), { purpose: "t", messages: msgs }, (t) => t);
		expect(r.value).toBe("ok");
		expect(r.call.estimated).toBe(true); // tanpa usage dari server -> perkiraan
		expect(sent.map((b) => [!!b.stream, !!b.stream_options])).toEqual([[true, true], [true, false]]);
	});

	it("provider menolak stream sama sekali -> diulang tanpa stream", async () => {
		await botCfgSet(env, { ai_providers: JSON.stringify([prov()]) });
		const sent: any[] = [];
		mockFetch((_u, body) => {
			sent.push(body);
			return body.stream ? { status: 400, body: { error: { message: "stream is not supported" } } } : chatOk("biasa");
		});
		const r = await aiGenerate(env, await botCfg(env), { purpose: "t", messages: msgs }, (t) => t);
		expect(r.value).toBe("biasa");
		expect(sent.map((b) => !!b.stream)).toEqual([true, false]);
	});

	it("error yang dikirim lewat stream dianggap gagal", async () => {
		await botCfgSet(env, { ai_providers: JSON.stringify([prov()]) });
		vi.stubGlobal("fetch", async () =>
			new Response(new TextEncoder().encode(`data: {"error":{"message":"upstream overloaded"}}\n\ndata: [DONE]\n\n`), { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		await expect(aiGenerate(env, await botCfg(env), { purpose: "t", messages: msgs }, (t) => t)).rejects.toThrow(/upstream overloaded/);
	});
});

describe("jeda provider yang bermasalah", () => {
	const msgs = [{ role: "user", content: "x" }];

	it("lama jeda per jenis error", () => {
		expect(cooldownMsFor("Gagal menghubungi server: server belum mulai membalas setelah 120 detik")).toBe(10 * 60_000);
		expect(cooldownMsFor("Gagal menghubungi server: server berhenti mengirim jawaban selama 60 detik")).toBe(10 * 60_000);
		expect(cooldownMsFor("Gagal menghubungi server: fetch failed -- ECONNRESET")).toBe(5 * 60_000);
		expect(cooldownMsFor("HTTP 429 Rate limit reached for model `qwen`. Please try again in 7.5s.")).toBe(9_500);
		expect(cooldownMsFor("HTTP 429 Rate limit reached ... tokens per day (TPD). Please try again in 1h2m3s.")).toBe(60 * 60_000);
		expect(cooldownMsFor("HTTP 429 Rate limit reached. Please try again in 4m30s.")).toBe(272_000);
		expect(cooldownMsFor("HTTP 429 slow down")).toBe(2 * 60_000);
		expect(cooldownMsFor("HTTP 429 Request too large for model on output tokens")).toBe(0);
		expect(cooldownMsFor("HTTP 503 overloaded")).toBe(2 * 60_000);
		expect(cooldownMsFor("HTTP 401 invalid api key")).toBe(30 * 60_000);
		expect(cooldownMsFor("HTTP 400 bad request")).toBe(0);
		expect(cooldownMsFor("artikel terlalu pendek")).toBe(0);
	});

	it("provider diam dilewati di artikel berikutnya -- juga oleh proses baru (run GitHub berikutnya)", async () => {
		await botCfgSet(env, { ai_providers: JSON.stringify([prov({ name: "Diam" }), prov({ id: "b", name: "B", base_url: "https://b.test/v1" })]) });
		const hosts: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			hosts.push(new URL(String(input)).host);
			if (String(input).startsWith("https://a.test")) throw new AiTimeoutError("server belum mulai membalas setelah 120 detik", 0);
			return new Response(JSON.stringify(chatOk("dari B").body), { status: 200 });
		});
		await aiGenerate(env, await botCfg(env), { purpose: "t", messages: msgs }, (t) => t);
		await aiGenerate(env, await botCfg(env), { purpose: "t", messages: msgs }, (t) => t);
		expect(hosts).toEqual(["a.test", "b.test", "b.test"]);

		aiResetCooldowns(); // proses baru: memori kosong, jeda dibaca dari bot_kv
		const cfg = await botCfg(env);
		expect(aiCooldown(cfg, prov({ name: "Diam" }))?.reason).toMatch(/belum mulai membalas/);
		await aiGenerate(env, cfg, { purpose: "t", messages: msgs }, (t) => t);
		expect(hosts).toEqual(["a.test", "b.test", "b.test", "b.test"]);
	});

	it("ganti model = jeda hilang; panggilan sukses menghapus jeda", async () => {
		await botCfgSet(env, { ai_providers: JSON.stringify([prov({ model: "auto" })]) });
		let fail = true;
		mockFetch(() => (fail ? { status: 503, body: { error: { message: "busy" } } } : chatOk("ok")));
		await expect(aiGenerate(env, await botCfg(env), { purpose: "t", messages: msgs }, (t) => t)).rejects.toThrow(/HTTP 503/);
		expect(aiCooldown(await botCfg(env), prov({ model: "auto" }))).not.toBeNull();
		expect(aiCooldown(await botCfg(env), prov({ model: "deepseek-v4-flash" }))).toBeNull();

		await botCfgSet(env, { ai_providers: JSON.stringify([prov({ model: "deepseek-v4-flash" })]) });
		fail = false;
		const r = await aiGenerate(env, await botCfg(env), { purpose: "t", messages: msgs }, (t) => t);
		expect(r.value).toBe("ok");
		expect(JSON.parse((await botCfg(env)).ai_cooldowns || "{}")).toEqual({});
	});

	it("semua provider dijeda -> AiUnavailableError tanpa panggilan jaringan; waktu siap terdekat diketahui", async () => {
		await botCfgSet(env, { ai_providers: JSON.stringify([prov()]) });
		const calls = mockFetch(() => ({ status: 429, body: { error: { message: "Rate limit reached. Please try again in 20s." } } }));
		await expect(aiGenerate(env, await botCfg(env), { purpose: "t", messages: msgs }, (t) => t)).rejects.toThrow(/HTTP 429/);
		expect(calls.length).toBe(1);
		const err = await aiGenerate(env, await botCfg(env), { purpose: "t", messages: msgs }, (t) => t).catch((e) => e);
		expect(err).toBeInstanceOf(AiUnavailableError);
		expect(err.message).toMatch(/dijeda/);
		expect(calls.length).toBe(1);
		const wait = await aiNextReadyInMs(env, await botCfg(env));
		expect(wait).toBeGreaterThan(15_000);
		expect(wait).toBeLessThanOrEqual(22_000);
	});

	it("PROSES manual menghapus semua jeda (memori & bot_kv)", async () => {
		await botCfgSet(env, { ai_providers: JSON.stringify([prov()]) });
		mockFetch(() => ({ status: 503, body: { error: { message: "busy" } } }));
		await aiGenerate(env, await botCfg(env), { purpose: "t", messages: msgs }, (t) => t).catch(() => {});
		expect(aiCooldown(await botCfg(env), prov())).not.toBeNull();
		await aiClearAllCooldowns(env, await botCfg(env));
		aiResetCooldowns(); // proses baru
		expect(aiCooldown(await botCfg(env), prov())).toBeNull();
		expect(await aiNextReadyInMs(env, await botCfg(env))).toBe(0);
	});

	it("simpan ulang provider di panel menghapus jedanya", async () => {
		await botCfgSet(env, { ai_providers: JSON.stringify([prov()]) });
		mockFetch(() => ({ status: 500, body: { error: { message: "down" } } }));
		await aiGenerate(env, await botCfg(env), { purpose: "t", messages: msgs }, (t) => t).catch(() => {});
		expect(aiCooldown(await botCfg(env), prov())).not.toBeNull();
		const { env: e, db } = fakeEnv();
		db.prepare(`INSERT INTO users (username, username_lc, password_hash, role) VALUES ('Bos','bos',?, 'ADMIN')`).run(await hashPassword("pw"));
		const { sessionToken } = (await checkLogin(e, "Bos", "pw", "")) as { sessionToken: string };
		const res: any = await botAiSave(e, sessionToken, { id: "a", name: "A" });
		expect(res.providers[0].cooldown_until).toBe(0);
		expect(aiCooldown(await botCfg(env), prov())).toBeNull();
	});
});
