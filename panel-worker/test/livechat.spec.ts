import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { livechatBotSync } from "../src/api/livechat";
import { fakeD1 } from "./helpers/fake-env";

const KEY = "kunci-userscript";
const env = { LIVECHAT_BOT_KEY: KEY } as unknown as Env;
const count = () => (turso.current!.raw.prepare(`SELECT COUNT(*) n FROM livechat_session`).get() as { n: number }).n;
const botOn = (k: string) =>
	(turso.current!.raw.prepare(`SELECT bot_enabled b FROM livechat_session WHERE session_key = ?`).get(k) as { b: number } | undefined)?.b;

// Satu database untuk seluruh file: flag `tablesEnsured` di livechat-bot.ts
// bersifat per-modul, jadi tabel hanya dibuat sekali. Antar test cukup dikosongkan.
turso.current = fakeD1([]);
beforeEach(() => {
	try {
		turso.current!.raw.exec(`DELETE FROM livechat_session`);
	} catch {
		/* tabel belum dibuat -- dibuat saat panggilan pertama */
	}
});

describe("livechatBotSync", () => {
	it("menolak kunci yang salah", async () => {
		await expect(livechatBotSync(env, "salah", [])).rejects.toThrow(/tidak valid/i);
	});

	it("rows kosong ([]) = Kotak Masuk memang kosong -> bot sesi yang pergi dimatikan & dibuang", async () => {
		await livechatBotSync(env, KEY, [{ sessionKey: "s1" }, { sessionKey: "s2" }]);
		turso.current!.raw.prepare(`UPDATE livechat_session SET bot_enabled = 1 WHERE session_key = 's1'`).run();
		await livechatBotSync(env, KEY, []);
		expect(count()).toBe(0);
	});

	it("body tanpa rows / bukan array TIDAK boleh mematikan bot atau menghapus sesi", async () => {
		await livechatBotSync(env, KEY, [{ sessionKey: "s1" }]);
		turso.current!.raw.prepare(`UPDATE livechat_session SET bot_enabled = 1 WHERE session_key = 's1'`).run();
		for (const bad of [undefined, null, "oops", { a: 1 }, 5]) {
			await expect(livechatBotSync(env, KEY, bad)).rejects.toThrow(/array/i);
		}
		expect(count()).toBe(1);
		expect(botOn("s1")).toBe(1);
	});
});
