import { beforeEach, describe, expect, it, vi } from "vitest";

// Batas Cloudflare gratis: 50 subrequest per invocation, dan tiap perintah Turso memakai >= 1. Galat nyata di produksi:
// "Too many subrequests by single Worker invocation" di autoInputGetState (menu Auto Prediksi) pada isolate dingin.
const turso = vi.hoisted(() => ({ current: null as null | { d1: any }, calls: 0, log: [] as string[] }));
vi.mock("../src/lib/turso", () => {
	const wrap = (st: any, sql = ""): any => ({
		inner: st,
		bind: (...a: unknown[]) => wrap(st.bind(...a), sql),
		run: () => (turso.calls++, turso.log.push(sql.replace(/\s+/g, " ").slice(0, 90)), st.run()),
		all: () => (turso.calls++, turso.log.push(sql.replace(/\s+/g, " ").slice(0, 90)), st.all()),
		first: (c?: string) => (turso.calls++, turso.log.push(sql.replace(/\s+/g, " ").slice(0, 90)), st.first(c)),
	});
	return {
		getTurso: () => {
			const d1 = turso.current!.d1;
			return {
				prepare: (sql: string) => wrap(d1.prepare(sql), sql),
				batch: async (stmts: any[]) => (turso.calls++, turso.log.push("BATCH x" + stmts.length), d1.batch(stmts.map((s) => s.inner))),
			};
		},
	};
});

import { autoInputGetState } from "../src/api/auto-input";
import { checkLogin } from "../src/api/auth";
import { resetAutoInputTablesFlag } from "../src/lib/auto-input";
import { hashPassword } from "../src/lib/crypto";
import { fakeD1, fakeEnv } from "./helpers/fake-env";

describe("anggaran subrequest menu Auto Prediksi (isolate dingin)", () => {
	let env: Env;
	let db: ReturnType<typeof fakeEnv>["db"];
	beforeEach(async () => {
		turso.current = { d1: fakeD1([]).d1 };
		turso.calls = 0;
		resetAutoInputTablesFlag();
		const ctx = fakeEnv();
		env = ctx.env;
		db = ctx.db;
		db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status, websites) VALUES ('Op', 'op', ?, 'OPERATOR', 'AKTIF', 'HUGOTOGEL')`).run(await hashPassword("pw"));
	});
	const token = async () => ((await checkLogin(env, "Op", "pw", "")) as { sessionToken: string }).sessionToken;

	it("buka menu di isolate DINGIN memakai <= 8 perintah Turso (dulu 20+); isolate hangat <= 3", async () => {
		const tok = await token();
		await autoInputGetState(env, tok); // skema dibuat sekali seumur hidup database
		resetAutoInputTablesFlag(); // isolate DINGIN baru pada database yang tabel & kolomnya sudah ada (keadaan produksi)
		turso.calls = 0;
		turso.log.length = 0;
		const r = (await autoInputGetState(env, tok)) as { success: boolean };
		expect(r.success).toBe(true);
		if (turso.calls > 8) console.log(turso.log.join("\n"));
		expect(turso.calls).toBeLessThanOrEqual(8); // batch skema + 1 query kolom + config + sesi + expire(batch) + riwayat
		turso.calls = 0;
		await autoInputGetState(env, tok);
		expect(turso.calls).toBeLessThanOrEqual(3);
	});

	it("respons riwayat hanya berisi kolom yang dipakai tampilan dan detail dipangkas (cegah respons raksasa terpotong)", async () => {
		const tok = await token();
		await autoInputGetState(env, tok);
		const now = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
		const ins = turso.current!.d1.prepare(`INSERT INTO auto_input_job (username, website, market, result_key, status, stage, detail, created_at, updated_at) VALUES ('Op','HUGOTOGEL','HK',?, 'FAILED','cek',?,?,?)`);
		for (let i = 0; i < 5; i++) await ins.bind("k" + i, "x".repeat(5000), now, now).run();
		const r = (await autoInputGetState(env, tok)) as unknown as { jobs: { detail: string }[] };
		expect(r.jobs).toHaveLength(5);
		expect(Math.max(...r.jobs.map((j) => j.detail.length))).toBeLessThanOrEqual(700);
	});
});
