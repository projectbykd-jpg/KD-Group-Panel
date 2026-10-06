import { beforeEach, describe, expect, it } from "vitest";
import { adminDeleteUser, adminSaveUser } from "../src/api/admin";
import { checkLogin, resumeSession } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { fakeEnv } from "./helpers/fake-env";

let ctx: ReturnType<typeof fakeEnv>;

async function addUser(username: string, password: string, role = "OPERATOR") {
	ctx.db
		.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES (?, ?, ?, ?, 'AKTIF')`)
		.run(username, username.toLowerCase(), await hashPassword(password), role);
}
const login = async (u: string, p: string) =>
	((await checkLogin(ctx.env, u, p, "")) as { sessionToken: string }).sessionToken;
const alive = async (token: string) => (await resumeSession(ctx.env, token)).success;
const sessionRows = (u: string) =>
	(ctx.db.prepare(`SELECT COUNT(*) n FROM sessions WHERE lower(username) = ?`).get(u.toLowerCase()) as { n: number }).n;

beforeEach(async () => {
	ctx = fakeEnv();
	await addUser("Boss", "pw-boss", "ADMIN");
	await addUser("Victim", "pw-old");
});

describe("pencabutan sesi oleh admin", () => {
	it("hapus user mencabut sesinya -- akun baru dg username sama TIDAK mewarisi token lama", async () => {
		const boss = await login("Boss", "pw-boss");
		const old = await login("Victim", "pw-old");
		expect(await alive(old)).toBe(true);

		await adminDeleteUser(ctx.env, boss, "Victim");
		expect(sessionRows("Victim")).toBe(0);
		expect(ctx.kv.store.has(old)).toBe(false);

		await adminSaveUser(ctx.env, boss, { username: "Victim", password: "pw-new", role: "OPERATOR", status: "AKTIF" });
		expect(await alive(old)).toBe(false);
		expect(await alive(await login("Victim", "pw-new"))).toBe(true);
	});

	it("reset password oleh admin mencabut sesi lama user itu", async () => {
		const boss = await login("Boss", "pw-boss");
		const old = await login("Victim", "pw-old");
		await adminSaveUser(ctx.env, boss, { originalUsername: "Victim", username: "Victim", password: "pw-reset", role: "OPERATOR", status: "AKTIF" });
		expect(await alive(old)).toBe(false);
		expect(await alive(await login("Victim", "pw-reset"))).toBe(true);
	});

	it("edit tanpa ganti password / status TIDAK menendang user", async () => {
		const boss = await login("Boss", "pw-boss");
		const tok = await login("Victim", "pw-old");
		await adminSaveUser(ctx.env, boss, { originalUsername: "Victim", username: "Victim", password: "", role: "OPERATOR", status: "AKTIF", note: "catatan" });
		expect(await alive(tok)).toBe(true);
	});

	it("rename user mencabut sesi atas nama lama", async () => {
		const boss = await login("Boss", "pw-boss");
		const tok = await login("Victim", "pw-old");
		await adminSaveUser(ctx.env, boss, { originalUsername: "Victim", username: "Victor", password: "", role: "OPERATOR", status: "AKTIF" });
		expect(sessionRows("Victim")).toBe(0);
		expect(await alive(tok)).toBe(false);
	});

	it("admin yang mengganti password akunnya SENDIRI tidak ditendang dari sesi yang sedang dipakai", async () => {
		const boss = await login("Boss", "pw-boss");
		const other = await login("Boss", "pw-boss"); // sesi lain milik admin yang sama
		await adminSaveUser(ctx.env, boss, { originalUsername: "Boss", username: "Boss", password: "pw-boss2", role: "ADMIN", status: "AKTIF" });
		expect(await alive(boss)).toBe(true);
		expect(await alive(other)).toBe(false);
	});
});
