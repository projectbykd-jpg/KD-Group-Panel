import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1, tursoGeneration: () => 0 }));

import { sendToPanelZOnly, smartAutoSendFast } from "../src/api/send";
import { checkLogin } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { resetSysCache } from "../src/lib/settings";
import { resetIntegrationsCache } from "../src/lib/integrations";
import { fakeD1, fakeEnv } from "./helpers/fake-env";

// "Kirim Semua" (smartAutoSendFast) dulu mengirim website BERGILIRAN. LinkTree dipakai SEMUA website lewat SATU server, jadi
// saat server itu lambat: 25 dtk x tiap panggilan x tiap website > 100 dtk -> "Permintaan menggantung lebih dari 100 dtk"
// (Error & Bug, 14 Okt 02:04) dan operator tidak melihat hasil apa pun.

const RAW = `Hasil Pengeluaran Pasaran FLORIDAEVE
Hari Selasa , 06 October 2026

Prize 1 : 9808
Shio : BABI`;
let SITES = ["HUGO", "FOLA", "ZETA"];

type Route = (url: string, init?: RequestInit) => Promise<Response>;
let ctx: ReturnType<typeof fakeEnv>;
let calls: string[];
let inFlight = 0;
let peak = 0;
let override: Route | null = null;

const ok: Route = async (url) => {
	if (url.includes("api.telegram.org")) return new Response('{"ok":true}', { status: 200 });
	if (url.includes(":8069/index")) return new Response("", { status: 302, headers: { "set-cookie": "session_id=lt1; Path=/" } });
	if (url.includes(":8069/notif_send_post")) return new Response("ok", { status: 200 });
	if (url.includes("authentication.php")) return new Response("", { status: 302, headers: { "set-cookie": "PHPSESSID=pz1; path=/" } });
	if (url.includes("dashboard.php")) return new Response(`<tr><td>florida-eve</td><td><a href="update-resultlotto.php?row=7">ubah</a></td></tr>`, { status: 200 });
	if (url.includes("update-resultlotto.php")) return new Response("ok", { status: 200 });
	return new Response("?", { status: 404 });
};

async function login(): Promise<string> {
	ctx.db
		.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status, websites, perm_telegram, perm_linktree, perm_panelz) VALUES ('Op','op',?,'OPERATOR','AKTIF',?,1,1,1)`)
		.run(await hashPassword("pw"), JSON.stringify(SITES));
	for (const w of SITES) {
		ctx.db
			.prepare(`INSERT INTO site_accounts (website, tg_token, tg_chat_id, lt_email, lt_pass, pz_url, pz_user, pz_pass, pz_user2, pz_pass2) VALUES (?,?,?,?,?,?,?,?,?,?)`)
			.run(w, "1:tok" + w, "-100" + w.length, w.toLowerCase() + "@lt", "x", "https://pz-" + w.toLowerCase() + ".test", "u", "p", "u2", "p2");
	}
	return ((await checkLogin(ctx.env, "Op", "pw", "")) as { sessionToken: string }).sessionToken;
}

/** Tunggu (tanpa memajukan jam tiruan) sampai pengiriman benar-benar mulai -- login/hash memakai async asli. */
async function untilSending(): Promise<void> {
	// Batas WAKTU NYATA (bukan jumlah putaran): hashing password memakai crypto asli, lama-nya bergantung beban mesin.
	// setTimeout dipalsukan di tes ini, jadi tunggu lewat setImmediate; Date.now tidak dipalsukan.
	const until = Date.now() + 10_000;
	while (!calls.length && Date.now() < until) await new Promise((r) => setImmediate(r));
	expect(calls.length).toBeGreaterThan(0);
}

const timeoutErr = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

beforeEach(() => {
	SITES = ["HUGO", "FOLA", "ZETA"];
	const t = fakeD1([]);
	// registry membuat tabelnya sekali per isolate; Turso tiruan baru per tes -> siapkan tabelnya di sini
	t.raw.exec(`CREATE TABLE sent_registry (hash TEXT NOT NULL, website TEXT NOT NULL, sent_at TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', market TEXT NOT NULL DEFAULT '', telegram INTEGER NOT NULL DEFAULT 0, linktree INTEGER NOT NULL DEFAULT 0, panelz INTEGER NOT NULL DEFAULT 0, content TEXT NOT NULL DEFAULT '', PRIMARY KEY (hash, website))`);
	turso.current = t;
	ctx = fakeEnv();
	resetSysCache();
	resetIntegrationsCache();
	calls = [];
	inFlight = 0;
	peak = 0;
	override = null;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		inFlight++;
		peak = Math.max(peak, inFlight);
		try {
			await new Promise((r) => setTimeout(r, 1)); // beri kesempatan website lain berjalan bersamaan
			return await (override ?? ok)(url, init);
		} finally {
			inFlight--;
		}
	});
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

type Res = { websiteResults: { website: string; telegram: { status: string; reason: string }; linktree: { status: string; reason: string }; panelz: { status: string; reason: string } }[] };

