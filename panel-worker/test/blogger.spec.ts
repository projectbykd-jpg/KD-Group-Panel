import { beforeEach, describe, expect, it, vi } from "vitest";

// Turso tiruan dipasang lewat mock modul -- semua kode bot-news memakai getTurso(env).
const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import {
	botCfg,
	botCfgSet,
	botNewsRun,
	bloggerAuthUrl,
	bloggerExchangeCode,
	extractOAuthCode,
	requeueBloggerAuthFailures,
	resetBloggerTokenCache,
} from "../src/lib/bot-news";
import { botBloggerConnect, botBloggerTest } from "../src/api/bot";
import { checkLogin } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { fakeEnv, fakeTurso } from "./helpers/fake-env";

type FetchHandler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
function mockFetch(handler: FetchHandler) {
	const calls: string[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		const { status = 200, body } = handler(url, init);
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	});
	return calls;
}

const BASE_CFG = {
	enabled: "1",
	per_run: "2",
	daily_cap: "8",
	site_per_run: "0",
	blogger_client_id: "cid.apps.googleusercontent.com",
	blogger_client_secret: "secret",
	blogger_refresh_token: "1//old",
	blogger_blog_id: "8778418113588221802",
	groq_key: "gsk_test",
};

function addArticle(id: number, status = "new", error = "") {
	turso.current!.raw
		.prepare(`INSERT INTO news_article (id, url, url_hash, title, status, error, found_at) VALUES (?, ?, ?, ?, ?, ?, '2026-10-05 10:00:00')`)
		.run(id, `https://news.test/${id}`, `h${id}`, `Judul ${id}`, status, error);
}
const statusOf = (id: number) =>
	(turso.current!.raw.prepare(`SELECT status FROM news_article WHERE id = ?`).get(id) as { status: string }).status;

beforeEach(async () => {
	turso.current = fakeTurso();
	resetBloggerTokenCache();
	vi.unstubAllGlobals();
	await botCfgSet({} as Env, BASE_CFG);
});

describe("izin Blogger mati (invalid_grant)", () => {
	it("tidak mengambil/membakar artikel, menandai status terputus, dan memberi pesan jelas", async () => {
		addArticle(1);
		addArticle(2);
		const calls = mockFetch((url) =>
			url.includes("oauth2.googleapis.com/token")
				? { status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } }
				: { status: 500, body: { error: "tidak boleh dipanggil" } },
		);
		const r = await botNewsRun({} as Env, { force: true, mode: "blogger" });
		expect(r.posted).toBe(0);
		expect(r.message).toMatch(/Blogger terputus/);
		expect(r.bloggerBlocked).toMatch(/invalid_grant/);
		// Artikel tetap di antrean -- dulu langsung ditandai 'error'.
		expect(statusOf(1)).toBe("new");
		expect(statusOf(2)).toBe("new");
		// Hanya 1 panggilan ke Google, tidak ada panggilan AI/Blogger.
		expect(calls.filter((u) => !u.includes("oauth2.googleapis.com"))).toEqual([]);
		const cfg = await botCfg({} as Env);
		expect(cfg.blogger_auth_error).toMatch(/Blogger terputus/);
		expect(cfg.blogger_auth_error_at).not.toBe("");
	});

	it("status terputus dihapus lagi begitu token kembali valid", async () => {
		await botCfgSet({} as Env, { blogger_auth_error: "Blogger terputus: lama", blogger_auth_error_at: "x" });
		mockFetch((url) => (url.includes("oauth2") ? { body: { access_token: "ya29.ok", expires_in: 3600 } } : { body: {} }));
		await botNewsRun({} as Env, { force: true, mode: "blogger" }); // antrean kosong -> 0 posting
		expect((await botCfg({} as Env)).blogger_auth_error).toBe("");
	});
});

