import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { lapGetResults, lapJobResult, lapJobStart, lapJobs } from "../src/api/lap";
import { checkLogin } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { lapResultsJsonRaw } from "../src/lib/lap";
import { tsNow, tsPlusMinutes } from "../src/lib/time";
import { fakeD1, fakeEnv } from "./helpers/fake-env";

let env: Env;
let db: import("node:sqlite").DatabaseSync;

async function login(menus = "") {
	db.prepare(`INSERT INTO users (username, username_lc, password_hash, role) VALUES ('Op','op',?, 'OPERATOR')`).run(await hashPassword("pw"));
	if (menus) {
		db.exec(`ALTER TABLE users ADD COLUMN menus TEXT NOT NULL DEFAULT ''`);
		db.prepare(`UPDATE users SET menus = ?`).run(menus);
	}
	return ((await checkLogin(env, "Op", "pw", "")) as { sessionToken: string }).sessionToken;
}
function job(id: string, kind: string, status: string, createdAt: string, updatedAt = createdAt) {
	turso.current!.raw
		.prepare(`INSERT INTO lap_job (id, username, kind, status, params, message, created_at, updated_at) VALUES (?, 'Op', ?, ?, ?, 'msg', ?, ?)`)
		.run(id, kind, status, JSON.stringify({ kind, startDate: "2026-10-01", endDate: "2026-10-05", key: "RAHASIA-JOB-KEY" }), createdAt, updatedAt);
}

beforeEach(() => {
	turso.current = fakeD1(["turso_001_schema.sql"]);
	const f = fakeEnv();
	env = f.env;
	db = f.db;
});

describe("lapResultsJsonRaw", () => {
	it("menggabungkan blob apa adanya & mengganti blob rusak dengan []", () => {
		const out = lapResultsJsonRaw([
			{ module: "register", data: '[{"username":"a","deposit":1}]' },
			{ module: "registerMeta", data: '{"dateLabel":"1 Okt"}' },
			{ module: "checkCoin", data: "rusak" },
		]);
		expect(JSON.parse(out)).toEqual({ register: [{ username: "a", deposit: 1 }], registerMeta: { dateLabel: "1 Okt" }, checkCoin: [] });
		expect(lapResultsJsonRaw([])).toBe("{}");
	});
});

describe("lapGetResults", () => {
	it("membalas JSON utuh tanpa parse ulang & menyaring modul yang menunya tidak diizinkan", async () => {
		const token = await login('["lap-motion"]');
		const ins = turso.current!.raw.prepare(`INSERT INTO lap_result (username, module, data, updated_at) VALUES ('Op', ?, ?, '')`);
		ins.run("motionDpPga", '[{"refNo":"R1"}]');
		ins.run("register", '[{"username":"rahasia-admin"}]');
		const res = (await lapGetResults(env, token, ["motionDpPga", "register"])) as Response;
		expect(res).toBeInstanceOf(Response);
		const body = (await res.json()) as { success: boolean; results: Record<string, unknown> };
		expect(body.success).toBe(true);
		expect(body.results).toEqual({ motionDpPga: [{ refNo: "R1" }] });
	});
});

