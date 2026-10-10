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
	it("/health?deep=1 memeriksa D1 + KV dan menjawab 503 saat gagal", async () => {
		const { deepHealth } = await import("../src/lib/health");
		const { fakeEnv } = await import("./helpers/fake-env");
		const env = fakeEnv().env;
		const ok = await deepHealth(env);
		expect(ok.ok).toBe(true);
		expect(Object.keys(ok.checks).sort()).toEqual(["d1", "kv"]);
		const broken = { ...env, DB: { prepare: () => { throw new Error("D1 down"); } } } as unknown as typeof env;
		const bad = await deepHealth(broken);
		expect(bad.ok).toBe(false);
		expect(bad.checks.d1.error).toContain("D1 down");
	});

	it("workflow watchdog ada, tiap 5 menit, memakai /health?deep=1", () => {
		const wf = readFileSync(join(process.cwd(), "..", ".github", "workflows", "watchdog.yml"), "utf8");
		expect(wf).toContain("*/5 * * * *");
		expect(wf).toContain("/health?deep=1");
	});
});
