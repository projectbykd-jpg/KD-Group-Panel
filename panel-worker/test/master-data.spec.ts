import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminGetMasterData, adminSaveMasterData, shioMapGet } from "../src/api/master-data";
import { checkLogin } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { resetSysCache } from "../src/lib/settings";
import { MASTER_DEFS, loadMasterData, resetMasterCache } from "../src/lib/master-data";
import { getShio, convertMarketToPanel, processText } from "../src/lib/parser";
import { JADWAL_PREDIKSI_CONFIG, CLOSING_PREDICTION_SLOTS, getActiveClosingSlot } from "../src/lib/prediction";
import { INVEST_PASARAN } from "../src/lib/invest";
import { fakeEnv } from "./helpers/fake-env";

let ctx: ReturnType<typeof fakeEnv>;
async function addUser(username: string, password: string, role: string) {
	ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES (?, ?, ?, ?, 'AKTIF')`)
		.run(username, username.toLowerCase(), await hashPassword(password), role);
}
const tok = async (u: string, p: string) => ((await checkLogin(ctx.env, u, p, "")) as { sessionToken: string }).sessionToken;
type Item = { key: string; value: unknown; def: unknown; custom: boolean };
const items = (r: unknown) => (r as { items: Item[] }).items;

beforeEach(async () => {
	ctx = fakeEnv();
	resetSysCache();
	resetMasterCache();
	await addUser("Boss", "pw-boss", "ADMIN");
	await addUser("Opr", "pw-opr", "OPERATOR");
	await loadMasterData(ctx.env);
});
// Daftar di memori bersifat global per proses test -> kembalikan ke bawaan agar test lain tidak terpengaruh.
afterEach(async () => {
	const c = fakeEnv();
	resetMasterCache();
	await loadMasterData(c.env);
});

describe("data master -- bawaan", () => {
	it("SEMUA nilai bawaan di kode lolos validasi sendiri (kalau tidak, admin tidak bisa menyimpan ulang apa yang tampil)", () => {
		for (const d of MASTER_DEFS) {
			const p = d.parse(JSON.parse(JSON.stringify(d.def)));
			expect(p.ok, d.key + (p.ok ? "" : ": " + p.error)).toBe(true);
		}
	});
	it("tanpa data tersimpan, perilaku sama persis dengan sebelumnya", () => {
		expect(getShio(0)).toBe("KELINCI");
		expect(getShio(1)).toBe("KUDA");
		expect(getShio(24)).toBe("KAMBING");
		expect(convertMarketToPanel("hk siang")).toBe("hk-siang");
		expect(JADWAL_PREDIKSI_CONFIG).toHaveLength(7);
		expect(CLOSING_PREDICTION_SLOTS).toEqual(["06:15", "16:00"]);
		expect(INVEST_PASARAN.length).toBeGreaterThan(60);
	});
});

describe("data master -- simpan & terapkan", () => {
	it("hanya ADMIN yang boleh membaca/mengubah", async () => {
		const opr = await tok("Opr", "pw-opr");
		await expect(adminGetMasterData(ctx.env, opr)).rejects.toThrow();
		await expect(adminSaveMasterData(ctx.env, opr, "md_shio", { names: [], zero: "X" })).rejects.toThrow();
	});

	it("peta shio: disimpan, langsung dipakai parser & dibaca UI; reset kembali ke bawaan", async () => {
		const boss = await tok("Boss", "pw-boss");
		const names = ["TIKUS", "KERBAU", "HARIMAU", "KELINCI", "NAGA", "ULAR", "KUDA", "KAMBING", "MONYET", "AYAM", "ANJING", "BABI"];
		const r = (await adminSaveMasterData(ctx.env, boss, "md_shio", { names, zero: "naga" })) as { success: boolean };
		expect(r.success).toBe(true);
		expect(getShio(1)).toBe("TIKUS");
		expect(getShio(12)).toBe("BABI");
		expect(getShio(0)).toBe("NAGA");
		// dipakai juga saat memeriksa hasil: "Prize 1 ...13" -> sisa 1 -> TIKUS
		expect(processText("Pasaran HONGKONG\nPrize 1 : 1213\nShio : TIKUS").status).toBe("BENAR");
		const map = (await shioMapGet(ctx.env, await tok("Opr", "pw-opr"))) as { names: string[]; zero: string };
		expect(map.names[0]).toBe("TIKUS");
		expect(map.zero).toBe("NAGA");
		const it = items(await adminGetMasterData(ctx.env, boss)).find((x) => x.key === "md_shio")!;
		expect(it.custom).toBe(true);

		await adminSaveMasterData(ctx.env, boss, "md_shio", null);
		expect(getShio(1)).toBe("KUDA");
		expect(getShio(0)).toBe("KELINCI");
	});

	it("validasi menolak data ngawur dengan pesan jelas, dan tidak mengubah apa pun", async () => {
		const boss = await tok("Boss", "pw-boss");
		const bad = async (key: string, value: unknown, re: RegExp) => {
			const r = (await adminSaveMasterData(ctx.env, boss, key, value)) as { success: boolean; message: string };
			expect(r.success, key).toBe(false);
			expect(r.message).toMatch(re);
		};
		await bad("md_shio", { names: ["A"], zero: "X" }, /12 nama/);
		await bad("md_shio", { names: Array(12).fill("KUDA"), zero: "KUDA" }, /kembar/);
		await bad("md_jadwal", [], /1-12/);
		await bad("md_jadwal", [{ jam: "25:99", nama: "PREDIKSI X", pasaran: ["A"] }], /HH:MM/);
		await bad("md_jadwal", [{ jam: "01:00", nama: "PREDIKSI X", pasaran: ["A"] }, { jam: "01:00", nama: "PREDIKSI Y", pasaran: ["B"] }], /dua kali/);
		await bad("md_jadwal", [{ jam: "01:00", nama: "PREDIKSI X", pasaran: [] }], /pasaran/);
		await bad("md_market_panel", { HK: "hk siang!" }, /Slug/);
		await bad("md_invest_pasaran", [["x1", "A"]], /p diikuti angka/);
		await bad("md_invest_pasaran", [["p1", "A"], ["p1", "B"]], /dua kali/);
		await bad("md_closing", { slots: ["99:00"], variants: ["kalimat panjang cukup"] }, /HH:MM/);
		await bad("tidak_ada", {}, /tidak dikenal/);
		expect(getShio(1)).toBe("KUDA");
		expect(JADWAL_PREDIKSI_CONFIG).toHaveLength(7);
	});

	it("jadwal prediksi & slot penutup: terapkan, urutan jam penutup diurutkan, slot aktif mengikuti", async () => {
		const boss = await tok("Boss", "pw-boss");
		const jadwal = JADWAL_PREDIKSI_CONFIG.map((s) => ({ ...s }));
		jadwal[0] = { jam: "01:10", nama: "PREDIKSI BARU s/d TES", pasaran: ["bali", "Sydney"] };
		jadwal.push({ jam: "23:55", nama: "PREDIKSI TAMBAHAN", pasaran: ["OHIO"] });
		expect(((await adminSaveMasterData(ctx.env, boss, "md_jadwal", jadwal)) as { success: boolean }).success).toBe(true);
		expect(JADWAL_PREDIKSI_CONFIG).toHaveLength(8);
		expect(JADWAL_PREDIKSI_CONFIG[0]).toEqual({ jam: "01:10", nama: "PREDIKSI BARU s/d TES", pasaran: ["BALI", "SYDNEY"] }); // pasaran dijadikan huruf besar

		const r = (await adminSaveMasterData(ctx.env, boss, "md_closing", {
			slots: ["18:00", "07:00"], variants: ["Kalimat penutup contoh satu.", "Kalimat penutup contoh dua."],
		})) as { success: boolean };
		expect(r.success).toBe(true);
		expect(CLOSING_PREDICTION_SLOTS).toEqual(["07:00", "18:00"]);
		expect(["07:00", "18:00"]).toContain(getActiveClosingSlot());
	});

	it("peta pasaran Panel-Z & daftar pasaran Invest dipakai kode yang ada", async () => {
		const boss = await tok("Boss", "pw-boss");
		await adminSaveMasterData(ctx.env, boss, "md_market_panel", { "PASARAN BARU": "pasaran-baru" });
		expect(convertMarketToPanel("pasaran baru")).toBe("pasaran-baru");
		expect(convertMarketToPanel("HK SIANG")).toBeNull(); // peta diganti seluruhnya oleh admin
		await adminSaveMasterData(ctx.env, boss, "md_invest_pasaran", [["p1", "satu"], ["p22", "DUA"]]);
		expect(INVEST_PASARAN).toEqual([["p1", "SATU"], ["p22", "DUA"]]);
		await adminSaveMasterData(ctx.env, boss, "md_market_panel", null);
		await adminSaveMasterData(ctx.env, boss, "md_invest_pasaran", null);
		expect(convertMarketToPanel("HK SIANG")).toBe("hk-siang");
		expect(INVEST_PASARAN.length).toBeGreaterThan(60);
	});

	it("JSON rusak / tak valid di database -> otomatis bawaan (sistem tidak pernah lumpuh)", async () => {
		ctx.db.prepare(`INSERT INTO settings (key, value) VALUES ('md_shio', '{rusak'), ('md_jadwal', '[]')`).run();
		resetMasterCache();
		await loadMasterData(ctx.env);
		expect(getShio(1)).toBe("KUDA");
		expect(JADWAL_PREDIKSI_CONFIG).toHaveLength(7);
	});
});
