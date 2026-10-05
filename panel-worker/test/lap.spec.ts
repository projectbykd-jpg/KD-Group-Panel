import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { lapGetResults, lapJobs } from "../src/api/lap";
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
