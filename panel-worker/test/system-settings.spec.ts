import { beforeEach, describe, expect, it } from "vitest";
import { adminGetSystemSettings, adminSaveSystemSettings } from "../src/api/admin";
import { checkLogin } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { resetSysCache } from "../src/lib/settings";
import { fakeEnv } from "./helpers/fake-env";

let ctx: ReturnType<typeof fakeEnv>;
async function addUser(username: string, password: string, role: string) {
	ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES (?, ?, ?, ?, 'AKTIF')`)
		.run(username, username.toLowerCase(), await hashPassword(password), role);
}
const tok = async (u: string, p: string) => ((await checkLogin(ctx.env, u, p, "")) as { sessionToken: string }).sessionToken;

beforeEach(async () => {
	ctx = fakeEnv();
	resetSysCache();
	await addUser("Boss", "pw-boss", "ADMIN");
	await addUser("Opr", "pw-opr", "OPERATOR");
});

describe("pengaturan sistem", () => {
	it("hanya admin; nilai dibatasi min/max; sisanya default", async () => {
		const boss = await tok("Boss", "pw-boss");
		await expect(adminSaveSystemSettings(ctx.env, await tok("Opr", "pw-opr"), { sys_login_max_fails: 3 })).rejects.toThrow();
		const r = (await adminSaveSystemSettings(ctx.env, boss, { sys_login_max_fails: 9999, sys_catchup_minutes: "abc", sys_bukan_ada: 1 })) as { settings: { key: string; value: number }[] };
		const val = (k: string) => r.settings.find((s) => s.key === k)!.value;
		expect(val("sys_login_max_fails")).toBe(20); // dijepit ke max
		expect(val("sys_catchup_minutes")).toBe(25); // tidak valid -> default
		expect(r.settings.some((s) => s.key === "sys_bukan_ada")).toBe(false);
		expect(((await adminGetSystemSettings(ctx.env, boss)) as { settings: unknown[] }).settings.length).toBeGreaterThan(5);
	});

	it("batas salah password dipakai saat login", async () => {
		const boss = await tok("Boss", "pw-boss");
		await adminSaveSystemSettings(ctx.env, boss, { sys_login_max_fails: 3, sys_login_lock_minutes: 5 });
		for (let i = 0; i < 3; i++) await checkLogin(ctx.env, "Opr", "salah", "");
		const row = ctx.db.prepare(`SELECT failed_login f, locked_until l FROM users WHERE username = 'Opr'`).get() as { f: number; l: string | null };
		expect(row.f).toBe(3);
		expect(row.l).toBeTruthy();
	});
});
