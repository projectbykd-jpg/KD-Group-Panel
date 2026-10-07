import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { logClientActivity } from "../src/api/activity";
import { checkLogin } from "../src/api/auth";
import { runAutoPostRouter } from "../src/api/prediction";
import { setMaintenance } from "../src/api/settings";
import { adminSaveSite } from "../src/api/sites";
import { hashPassword } from "../src/lib/crypto";
import { wdListedAdd, wdListedList } from "../src/lib/wd-listed";
import { fakeEnv, fakeTurso } from "./helpers/fake-env";

let ctx: ReturnType<typeof fakeEnv>;
turso.current = fakeTurso();
beforeEach(async () => {
	ctx = fakeEnv();
	vi.useRealTimers();
	for (const [u, p, r] of [["Boss", "pw-boss", "ADMIN"], ["Ani", "pw-ani", "OPERATOR"]] as const)
		ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES (?, ?, ?, ?, 'AKTIF')`).run(u, u.toLowerCase(), await hashPassword(p), r);
});
const tok = async (u: string, p: string) => ((await checkLogin(ctx.env, u, p, "")) as { sessionToken: string }).sessionToken;
const rows = (sql: string, ...a: unknown[]) => ctx.db.prepare(sql).all(...(a as never[])) as Record<string, unknown>[];

describe("perbaikan hasil audit", () => {
	it("catatan aktivitas dari browser: dibatasi panjangnya, tidak bisa menyamar sebagai aksi server, status dibatasi", async () => {
		const ani = await tok("Ani", "pw-ani");
		await logClientActivity(ctx.env, ani, "LOGIN", "x".repeat(5000), "BERHASIL-PALSU", "y".repeat(9000));
		await logClientActivity(ctx.env, ani, "COPY PRIZE 1", "ok", "BERHASIL", "1234");
		const r = rows(`SELECT action, status, detail, content FROM activity_log ORDER BY id DESC LIMIT 2`);
		const copy = r[0], fake = r[1];
		expect(copy.action).toBe("COPY PRIZE 1");
		expect(String(fake.action)).toBe("KLIEN: LOGIN");
		expect(String(fake.detail).length).toBe(500);
		expect(String(fake.content).length).toBe(2000);
		expect(fake.status).toBe("INFO");
	});

	it("mode maintenance tetap aktif walau baris settings belum ada (UPSERT, bukan UPDATE)", async () => {
		ctx.db.exec(`DELETE FROM settings WHERE key IN ('maintenance','maintenance_message','updated_by','updated_at')`);
		const boss = await tok("Boss", "pw-boss");
		await setMaintenance(ctx.env, boss, true, "Sedang perbaikan");
		expect(rows(`SELECT value FROM settings WHERE key='maintenance'`)[0].value).toBe("TRUE");
		expect(rows(`SELECT value FROM settings WHERE key='maintenance_message'`)[0].value).toBe("Sedang perbaikan");
	});

	it("ganti kode website: yang baru tersimpan DAN yang lama terhapus (atomik)", async () => {
		const boss = await tok("Boss", "pw-boss");
		await adminSaveSite(ctx.env, boss, { website: "HUGO", telegramToken: "t1" });
		await adminSaveSite(ctx.env, boss, { website: "HUGOTOGEL", originalWebsite: "HUGO", telegramToken: "t2" });
		const sites = rows(`SELECT website FROM site_accounts`).map((x) => x.website);
		expect(sites).toContain("HUGOTOGEL");
		expect(sites).not.toContain("HUGO");
	});

	it("WD Listed: baris website lain dibuang & baris milik website lain tidak bisa direbut lewat ref_no", async () => {
		const mk = (website: string, ref: string, user = "u1") => ({ website, idTrans: "t", tanggal: "x", idUser: user, jumlah: 1000, statusText: "PGA Pending", pgaRefNo: ref, vendorName: "v" });
		expect(await wdListedAdd(ctx.env, "ani", [mk("HUGO", "REF-A")], ["HUGO"])).toBe(1);
		// operator FOLA mencoba merebut REF-A dan menambah baris atas nama HUGO
		expect(await wdListedAdd(ctx.env, "budi", [mk("FOLA", "REF-A", "dibajak"), mk("HUGO", "REF-X")], ["FOLA"])).toBe(0);
		const hugo = await wdListedList(ctx.env, ["HUGO"]);
		expect(hugo.map((r) => r.pgaRefNo)).toEqual(["REF-A"]);
		expect(hugo[0].idUser).toBe("u1");
		expect(await wdListedList(ctx.env, ["FOLA"])).toEqual([]);
	});

	it("router auto-post: tick tanpa slot jatuh tempo selesai TANPA menyentuh sesi/KV (hemat kuota KV)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-07T21:30:00Z")); // 04:30 WIB: di luar semua slot
		const put = vi.spyOn(ctx.kv, "put");
		const list = vi.spyOn(ctx.kv, "list");
		const r = await runAutoPostRouter(ctx.env, {});
		expect(r.message).toMatch(/Belum ada slot/);
		expect(r.ran).toBe(false);
		expect(put).not.toHaveBeenCalled();
		expect(list).not.toHaveBeenCalled();
	});
});
