import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({
	current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync },
	broken: false,
	status: { active: "primary", spareConfigured: false, spareSyncedAt: "", spareSince: "" },
}));
vi.mock("../src/lib/turso", () => ({
	getTurso: () => {
		if (turso.broken) return { prepare: () => ({ all: async () => { throw new Error("Turso down"); } }) };
		return turso.current!.d1;
	},
	tursoStatus: async () => turso.status,
}));

import { deepHealth } from "../src/lib/health";
import { resetSysCache } from "../src/lib/settings";
import { fakeEnv, fakeTurso } from "./helpers/fake-env";

const now = Date.parse("2026-10-11T00:30:00Z");
const beat = (minAgo: number) => new Date(now + 7 * 3600_000 - minAgo * 60_000).toISOString().slice(0, 19).replace("T", " ") + " | cron=* * * * *";

let ctx: ReturnType<typeof fakeEnv>;
beforeEach(() => {
	turso.current = fakeTurso();
	turso.broken = false;
	turso.status = { active: "primary", spareConfigured: false, spareSyncedAt: "", spareSince: "" };
	ctx = fakeEnv();
	resetSysCache();
	Object.assign(ctx.env, { TURSO_URL: "libsql://fake", TURSO_TOKEN: "x" });
	ctx.db.prepare(`INSERT INTO settings (key, value) VALUES ('cron_heartbeat', ?)`).run(beat(1));
});

describe("deepHealth + Turso", () => {
	it("Turso sehat & channel Telegram normal -> tanpa peringatan", async () => {
		const h = await deepHealth(ctx.env, now);
		expect(h.ok).toBe(true);
		expect(h.checks.turso.ok).toBe(true);
		expect(h.warnings).toEqual([]);
	});

	it("channel Telegram aktif tapi galat konfigurasi -> peringatan (panel tetap ok)", async () => {
		const ins = turso.current!.raw.prepare(`INSERT INTO bot_kv (k, v, updated_at) VALUES (?, ?, '2026-10-11 07:00:00')`);
		ins.run("tg_channel_enabled", "1");
		ins.run("tg_channel_last_error", "2026-10-11 07:00:00 | Chat ID tidak ditemukan");
		const h = await deepHealth(ctx.env, now);
		expect(h.ok).toBe(true);
		expect(h.warnings[0]).toContain("Chat ID tidak ditemukan");
	});

	it("channel nonaktif -> galat lama tidak dilaporkan", async () => {
		turso.current!.raw.prepare(`INSERT INTO bot_kv (k, v, updated_at) VALUES ('tg_channel_last_error', 'x', 'y')`).run();
		expect((await deepHealth(ctx.env, now)).warnings).toEqual([]);
	});

	it("Turso mati -> GAGAL dengan alasan", async () => {
		turso.broken = true;
		const h = await deepHealth(ctx.env, now);
		expect(h.ok).toBe(false);
		expect(h.checks.turso.error).toContain("Turso down");
	});

	it("database cadangan: sedang dipakai / belum pernah disalin / salinan basi -> peringatan; salinan segar -> tanpa peringatan", async () => {
		turso.status = { active: "spare", spareConfigured: true, spareSyncedAt: "2026-10-11 07:00:00", spareSince: "2026-10-11 07:10:00" };
		expect((await deepHealth(ctx.env, now)).warnings.join(" ")).toContain("database CADANGAN sejak 2026-10-11 07:10:00");
		turso.status = { active: "primary", spareConfigured: true, spareSyncedAt: "", spareSince: "" };
		expect((await deepHealth(ctx.env, now)).warnings.join(" ")).toContain("belum pernah disalin");
		turso.status = { active: "primary", spareConfigured: true, spareSyncedAt: "2026-10-11 02:00:00", spareSince: "" }; // 5,5 jam lalu
		expect((await deepHealth(ctx.env, now)).warnings.join(" ")).toContain("basi");
		turso.status = { active: "primary", spareConfigured: true, spareSyncedAt: "2026-10-11 07:20:00", spareSince: "" }; // 10 menit lalu
		const h = await deepHealth(ctx.env, now);
		expect(h.warnings).toEqual([]);
		expect(h.checks.turso.note).toContain("cadangan disalin 2026-10-11 07:20:00");
	});
});
