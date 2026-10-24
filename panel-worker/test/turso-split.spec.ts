import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";

// Pembagian database (perintah pemilik 25 Okt 2026): DB 1 (utama) HANYA BOT News, DB 2 (cadangan) semua data panel.
// Tidak ada lagi pindah otomatis / failback: kuota BOT News di DB 1 tidak boleh mematikan panel.

const dbs = vi.hoisted(() => ({ map: new Map<string, unknown>() }));
vi.mock("@libsql/client/web", () => ({ createClient: ({ url }: { url: string }) => dbs.map.get(url) }));

import { getTurso, resetTursoForTest, tursoGeneration, tursoLayout, tursoTargetFor } from "../src/lib/turso";
import { sharedOnce } from "../src/lib/shared-once";

const BLOCKED = "BLOCKED: Operation was blocked: SQL read operations are forbidden (reads are blocked, do you need to upgrade your plan?)";
let dir: string;
let primary: Client, spare: Client;
const calls = { primary: 0, spare: 0 };
let primaryBlocked = false;

/** Klien yang mencatat pemakaian; utama bisa "diblokir" seperti Turso saat kuota habis. */
function tracked(real: Client, name: "primary" | "spare"): Client {
	const guard = <T>(fn: () => Promise<T>) => {
		calls[name]++;
		return name === "primary" && primaryBlocked ? Promise.reject(new Error(BLOCKED)) : fn();
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
const tables = async (c: Client) => (await c.execute(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)).rows.map((r) => String(r.name));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kd-turso-"));
	primary = createClient({ url: "file:" + join(dir, "p.db") });
	spare = createClient({ url: "file:" + join(dir, "s.db") });
	calls.primary = calls.spare = 0;
	primaryBlocked = false;
	dbs.map.set("libsql://primary", tracked(primary, "primary"));
	dbs.map.set("libsql://spare", tracked(spare, "spare"));
	resetTursoForTest();
});
afterEach(() => {
	primary.close();
	spare.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("DB 1 = BOT News, DB 2 = panel", () => {
	it("tabel panel (Laporan, Live Chat, Auto Prediksi, ...) SELALU ke DB 2; tabel BOT News SELALU ke DB 1", async () => {
		const db = getTurso(env());
		await db.prepare(`CREATE TABLE IF NOT EXISTS livechat_log (id INTEGER PRIMARY KEY, msg TEXT)`).run();
		await db.prepare(`INSERT INTO livechat_log (msg) VALUES (?)`).bind("halo").run();
		expect(calls).toEqual({ primary: 0, spare: 2 });
		await db.prepare(`CREATE TABLE IF NOT EXISTS bot_kv (k TEXT PRIMARY KEY, v TEXT)`).run();
		await db.prepare(`INSERT INTO bot_kv (k, v) VALUES ('a', '1')`).run();
		expect(calls).toEqual({ primary: 2, spare: 2 });
		expect(await tables(primary)).toEqual(["bot_kv"]);
		expect(await tables(spare)).toEqual(["livechat_log"]);
		expect(tursoLayout(env())).toEqual({ news: "primary", panel: "spare", spareConfigured: true });
		for (const t of ["news_article", "news_source", "bot_kv", "ai_usage"]) expect(tursoTargetFor(env(), `SELECT * FROM ${t}`)).toBe("primary");
		for (const t of ["lap_job", "invest_raw", "auto_input_job", "livechat_session", "toto_macau_log", "wd_listed", "assistant_usage"]) expect(tursoTargetFor(env(), `SELECT * FROM ${t}`)).toBe("spare");
	});

	it("DB 1 kena kuota: BOT News gagal apa adanya, panel TETAP jalan di DB 2 tanpa menyentuh DB 1", async () => {
		primaryBlocked = true;
		const db = getTurso(env());
		await expect(db.prepare(`SELECT * FROM news_article`).all()).rejects.toThrow(/BLOCKED/);
		calls.primary = 0;
		await db.prepare(`CREATE TABLE lap_job (id INTEGER PRIMARY KEY, st TEXT)`).run();
		await db.prepare(`INSERT INTO lap_job (st) VALUES ('ok')`).run();
		expect((await db.prepare(`SELECT st FROM lap_job`).first<{ st: string }>())?.st).toBe("ok");
		expect(calls.primary).toBe(0);
	});

	it("penanda lama kd_failover di DB 2 diabaikan: panel tidak pernah kembali menulis ke DB 1", async () => {
		await spare.batch(
			[`CREATE TABLE kd_failover (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '', at TEXT NOT NULL DEFAULT '')`, `INSERT INTO kd_failover (k, v) VALUES ('active', 'primary'), ('synced_at', 'x')`],
			"write",
		);
		await getTurso(env()).prepare(`CREATE TABLE wd_listed (id INTEGER PRIMARY KEY)`).run();
		expect(calls.primary).toBe(0);
		expect(await tables(spare)).toContain("wd_listed");
	});

	it("satu batch yang mencampur tabel News + panel DITOLAK (tidak ada yang tertulis di database mana pun)", async () => {
		const db = getTurso(env());
		await expect(
			db.batch([db.prepare(`CREATE TABLE news_article (id INTEGER PRIMARY KEY)`), db.prepare(`CREATE TABLE error_log (id INTEGER PRIMARY KEY)`)]),
		).rejects.toThrow(/mencampur tabel BOT News \(DB 1\) dan tabel panel \(DB 2\)/);
		expect(calls).toEqual({ primary: 0, spare: 0 });
		// batch satu database tetap jalan
		await db.batch([db.prepare(`CREATE TABLE news_source (id INTEGER PRIMARY KEY)`), db.prepare(`INSERT INTO news_source (id) VALUES (1)`)]);
		expect(await tables(primary)).toEqual(["news_source"]);
	});

	it("DB 2 belum diatur (dev/test): semuanya di utama seperti sebelum ada cadangan, galat kuota diteruskan", async () => {
		const db = getTurso(env(false));
		await db.prepare(`CREATE TABLE lap_job (id INTEGER PRIMARY KEY)`).run();
		expect(calls).toEqual({ primary: 1, spare: 0 });
		expect(tursoLayout(env(false))).toEqual({ news: "primary", panel: "primary", spareConfigured: false });
		primaryBlocked = true;
		await expect(db.prepare(`SELECT * FROM lap_job`).all()).rejects.toThrow(/BLOCKED/);
	});

	it("skema 'sekali per isolate' (sharedOnce + generasi) dibuat di database tujuannya masing-masing", async () => {
		const ensure = sharedOnce(
			async (e) => {
				await getTurso(e).prepare(`CREATE TABLE IF NOT EXISTS auto_input_job (id INTEGER PRIMARY KEY)`).run();
				await getTurso(e).prepare(`CREATE TABLE IF NOT EXISTS ai_usage (id INTEGER PRIMARY KEY)`).run();
			},
			1000,
			tursoGeneration,
		);
		await ensure(env());
		await ensure(env()); // sudah siap -> tanpa query lagi
		expect(calls).toEqual({ primary: 1, spare: 1 });
		expect(await tables(spare)).toEqual(["auto_input_job"]);
		expect(await tables(primary)).toEqual(["ai_usage"]);
	});
});
