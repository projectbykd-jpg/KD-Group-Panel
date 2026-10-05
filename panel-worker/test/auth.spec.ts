import { beforeEach, describe, expect, it } from "vitest";
import { checkLogin, requireSession, resumeSession } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { LOGIN_THROTTLE } from "../src/lib/login-throttle";
import { tsPlusMinutes } from "../src/lib/time";
import { fakeEnv } from "./helpers/fake-env";

type Ctx = ReturnType<typeof fakeEnv>;
const msg = (r: unknown) => String((r as { message?: string }).message ?? "");
let ctx: Ctx;

async function addUser(username: string, password: string, role = "OPERATOR", extra: Record<string, unknown> = {}) {
	const h = await hashPassword(password);
	ctx.db
		.prepare(
			`INSERT INTO users (username, username_lc, password_hash, role, status, failed_login, locked_until)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			username,
			username.toLowerCase(),
			h,
			role,
			String(extra.status ?? "AKTIF"),
			Number(extra.failed_login ?? 0),
			(extra.locked_until as string | null) ?? null,
		);
}

const userRow = (u: string) =>
	ctx.db.prepare(`SELECT failed_login, locked_until FROM users WHERE username_lc = ?`).get(u.toLowerCase()) as {
		failed_login: number;
		locked_until: string | null;
	};

beforeEach(() => {
	ctx = fakeEnv();
});

describe("checkLogin", () => {
	it("login benar membuat sesi yang bisa dipakai lagi", async () => {
		await addUser("Budi", "pw-budi");
		const res = (await checkLogin(ctx.env, "budi", "pw-budi", "1.1.1.1")) as { success: boolean; sessionToken: string };
		expect(res.success).toBe(true);
		expect(res.sessionToken).toMatch(/^dg_/);
		const again = await resumeSession(ctx.env, res.sessionToken);
		expect(again.success).toBe(true);
	});

	it("5x salah mengunci akun 10 menit", async () => {
		await addUser("Budi", "pw-budi");
		for (let i = 0; i < 5; i++) await checkLogin(ctx.env, "Budi", "salah", "1.1.1.1");
		expect(userRow("Budi").locked_until).not.toBeNull();
		const res = await checkLogin(ctx.env, "Budi", "pw-budi", "1.1.1.1");
		expect(res.success).toBe(false);
		expect(msg(res)).toMatch(/terkunci/i);
	});

	it("sesudah kunci lama habis, satu salah ketik TIDAK langsung mengunci lagi", async () => {
		await addUser("Budi", "pw-budi", "OPERATOR", { failed_login: 5, locked_until: tsPlusMinutes(-1) });
		await checkLogin(ctx.env, "Budi", "salah", "1.1.1.1");
		expect(userRow("Budi").failed_login).toBe(1);
		expect(userRow("Budi").locked_until).toBeNull();
	});

	it("login sukses mereset hitungan gagal", async () => {
		await addUser("Budi", "pw-budi");
		await checkLogin(ctx.env, "Budi", "salah", "1.1.1.1");
		await checkLogin(ctx.env, "Budi", "pw-budi", "1.1.1.1");
		expect(userRow("Budi").failed_login).toBe(0);
	});

	it("password plaintext lama dimigrasi jadi hash saat login", async () => {
		ctx.db
			.prepare(`INSERT INTO users (username, username_lc, password_hash) VALUES ('Lama','lama','plain-pw')`)
			.run();
		expect((await checkLogin(ctx.env, "Lama", "plain-pw", "")).success).toBe(true);
		const row = ctx.db.prepare(`SELECT password_hash FROM users WHERE username_lc='lama'`).get() as { password_hash: string };
		expect(row.password_hash.startsWith("pbkdf2-sha256$")).toBe(true);
	});

	it("satu IP yang terlalu sering gagal diblokir, IP lain tetap bisa login", async () => {
		await addUser("Budi", "pw-budi");
		for (let i = 0; i < LOGIN_THROTTLE.MAX_FAILS; i++) await checkLogin(ctx.env, "tidak-ada-" + i, "x", "6.6.6.6");
		const blocked = await checkLogin(ctx.env, "Budi", "pw-budi", "6.6.6.6");
		expect(blocked.success).toBe(false);
		expect(msg(blocked)).toMatch(/terlalu banyak/i);
		expect((await checkLogin(ctx.env, "Budi", "pw-budi", "7.7.7.7")).success).toBe(true);
	});

	it("jendela throttle yang sudah lewat dimulai dari nol lagi", async () => {
		await addUser("Budi", "pw-budi");
		ctx.db
			.prepare(`INSERT INTO login_throttle (ip, fails, window_start) VALUES (?, ?, ?)`)
			.run("6.6.6.6", LOGIN_THROTTLE.MAX_FAILS + 5, Date.now() - LOGIN_THROTTLE.WINDOW_MS - 1000);
		expect((await checkLogin(ctx.env, "Budi", "pw-budi", "6.6.6.6")).success).toBe(true);
	});
});

describe("requireSession", () => {
	async function tokenFor(user: string, role: string) {
		await addUser(user, "pw", role);
		const r = (await checkLogin(ctx.env, user, "pw", "")) as { sessionToken: string };
		return r.sessionToken;
	}

	it("role BOT ditolak di endpoint biasa, diterima kalau allowBot", async () => {
		const t = await tokenFor("Robot", "BOT");
		await expect(requireSession(ctx.env, t)).rejects.toThrow(/BOT/);
		await expect(requireSession(ctx.env, t, { allowBot: true })).resolves.toMatchObject({ username: "Robot" });
	});

	it("endpoint admin menolak OPERATOR", async () => {
		const t = await tokenFor("Op", "OPERATOR");
		await expect(requireSession(ctx.env, t, { admin: true })).rejects.toThrow(/ADMIN/);
		await expect(requireSession(ctx.env, t)).resolves.toMatchObject({ username: "Op" });
	});

	it("mode maintenance menolak non-admin, tapi ADMIN tetap lolos", async () => {
		const op = await tokenFor("Op", "OPERATOR");
		const adm = await tokenFor("Bos", "ADMIN");
		ctx.db.prepare(`UPDATE settings SET value='TRUE' WHERE key='maintenance'`).run();
		await expect(requireSession(ctx.env, op)).rejects.toThrow(/pemeliharaan/i);
		await expect(requireSession(ctx.env, adm)).resolves.toMatchObject({ username: "Bos" });
	});

	it("token asing / kosong ditolak", async () => {
		await expect(requireSession(ctx.env, "")).rejects.toThrow(/Sesi tidak valid/);
		await expect(requireSession(ctx.env, "dg_palsu")).rejects.toThrow(/Sesi tidak valid/);
	});

	it("sesi tetap valid walau KV kosong (cadangan D1)", async () => {
		const t = await tokenFor("Op", "OPERATOR");
		ctx.kv.store.clear();
		await expect(requireSession(ctx.env, t)).resolves.toMatchObject({ username: "Op" });
	});
});
