import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { assistantAsk } from "../src/api/assistant";
import { checkLogin } from "../src/api/auth";
import { botAiSave } from "../src/api/bot";
import { aiResetCooldowns } from "../src/lib/ai-provider";
import { hashPassword } from "../src/lib/crypto";
import { resetSysCache } from "../src/lib/settings";
import { fakeEnv, fakeTurso } from "./helpers/fake-env";

let ctx: ReturnType<typeof fakeEnv>;
const sent: { url: string; body: any; auth: string }[] = [];

beforeEach(async () => {
	turso.current = fakeTurso();
	ctx = fakeEnv();
	resetSysCache();
	aiResetCooldowns();
	sent.length = 0;
	vi.unstubAllGlobals();
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		sent.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null, auth: String((init?.headers as Record<string, string>)?.authorization ?? (init?.headers as Record<string, string>)?.Authorization ?? "") });
		return new Response(JSON.stringify({ model: "llama-3.3-70b", choices: [{ message: { content: "1. Buka menu **Result**.\n2. Klik **KIRIM SEMUA SISTEM**." } }], usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 } }), { status: 200, headers: { "content-type": "application/json" } });
	});
	for (const [u, p, r] of [["Boss", "pw-boss", "ADMIN"], ["Opr", "pw-opr", "OPERATOR"]] as const)
		ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES (?, ?, ?, ?, 'AKTIF')`).run(u, u.toLowerCase(), await hashPassword(p), r);
	try {
		ctx.db.exec(`ALTER TABLE users ADD COLUMN menus TEXT NOT NULL DEFAULT ''`);
	} catch {
		/* sudah ada */
	}
	ctx.db.prepare(`UPDATE users SET menus = ? WHERE username_lc = 'opr'`).run(JSON.stringify(["result", "activity"]));
});
const tok = async (u: string, p: string) => ((await checkLogin(ctx.env, u, p, "")) as { sessionToken: string }).sessionToken;

describe("Asisten KD memakai AI Provider dari menu BOT (mis. Groq)", () => {
	it("memanggil provider terdaftar dengan konteks role/menu + pengetahuan relevan, tanpa kebocoran key", async () => {
		const boss = await tok("Boss", "pw-boss");
		await botAiSave(ctx.env, boss, { name: "Groq", base_url: "https://api.groq.com/openai/v1", key: "gsk_rahasia_1234567890", model: "llama-3.3-70b-versatile" });
		const r = (await assistantAsk(ctx.env, await tok("Opr", "pw-opr"), "Bagaimana cara kirim result ke telegram?", [{ role: "user", content: "halo" }, { role: "assistant", content: "hai" }])) as { success: boolean; answer: string };
		expect(r.success).toBe(true);
		expect(r.answer).toContain("KIRIM SEMUA SISTEM");
		const call = sent.find((c) => c.url.includes("groq.com"))!;
		expect(call.url).toBe("https://api.groq.com/openai/v1/chat/completions");
		expect(call.auth).toContain("gsk_rahasia_1234567890"); // dikirim hanya ke provider
		const sys = call.body.messages[0].content as string;
		expect(sys).toContain("role=OPERATOR");
		expect(sys).toContain("Result, Aktivitas"); // hanya menu yang diizinkan
		expect(sys).toContain("## MENU Result");
		expect(sys).not.toContain("gsk_rahasia");
		expect(call.body.messages.at(-1)).toEqual({ role: "user", content: "Bagaimana cara kirim result ke telegram?" });
		expect(JSON.stringify(r)).not.toContain("gsk_rahasia");
		// prompt hemat: jauh di bawah seluruh manual
		expect(sys.length).toBeLessThan(11000);
	});
});
