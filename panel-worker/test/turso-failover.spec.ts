import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";

// Database cadangan Turso (spare): panel pindah otomatis bila utama kena kuota, HANYA bila spare sudah disalin; skrip
// sinkron menyalin dengan rowid identik, tidak menimpa spare saat spare sedang dipakai, dan failback mengembalikannya.

const dbs = vi.hoisted(() => ({ map: new Map<string, unknown>() }));
vi.mock("@libsql/client/web", () => ({ createClient: ({ url }: { url: string }) => dbs.map.get(url) }));

import { getTurso, onTursoFailover, resetTursoForTest, tursoGeneration, tursoStatus } from "../src/lib/turso";
import { sharedOnce } from "../src/lib/shared-once";
import { runSync } from "../scripts/turso-sync";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BLOCKED = "BLOCKED: Operation was blocked: SQL read operations are forbidden (reads are blocked, do you need to upgrade your plan?)";
let dir: string;
let primary: Client, spare: Client;
let primaryCalls = 0;
let primaryBlocked = false;

/** Klien utama yang bisa "diblokir" seperti Turso saat kuota habis. */
function blockable(real: Client): Client {
	const guard = <T>(fn: () => Promise<T>) => {
		primaryCalls++;
		return primaryBlocked ? Promise.reject(new Error(BLOCKED)) : fn();
	};
	return new Proxy(real, {
		get(t, k) {
			if (k === "execute") return (s: never) => guard(() => t.execute(s));
			if (k === "batch") return (s: never, m: never) => guard(() => t.batch(s, m));
			return Reflect.get(t, k);
		},
	});
}

const env = (withSpare = true) =>
	({ TURSO_URL: "libsql://primary", TURSO_TOKEN: "p", ...(withSpare ? { TURSO_SPARE_URL: "libsql://spare", TURSO_SPARE_TOKEN: "s" } : {}) }) as unknown as Env;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "kd-turso-"));
	primary = createClient({ url: "file:" + join(dir, "p.db") });
	spare = createClient({ url: "file:" + join(dir, "s.db") });
	primaryCalls = 0;
	primaryBlocked = false;
	dbs.map.set("libsql://primary", blockable(primary));
	dbs.map.set("libsql://spare", spare);
	resetTursoForTest();
	await primary.batch(
		[
			`CREATE TABLE app_item (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new')`,
			`CREATE INDEX ix_app_status ON app_item(status, id)`,
			`CREATE TABLE app_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '')`,
			`INSERT INTO app_item (title) VALUES ('a'), ('b'), ('c')`,
			`DELETE FROM app_item WHERE id = 2`, // celah id: salinan harus mempertahankan id 1 & 3
			`INSERT INTO app_kv (k, v) VALUES ('daily_cap', '5')`,
		],
		"write",
	);
});
afterEach(() => {
	primary.close();
	spare.close();
	rmSync(dir, { recursive: true, force: true });
});

const ids = async (c: Client) => (await c.execute(`SELECT id, title, status FROM app_item ORDER BY id`)).rows.map((r) => `${r.id}:${r.title}:${r.status}`);

describe("sinkron utama -> cadangan", () => {
	it("menyalin skema, index & isi dengan id IDENTIK; kedua kalinya hanya menulis yang berubah", async () => {
		const r1 = await runSync({ primary, spare, mode: "sync", exclude: [] });
		expect(await ids(spare)).toEqual(["1:a:new", "3:c:new"]);
		expect((await spare.execute(`SELECT name FROM sqlite_master WHERE name = 'ix_app_status'`)).rows.length).toBe(1);
		expect(r1.tables.find((t) => t.name === "app_item")).toMatchObject({ written: 2, deleted: 0 });
		await primary.batch([`UPDATE app_item SET status = 'posted' WHERE id = 3`, `DELETE FROM app_item WHERE id = 1`, `INSERT INTO app_item (title) VALUES ('d')`], "write");
		await primary.execute(`ALTER TABLE app_item ADD COLUMN views INTEGER NOT NULL DEFAULT 0`);
		const r2 = await runSync({ primary, spare, mode: "sync", exclude: [] });
		expect(await ids(spare)).toEqual(["3:c:posted", "4:d:new"]);
		expect(r2.tables.find((t) => t.name === "app_item")).toMatchObject({ written: 2, deleted: 1 });
		expect((await spare.execute(`SELECT views FROM app_item WHERE id = 4`)).rows[0].views).toBe(0); // kolom baru ikut
		expect((await spare.execute(`SELECT v FROM kd_failover WHERE k = 'synced_at'`)).rows.length).toBe(1);
	});
});

