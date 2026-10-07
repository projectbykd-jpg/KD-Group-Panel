import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { adminSaveSystemSettings } from "../src/api/admin";
import { assistantAsk, cleanHistory } from "../src/api/assistant";
import { checkLogin } from "../src/api/auth";
import { ASSISTANT_KB_VERSION, KB_ADMIN_TABS, KB_GENERAL, KB_PAGES, buildKnowledgeText, selectKnowledge } from "../src/lib/assistant-kb";
import { hashPassword } from "../src/lib/crypto";
import { MENU_ITEMS } from "../src/lib/menus";
import { SYS_SETTINGS, resetSysCache } from "../src/lib/settings";
import { fakeEnv } from "./helpers/fake-env";

const html: string = String(readFileSync("ui-src/Index.html", "utf8"));

describe("basis pengetahuan Asisten KD wajib mengikuti fitur", () => {
	it("setiap menu di sidebar (nav-*) punya penjelasan", () => {
		const ids = [...html.matchAll(/id="nav-([a-z-]+)"/g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(15);
		const missing = ids.filter((id) => !KB_PAGES[id]);
		expect(missing, `Tambahkan penjelasan menu ini ke src/lib/assistant-kb.ts (KB_PAGES): ${missing.join(", ")}`).toEqual([]);
	});

	it("setiap tab menu Admin punya penjelasan", () => {
		const tabs = [...html.matchAll(/data-admin-tab="([a-z]+)"/g)].map((m) => m[1]);
		const missing = tabs.filter((t) => !KB_ADMIN_TABS[t]);
		expect(missing, `Tambahkan ke KB_ADMIN_TABS: ${missing.join(", ")}`).toEqual([]);
	});

	it("setiap menu hak-akses (MENU_ITEMS) disebut label-nya", () => {
		const kb = buildKnowledgeText().toLowerCase();
		const missing = MENU_ITEMS.filter((m) => !kb.includes(m.label.toLowerCase())).map((m) => m.label);
		expect(missing).toEqual([]);
	});

	it("setiap pengaturan sistem dijelaskan (label tersebut di KB admin 'lapops')", () => {
		const txt = KB_ADMIN_TABS.lapops.text.toLowerCase();
		// kelompok pengaturan harus tersebut dengan kata kuncinya
		for (const kw of ["log", "susulan", "salah password", "sesi", "invest", "asisten"]) expect(txt).toContain(kw);
		expect(SYS_SETTINGS.length).toBeGreaterThan(0);
	});

	it("versi KB terisi dan tidak ada rahasia tertulis", () => {
		expect(ASSISTANT_KB_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
		expect(buildKnowledgeText()).not.toMatch(/sk-[A-Za-z0-9]{10,}|gsk_[A-Za-z0-9]{10,}|bbd53ebb/);
		expect(KB_GENERAL.length).toBeGreaterThan(200);
	});
});

describe("pemilihan pengetahuan", () => {
	it("pertanyaan dipetakan ke bagian yang benar & hemat token", () => {
		const a = selectKnowledge("cara kirim result ke telegram dan linktree?");
		expect(a).toContain("## MENU Result");
		const b = selectKnowledge("kenapa PHPSESSID expired di auto prediksi");
		expect(b).toContain("## MENU Auto Prediksi");
		const c = selectKnowledge("gimana atur operator blazz di lap admin");
		expect(c).toContain("ADMIN › Pengaturan");
		expect(a.length).toBeLessThan(buildKnowledgeText().length * 0.75);
		expect(selectKnowledge("zzzz qqqq")).toContain("tidak ada yang cocok");
	});
	it("riwayat dibersihkan: role valid, maks 6, dipotong", () => {
		const h = cleanHistory(Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(2000) })).concat([{ role: "system", content: "bocor" } as never]));
		expect(h.length).toBeLessThanOrEqual(6);
		expect(h.every((m) => m.content.length <= 1200 && (m.role === "user" || m.role === "assistant"))).toBe(true);
	});
});

describe("API asisten", () => {
	let ctx: ReturnType<typeof fakeEnv>;
	const add = async (u: string, p: string, role: string) =>
		ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES (?, ?, ?, ?, 'AKTIF')`).run(u, u.toLowerCase(), await hashPassword(p), role);
	const tok = async (u: string, p: string) => ((await checkLogin(ctx.env, u, p, "")) as { sessionToken: string }).sessionToken;
	beforeEach(async () => {
		ctx = fakeEnv();
		resetSysCache();
		await add("Boss", "pw-boss", "ADMIN");
		await add("Opr", "pw-opr", "OPERATOR");
		await add("Botx", "pw-bot", "BOT");
	});

	it("menolak pertanyaan kosong/terlalu panjang; semua role (termasuk BOT) boleh bertanya; pesan jelas bila belum ada AI Provider", async () => {
		const opr = await tok("Opr", "pw-opr");
		await expect(assistantAsk(ctx.env, opr, "  ", [])).rejects.toThrow(/kosong/);
		await expect(assistantAsk(ctx.env, opr, "a".repeat(601), [])).rejects.toThrow(/terlalu panjang/);
		await expect(assistantAsk(ctx.env, await tok("Botx", "pw-bot"), "halo", [])).rejects.toThrow(/AI Provider|sibuk/); // BOT juga boleh bertanya
		await expect(assistantAsk(ctx.env, opr, "cara kirim result?", [])).rejects.toThrow(/AI Provider|sibuk/);
	});

	it("admin bisa mematikan asisten & membatasi pertanyaan per jam", async () => {
		const boss = await tok("Boss", "pw-boss");
		const opr = await tok("Opr", "pw-opr");
		await adminSaveSystemSettings(ctx.env, boss, { sys_assistant_per_hour: 5 });
		for (let i = 0; i < 5; i++) await assistantAsk(ctx.env, opr, "halo", []).catch(() => {});
		await expect(assistantAsk(ctx.env, opr, "halo lagi", [])).rejects.toThrow(/Batas pertanyaan/);
		await adminSaveSystemSettings(ctx.env, boss, { sys_assistant_enabled: 0 });
		await expect(assistantAsk(ctx.env, opr, "halo", [])).rejects.toThrow(/dimatikan/);
	});

	it("pertanyaan cara pasang bot Live Chat (Console / Kunci Bot / bookmark) memuat bagian Sesi Chat", () => {
		for (const q of ["cara pasang bot livechat lewat console", "kunci bot saya dimana", "kenapa bookmark tidak jalan", "f12 apa yang harus ditempel"]) {
			const kb = selectKnowledge(q, []);
			expect(kb, q).toContain("SALIN KODE CONSOLE");
			expect(kb, q).toContain("KUNCI BOT KAMU");
		}
	});
});
