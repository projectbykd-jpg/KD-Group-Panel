import { beforeEach, describe, expect, it } from "vitest";
import { checkLogin } from "../src/api/auth";
import { lapGetSpecialOps, lapSaveSpecialOps } from "../src/api/lap";
import { hashPassword } from "../src/lib/crypto";
import { fakeEnv } from "./helpers/fake-env";

let ctx: ReturnType<typeof fakeEnv>;
async function addUser(username: string, password: string, role: string) {
	ctx.db
		.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES (?, ?, ?, ?, 'AKTIF')`)
		.run(username, username.toLowerCase(), await hashPassword(password), role);
}
const login = async (u: string, p: string) => ((await checkLogin(ctx.env, u, p, "")) as { sessionToken: string }).sessionToken;

beforeEach(async () => {
	ctx = fakeEnv();
	await addUser("Boss", "pw-boss", "ADMIN");
	await addUser("Opr", "pw-opr", "OPERATOR");
});

describe("operator khusus Lap Admin", () => {
	it("admin menyimpan, operator bisa membaca tetapi tidak bisa menyimpan", async () => {
		const boss = await login("Boss", "pw-boss");
		const opr = await login("Opr", "pw-opr");
		const saved = (await lapSaveSpecialOps(ctx.env, boss, [{ label: "Blazz", operator: "blazz" }, { label: "Khanpay", operator: "khanpay" }])) as { operators: unknown[] };
		expect(saved.operators).toHaveLength(2);
		const read = (await lapGetSpecialOps(ctx.env, opr)) as { operators: { label: string; operator: string }[] };
		expect(read.operators.map((o) => o.operator)).toEqual(["blazz", "khanpay"]);
		await expect(lapSaveSpecialOps(ctx.env, opr, [{ label: "X", operator: "x" }])).rejects.toThrow();
	});

	it("membersihkan input: kosong dibuang, duplikat (tak peka huruf) dibuang, label default = operator, maks 10", async () => {
		const boss = await login("Boss", "pw-boss");
		const many = Array.from({ length: 14 }, (_, i) => ({ label: "L" + i, operator: "op" + i }));
		const r = (await lapSaveSpecialOps(ctx.env, boss, [{ label: "", operator: "  Blazz " }, { label: "dup", operator: "BLAZZ" }, { label: "x", operator: "" }, ...many])) as {
			operators: { label: string; operator: string }[];
		};
		expect(r.operators[0]).toEqual({ label: "Blazz", operator: "Blazz" });
		expect(r.operators).toHaveLength(10);
		expect(new Set(r.operators.map((o) => o.operator.toLowerCase())).size).toBe(10);
		const r2 = (await lapSaveSpecialOps(ctx.env, boss, "bukan-array")) as { operators: unknown[] };
		expect(r2.operators).toEqual([]);
	});
});