describe("panel pindah ke cadangan saat utama kena kuota", () => {
	it("tanpa cadangan diatur: galat kuota diteruskan seperti dulu", async () => {
		primaryBlocked = true;
		await expect(getTurso(env(false)).prepare(`SELECT * FROM app_kv`).all()).rejects.toThrow(/BLOCKED/);
	});

	it("cadangan BELUM pernah disalin: TIDAK pindah (spare kosong akan merusak data), pesannya jelas", async () => {
		primaryBlocked = true;
		await expect(getTurso(env()).prepare(`SELECT * FROM app_kv`).all()).rejects.toThrow(/belum pernah disalin/);
		expect((await tursoStatus(env())).active).toBe("primary");
	});

	it("cadangan sudah disalin: query dilayani cadangan, penanda dicatat, hook dipanggil sekali; berikutnya langsung ke cadangan", async () => {
		await runSync({ primary, spare, mode: "sync", exclude: [] });
		const hook = vi.fn();
		onTursoFailover(hook);
		primaryBlocked = true;
		const db = getTurso(env());
		const r = await db.prepare(`SELECT v FROM app_kv WHERE k = ?`).bind("daily_cap").first<{ v: string }>();
		expect(r?.v).toBe("5");
		expect(hook).toHaveBeenCalledTimes(1);
		expect((await tursoStatus(env())).active).toBe("spare");
		// tulis setelah pindah: ke cadangan, id melanjutkan id yang sama dengan utama (tidak bertabrakan)
		const ins = await db.prepare(`INSERT INTO app_item (title) VALUES (?)`).bind("baru").run();
		expect(ins.meta.last_row_id).toBe(4);
		const before = primaryCalls;
		await db.prepare(`SELECT COUNT(*) AS n FROM app_item`).first();
		expect(primaryCalls).toBe(before); // utama tidak disentuh lagi
		expect(hook).toHaveBeenCalledTimes(1);
	});

	it("galat query biasa di utama TIDAK memicu pindah", async () => {
		await runSync({ primary, spare, mode: "sync", exclude: [] });
		await expect(getTurso(env()).prepare(`SELECT * FROM tabel_tidak_ada`).all()).rejects.toThrow(/no such table/);
		expect((await tursoStatus(env())).active).toBe("primary");
	});

	it("selama cadangan dipakai, sinkron utama->cadangan DILEWATI; failback menyalin balik lalu kembali ke utama", async () => {
		await runSync({ primary, spare, mode: "sync", exclude: [] });
		primaryBlocked = true;
		const db = getTurso(env());
		await db.prepare(`INSERT INTO app_item (title) VALUES ('saat-gangguan')`).run();
		primaryBlocked = false; // kuota pulih
		const skip = await runSync({ primary, spare, mode: "sync", exclude: [] });
		expect(skip.skipped).toMatch(/dilewati/);
		expect(await ids(spare)).toContain("4:saat-gangguan:new"); // tidak tertimpa
		const back = await runSync({ primary, spare, mode: "failback", exclude: [] });
		expect(back.skipped).toBeUndefined();
		expect(await ids(primary)).toEqual(["1:a:new", "3:c:new", "4:saat-gangguan:new"]);
		resetTursoForTest(); // cache status 60 dtk
		dbs.map.set("libsql://primary", blockable(primary));
		dbs.map.set("libsql://spare", spare);
		expect((await tursoStatus(env())).active).toBe("primary");
		const again = await runSync({ primary, spare, mode: "failback", exclude: [] });
		expect(again.skipped).toMatch(/tidak diperlukan/); // failback dua kali tidak menimpa utama
	});
});

