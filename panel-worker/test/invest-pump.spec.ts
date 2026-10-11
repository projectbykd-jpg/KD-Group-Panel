import { describe, expect, it } from "vitest";
import { pumpTurn } from "../src/lib/invest-scan";

describe("pump Invest: anggaran subrequest per tick (batas Cloudflare gratis 50)", () => {
	it("total fetch tidak pernah melebihi anggaran, berapa pun jumlah user yang scan", () => {
		for (const n of [1, 2, 3, 4, 6, 10, 25]) {
			const users = Array.from({ length: n }, (_, i) => "u" + i);
			const { turn, perUserFetch } = pumpTurn(users, 0, 28);
			expect(turn.length * perUserFetch).toBeLessThanOrEqual(28);
			expect(perUserFetch).toBeGreaterThanOrEqual(8);
		}
	});
	it("bergiliran: dalam beberapa menit semua user kebagian", () => {
		const users = Array.from({ length: 7 }, (_, i) => "u" + i);
		const seen = new Set<string>();
		for (let m = 0; m < 7; m++) pumpTurn(users, m * 60_000, 28).turn.forEach((u) => seen.add(u));
		expect(seen.size).toBe(7);
	});
});
