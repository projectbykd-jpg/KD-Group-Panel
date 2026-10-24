import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Pagar CI (perintah pemilik 24 Okt 2026: "db utama sama db spare tidak ada yang beda, tampilan, logika, cara kerjanya sama").
// Modul yang membuat tabel/kolom Turso secara lazy WAJIB mencatat generasi database (tursoGeneration / sharedOnce(..., tursoGeneration)),
// bukan boolean "sudah dibuat" per isolate: boolean itu ikut terbawa saat panel pindah utama <-> cadangan, sehingga database
// tujuan tidak pernah mendapat tabel/kolom baru dan query gagal di sana. Tabel news memang SELALU di utama (dikecualikan).
const NEWS_ONLY = new Set(["bot-news.ts", "ai-provider.ts"]);
const dir = resolve(__dirname, "../src/lib");

describe("skema Turso sama di database utama & cadangan", () => {
	it("tidak ada penanda boolean skema per isolate di modul Turso (pakai tursoGeneration)", () => {
		const bad: string[] = [];
		for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
			if (NEWS_ONLY.has(f)) continue;
			const src = readFileSync(resolve(dir, f), "utf8");
			if (!/getTurso\(/.test(src) || !/CREATE TABLE|ADD COLUMN|ensureColumns\(/.test(src)) continue;
			// penanda milik D1 (env.DB, satu database tetap) dikecualikan: namanya wajib memuat "d1"/"D1"
			for (const m of src.matchAll(/^let (\w*(?:[Ee]nsured|[Rr]eady)\w*)\s*=\s*false;/gm)) if (!/d1|D1/.test(m[1])) bad.push(`${f}: ${m[1]}`);
			for (const m of src.matchAll(/sharedOnce\(([^;]*)\);/g)) if (!/tursoGeneration/.test(m[1])) bad.push(`${f}: sharedOnce tanpa tursoGeneration`);
		}
		expect(bad, "Pakai `let xGen = -1` + tursoGeneration() atau sharedOnce(..., tursoGeneration). Lihat src/lib/turso.ts").toEqual([]);
	});
});
