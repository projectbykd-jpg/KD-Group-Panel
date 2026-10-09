import { beforeEach, describe, expect, it } from "vitest";
import { homeInsights } from "../src/api/dashboard";
import { checkLogin } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { resetInsightCache } from "../src/lib/dash";
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
	ctx = fakeEnv(); resetSysCache(); resetInsightCache();
	await addUser("Boss", "pw-boss", "ADMIN");
	await addUser("Opr", "pw-opr", "OPERATOR");
});

describe("Dashboard: wawasan per jam / top operator / jadwal", () => {
	it("admin: menghitung per jam (+gagal), top operator, jadwal; operator: hanya miliknya & tanpa top operator", async () => {
		const d = dateKeyNow();
		// jam uji dipilih BUKAN jam sekarang: login saat tes ikut tercatat di jam berjalan dan akan mengacaukan hitungan
		const nowH = new Date(Date.now() + 7 * 3600_000).getUTCHours();
		const H1 = [9, 10, 11].find((h) => h !== nowH)!, H2 = [14, 15, 16].find((h) => h !== nowH)!;
		const hh = (h: number) => String(h).padStart(2, "0");
		log(`${d} ${hh(H1)}:10:00`, "Opr", "BERHASIL"); log(`${d} ${hh(H1)}:50:00`, "Opr", "GAGAL"); log(`${d} ${hh(H1)}:55:00`, "Boss", "BERHASIL");
		log(`${d} ${hh(H2)}:05:00`, "Boss", "BERHASIL"); log("2000-01-01 09:00:00", "Opr", "BERHASIL"); // hari lain: tidak dihitung
		const a = (await homeInsights(ctx.env, await tok("Boss", "pw-boss"))) as { hourly: number[]; hourlyFailed: number[]; topUsers: { username: string; n: number }[]; schedule: { jam: string }[]; closing: string[] };
		expect(a.hourly[H1]).toBe(3); expect(a.hourlyFailed[H1]).toBe(1); expect(a.hourly[H2]).toBe(1);
		expect(a.hourly.reduce((x, y) => x + y, 0)).toBeGreaterThanOrEqual(4);
		expect(a.topUsers.map((u) => u.username)).toContain("Opr");
		expect((a as unknown as { scope: string }).scope).toBe("all"); expect(a.schedule).toHaveLength(7); expect(a.closing).toEqual(["06:15", "16:00"]);

		const o = (await homeInsights(ctx.env, await tok("Opr", "pw-opr"))) as { hourly: number[]; topUsers: unknown[] };
		expect(o.hourly[H1]).toBe(2); expect(o.hourly[H2]).toBe(0); // hanya aktivitas Opr
		expect(o.topUsers).toEqual([]); expect((o as unknown as { scope: string }).scope).toBe("own");
	});
	it("7 hari: tren harian, peta panas, kemarin jam yang sama, jenis aktivitas; operator tanpa kesehatan sistem", async () => {
		const d = dateKeyNow();
		const dayMs = Date.parse(d + "T00:00:00Z");
		const key = (back: number) => new Date(dayMs - back * 86400_000).toISOString().slice(0, 10);
		log(`${key(1)} 09:10:00`, "Opr", "BERHASIL"); log(`${key(1)} 09:20:00`, "Opr", "GAGAL");
		log(`${key(6)} 23:59:00`, "Boss", "BERHASIL");
		log(`${key(7)} 10:00:00`, "Boss", "BERHASIL"); // di luar 7 hari
		log(`${d} 09:05:00`, "Opr", "BERHASIL");
		const a = (await homeInsights(ctx.env, await tok("Boss", "pw-boss"))) as unknown as {
			days: { date: string; n: number; f: number }[]; heat: number[][]; yHourly: number[]; actions: { action: string; n: number }[];
			health: { openErrors: number; autoPost: boolean; activeSessions: number; maintenance: boolean; cronAgoMin: number | null } | null;
		};
		expect(a.days).toHaveLength(7);
		expect(a.days[6].date).toBe(d); expect(a.days[0].date).toBe(key(6));
		expect(a.days[5]).toMatchObject({ n: 2, f: 1 });
		expect(a.days[0].n).toBe(1); // 23:59 hari ke-7 masuk; 10:00 hari ke-8 tidak
		expect(a.heat[5][9]).toBe(2); expect(a.heat[0][23]).toBe(1); expect(a.heat[6][9]).toBeGreaterThanOrEqual(1);
		expect(a.yHourly[9]).toBe(2);
		expect(a.actions[0].action).toBe("SEND RESULT");
		expect(a.health).toMatchObject({ openErrors: 0, autoPost: true, maintenance: false });
		expect(a.health!.activeSessions).toBeGreaterThanOrEqual(1);
		ctx.db.exec(`CREATE TABLE error_log (id INTEGER PRIMARY KEY, status TEXT)`);
		ctx.db.exec(`INSERT INTO error_log (status) VALUES ('open'), ('open'), ('resolved')`);
		resetInsightCache();
		const a2 = (await homeInsights(ctx.env, await tok("Boss", "pw-boss"))) as unknown as { health: { openErrors: number } };
		expect(a2.health.openErrors).toBe(2); // hanya yang berstatus open
		resetInsightCache();
		const o = (await homeInsights(ctx.env, await tok("Opr", "pw-opr"))) as unknown as { health: unknown; days: { n: number }[] };
		expect(o.health).toBeNull();
		expect(o.days[5].n).toBe(2); // milik Opr sendiri
	});
	it("wajib login", async () => {
		await expect(homeInsights(ctx.env, "dg_tidak-valid")).rejects.toThrow();
	});
});
