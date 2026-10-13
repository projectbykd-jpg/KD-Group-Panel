import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./helpers/fake-env";
import { sendPredictionJob } from "../src/lib/prediction";

// Bug nyata (audit): cron auto-post & operator menekan kirim pada sesi+website yang sama di saat bersamaan ->
// keduanya lolos klaim Smart Lock -> prediksi terkirim DUA KALI ke grup Telegram website.
afterEach(() => vi.unstubAllGlobals());

describe("Smart Lock prediksi: tidak boleh terkirim dua kali", () => {
	it("dua permintaan bersamaan (cron + operator) -> hanya SATU yang mengirim; yang lain 'SEDANG DIPROSES'", async () => {
		const { env, db } = fakeEnv();
		db.exec(`INSERT INTO site_accounts (website, tg_pred_token, tg_pred_chat_id) VALUES ('HUGO','t','c')`);
		let sends = 0;
		let releaseB!: () => void;
		const bGate = new Promise<void>((r) => (releaseB = r));
		vi.stubGlobal("fetch", async () => {
			sends++;
			releaseB(); // B baru mereservasi SETELAH A mulai mengirim (jendela balapan yang nyata)
			await new Promise((r) => setTimeout(r, 20));
			return new Response("ok", { status: 200 });
		});
		const origBatch = (env.DB as unknown as { batch: (s: unknown[]) => Promise<unknown> }).batch;
		(env.DB as unknown as { batch: (s: { sql?: string; params?: unknown[] }[]) => Promise<unknown> }).batch = async (stmts) => {
			const p = stmts[0]?.params ?? [];
			if (String(stmts[0]?.sql).includes("Reservasi") && p.includes("OP")) await bGate;
			return origBatch.call(env.DB, stmts);
		};
		const base = { env, websites: ["HUGO"], scheduleId: "CLOSING-1600", predictionName: "X", kind: "closing" as const, logAction: "T" };
		const A = sendPredictionJob({ ...base, username: "AUTO", messageForWebsite: async () => { await new Promise((r) => setTimeout(r, 5)); return "msg"; } });
		const B = sendPredictionJob({ ...base, username: "OP", messageForWebsite: async () => "msg" });
		const [ra, rb] = await Promise.all([A, B]);
		expect(sends).toBe(1);
		const statuses = [...ra.websiteResults, ...rb.websiteResults].map((x) => x.status).sort();
		expect(statuses).toEqual(["BERHASIL", "SEDANG DIPROSES"]);
		expect(db.prepare(`SELECT status FROM prediction_registry`).all()).toEqual([{ status: "BERHASIL" }]);
	});

	it("reservasi basi (request mati > 3 menit) tetap bisa diambil alih -> tidak macet selamanya", async () => {
		const { env, db } = fakeEnv();
		db.exec(`INSERT INTO site_accounts (website, tg_pred_token, tg_pred_chat_id) VALUES ('HUGO','t','c')`);
		let sends = 0;
		vi.stubGlobal("fetch", async () => { sends++; return new Response("ok", { status: 200 }); });
		const base = { env, websites: ["HUGO"], scheduleId: "CLOSING-1600", predictionName: "X", kind: "closing" as const, logAction: "T" };
		await sendPredictionJob({ ...base, username: "AUTO", messageForWebsite: async () => "msg" });
		db.exec(`UPDATE prediction_registry SET status = 'PROCESSING', sent_at = '2000-01-01 00:00:00', request_id = 'mati'`);
		const r = await sendPredictionJob({ ...base, username: "OP", messageForWebsite: async () => "msg" });
		expect(r.websiteResults[0].status).toBe("BERHASIL");
		expect(sends).toBe(2);
	});

	it("Telegram tidak menjawab untuk satu website -> website lain langsung dilewati (tidak menunggu 25 dtk lagi), status GAGAL = aman dikirim ulang", async () => {
		const { env, db } = fakeEnv();
		db.exec(`INSERT INTO site_accounts (website, tg_pred_token, tg_pred_chat_id) VALUES ('HUGO','t','c'), ('FOLA','t','c'), ('ZETA','t','c')`);
		let sends = 0;
		vi.stubGlobal("fetch", async (_u: unknown, init?: RequestInit) => {
			sends++;
			expect(init?.signal).toBeInstanceOf(AbortSignal); // terikat tenggat keras
			throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
		});
		const base = { env, websites: ["HUGO", "FOLA", "ZETA"], scheduleId: "CLOSING-1600", predictionName: "X", kind: "closing" as const, logAction: "T" };
		const r = await sendPredictionJob({ ...base, username: "OP", messageForWebsite: async () => "msg" });
		expect(sends).toBe(1);
		expect(r.websiteResults.map((x) => x.status)).toEqual(["GAGAL", "GAGAL", "GAGAL"]);
		expect(r.websiteResults[0].reason).toContain("mungkin tetap terkirim");
		expect(r.websiteResults[1].reason).toMatch(/^Dilewati: Telegram tidak menjawab/);
		// Telegram pulih -> kirim ulang berjalan normal
		vi.stubGlobal("fetch", async () => { sends++; return new Response("ok", { status: 200 }); });
		const again = await sendPredictionJob({ ...base, username: "OP", messageForWebsite: async () => "msg" });
		expect(again.websiteResults.map((x) => x.status)).toEqual(["BERHASIL", "BERHASIL", "BERHASIL"]);
	});
});
