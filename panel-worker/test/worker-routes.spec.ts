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
