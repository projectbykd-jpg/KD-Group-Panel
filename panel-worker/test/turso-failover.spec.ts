import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";

// Database cadangan Turso (spare): panel pindah otomatis bila utama kena kuota, HANYA bila spare sudah disalin; skrip
// sinkron menyalin dengan rowid identik, tidak menimpa spare saat spare sedang dipakai, dan failback mengembalikannya.

const dbs = vi.hoisted(() => ({ map: new Map<string, unknown>() }));
vi.mock("@libsql/client/web", () => ({ createClient: ({ url }: { url: string }) => dbs.map.get(url) }));

import { getTurso, onTursoFailover, resetTursoForTest, tursoStatus } from "../src/lib/turso";
import { runSync } from "../scripts/turso-sync";

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
			`CREATE TABLE news_article (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new')`,
			`CREATE INDEX ix_news_status ON news_article(status, id)`,
			`CREATE TABLE bot_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '')`,
			`INSERT INTO news_article (title) VALUES ('a'), ('b'), ('c')`,
			`DELETE FROM news_article WHERE id = 2`, // celah id: salinan harus mempertahankan id 1 & 3
			`INSERT INTO bot_kv (k, v) VALUES ('daily_cap', '5')`,
		],
		"write",
	);
});
afterEach(() => {
	primary.close();
	spare.close();
	rmSync(dir, { recursive: true, force: true });
});

const ids = async (c: Client) => (await c.execute(`SELECT id, title, status FROM news_article ORDER BY id`)).rows.map((r) => `${r.id}:${r.title}:${r.status}`);

describe("sinkron utama -> cadangan", () => {
	it("menyalin skema, index & isi dengan id IDENTIK; kedua kalinya hanya menulis yang berubah", async () => {
		const r1 = await runSync({ primary, spare, mode: "sync", exclude: [] });
		expect(await ids(spare)).toEqual(["1:a:new", "3:c:new"]);
		expect((await spare.execute(`SELECT name FROM sqlite_master WHERE name = 'ix_news_status'`)).rows.length).toBe(1);
		expect(r1.tables.find((t) => t.name === "news_article")).toMatchObject({ written: 2, deleted: 0 });
		await primary.batch([`UPDATE news_article SET status = 'posted' WHERE id = 3`, `DELETE FROM news_article WHERE id = 1`, `INSERT INTO news_article (title) VALUES ('d')`], "write");
		await primary.execute(`ALTER TABLE news_article ADD COLUMN views INTEGER NOT NULL DEFAULT 0`);
		const r2 = await runSync({ primary, spare, mode: "sync", exclude: [] });
		expect(await ids(spare)).toEqual(["3:c:posted", "4:d:new"]);
		expect(r2.tables.find((t) => t.name === "news_article")).toMatchObject({ written: 2, deleted: 1 });
		expect((await spare.execute(`SELECT views FROM news_article WHERE id = 4`)).rows[0].views).toBe(0); // kolom baru ikut
		expect((await spare.execute(`SELECT v FROM kd_failover WHERE k = 'synced_at'`)).rows.length).toBe(1);
	});
});

describe("panel pindah ke cadangan saat utama kena kuota", () => {
	it("tanpa cadangan diatur: galat kuota diteruskan seperti dulu", async () => {
		primaryBlocked = true;
		await expect(getTurso(env(false)).prepare(`SELECT * FROM bot_kv`).all()).rejects.toThrow(/BLOCKED/);
	});

	it("cadangan BELUM pernah disalin: TIDAK pindah (spare kosong akan merusak data), pesannya jelas", async () => {
		primaryBlocked = true;
		await expect(getTurso(env()).prepare(`SELECT * FROM bot_kv`).all()).rejects.toThrow(/belum pernah disalin/);
		expect((await tursoStatus(env())).active).toBe("primary");
	});

	it("cadangan sudah disalin: query dilayani cadangan, penanda dicatat, hook dipanggil sekali; berikutnya langsung ke cadangan", async () => {
		await runSync({ primary, spare, mode: "sync", exclude: [] });
		const hook = vi.fn();
		onTursoFailover(hook);
		primaryBlocked = true;
		const db = getTurso(env());
		const r = await db.prepare(`SELECT v FROM bot_kv WHERE k = ?`).bind("daily_cap").first<{ v: string }>();
		expect(r?.v).toBe("5");
		expect(hook).toHaveBeenCalledTimes(1);
		expect((await tursoStatus(env())).active).toBe("spare");
		// tulis setelah pindah: ke cadangan, id melanjutkan id yang sama dengan utama (tidak bertabrakan)
		const ins = await db.prepare(`INSERT INTO news_article (title) VALUES (?)`).bind("baru").run();
		expect(ins.meta.last_row_id).toBe(4);
		const before = primaryCalls;
		await db.prepare(`SELECT COUNT(*) AS n FROM news_article`).first();
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
		await db.prepare(`INSERT INTO news_article (title) VALUES ('saat-gangguan')`).run();
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