describe("mulai-baru di cadangan kosong (utama diblokir): news tetap di utama, sisanya jalan di cadangan", () => {
	const MIG = fileURLToPath(new URL("../../migration/", import.meta.url).href);
	const readSql = (f: string): string => readFileSync(MIG + f, "utf8");

	it("fresh: skema Lap/Invest dibuat di cadangan TANPA membaca utama; panel pindah; news ditolak (tetap utama); non-news jalan; sinkron & failback dikunci", async () => {
		primaryBlocked = true; // utama mati total selama proses
		const r = await runSync({ spare, mode: "fresh", exclude: [], readSql });
		expect(r.skipped).toBeUndefined();
		expect(primaryCalls).toBe(0); // utama tidak disentuh sama sekali
		const names = (await spare.execute(`SELECT name FROM sqlite_master WHERE type = 'table'`)).rows.map((x) => String(x.name));
		expect(names).toEqual(expect.arrayContaining(["lap_credentials", "lap_job", "invest_config", "invest_raw", "kd_failover"]));
		expect(names).not.toContain("news_article");

		resetTursoForTest();
		dbs.map.set("libsql://primary", blockable(primary));
		dbs.map.set("libsql://spare", spare);
		const db = getTurso(env());
		expect((await tursoStatus(env())).active).toBe("spare");
		await db.prepare(`INSERT INTO lap_credentials (username, link_admin) VALUES ('op', 'x')`).run(); // non-news -> cadangan
		expect((await db.prepare(`SELECT link_admin FROM lap_credentials WHERE username = 'op'`).first<{ link_admin: string }>())?.link_admin).toBe("x");
		const before = primaryCalls;
		await expect(db.prepare(`SELECT * FROM news_article`).all()).rejects.toThrow(/BLOCKED/); // news tetap ke utama
		await expect(db.prepare(`SELECT k, v FROM bot_kv`).all()).rejects.toThrow(/BLOCKED/);
		expect(primaryCalls).toBeGreaterThan(before);
		expect((await spare.execute(`SELECT name FROM sqlite_master WHERE name IN ('news_article', 'bot_kv')`)).rows.length).toBe(0); // tidak pernah dibuat di cadangan

		const again = await runSync({ spare, mode: "fresh", exclude: [], readSql });
		expect(again.skipped).toMatch(/sudah pernah/);
		primaryBlocked = false;
		expect((await runSync({ primary, spare, mode: "sync", exclude: [] })).skipped).toMatch(/KOSONG/);
		expect((await runSync({ primary, spare, mode: "failback", exclude: [] })).skipped).toMatch(/KOSONG/);
	});

	it("tanpa mulai-baru, news tetap tidak pernah dilayani cadangan walau sudah disalin", async () => {
		await runSync({ primary, spare, mode: "sync", exclude: [] });
		primaryBlocked = true;
		const db = getTurso(env());
		await expect(db.prepare(`SELECT * FROM news_article`).all()).rejects.toThrow(/BLOCKED/);
		expect(await db.prepare(`SELECT v FROM bot_kv`).all().catch(() => "err")).toBe("err");
	});
});

describe("utama & cadangan berperilaku SAMA: skema dibuat ulang di database yang baru aktif", () => {
	it("tabel yang dibuat 'sekali per isolate' di utama ikut disiapkan di cadangan begitu panel pindah (dulu: 'no such table' sampai isolate diganti)", async () => {
		await runSync({ primary, spare, mode: "sync", exclude: [] }); // cadangan siap dipakai (synced_at), app_new BELUM ada di sana
		let runs = 0;
		const ensure = sharedOnce(
			async (e) => {
				runs++;
				await getTurso(e).prepare(`CREATE TABLE IF NOT EXISTS app_new (id INTEGER PRIMARY KEY, note TEXT NOT NULL DEFAULT '')`).run();
			},
			1000,
			tursoGeneration,
		);
		const write = async (note: string) => {
			await ensure(env());
			await getTurso(env()).prepare(`INSERT INTO app_new (note) VALUES (?)`).bind(note).run();
		};
		await write("utama");
		expect(runs).toBe(1);
		const g0 = tursoGeneration();
		primaryBlocked = true;
		// permintaan yang MEMICU pindah: utama ditolak -> cadangan (generasi naik)
		await getTurso(env()).prepare(`SELECT COUNT(*) AS n FROM app_item`).first();
		expect(tursoGeneration()).toBe(g0 + 1);
		await write("cadangan"); // skema disiapkan ulang di cadangan, lalu tulis berhasil
		expect(runs).toBe(2);
		expect((await spare.execute(`SELECT note FROM app_new`)).rows.map((r) => String(r.note))).toEqual(["cadangan"]);
		await write("cadangan-2"); // generasi sama -> tidak membuat ulang
		expect(runs).toBe(2);
	});

	it("isolate lain yang melihat penanda berganti (tanpa memicu sendiri) juga menaikkan generasi", async () => {
		await runSync({ primary, spare, mode: "sync", exclude: [] });
		await tursoStatus(env()); // baca penanda: utama
		const g0 = tursoGeneration();
		await spare.execute(`INSERT OR REPLACE INTO kd_failover (k, v, at) VALUES ('active', 'spare', 'x')`);
		resetTursoForTest(); // isolate baru tidak membawa generasi lama -> lihat penanda langsung
		await tursoStatus(env());
		const g1 = tursoGeneration();
		await spare.execute(`INSERT OR REPLACE INTO kd_failover (k, v, at) VALUES ('active', 'primary', 'y')`);
		vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
		try {
			await tursoStatus(env()); // cache 60 dtk habis -> penanda dibaca ulang -> berganti
		} finally {
			vi.useRealTimers();
		}
		expect(tursoGeneration()).toBe(g1 + 1);
		expect(g0).toBeGreaterThanOrEqual(0);
	});
});
