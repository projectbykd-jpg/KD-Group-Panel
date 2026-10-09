import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { checkLogin } from "../src/api/auth";
import {
	livechatBotPull,
	livechatBotReport,
	livechatBotSync,
	livechatDeleteTemplate,
	livechatGetBotKey,
	livechatListSessions,
	livechatListTemplates,
	livechatRecentLogs,
	livechatResetBotKey,
	livechatSaveTemplate,
	livechatSetBotEnabled,
	resetLivechatKeyCache,
} from "../src/api/livechat";
import { hashPassword } from "../src/lib/crypto";
import { resetSysCache, saveSys } from "../src/lib/settings";
import { fakeEnv, fakeTurso } from "./helpers/fake-env";

const MASTER = "master-secret-livechat";
let ctx: ReturnType<typeof fakeEnv>;

// Satu database Turso untuk seluruh file (flag `tablesEnsured` bersifat per-modul); antar test cukup dikosongkan.
turso.current = fakeTurso();
beforeEach(async () => {
	for (const t of ["livechat_session", "livechat_template", "livechat_log"]) {
		try {
			turso.current!.raw.exec(`DELETE FROM ${t}`);
		} catch {
			/* tabel belum dibuat -- dibuat saat panggilan pertama */
		}
	}
	ctx = fakeEnv();
	(ctx.env as unknown as Record<string, string>).LIVECHAT_BOT_KEY = MASTER;
	resetLivechatKeyCache();
	for (const [u, p, r] of [["Boss", "pw-boss", "ADMIN"], ["Ani", "pw-ani", "OPERATOR"], ["Budi", "pw-budi", "OPERATOR"]] as const)
		ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES (?, ?, ?, ?, 'AKTIF')`).run(u, u.toLowerCase(), await hashPassword(p), r);
});
const tok = async (u: string, p: string) => ((await checkLogin(ctx.env, u, p, "")) as { sessionToken: string }).sessionToken;
const keyOf = async (t: string) => ((await livechatGetBotKey(ctx.env, t)) as { key: string }).key;
const sessions = async (t: string) => ((await livechatListSessions(ctx.env, t)) as { sessions: { session_key: string; bot_enabled: number }[] }).sessions;
const tpls = async (t: string) => ((await livechatListTemplates(ctx.env, t)) as { templates: { id: number; reply_text: string }[] }).templates;
const row = (id: string, name = "") => ({ sessionKey: id, queueCode: "Q" + id, customerName: name });

describe("Live Chat: data & kunci terpisah per pengguna", () => {
	it("tiap pengguna punya Kunci Bot sendiri, stabil, dan tidak bisa dipalsukan", async () => {
		const ani = await tok("Ani", "pw-ani"), budi = await tok("Budi", "pw-budi");
		const ka = await keyOf(ani), kb = await keyOf(budi);
		expect(ka).not.toBe(kb);
		expect(await keyOf(ani)).toBe(ka);
		expect(ka).not.toContain(MASTER);
		// kunci Ani dengan mac diubah / kunci acak ditolak
		await expect(livechatBotPull(ctx.env, ka.slice(0, -1) + (ka.endsWith("0") ? "1" : "0"))).rejects.toThrow(/tidak valid/);
		await expect(livechatBotPull(ctx.env, "kd1_YWJj_" + "0".repeat(32))).rejects.toThrow(/tidak valid/);
		await expect(livechatBotPull(ctx.env, "")).rejects.toThrow(/tidak valid/);
		await expect(livechatBotPull(ctx.env, ka)).resolves.toMatchObject({ success: true });
	});

	it("sesi tidak bercampur: id sama dari dua akun tidak bertabrakan, sinkron satu akun tidak menghapus akun lain", async () => {
		const ani = await tok("Ani", "pw-ani"), budi = await tok("Budi", "pw-budi");
		const ka = await keyOf(ani), kb = await keyOf(budi);
		await livechatBotSync(ctx.env, ka, [row("1", "Member A1"), row("2", "Member A2")]);
		await livechatBotSync(ctx.env, kb, [row("1", "Member B1")]); // id "1" sama dgn milik Ani
		expect((await sessions(ani)).length).toBe(2);
		const bs = await sessions(budi);
		expect(bs.length).toBe(1);
		// Budi sinkron kosong -> hanya sesi Budi yang dibuang
		await livechatBotSync(ctx.env, kb, []);
		expect((await sessions(budi)).length).toBe(0);
		expect((await sessions(ani)).length).toBe(2);
	});

	it("pengguna tidak bisa menyalakan bot di sesi orang lain; pull hanya mengembalikan id asli milik sendiri", async () => {
		const ani = await tok("Ani", "pw-ani"), budi = await tok("Budi", "pw-budi");
		const ka = await keyOf(ani), kb = await keyOf(budi);
		await livechatBotSync(ctx.env, ka, [row("7")]);
		await livechatBotSync(ctx.env, kb, [row("7")]);
		const aniKey = (await sessions(ani))[0].session_key;
		await livechatSetBotEnabled(ctx.env, budi, aniKey, true); // Budi mencoba sesi Ani -> tidak berefek
		expect((await sessions(ani))[0].bot_enabled).toBe(0);
		await livechatSetBotEnabled(ctx.env, ani, aniKey, true);
		expect(((await livechatBotPull(ctx.env, ka)) as { enabledKeys: string[] }).enabledKeys).toEqual(["7"]);
		expect(((await livechatBotPull(ctx.env, kb)) as { enabledKeys: string[] }).enabledKeys).toEqual([]);
	});

	it("template berbeda per pengguna: template admin/pengguna lain tidak terlihat, tidak terpakai, tidak bisa diubah/dihapus", async () => {
		const boss = await tok("Boss", "pw-boss"), ani = await tok("Ani", "pw-ani"), budi = await tok("Budi", "pw-budi");
		const [kb, ka] = [await keyOf(boss), await keyOf(ani)];
		await livechatSaveTemplate(ctx.env, boss, { replyText: "Template ADMIN" });
		await livechatSaveTemplate(ctx.env, ani, { replyText: "Template ANI" });
		expect((await tpls(boss)).map((t) => t.reply_text)).toEqual(["Template ADMIN"]);
		expect((await tpls(ani)).map((t) => t.reply_text)).toEqual(["Template ANI"]);
		expect(await tpls(budi)).toEqual([]);
		const pull = async (k: string) => ((await livechatBotPull(ctx.env, k)) as { templates: { reply_text: string }[] }).templates.map((t) => t.reply_text);
		expect(await pull(ka)).toEqual(["Template ANI"]);
		expect(await pull(kb)).toEqual(["Template ADMIN"]);
		expect(await pull(await keyOf(budi))).toEqual([]);
		// Ani mencoba mengubah & menghapus template admin lewat id-nya
		const bossTpl = (await tpls(boss))[0];
		await livechatSaveTemplate(ctx.env, ani, { id: bossTpl.id, replyText: "DIBAJAK" });
		await livechatDeleteTemplate(ctx.env, ani, bossTpl.id);
		expect((await tpls(boss)).map((t) => t.reply_text)).toEqual(["Template ADMIN"]);
	});

	it("kunci lama (LIVECHAT_BOT_KEY) tetap jalan ke data lama yang hanya dilihat ADMIN", async () => {
		const boss = await tok("Boss", "pw-boss"), ani = await tok("Ani", "pw-ani");
		await livechatBotSync(ctx.env, MASTER, [row("9", "Lama")]);
		expect((await sessions(boss)).map((r) => r.session_key)).toContain("9");
		expect(await sessions(ani)).toEqual([]);
	});

	it("reset kunci mematikan kunci lama; pengguna nonaktif/dihapus ditolak; log terpisah", async () => {
		const ani = await tok("Ani", "pw-ani");
		const old = await keyOf(ani);
		const fresh = ((await livechatResetBotKey(ctx.env, ani)) as { key: string }).key;
		expect(fresh).not.toBe(old);
		await expect(livechatBotPull(ctx.env, old)).rejects.toThrow(/tidak valid/);
		await expect(livechatBotPull(ctx.env, fresh)).resolves.toMatchObject({ success: true });
		await livechatBotReport(ctx.env, fresh, "5", "halo", null, "balasan");
		const budi = await tok("Budi", "pw-budi");
		expect(((await livechatRecentLogs(ctx.env, ani)) as { logs: unknown[] }).logs.length).toBe(1);
		expect(((await livechatRecentLogs(ctx.env, budi)) as { logs: unknown[] }).logs.length).toBe(0);
		ctx.db.prepare(`UPDATE users SET status = 'NONAKTIF' WHERE username_lc = 'ani'`).run();
		resetLivechatKeyCache();
		await expect(livechatBotPull(ctx.env, fresh)).rejects.toThrow(/tidak valid/);
	});
});

describe("Live Chat: jeda bot diatur admin (Pengaturan Sistem)", () => {
	it("pull membawa jeda rentetan & toleransi; bawaan 90/30 dtk, nilai admin dihormati dan dibatasi aman", async () => {
		resetSysCache();
		const key = await keyOf(await tok("Ani", "pw-ani"));
		const d = (await livechatBotPull(ctx.env, key)) as { burstResetSec: number; graceSec: number };
		expect(d).toMatchObject({ burstResetSec: 90, graceSec: 30 });
		await saveSys(ctx.env, { sys_livechat_burst_reset_sec: 120, sys_livechat_grace_sec: 10 });
		resetSysCache();
		expect(await livechatBotPull(ctx.env, key)).toMatchObject({ burstResetSec: 120, graceSec: 10 });
		await saveSys(ctx.env, { sys_livechat_burst_reset_sec: 5 }); // di luar batas -> dijepit ke minimum aman
		resetSysCache();
		expect(((await livechatBotPull(ctx.env, key)) as { burstResetSec: number }).burstResetSec).toBe(30);
	});
});