describe("lapJobs (progres tarik data)", () => {
	it("mengembalikan job terbaru, menandai yang macet, dan tidak membocorkan key job", async () => {
		const token = await login();
		job("aktif", "admin", "running", tsPlusMinutes(-2), tsPlusMinutes(-1));
		job("antre-macet", "admin", "pending", tsPlusMinutes(-40));
		job("jalan-macet", "admin", "running", tsPlusMinutes(-60), tsPlusMinutes(-50));
		job("selesai", "admin", "done", tsPlusMinutes(-120));
		const r = await lapJobs(env, token);
		const byId = Object.fromEntries(r.jobs.map((j) => [j.id, j]));
		expect(byId["aktif"].status).toBe("running");
		expect(byId["antre-macet"].status).toBe("stale");
		expect(byId["jalan-macet"].status).toBe("stale");
		expect(byId["selesai"].status).toBe("done");
		expect(byId["aktif"].startDate).toBe("2026-10-01");
		expect(JSON.stringify(r)).not.toContain("RAHASIA-JOB-KEY");
		expect(r.jobs[0].id).toBe("aktif"); // terbaru dulu
		expect(r.now).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it("hanya menampilkan jenis job yang menunya diizinkan", async () => {
		const token = await login('["lap-motion"]');
		job("a", "admin", "done", tsNow());
		job("m", "motion", "done", tsNow());
		const r = await lapJobs(env, token);
		expect(r.jobs.map((j) => j.id)).toEqual(["m"]);
	});
});

describe("callback scraper (key job dari log publik GitHub Actions)", () => {
	const KEY = "RAHASIA-JOB-KEY";
	const jobStatus = (id: string) =>
		(turso.current!.raw.prepare(`SELECT status FROM lap_job WHERE id = ?`).get(id) as { status: string }).status;
	beforeEach(() => {
		turso.current!.raw
			.prepare(`INSERT INTO lap_credentials (username, link_admin, cookie_admin) VALUES ('Op', 'https://ag.example.com', 'PHPSESSID=SECRETCOOKIE')`)
			.run();
	});

	it("job yang sedang berjalan boleh mengambil kredensial & menyetor hasil", async () => {
		job("j1", "admin", "pending", tsNow());
		const st = (await lapJobStart(env, "j1", KEY)) as { success: boolean; creds?: { cookieAdmin: string } };
		expect(st.success).toBe(true);
		expect(st.creds?.cookieAdmin).toBe("PHPSESSID=SECRETCOOKIE");
		expect(jobStatus("j1")).toBe("running");
		const res = await lapJobResult(env, "j1", KEY, true, { register: [{ username: "a" }] }, {});
		expect(res.success).toBe(true);
		expect(jobStatus("j1")).toBe("done");
	});

	it("key salah ditolak", async () => {
		job("j2", "admin", "pending", tsNow());
		expect((await lapJobStart(env, "j2", "tebakan")).success).toBe(false);
		expect((await lapJobResult(env, "j2", "tebakan", true, {}, {})).success).toBe(false);
	});

	it("SESUDAH selesai, key yang bocor tidak bisa lagi menarik kredensial user", async () => {
		job("j3", "admin", "done", tsPlusMinutes(-5));
		const st = (await lapJobStart(env, "j3", KEY)) as { success: boolean; creds?: unknown };
		expect(st.success).toBe(false);
		expect(st.creds).toBeUndefined();
		expect(JSON.stringify(st)).not.toContain("SECRETCOOKIE");
	});

	it("job lama yang tidak pernah selesai juga kedaluwarsa", async () => {
		job("j4", "admin", "pending", tsPlusMinutes(-60 * 7));
		expect((await lapJobStart(env, "j4", KEY)).success).toBe(false);
	});

	it("retry scraper sesudah lapor gagal tetap jalan (error baru saja)", async () => {
		job("j5", "admin", "error", tsPlusMinutes(-1), tsPlusMinutes(0));
		expect((await lapJobStart(env, "j5", KEY)).success).toBe(true);
		expect(jobStatus("j5")).toBe("running");
	});

	it("job gagal yang sudah lama tidak bisa dihidupkan lagi", async () => {
		job("j6", "admin", "error", tsPlusMinutes(-120), tsPlusMinutes(-60));
		expect((await lapJobStart(env, "j6", KEY)).success).toBe(false);
	});

	it("hasil yang sudah diterima tidak bisa ditimpa; kirim ulang dijawab sukses (idempoten)", async () => {
		job("j7", "admin", "pending", tsNow());
		await lapJobStart(env, "j7", KEY);
		await lapJobResult(env, "j7", KEY, true, { register: [{ username: "asli" }] }, {});
		const again = await lapJobResult(env, "j7", KEY, true, { register: [{ username: "PALSU" }] }, {});
		expect(again.success).toBe(true);
		const row = turso.current!.raw.prepare(`SELECT data FROM lap_result WHERE username='Op' AND module='register'`).get() as { data: string };
		expect(row.data).toContain("asli");
		expect(row.data).not.toContain("PALSU");
	});
});
