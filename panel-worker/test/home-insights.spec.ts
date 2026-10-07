import { beforeEach, describe, expect, it } from "vitest";
import { homeInsights } from "../src/api/dashboard";
import { checkLogin } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { resetSysCache } from "../src/lib/settings";
import { dateKeyNow } from "../src/lib/time";
import { fakeEnv } from "./helpers/fake-env";

let ctx: ReturnType<typeof fakeEnv>;
async function addUser(username: string, password: string, role: string) {
	ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES (?, ?, ?, ?, 'AKTIF')`)
		.run(username, username.toLowerCase(), await hashPassword(password), role);
}
const tok = async (u: string, p: string) => ((await checkLogin(ctx.env, u, p, "")) as { sessionToken: string }).sessionToken;
const log = (ts: string, user: string, status: string) =>
	ctx.db.prepare(`INSERT INTO activity_log (ts, username, action, status, detail, content) VALUES (?, ?, 'SEND RESULT', ?, '', '')`).run(ts, user, status);

beforeEach(async () => {
	ctx = fakeEnv(); resetSysCache();
	await addUser("Boss", "pw-boss", "ADMIN");
	await addUser("Opr", "pw-opr", "OPERATOR");
});

describe("Dashboard: wawasan per jam / top operator / jadwal", () => {
	it("admin: menghitung per jam (+gagal), top operator, jadwal; operator: hanya miliknya & tanpa top operator", async () => {
		const d = dateKeyNow();
		log(`${d} 09:10:00`, "Opr", "BERHASIL"); log(`${d} 09:50:00`, "Opr", "GAGAL"); log(`${d} 09:55:00`, "Boss", "BERHASIL");
		log(`${d} 14:05:00`, "Boss", "BERHASIL"); log("2000-01-01 09:00:00", "Opr", "BERHASIL"); // hari lain: tidak dihitung
		const a = (await homeInsights(ctx.env, await tok("Boss", "pw-boss"))) as { hourly: number[]; hourlyFailed: number[]; topUsers: { username: string; n: number }[]; schedule: { jam: string }[]; closing: string[] };
		expect(a.hourly[9]).toBe(3); expect(a.hourlyFailed[9]).toBe(1); expect(a.hourly[14]).toBe(1);
		expect(a.hourly.reduce((x, y) => x + y, 0)).toBeGreaterThanOrEqual(4);
		expect(a.topUsers.map((u) => u.username)).toContain("Opr");
		expect(a.schedule).toHaveLength(7); expect(a.closing).toEqual(["06:15", "16:00"]);

		const o = (await homeInsights(ctx.env, await tok("Opr", "pw-opr"))) as { hourly: number[]; topUsers: unknown[] };
		expect(o.hourly[9]).toBe(2); expect(o.hourly[14]).toBe(0); // hanya aktivitas Opr
		expect(o.topUsers).toEqual([]);
	});
	it("wajib login", async () => {
		await expect(homeInsights(ctx.env, "dg_tidak-valid")).rejects.toThrow();
	});
});
