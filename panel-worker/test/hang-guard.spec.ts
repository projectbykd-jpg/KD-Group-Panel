import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMasterData, MASTER_LOAD_TIMEOUT_MS, resetMasterCache } from "../src/lib/master-data";
import { resetSysCache } from "../src/lib/settings";
import { resetIntegrationsCache } from "../src/lib/integrations";
import { fakeKV } from "./helpers/fake-env";

// Database yang TIDAK PERNAH menjawab (D1 menggantung) -- kondisi yang membuat panel "Memuat…" / login "Memverifikasi…" tanpa akhir.
const never = () => new Promise<never>(() => {});
const hangingDB = { prepare: () => ({ bind() { return this; }, first: never, all: never, run: never }), batch: never };
const hangingEnv = () => ({ DB: hangingDB, SESS: fakeKV(), TZ_OFFSET_HOURS: "7" }) as unknown as Env;

afterEach(() => {
	vi.useRealTimers();
	resetMasterCache();
	resetSysCache();
	resetIntegrationsCache();
});

describe("pengaman permintaan menggantung", () => {
	it("pemuatan pengaturan bersama punya batas waktu: database menggantung tidak menggantungkan request", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const env = hangingEnv();
		let done = false;
		const p = loadMasterData(env).then(() => (done = true));
		await vi.advanceTimersByTimeAsync(MASTER_LOAD_TIMEOUT_MS - 100);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(200);
		await p;
		expect(done).toBe(true);
		// request berikutnya tidak ikut menunggu janji yang menggantung (langsung jalan, coba muat lagi ±3 dtk kemudian)
		let second = false;
		const q = loadMasterData(env).then(() => (second = true));
		await vi.advanceTimersByTimeAsync(0);
		await q;
		expect(second).toBe(true);
	});

	it("/api yang menggantung dijawab 504 dengan pesan jelas (bukan spinner tanpa akhir) dan prosesnya diteruskan di belakang", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		const worker = (await import("../src/index")).default as unknown as {
			fetch: (r: Request, e: Env, c: { waitUntil: (p: Promise<unknown>) => void; passThroughOnException: () => void }) => Promise<Response>;
		};
		const waits: Promise<unknown>[] = [];
		const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException: () => {} };
		const req = new Request("https://panel.test/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "checkLogin", username: "Admin", password: "x" }) });
		let res: Response | null = null;
		const pr = worker.fetch(req, hangingEnv(), ctx).then((r) => (res = r));
		await vi.advanceTimersByTimeAsync(99_000 + MASTER_LOAD_TIMEOUT_MS);
		expect(res).toBeNull(); // belum lewat batas bawaan 100 dtk
		await vi.advanceTimersByTimeAsync(2_000);
		await pr;
		expect(res!.status).toBe(504);
		const body = (await res!.json()) as { success: boolean; message: string };
		expect(body.success).toBe(false);
		expect(body.message).toContain("Server tidak menjawab dalam 100 detik");
		expect(body.message).toContain("checkLogin");
		expect(waits.length).toBeGreaterThanOrEqual(2); // proses asli + pencatatan galat diteruskan di belakang
	});
});
