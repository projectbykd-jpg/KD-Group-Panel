import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";

// Perintah pemilik 25 Okt 2026: DB 1 kena limit -> jangan spam; uji 1x sehari; masih gagal -> besok; berhasil -> lanjut Online.

const dbs = vi.hoisted(() => ({ map: new Map<string, unknown>() }));
vi.mock("@libsql/client/web", () => ({ createClient: ({ url }: { url: string }) => dbs.map.get(url) }));

import { getTurso, resetTursoForTest } from "../src/lib/turso";
import { db1Gate, db1GatePeek, db1Settle, resetDb1GateForTest } from "../src/lib/db1-gate";
import { resetSysCache } from "../src/lib/settings";

const BLOCKED = "BLOCKED: Operation was blocked: SQL read operations are forbidden (reads are blocked, do you need to upgrade your plan?)";
const H = 3600_000;
let dir: string;
let primary: Client, spare: Client;
const calls = { primary: 0, spare: 0 };
const fail: { primary: string | null; spare: string | null } = { primary: null, spare: null };

function tracked(real: Client, name: "primary" | "spare"): Client {
	const guard = <T>(fn: () => Promise<T>) => {
		calls[name]++;
		return fail[name] ? Promise.reject(new Error(fail[name]!)) : fn();
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

/** Satu pekerjaan BOT News yang menyentuh DB 1 (galatnya sengaja dibungkus ulang, seperti pemanggil sungguhan). */
async function newsJob(e: Env) {
	try {
		await getTurso(e).prepare(`SELECT v FROM bot_kv WHERE k = 'enabled'`).first();
	} catch (err) {
		throw new Error("BOT News gagal: " + String(err).slice(0, 40));
	}
}

const t0 = Date.parse("2026-10-25T03:00:00Z");

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "kd-db1gate-"));
	primary = createClient({ url: "file:" + join(dir, "p.db") });
	spare = createClient({ url: "file:" + join(dir, "s.db") });
	await primary.execute(`CREATE TABLE bot_kv (k TEXT PRIMARY KEY, v TEXT)`);
	calls.primary = calls.spare = 0;
	fail.primary = fail.spare = null;
	dbs.map.set("libsql://primary", tracked(primary, "primary"));
	dbs.map.set("libsql://spare", tracked(spare, "spare"));
	resetTursoForTest();
	resetDb1GateForTest();
	resetSysCache();
});
afterEach(() => {
	primary.close();
	spare.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("gerbang DB 1 (BOT News)", () => {
	it("tanpa galat: terbuka, tidak menyentuh DB 1 sama sekali", async () => {
		expect(await db1Gate(env(), { nowMs: t0 })).toEqual({ open: true });
		expect(calls.primary).toBe(0);
	});

	it("kuota DB 1 -> tertutup; selama 24 jam DB 1 TIDAK disentuh; lalu diuji sekali; masih kuota -> besok; pulih -> Online", async () => {
		fail.primary = BLOCKED;
		await expect(newsJob(env())).rejects.toThrow(/BOT News gagal/);
		expect(await db1Settle(env(), t0)).toBe(true);
		calls.primary = 0;
		for (const dt of [1, 5 * 60_000, H, 12 * H, 24 * H - 1]) {
			const g = await db1Gate(env(), { nowMs: t0 + dt });
			expect(g.open).toBe(false);
			if (!g.open) expect(g.message).toMatch(/BOT News dijeda: DB 1 kena kuota Turso sejak 2026-10-25 10:00 WIB\. Diuji otomatis lagi ±2026-10-26 10:00 WIB/);
		}
		expect(calls.primary).toBe(0);

		// hari ke-2: masih kuota -> satu uji saja, jadwal maju 24 jam
		const g2 = await db1Gate(env(), { nowMs: t0 + 24 * H });
		expect(g2.open).toBe(false);
		expect(calls.primary).toBe(1);
		expect((await db1Gate(env(), { nowMs: t0 + 25 * H })).open).toBe(false);
		expect(calls.primary).toBe(1);
		if (!g2.open) expect(g2.nextProbeAt).toBe(t0 + 48 * H);

		// hari ke-3: pulih -> terbuka, penanda dihapus, berikutnya tidak menguji lagi
		fail.primary = null;
		expect(await db1Gate(env(), { nowMs: t0 + 48 * H })).toEqual({ open: true, recovered: true });
		expect(await db1Gate(env(), { nowMs: t0 + 48 * H + 1 })).toEqual({ open: true });
		expect(await db1GatePeek(env())).toEqual({ open: true });
		expect(calls.primary).toBe(2);
	});

	it("kuota di DB 2 (tabel panel) TIDAK pernah menjeda BOT News", async () => {
		fail.spare = BLOCKED;
		await expect(getTurso(env()).prepare(`SELECT * FROM lap_job`).all()).rejects.toThrow(/BLOCKED/);
		fail.spare = null; // DB 2 sudah normal lagi: penanda BISA ditulis, tapi tidak boleh ditulis
		expect(await db1Settle(env(), t0)).toBe(false);
		expect((await db1Gate(env(), { nowMs: t0 })).open).toBe(true);
	});

	it("galat DB 1 BUKAN kuota (jaringan) tidak menjeda; saat uji harian galat begitu dicoba lagi 1 jam kemudian", async () => {
		fail.primary = "fetch failed: ECONNRESET";
		await expect(newsJob(env())).rejects.toThrow();
		expect(await db1Settle(env(), t0)).toBe(false);
		expect((await db1Gate(env(), { nowMs: t0 })).open).toBe(true);

		fail.primary = BLOCKED;
		await expect(newsJob(env())).rejects.toThrow();
		await db1Settle(env(), t0);
		fail.primary = "fetch failed: ECONNRESET";
		const g = await db1Gate(env(), { nowMs: t0 + 24 * H });
		expect(g.open).toBe(false);
		if (!g.open) expect(g.nextProbeAt).toBe(t0 + 25 * H);
	});

	it("banyak tick bersamaan saat jadwal uji: DB 1 hanya diuji SEKALI", async () => {
		fail.primary = BLOCKED;
		await expect(newsJob(env())).rejects.toThrow();
		await db1Settle(env(), t0);
		calls.primary = 0;
		const rs = await Promise.all([1, 2, 3, 4, 5].map(() => db1Gate(env(), { nowMs: t0 + 24 * H + 5 })));
		expect(rs.every((r) => !r.open)).toBe(true);
		expect(calls.primary).toBe(1);
	});

	it("tombol manual (force) menguji sekarang tanpa menunggu jadwal", async () => {
		fail.primary = BLOCKED;
		await expect(newsJob(env())).rejects.toThrow();
		await db1Settle(env(), t0);
		fail.primary = null;
		expect(await db1Gate(env(), { nowMs: t0 + H, force: true })).toEqual({ open: true, recovered: true });
	});

	it("jeda kedua kali tidak memundurkan jadwal uji yang sudah ada", async () => {
		fail.primary = BLOCKED;
		await expect(newsJob(env())).rejects.toThrow();
		await db1Settle(env(), t0);
		await expect(newsJob(env())).rejects.toThrow();
		await db1Settle(env(), t0 + 10 * H);
		const g = await db1GatePeek(env());
		expect(!g.open && g.nextProbeAt).toBe(t0 + 24 * H);
	});

	it("interval uji mengikuti Admin > Pengaturan Sistem (sys_db1_probe_hours)", async () => {
		const e = { ...env(), DB: { prepare: () => ({ all: async () => ({ results: [{ key: "sys_db1_probe_hours", value: "6" }] }) }) } } as unknown as Env;
		fail.primary = BLOCKED;
		await expect(newsJob(e)).rejects.toThrow();
		await db1Settle(e, t0);
		const g = await db1GatePeek(e);
		expect(!g.open && g.nextProbeAt).toBe(t0 + 6 * H);
	});

	it("tanpa DB 2 (dev/test): gerbang tidak dipakai (penandanya akan ikut tersimpan di DB 1 yang diblokir)", async () => {
		fail.primary = BLOCKED;
		await expect(newsJob(env(false))).rejects.toThrow();
		expect(await db1Settle(env(false), t0)).toBe(false);
		expect((await db1Gate(env(false), { nowMs: t0 })).open).toBe(true);
	});

	it("penanda disimpan di DB 2, bukan di DB 1", async () => {
		fail.primary = BLOCKED;
		await expect(newsJob(env())).rejects.toThrow();
		await db1Settle(env(), t0);
		const names = async (c: Client) => (await c.execute(`SELECT name FROM sqlite_master WHERE type = 'table'`)).rows.map((r) => String(r.name));
		expect(await names(spare)).toContain("turso_db1_gate");
		fail.primary = null;
		expect(await names(primary)).not.toContain("turso_db1_gate");
	});
});

describe("/__cron saat DB 1 dijeda", () => {
	it("job=githubnews TIDAK memicu workflow BOT NEWS turbo (tidak ada run merah di GitHub Actions); hari berikutnya pulih -> memicu lagi", async () => {
		const { default: worker } = await import("../src/index");
		const { fakeEnv } = await import("./helpers/fake-env");
		const ctx = fakeEnv();
		const e = { ...ctx.env, ...env(), CRON_KEY: "k", GH_TOKEN: "ghp_test" } as unknown as Env;
		const gh: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (u: string) => {
			gh.push(String(u));
			return new Response(null, { status: 204 });
		}) as typeof fetch;
		const exec = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
		const call = async () => (await (await worker.fetch!(new Request("https://x/__cron?key=k&job=githubnews") as never, e, exec)).json()) as Record<string, unknown>;
		try {
			fail.primary = BLOCKED;
			await expect(newsJob(e)).rejects.toThrow();
			await db1Settle(e);
			calls.primary = 0;
			const out = await call();
			expect(out.githubnews).toBeUndefined();
			expect(String(out.db1)).toContain("BOT News dijeda");
			expect(gh.filter((u) => u.includes("news-turbo.yml"))).toEqual([]);
			expect(calls.primary).toBe(0);

			fail.primary = null;
			const { db1Gate: g } = await import("../src/lib/db1-gate");
			expect((await g(e, { force: true })).open).toBe(true);
			const out2 = await call();
			expect(out2.db1).toBeUndefined();
			expect(gh.filter((u) => u.includes("news-turbo.yml"))).toHaveLength(1);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
