import { describe, expect, it } from "vitest";
import { sharedOnce } from "../src/lib/shared-once";

const env = {} as Env;
const never = () => new Promise<void>(() => {});

describe("sharedOnce: pembuatan skema bersama tidak boleh membuat semua request menggantung", () => {
	it("janji milik request lain yang TIDAK pernah selesai -> request berikutnya lanjut sendiri setelah batas tunggu", async () => {
		let calls = 0;
		const ensure = sharedOnce(async () => {
			calls++;
			if (calls === 1) return never(); // request pertama terputus / Turso macet
		}, 50);
		void ensure(env); // request A (tidak pernah selesai)
		const t0 = Date.now();
		await ensure(env); // request B: dulu menunggu selamanya
		expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
		expect(calls).toBe(2);
		await ensure(env); // sudah beres -> tanpa query lagi
		expect(calls).toBe(2);
	});

	it("panggilan paralel (Promise.all) berbagi SATU pembuatan skema (hemat subrequest)", async () => {
		let calls = 0;
		const ensure = sharedOnce(async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 10));
		}, 1000);
		await Promise.all([ensure(env), ensure(env), ensure(env)]);
		expect(calls).toBe(1);
	});

	it("gagal -> galat diteruskan ke semua penunggu, panggilan berikutnya mencoba lagi", async () => {
		let calls = 0;
		const ensure = sharedOnce(async () => {
			calls++;
			if (calls === 1) throw new Error("turso down");
		}, 1000);
		const r = await Promise.allSettled([ensure(env), ensure(env)]);
		expect(r.map((x) => x.status)).toEqual(["rejected", "rejected"]);
		await ensure(env);
		expect(calls).toBe(2);
	});
});