describe("Kirim Semua tidak lagi menggantung", () => {
	it("website dikirimi PARALEL (maks 6 koneksi), urutan hasil tetap sama, semua sistem terkirim", async () => {
		const token = await login();
		const r = (await smartAutoSendFast(ctx.env, token, RAW)) as unknown as Res;
		expect(r.websiteResults.map((w) => w.website)).toEqual(SITES);
		for (const w of r.websiteResults) {
			expect([w.telegram.status, w.linktree.status, w.panelz.status]).toEqual(["BERHASIL", "BERHASIL", "BERHASIL"]);
		}
		expect(peak).toBeGreaterThan(1); // bersamaan, bukan bergiliran
		expect(peak).toBeLessThanOrEqual(6); // batas koneksi keluar Cloudflare
	});

	it("LinkTree (satu server untuk semua website) tidak menjawab -> website berikutnya TIDAK menunggu 25 dtk lagi (dilewati), Telegram/Panel-Z tetap jalan", async () => {
		SITES = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]; // lebih banyak dari 6 kiriman bersamaan
		const token = await login();
		override = async (url, init) => {
			if (url.includes(":8069/")) throw timeoutErr();
			return ok(url, init);
		};
		const r = (await smartAutoSendFast(ctx.env, token, RAW)) as unknown as Res;
		// gelombang pertama (6 website bersamaan) menunggu server mati SEKALI bersama-sama; website 7-8 langsung dilewati
		expect(calls.filter((u) => u.includes(":8069/")).length).toBe(6);
		expect(r.websiteResults.slice(6).every((w) => w.linktree.reason.startsWith("Dilewati: LinkTree tidak menjawab"))).toBe(true);
		for (const w of r.websiteResults) {
			expect(w.telegram.status).toBe("BERHASIL");
			expect(w.panelz.status).toBe("BERHASIL");
			expect(w.linktree.status).toBe("GAGAL");
			expect(w.linktree.reason).toMatch(/LinkTree (tidak menjawab|koneksi)|Dilewati: LinkTree tidak menjawab/);
		}

		// kirim ulang: yang sudah terkirim tidak dobel (registry), hanya LinkTree yang dicoba lagi
		override = null;
		calls = [];
		const again = (await smartAutoSendFast(ctx.env, token, RAW)) as unknown as Res;
		for (const w of again.websiteResults) {
			expect(w.telegram.status).toBe("SUDAH DIKIRIM");
			expect(w.panelz.status).toBe("SUDAH DIKIRIM");
			expect(w.linktree.status).toBe("BERHASIL");
		}
		expect(calls.some((u) => u.includes("api.telegram.org") || u.includes("pz-"))).toBe(false);
	});

	it("TENGGAT KERAS: server yang menggantung diputus sebelum batas tunggu panel; hasil tetap dikembalikan dan yang berhasil tercatat", async () => {
		const token = await login();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		override = (url, init) => {
			if (!url.includes("pz-")) return ok(url, init);
			// Panel-Z tidak pernah menjawab; hanya putus bila signal-nya dibatalkan
			return new Promise<Response>((_res, rej) => {
				const s = init?.signal;
				if (!s) return; // tanpa signal = menggantung selamanya (gagal tes lewat timeout)
				s.addEventListener("abort", () => rej(s.reason));
			});
		};
		let res: Res | null = null;
		const p = smartAutoSendFast(ctx.env, token, RAW).then((x) => (res = x as unknown as Res));
		await untilSending();
		await vi.advanceTimersByTimeAsync(86_000);
		expect(res).toBeNull(); // masih menunggu Panel-Z
		await vi.advanceTimersByTimeAsync(3_000); // bawaan 100 dtk - cadangan 12 dtk = 88 dtk
		await p;
		for (const w of res!.websiteResults) {
			expect(w.telegram.status).toBe("BERHASIL");
			expect(w.linktree.status).toBe("BERHASIL");
			expect(w.panelz.status).toBe("GAGAL");
			expect(w.panelz.reason).toContain("batas waktu kirim habis");
			expect(w.panelz.reason).toContain("mungkin tetap terkirim");
		}
		// Telegram/LinkTree yang sudah terkirim tercatat -> kirim ulang tidak dobel
		vi.useRealTimers();
		override = null;
		const again = (await smartAutoSendFast(ctx.env, token, RAW)) as unknown as Res;
		expect(again.websiteResults.every((w) => w.telegram.status === "SUDAH DIKIRIM" && w.panelz.status === "BERHASIL")).toBe(true);
	});

	it("Send Panel-Z (manual) juga paralel + bertenggat; hasil tiap website dilaporkan", async () => {
		const token = await login();
		const r = await sendToPanelZOnly(ctx.env, token, "FLORIDAEVE", "1234");
		expect(r.success).toBe(true);
		expect(r.message).toBe(SITES.map((w) => `${w}: Berhasil dikirim`).join(" | "));
		expect(peak).toBeGreaterThan(1);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		override = (url, init) =>
			url.includes("pz-fola")
				? new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)))
				: ok(url, init);
		let out: { success: boolean; message: string } | null = null;
		calls = [];
		const p = sendToPanelZOnly(ctx.env, token, "FLORIDAEVE", "1234").then((x) => (out = x));
		await untilSending();
		await vi.advanceTimersByTimeAsync(86_000);
		expect(out).toBeNull();
		await vi.advanceTimersByTimeAsync(3_000);
		await p;
		expect(out!.success).toBe(false);
		expect(out!.message).toContain("HUGO: Berhasil dikirim");
		expect(out!.message).toContain("FOLA: Panel-Z belum menjawab saat batas waktu kirim habis");
		expect(out!.message).toContain("ZETA: Berhasil dikirim");
	});
});
