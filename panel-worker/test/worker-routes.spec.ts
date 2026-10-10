import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Aset statis memakai not_found_handling "single-page-application": alamat yang TIDAK terdaftar di assets.run_worker_first
// tidak pernah sampai ke kode Worker -- pengunjung malah mendapat halaman Dashboard (index.html). Bug nyata: /public/news-feed.xml
// pernah dibuat di index.ts tetapi lupa didaftarkan, sehingga RSS tampil sebagai Dashboard. Tes ini mencegah terulang.
// vitest dijalankan dari folder panel-worker (npm run check), jadi path relatif terhadap cwd.
const src = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
const cfg = readFileSync(join(process.cwd(), "wrangler.jsonc"), "utf8");

function workerFirst(): string[] {
	const m = cfg.match(/"run_worker_first"\s*:\s*\[([^\]]*)\]/);
	if (!m) throw new Error("assets.run_worker_first tidak ditemukan di wrangler.jsonc");
	return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("rute Worker vs aset statis", () => {
	it("setiap rute url.pathname === '...' di index.ts terdaftar di assets.run_worker_first", () => {
		const routes = [...new Set([...src.matchAll(/url\.pathname === "([^"]+)"/g)].map((x) => x[1]))];
		expect(routes.length).toBeGreaterThan(5); // pola pencarian tidak boleh diam-diam kosong
		const listed = workerFirst();
		const missing = routes.filter((r) => !listed.includes(r));
		expect(missing, `Rute ini akan tampil sebagai Dashboard (SPA) bila tidak didaftarkan: ${missing.join(", ")}`).toEqual([]);
	});

	it("umpan RSS Facebook terdaftar secara khusus", () => {
		expect(workerFirst()).toContain("/public/news-feed.xml");
	});
});

describe("kesehatan & penjaga", () => {
	const wibTs = (ms: number) => new Date(ms + 7 * 3600_000).toISOString().slice(0, 19).replace("T", " ") + " | cron=* * * * *";
	const now = Date.parse("2026-10-11T00:30:00Z");

	it("cronAgeMin membaca detak WIB", async () => {
		const { cronAgeMin } = await import("../src/lib/health");
		expect(cronAgeMin(wibTs(now - 3 * 60_000), now)).toBe(3);
		expect(cronAgeMin("", now)).toBeNull();
	});

	it("/health?deep=1: D1 + KV + cron sehat; Turso dilewati bila tidak dikonfigurasi", async () => {
		const { deepHealth } = await import("../src/lib/health");
		const { fakeEnv } = await import("./helpers/fake-env");
		const { env, db } = fakeEnv();
		db.prepare(`INSERT INTO settings (key, value) VALUES ('cron_heartbeat', ?)`).run(wibTs(now - 60_000));
		const h = await deepHealth(env, now);
		expect(h.ok).toBe(true);
		expect(Object.keys(h.checks).sort()).toEqual(["cron", "d1", "kv", "turso"]);
		expect(h.checks.turso.note).toBe("tidak dikonfigurasi");
		expect(h.warnings).toEqual([]);
	});

	it("cron berhenti / belum pernah jalan = GAGAL; D1 mati = GAGAL", async () => {
		const { deepHealth } = await import("../src/lib/health");
		const { fakeEnv } = await import("./helpers/fake-env");
		const { env, db } = fakeEnv();
		expect((await deepHealth(env, now)).checks.cron.error).toContain("belum pernah");
		db.prepare(`INSERT INTO settings (key, value) VALUES ('cron_heartbeat', ?)`).run(wibTs(now - 25 * 60_000));
		const stale = await deepHealth(env, now);
		expect(stale.ok).toBe(false);
		expect(stale.checks.cron.error).toContain("25 menit");
		const broken = { ...env, DB: { prepare: () => { throw new Error("D1 down"); } } } as unknown as typeof env;
		const bad = await deepHealth(broken, now);
		expect(bad.ok).toBe(false);
		expect(bad.checks.d1.error).toContain("D1 down");
	});

	it("workflow watchdog: tiap 5 menit, /health?deep=1, peringatan, kuota Cloudflare", () => {
		const wf = readFileSync(join(process.cwd(), "..", ".github", "workflows", "watchdog.yml"), "utf8");
		const sh = readFileSync(join(process.cwd(), "..", ".github", "scripts", "watchdog.sh"), "utf8");
		expect(wf).toContain("*/5 * * * *");
		expect(wf).toContain("bash .github/scripts/watchdog.sh");
		expect(wf).toContain("TG_ALERT_TOKEN");
		expect(sh).toContain("/health?deep=1");
		expect(sh).toContain(".warnings");
		expect(sh).toContain("Aksi tidak dikenal"); // jalur /api
		expect(sh).toContain("workersInvocationsAdaptive"); // kuota request Worker
		expect(sh).toContain("d1AnalyticsAdaptiveGroups"); // kuota D1
	});
});
