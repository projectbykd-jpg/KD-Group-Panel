import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { fbDiagnose, explainFbError } from "../src/lib/fb-check";
import { botFbTest } from "../src/api/bot";
import { checkLogin } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { fakeEnv, fakeTurso } from "./helpers/fake-env";

beforeEach(() => {
	turso.current = fakeTurso();
});

const TOKEN = "EAAB" + "x".repeat(60);
const PAGE = "123456789012345";

type Route = (method: string, url: URL) => { status?: number; body: unknown };
function mockGraph(route: Route) {
	const calls: { method: string; url: string }[] = [];
	vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = (init?.method ?? "GET").toUpperCase();
		calls.push({ method, url: url.pathname });
		const r = route(method, url);
		return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
	}));
	return calls;
}
const gerr = (code: number, message: string, error_subcode?: number, status = 400) => ({ status, body: { error: { message, code, error_subcode } } });

afterEach(() => vi.unstubAllGlobals());

describe("diagnosa Facebook Page", () => {
	it("semua sehat: token halaman, halaman terbaca, posting tersembunyi dibuat lalu dihapus", async () => {
		const calls = mockGraph((m, u) => {
			if (m === "GET" && u.pathname.endsWith("/me")) return { body: { id: PAGE, name: "Kabar Lokalstore88" } };
			if (m === "GET" && u.pathname.endsWith("/" + PAGE)) return { body: { id: PAGE, name: "Kabar Lokalstore88", fan_count: 120 } };
			if (m === "POST" && u.pathname.endsWith("/feed")) return { body: { id: PAGE + "_999" } };
			if (m === "DELETE") return { body: { success: true } };
			return { status: 404, body: {} };
		});
		const r = await fbDiagnose(PAGE, TOKEN);
		expect(r.ok).toBe(true);
		expect(r.steps.map((s) => s.ok)).toEqual([true, true, true]);
		expect(r.verdict).toContain("SEHAT");
		expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST", "DELETE"]); // tes tersembunyi dibersihkan
	});

	it("token USER (bukan token halaman) -> vonis jelas, tidak lanjut memposting", async () => {
		const calls = mockGraph((m, u) => (u.pathname.endsWith("/me") ? { body: { id: "777", name: "Budi" } } : { status: 500, body: {} }));
		const r = await fbDiagnose(PAGE, TOKEN);
		expect(r.ok).toBe(false);
		expect(r.verdict).toMatch(/BUKAN halaman/);
		expect(r.verdict).toMatch(/token USER/);
		expect(calls).toHaveLength(1);
	});

	it("token kedaluwarsa / dicabut / tidak valid dibedakan", async () => {
		for (const [sub, re] of [[463, /KEDALUWARSA/], [460, /dicabut/], [467, /tidak valid lagi/], [undefined, /TIDAK VALID/]] as const) {
			mockGraph(() => gerr(190, "Error validating access token", sub as number | undefined, 401));
			const r = await fbDiagnose(PAGE, TOKEN);
			expect(r.ok).toBe(false);
			expect(r.verdict).toMatch(re);
		}
	});

	it("izin posting kurang (kode 200) terdeteksi di langkah posting", async () => {
		mockGraph((m, u) => {
			if (u.pathname.endsWith("/me")) return { body: { id: PAGE, name: "P" } };
			if (m === "GET") return { body: { id: PAGE, name: "P" } };
			return gerr(200, "(#200) Requires pages_manage_posts permission", undefined, 403);
		});
		const r = await fbDiagnose(PAGE, TOKEN);
		expect(r.ok).toBe(false);
		expect(r.steps.at(-1)).toMatchObject({ name: "Izin posting", ok: false });
		expect(r.verdict).toMatch(/pages_manage_posts/);
	});

	it("Page ID salah, rate limit, blokir, jaringan putus", () => {
		const wrongId = { status: 400, body: { error: { code: 100, message: "Unsupported get request. Object with ID '1' does not exist" } } };
		expect(explainFbError(wrongId, TOKEN)).toMatch(/Page ID SALAH/);
		expect(explainFbError({ status: 400, body: { error: { code: 4, message: "x" } } }, TOKEN)).toMatch(/BATAS KECEPATAN/);
		expect(explainFbError({ status: 400, body: { error: { code: 368, message: "x" } } }, TOKEN)).toMatch(/MEMBLOKIR/);
		expect(explainFbError({ status: 0, body: null, netError: "timeout" }, TOKEN)).toMatch(/tidak bisa menghubungi/);
	});

	it("token tidak pernah bocor ke hasil (walau Facebook memantulkannya di pesan galat)", async () => {
		mockGraph(() => gerr(1234, `weird error for ${TOKEN}`));
		const r = await fbDiagnose(PAGE, TOKEN);
		expect(JSON.stringify(r)).not.toContain(TOKEN);
	});

	it("posting tes sukses tetapi gagal dihapus -> beri id agar bisa dihapus manual", async () => {
		mockGraph((m, u) => {
			if (u.pathname.endsWith("/me") || m === "GET") return { body: { id: PAGE, name: "P" } };
			if (m === "POST") return { body: { id: PAGE + "_5" } };
			return gerr(10, "cannot delete", undefined, 403);
		});
		const r = await fbDiagnose(PAGE, TOKEN);
		expect(r.ok).toBe(true);
		expect(r.steps.at(-1)!.detail).toContain(PAGE + "_5");
	});
});

describe("endpoint botFbTest", () => {
	async function setup() {
		const ctx = fakeEnv();
		ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES ('Bos','bos',?, 'ADMIN','AKTIF')`).run(await hashPassword("pw"));
		ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES ('Opr','opr',?, 'OPERATOR','AKTIF')`).run(await hashPassword("pw"));
		const t = async (u: string) => ((await checkLogin(ctx.env, u, "pw", "")) as { sessionToken: string }).sessionToken;
		return { env: ctx.env, boss: await t("Bos"), opr: await t("Opr") };
	}

	it("OPERATOR ditolak; input tidak valid ditolak sebelum menyentuh Facebook", async () => {
		const { env, boss, opr } = await setup();
		const calls = mockGraph(() => ({ body: {} }));
		await expect(botFbTest(env, opr, { page_id: PAGE, page_token: TOKEN })).rejects.toThrow();
		expect(((await botFbTest(env, boss, { page_id: "abc", page_token: TOKEN })) as { success: boolean }).success).toBe(false);
		expect(((await botFbTest(env, boss, { page_id: PAGE, page_token: "" })) as { success: boolean }).success).toBe(false);
		expect(((await botFbTest(env, boss, { page_id: PAGE, page_token: "pendek" })) as { success: boolean }).success).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("ADMIN dengan data valid mendapat hasil diagnosa", async () => {
		const { env, boss } = await setup();
		mockGraph(() => gerr(190, "bad token", 463, 401));
		const r = (await botFbTest(env, boss, { page_id: PAGE, page_token: TOKEN })) as { success: boolean; ok: boolean; verdict: string };
		expect(r.success).toBe(true);
		expect(r.ok).toBe(false);
		expect(r.verdict).toMatch(/KEDALUWARSA/);
	});
});
