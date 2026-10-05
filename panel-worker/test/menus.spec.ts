import { beforeEach, describe, expect, it } from "vitest";
import { checkLogin, requireSession } from "../src/api/auth";
import { adminListUsers, adminSaveUser } from "../src/api/admin";
import { getUserProfile } from "../src/lib/db";
import { hashPassword } from "../src/lib/crypto";
import { MENU_KEYS, parseMenus, serializeMenus } from "../src/lib/menus";
import { fakeEnv } from "./helpers/fake-env";

type Ctx = ReturnType<typeof fakeEnv>;
let ctx: Ctx;

async function login(username: string, role = "OPERATOR", menus = "") {
	ctx.db
		.prepare(`INSERT INTO users (username, username_lc, password_hash, role) VALUES (?, ?, ?, ?)`)
		.run(username, username.toLowerCase(), await hashPassword("pw"), role);
	if (menus) {
		try {
			ctx.db.exec(`ALTER TABLE users ADD COLUMN menus TEXT NOT NULL DEFAULT ''`);
		} catch {
			/* sudah ada */
		}
		ctx.db.prepare(`UPDATE users SET menus = ? WHERE username_lc = ?`).run(menus, username.toLowerCase());
	}
	const r = (await checkLogin(ctx.env, username, "pw", "")) as { sessionToken: string; menus: unknown };
	return r;
}

beforeEach(() => {
	ctx = fakeEnv();
});

describe("parse/serialize menus", () => {
	it("kosong = semua (null); nilai asing dibuang; semua dicentang disimpan sebagai default", () => {
		expect(parseMenus("")).toBeNull();
		expect(parseMenus('["result","hack","invest"]')).toEqual(["result", "invest"]);
		expect(parseMenus("[]")).toEqual([]);
		expect(serializeMenus(["invest", "result"])).toBe('["result","invest"]');
		expect(serializeMenus([...MENU_KEYS])).toBe("");
		expect(serializeMenus(undefined)).toBe("");
		expect(serializeMenus([])).toBe("[]");
	});
});

describe("kolom users.menus", () => {
	it("dibuat otomatis di database lama yang belum punya kolomnya", async () => {
		const cols = () => (ctx.db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((c) => c.name);
		ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash) VALUES ('A','a','x')`).run();
		const before = cols().includes("menus");
		const p = await getUserProfile(ctx.env, "a");
		expect(p?.menus).toBeNull();
		expect(cols().includes("menus")).toBe(true);
		// Database baru (fake) memang belum punya kolom -> membuktikan jalur auto-add.
		expect(before).toBe(false);
	});
});

describe("penegakan hak akses menu di server", () => {
	it("user default boleh semua menu", async () => {
		const r = await login("Op");
		expect(r.menus).toBeNull();
		await expect(requireSession(ctx.env, r.sessionToken, { menu: "prediction" })).resolves.toBeTruthy();
		await expect(requireSession(ctx.env, r.sessionToken, { menu: "livechat-templates" })).resolves.toBeTruthy();
	});

	it("user yang dibatasi ditolak di menu lain, diterima di menunya sendiri", async () => {
		const r = await login("Op", "OPERATOR", '["result","lap-motion"]');
		expect(r.menus).toEqual(["result", "lap-motion"]);
		await expect(requireSession(ctx.env, r.sessionToken, { menu: "result" })).resolves.toBeTruthy();
		await expect(requireSession(ctx.env, r.sessionToken, { menu: "prediction" })).rejects.toThrow(/Prediksi tidak diizinkan/);
		// Grup Laporan: cukup salah satu menu laporan untuk membuka Setting laporan.
		await expect(requireSession(ctx.env, r.sessionToken, { menu: ["lap-admin", "lap-motion", "lap-mozart"] })).resolves.toBeTruthy();
		await expect(requireSession(ctx.env, r.sessionToken, { menu: "lap-admin" })).rejects.toThrow(/Lap Admin/);
		// Endpoint tanpa syarat menu (mis. Dashboard) tetap jalan.
		await expect(requireSession(ctx.env, r.sessionToken)).resolves.toBeTruthy();
	});

	it("pesan tolak tidak dikira sesi habis oleh panel", async () => {
		const r = await login("Op", "OPERATOR", "[]");
		await expect(requireSession(ctx.env, r.sessionToken, { menu: "invest" })).rejects.toThrow(
			expect.objectContaining({ message: expect.not.stringMatching(/sesi tidak valid|telah berakhir|akun tidak ditemukan|akun sedang|akun terkunci/i) }),
		);
	});

	it("ADMIN selalu bebas walau kolom menus terisi", async () => {
		const r = await login("Bos", "ADMIN", '["result"]');
		expect(r.menus).toBeNull();
		await expect(requireSession(ctx.env, r.sessionToken, { menu: "invest" })).resolves.toBeTruthy();
	});
});

describe("Admin -> Users", () => {
	it("menyimpan & membaca daftar menu; form lama tanpa field menus tidak menghapusnya", async () => {
		const admin = await login("Bos", "ADMIN");
		await adminSaveUser(ctx.env, admin.sessionToken, { username: "Tim1", password: "pw1", role: "OPERATOR", menus: ["result", "activity"] });
		let tim = (await adminListUsers(ctx.env, admin.sessionToken)).find((u) => u.username === "Tim1")!;
		expect(tim.menus).toEqual(["result", "activity"]);

		await adminSaveUser(ctx.env, admin.sessionToken, { originalUsername: "Tim1", username: "Tim1", role: "OPERATOR", displayName: "Tim Satu" });
		tim = (await adminListUsers(ctx.env, admin.sessionToken)).find((u) => u.username === "Tim1")!;
		expect(tim.menus).toEqual(["result", "activity"]);

		await adminSaveUser(ctx.env, admin.sessionToken, { originalUsername: "Tim1", username: "Tim1", role: "OPERATOR", menus: "all" });
		tim = (await adminListUsers(ctx.env, admin.sessionToken)).find((u) => u.username === "Tim1")!;
		expect(tim.menus).toBeNull();
	});
});