describe("hubungkan ulang Blogger", () => {
	it("link izin memakai client ID, scope blogger, offline + consent", async () => {
		const u = new URL(bloggerAuthUrl(await botCfg({} as Env)));
		expect(u.searchParams.get("client_id")).toBe(BASE_CFG.blogger_client_id);
		expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/blogger");
		expect(u.searchParams.get("access_type")).toBe("offline");
		expect(u.searchParams.get("prompt")).toBe("consent");
		expect(u.searchParams.get("redirect_uri")).toBe("http://localhost");
	});

	it("kode bisa ditempel sebagai URL lengkap atau kode mentah", () => {
		expect(extractOAuthCode("http://localhost/?code=4%2F0AbCdEf_gh&scope=https://www.googleapis.com/auth/blogger")).toBe("4/0AbCdEf_gh");
		expect(extractOAuthCode("  4/0AbCdEf_gh  ")).toBe("4/0AbCdEf_gh");
		expect(extractOAuthCode("")).toBe("");
	});

	it("menukar kode -> refresh token; app 'Testing' mencatat tanggal kedaluwarsa", async () => {
		let sent = "";
		mockFetch((_url, init) => {
			sent = String(init?.body ?? "");
			return { body: { access_token: "ya29", refresh_token: "1//new", refresh_token_expires_in: 604799 } };
		});
		const r = await bloggerExchangeCode(await botCfg({} as Env), "http://localhost/?code=4%2Fabcdefghijk");
		expect(r.refreshToken).toBe("1//new");
		expect(r.refreshExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
		const body = new URLSearchParams(sent);
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("4/abcdefghijk");
		expect(body.get("redirect_uri")).toBe("http://localhost");
	});

	it("kode basi memberi petunjuk mengulang dari langkah 1", async () => {
		mockFetch(() => ({ status: 400, body: { error: "invalid_grant" } }));
		await expect(bloggerExchangeCode(await botCfg({} as Env), "4/abcdefghijk")).rejects.toThrow(/ulangi dari langkah 1/);
	});

	it("endpoint panel: simpan token, verifikasi blog, kembalikan artikel yang gagal karena izin", async () => {
		addArticle(10, "error", 'Blogger OAuth refresh gagal: {"error":"invalid_grant"}');
		addArticle(11, "error", "Blogger terputus: izin Google kedaluwarsa");
		addArticle(12, "error", "Groq gagal: rate limit"); // error lain -> tidak disentuh
		await botCfgSet({} as Env, { blogger_auth_error: "Blogger terputus: lama" });

		const { env, db } = fakeEnv();
		db.prepare(`INSERT INTO users (username, username_lc, password_hash, role) VALUES ('Bos','bos',?, 'ADMIN')`).run(await hashPassword("pw"));
		const login = (await checkLogin(env, "Bos", "pw", "")) as { sessionToken: string };

		mockFetch((url) => {
			if (url.includes("oauth2.googleapis.com/token")) return { body: { access_token: "ya29.new", expires_in: 3600, refresh_token: "1//fresh" } };
			if (url.includes("/blogger/v3/blogs/")) return { body: { name: "LokalStore88", url: "https://lokalstore88.blogspot.com/" } };
			return { status: 404, body: {} };
		});
		const r = await botBloggerConnect(env, login.sessionToken, { code: "http://localhost/?code=4%2Fxyz1234567" });
		expect(r.success).toBe(true);
		expect(r.blog.name).toBe("LokalStore88");
		expect(r.requeued).toBe(2);
		expect(statusOf(10)).toBe("new");
		expect(statusOf(11)).toBe("new");
		expect(statusOf(12)).toBe("error");
		const cfg = await botCfg({} as Env);
		expect(cfg.blogger_refresh_token).toBe("1//fresh");
		expect(cfg.blogger_auth_error).toBe("");

		// Tes koneksi memakai token yang sama dan melaporkan blognya.
		const t = await botBloggerTest(env, login.sessionToken);
		expect(t.ok).toBe(true);
	});

	it("operator biasa tidak boleh mengubah koneksi Blogger", async () => {
		const { env, db } = fakeEnv();
		db.prepare(`INSERT INTO users (username, username_lc, password_hash, role) VALUES ('Op','op',?, 'OPERATOR')`).run(await hashPassword("pw"));
		const login = (await checkLogin(env, "Op", "pw", "")) as { sessionToken: string };
		await expect(botBloggerConnect(env, login.sessionToken, { code: "4/abcdefghijk" })).rejects.toThrow(/BOT atau ADMIN/);
	});

	it("requeue tidak menyentuh artikel yang error karena hal lain", async () => {
		addArticle(20, "error", "Blogger post gagal: quota");
		expect(await requeueBloggerAuthFailures({} as Env)).toBe(0);
	});
});
