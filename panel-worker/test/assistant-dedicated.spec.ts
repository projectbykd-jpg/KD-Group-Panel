import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { assistantAsk, assistantGetConfig, assistantModels, assistantSaveConfig, assistantTest } from "../src/api/assistant";
import { checkLogin } from "../src/api/auth";
import { botAiSave } from "../src/api/bot";
import { aiResetCooldowns } from "../src/lib/ai-provider";
import { hashPassword } from "../src/lib/crypto";
import { resetSysCache } from "../src/lib/settings";
import { fakeEnv, fakeTurso } from "./helpers/fake-env";

let ctx: ReturnType<typeof fakeEnv>;
let sent: { url: string; auth: string; body: any }[] = [];
let failHosts: string[] = [];

beforeEach(async () => {
	turso.current = fakeTurso();
	ctx = fakeEnv();
	resetSysCache();
	aiResetCooldowns();
	sent = [];
	failHosts = [];
	vi.unstubAllGlobals();
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const h = (init?.headers ?? {}) as Record<string, string>;
		sent.push({ url, auth: String(h.authorization ?? h.Authorization ?? ""), body: init?.body ? JSON.parse(String(init.body)) : null });
		if (failHosts.some((x) => url.includes(x))) return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } });
		return new Response(JSON.stringify({ model: "llama-x", choices: [{ message: { content: "OK dari " + new URL(url).host } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200, headers: { "content-type": "application/json" } });
	});
	for (const [u, p, r] of [["Boss", "pw-boss", "ADMIN"], ["Opr", "pw-opr", "OPERATOR"]] as const)
		ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES (?, ?, ?, ?, 'AKTIF')`).run(u, u.toLowerCase(), await hashPassword(p), r);
});
const tok = async (u: string, p: string) => ((await checkLogin(ctx.env, u, p, "")) as { sessionToken: string }).sessionToken;
const KEY = "gsk_khusus_asisten_1234567890";

describe("API key KHUSUS Asisten KD (terpisah dari provider bot)", () => {
	it("hanya admin yang menyimpan; key tidak pernah dikembalikan; input divalidasi", async () => {
		const boss = await tok("Boss", "pw-boss");
		await expect(assistantSaveConfig(ctx.env, await tok("Opr", "pw-opr"), { base_url: "https://api.groq.com/openai/v1", key: KEY, model: "llama-3.3-70b-versatile" })).rejects.toThrow();
		await expect(assistantSaveConfig(ctx.env, boss, { base_url: "http://x.test/v1", key: KEY, model: "m" })).rejects.toThrow(/https/);
		await expect(assistantSaveConfig(ctx.env, boss, { base_url: "https://x.test/v1", key: "pendek", model: "m" })).rejects.toThrow(/API key/);
		await expect(assistantSaveConfig(ctx.env, boss, { base_url: "https://x.test/v1", key: KEY, model: "dua model" })).rejects.toThrow(/Model/);
		const r = (await assistantSaveConfig(ctx.env, boss, { base_url: "https://api.groq.com/openai/v1/", key: KEY, model: "llama-3.3-70b-versatile" })) as { dedicated: { configured: boolean; base_url: string; key_mask: string } };
		expect(r.dedicated).toMatchObject({ configured: true, base_url: "https://api.groq.com/openai/v1" });
		expect(JSON.stringify(r)).not.toContain(KEY);
		expect(JSON.stringify(await assistantGetConfig(ctx.env, boss))).not.toContain(KEY);
		// key kosong = pertahankan yang lama; clear = hapus
		await assistantSaveConfig(ctx.env, boss, { model: "llama-3.1-8b-instant" });
		expect(((await assistantGetConfig(ctx.env, boss)) as { dedicated: { model: string } }).dedicated.model).toBe("llama-3.1-8b-instant");
		await assistantSaveConfig(ctx.env, boss, { clear: true });
		expect(((await assistantGetConfig(ctx.env, boss)) as { dedicated: { configured: boolean } }).dedicated.configured).toBe(false);
	});

	it("memakai key khusus dan TIDAK menyentuh provider bot lain (kuota terpisah)", async () => {
		const boss = await tok("Boss", "pw-boss");
		await botAiSave(ctx.env, boss, { name: "DattioAI", base_url: "https://dattio.test/v1", key: "sk-dattio-rahasia-123456", model: "deepseek" });
		await assistantSaveConfig(ctx.env, boss, { base_url: "https://api.groq.com/openai/v1", key: KEY, model: "llama-3.3-70b-versatile" });
		const r = (await assistantAsk(ctx.env, await tok("Opr", "pw-opr"), "cara kirim result?", [])) as { answer: string; via: string };
		expect(r.answer).toContain("api.groq.com");
		expect(r.via).toContain("key khusus");
		expect(sent.every((c) => c.url.includes("api.groq.com"))).toBe(true);
		expect(sent[0].auth).toContain(KEY);
		expect(JSON.stringify(r)).not.toContain(KEY);
	});

	it("key khusus gagal -> error; provider bot TIDAK dipakai sebagai cadangan (kuota terpisah)", async () => {
		const boss = await tok("Boss", "pw-boss");
		await botAiSave(ctx.env, boss, { name: "Cadangan", base_url: "https://backup.test/v1", key: "sk-backup-rahasia-123456", model: "m1" });
		await assistantSaveConfig(ctx.env, boss, { base_url: "https://api.groq.com/openai/v1", key: KEY, model: "llama-3.3-70b-versatile" });
		failHosts = ["api.groq.com"];
		await expect(assistantAsk(ctx.env, await tok("Opr", "pw-opr"), "halo", [])).rejects.toThrow(/sibuk|bermasalah/);
		expect(sent.some((c) => c.url.includes("backup.test"))).toBe(false);
	});

	it("tanpa key khusus: sementara memakai provider bot; galat 403 diberi diagnosa; daftar model menyaring non-chat", async () => {
		const boss = await tok("Boss", "pw-boss");
		await botAiSave(ctx.env, boss, { name: "Cadangan", base_url: "https://backup.test/v1", key: "sk-backup-rahasia-123456", model: "m1" });
		expect(((await assistantAsk(ctx.env, await tok("Opr", "pw-opr"), "halo", [])) as { answer: string }).answer).toContain("backup.test");
		await assistantSaveConfig(ctx.env, boss, { base_url: "https://api.groq.com/openai/v1", key: KEY, model: "meta-llama/llama-prompt-guard-2-86m" });
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "llama-3.3-70b-versatile" }, { id: "whisper-large-v3" }, { id: "meta-llama/llama-prompt-guard-2-86m" }, { id: "llama-3.1-8b-instant" }] }), { status: 200, headers: { "content-type": "application/json" } });
			return new Response(JSON.stringify({ error: { message: "Forbidden" } }), { status: 403, headers: { "content-type": "application/json" } });
		});
		const t = (await assistantTest(ctx.env, boss)) as { success: boolean; message: string };
		expect(t.success).toBe(false);
		expect(t.message).toMatch(/Diagnosa/);
		expect(t.message).toMatch(/Key & URL VALID/);
		const m = (await assistantModels(ctx.env, boss, "", "")) as { models: string[]; hidden: number };
		expect(m.models).toEqual(["llama-3.1-8b-instant", "llama-3.3-70b-versatile"].sort());
		expect(m.hidden).toBe(2);
	});

	it("provider yang menolak permintaan tanpa User-Agent (403 Forbidden): Worker kini selalu mengirim User-Agent", async () => {
		const boss = await tok("Boss", "pw-boss");
		await assistantSaveConfig(ctx.env, boss, { base_url: "https://api.groq.com/openai/v1", key: KEY, model: "openai/gpt-oss-20b" });
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const ua = new Headers(init?.headers).get("user-agent");
			if (!ua) return new Response(JSON.stringify({ error: { message: "Forbidden" } }), { status: 403, headers: { "content-type": "application/json" } });
			return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }], model: "openai/gpt-oss-20b" }), { status: 200, headers: { "content-type": "application/json" } });
		});
		const t = (await assistantTest(ctx.env, boss)) as { success: boolean };
		expect(t.success).toBe(true);
	});

	it("model berpikir di Groq dijawab cepat: reasoning_effort dikirim (gpt-oss=low, qwen=none)", async () => {
		const boss = await tok("Boss", "pw-boss");
		await assistantSaveConfig(ctx.env, boss, { base_url: "https://api.groq.com/openai/v1", key: KEY, model: "openai/gpt-oss-20b" });
		await assistantAsk(ctx.env, await tok("Opr", "pw-opr"), "halo", []);
		expect(sent.at(-1)!.body.reasoning_effort).toBe("low");
		await assistantSaveConfig(ctx.env, boss, { model: "qwen/qwen3.8-27b" });
		await assistantAsk(ctx.env, await tok("Opr", "pw-opr"), "halo lagi", []);
		expect(sent.at(-1)!.body.reasoning_effort).toBe("none");
		await assistantSaveConfig(ctx.env, boss, { base_url: "https://other.test/v1", model: "openai/gpt-oss-20b" });
		await assistantAsk(ctx.env, await tok("Opr", "pw-opr"), "halo 3", []);
		expect(sent.at(-1)!.body.reasoning_effort).toBeUndefined(); // hanya untuk Groq
	});

	it("tes koneksi: sukses & gagal ditangani", async () => {
		const boss = await tok("Boss", "pw-boss");
		await expect(assistantTest(ctx.env, boss)).rejects.toThrow(/Belum ada key/);
		await assistantSaveConfig(ctx.env, boss, { base_url: "https://api.groq.com/openai/v1", key: KEY, model: "llama-3.3-70b-versatile" });
		expect(((await assistantTest(ctx.env, boss)) as { success: boolean }).success).toBe(true);
		failHosts = ["api.groq.com"];
		aiResetCooldowns();
		const bad = (await assistantTest(ctx.env, boss)) as { success: boolean; message?: string };
		expect(bad.success).toBe(false);
		expect(bad.message).not.toContain(KEY);
	});
});
