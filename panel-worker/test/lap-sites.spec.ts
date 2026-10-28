import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1, tursoGeneration: () => 0 }));

import { lapGetConfig, lapGetResults, lapJobResult, lapJobStart, lapJobs, lapRunAdmin, lapSaveConfig } from "../src/api/lap";
import { checkLogin } from "../src/api/auth";
import { resetAutoInputTablesFlag, saveSession } from "../src/lib/auto-input";
import { hashPassword } from "../src/lib/crypto";
import { resetLapAdminSiteForTest } from "../src/lib/lap";
import { fakeD1, fakeEnv } from "./helpers/fake-env";

// Lap Admin per website (perintah pemilik 25 Okt 2026): akses 1, 2, 3+ website -> otomatis, tanpa setting tambahan.

let env: Env;
let db: import("node:sqlite").DatabaseSync;
let dispatched: { job_id: string; queue_key: string }[] = [];
const raw = () => turso.current!.raw;

async function login(websites: string[]) {
	db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, websites) VALUES ('Op','op',?, 'OPERATOR', ?)`).run(await hashPassword("pw"), JSON.stringify(websites));
	return ((await checkLogin(env, "Op", "pw", "")) as { sessionToken: string }).sessionToken;
}
const params = (id: string) => JSON.parse((raw().prepare(`SELECT params FROM lap_job WHERE id = ?`).get(id) as { params: string }).params);

beforeEach(() => {
	turso.current = fakeD1(["turso_001_schema.sql"]);
	resetAutoInputTablesFlag();
	resetLapAdminSiteForTest();
	const f = fakeEnv();
	env = f.env;
	db = f.db;
	Object.assign(env, { GH_TOKEN: "ghp_test", GH_REPO: "o/KD-scraper" });
	dispatched = [];
	vi.unstubAllGlobals();
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input).includes("/dispatches")) dispatched.push(JSON.parse(String(init?.body)).inputs);
		return new Response(null, { status: 204 });
	});
});

describe("Lap Admin otomatis untuk setiap website akun", () => {
	it("2 website: Setting otomatis per website (link admin bawaan, cookie Auto Prediksi dipakai bila Setting kosong) tanpa membocorkan cookie", async () => {
		const tok = await login(["HUGO", "FOLA"]);
		await saveSession(env, "Op", "HUGO", "https://ag.suksesbogil.com/", "PHPSESSID=hugoauto00000000aaaa; lastuser=vldaacs3");
		const cfg = (await lapGetConfig(env, tok)) as { config: { adminSites: Record<string, string>[] } };
		expect(cfg.config.adminSites).toEqual([
			{ website: "HUGO", brand: "HUGOTOGEL", linkAdmin: "https://ag.suksesbogil.com", cookieAdmin: "", source: "auto-prediksi", autoHint: "••••aaaa", vendorIdMotion: "", linkMotion: "", tokenMotion: "" },
			{ website: "FOLA", brand: "FOLATOTO", linkAdmin: "https://agwl12.suksesbogil.com", cookieAdmin: "", source: "", autoHint: "", vendorIdMotion: "", linkMotion: "", tokenMotion: "" },
		]);
		expect(JSON.stringify(cfg)).not.toContain("hugoauto00000000aaaa");
		// Setting per website: hanya website milik akun yang disimpan
		await lapSaveConfig(env, tok, { adminSites: [{ website: "FOLA", cookieAdmin: "PHPSESSID=folaset0000000000bbbb" }, { website: "XO", cookieAdmin: "PHPSESSID=asing" }] });
		const after = (await lapGetConfig(env, tok)) as { config: { adminSites: { website: string; source: string; cookieAdmin: string }[] } };
		expect(after.config.adminSites.map((x) => [x.website, x.source, x.cookieAdmin])).toEqual([
			["HUGO", "auto-prediksi", ""],
			["FOLA", "setting", "PHPSESSID=folaset0000000000bbbb"],
		]);
		expect(raw().prepare(`SELECT COUNT(*) AS n FROM lap_admin_site WHERE website = 'XO'`).get()).toEqual({ n: 0 });
		// link = bawaan disimpan kosong (tetap ikut Data Master); link lain disimpan
		await lapSaveConfig(env, tok, { adminSites: [{ website: "HUGO", linkAdmin: "https://ag.suksesbogil.com/" }, { website: "FOLA", linkAdmin: "https://lain.suksesbogil.com/x" }] });
		expect(raw().prepare(`SELECT website, link_admin FROM lap_admin_site ORDER BY website`).all()).toEqual([
			{ website: "FOLA", link_admin: "https://lain.suksesbogil.com" },
			{ website: "HUGO", link_admin: "" },
		]);
	});

	it("TARIK DATA menarik SEMUA website sekaligus (1 job per website); job membawa kredensial website-nya; hasil terpisah & berlabel", async () => {
		const tok = await login(["HUGO", "FOLA"]);
		await saveSession(env, "Op", "HUGO", "https://ag.suksesbogil.com/", "PHPSESSID=hugoauto00000000aaaa");
		await lapSaveConfig(env, tok, { adminSites: [{ website: "FOLA", cookieAdmin: "PHPSESSID=folaset0000000000bbbb" }] });
		const r = (await lapRunAdmin(env, tok, "2026-10-24", "2026-10-24")) as { success: boolean; jobs: { website: string; jobId: string }[] };
		expect(r.success).toBe(true);
		expect(r.jobs.map((j) => j.website)).toEqual(["HUGO", "FOLA"]);
		expect(dispatched.map((d) => d.queue_key)).toHaveLength(2);
		const [hugo, fola] = r.jobs;
		const key = (id: string) => params(id).key as string;
		const sh = (await lapJobStart(env, hugo.jobId, key(hugo.jobId))) as { creds: { linkAdmin: string; cookieAdmin: string; proxy: unknown } };
		expect(sh.creds).toEqual({ linkAdmin: "https://ag.suksesbogil.com", cookieAdmin: "PHPSESSID=hugoauto00000000aaaa", proxy: null });
		const sf = (await lapJobStart(env, fola.jobId, key(fola.jobId))) as { creds: { linkAdmin: string; cookieAdmin: string; proxy: unknown } };
		expect(sf.creds).toEqual({ linkAdmin: "https://agwl12.suksesbogil.com", cookieAdmin: "PHPSESSID=folaset0000000000bbbb", proxy: null });
		// klik lagi selama masih berjalan -> tidak memicu job ganda per website
		await lapRunAdmin(env, tok, "2026-10-24", "2026-10-24");
		expect(dispatched).toHaveLength(2);

		await lapJobResult(env, hugo.jobId, key(hugo.jobId), true, { register: [{ username: "h1" }], registerMeta: [{ dateLabel: "24 October 2026" }] }, {});
		await lapJobResult(env, fola.jobId, key(fola.jobId), true, { register: [{ username: "f1" }, { username: "f2" }], registerMeta: [{ dateLabel: "24 October 2026" }] }, {});
		const res = async (w: string) => JSON.parse(await ((await lapGetResults(env, tok, ["register", "registerMeta"], w)) as Response).text()).results;
		expect(await res("HUGO")).toEqual({ register: [{ username: "h1" }], registerMeta: [{ dateLabel: "24 October 2026", website: "HUGOTOGEL" }] });
		expect(await res("FOLA")).toEqual({ register: [{ username: "f1" }, { username: "f2" }], registerMeta: [{ dateLabel: "24 October 2026", website: "FOLATOTO" }] });
		const jobs = (await lapJobs(env, tok)) as { jobs: { website: string; brand: string; status: string }[] };
		expect(jobs.jobs.map((j) => [j.brand, j.status]).sort()).toEqual([["FOLATOTO", "done"], ["HUGOTOGEL", "done"]]);
	});

	it("website tanpa cookie dilewati dengan alasan; website lain tetap jalan", async () => {
		const tok = await login(["HUGO", "FOLA", "XO"]);
		await saveSession(env, "Op", "HUGO", "https://ag.suksesbogil.com/", "PHPSESSID=hugoauto00000000aaaa");
		const r = (await lapRunAdmin(env, tok, "2026-10-24", "2026-10-24")) as { success: boolean; jobs: { website: string }[]; skipped: string[] };
		expect(r.jobs.map((j) => j.website)).toEqual(["HUGO"]);
		expect(r.skipped.join(" ")).toMatch(/FOLATOTO: Cookie Admin belum ada.*XOTOGEL: Cookie Admin belum ada/);
	});

	it("data lama (satu cookie + hasil tanpa website) dipindah SEKALI ke website pemiliknya", async () => {
		const tok = await login(["HUGO", "FOLA"]);
		raw().prepare(`INSERT INTO lap_credentials (username, link_admin, cookie_admin) VALUES ('Op', 'https://agwl12.suksesbogil.com', 'PHPSESSID=lama000000000000cccc; vldaacs9=FOLATOTO.COM')`).run();
		raw().prepare(`INSERT INTO lap_result (username, module, data, updated_at) VALUES ('Op', 'register', '[{"username":"lama"}]', 'x'), ('Op', '_motionMeta', '[{"m":1}]', 'x')`).run();
		const res = async (w: string) => JSON.parse(await ((await lapGetResults(env, tok, ["register", "_motionMeta"], w)) as Response).text()).results;
		expect(await res("FOLA")).toEqual({ register: [{ username: "lama" }], _motionMeta: [{ m: 1 }], _motionShared: ["_motionMeta"] });
		expect(await res("HUGO")).toEqual({ _motionMeta: [{ m: 1 }], _motionShared: ["_motionMeta"] }); // Motion lama = gabungan, ditandai
		const cfg = (await lapGetConfig(env, tok)) as { config: { adminSites: { website: string; source: string; cookieAdmin: string }[] } };
		expect(cfg.config.adminSites.find((x) => x.website === "FOLA")).toMatchObject({ source: "setting", cookieAdmin: "PHPSESSID=lama000000000000cccc; vldaacs9=FOLATOTO.COM" });
		expect(raw().prepare(`SELECT module FROM lap_result WHERE username = 'Op' ORDER BY module`).all().map((x) => (x as { module: string }).module)).toEqual(["_motionMeta", "register@FOLA"]);
	});

	it("akun TANPA daftar website (mis. ADMIN): tetap satu set Setting seperti dulu", async () => {
		const tok = await login([]);
		await lapSaveConfig(env, tok, { linkAdmin: "https://ag.suksesbogil.com", cookieAdmin: "PHPSESSID=tunggal0000000000dddd" });
		const r = (await lapRunAdmin(env, tok, "2026-10-24", "2026-10-24")) as { success: boolean; jobId: string; jobs?: unknown };
		expect(r.success).toBe(true);
		expect(r.jobs).toBeUndefined();
		expect(params(r.jobId).website).toBeUndefined();
		const st = (await lapJobStart(env, r.jobId, params(r.jobId).key)) as { creds: { cookieAdmin: string } };
		expect(st.creds.cookieAdmin).toBe("PHPSESSID=tunggal0000000000dddd");
	});
});

import { lapMotionImport } from "../src/api/lap";

describe("Lap Motion per website", () => {
	const paidRow = (ref: string, game: string) => ({ reference_no: ref, paid_at: "2026-10-24 10:00:00", created_at: "2026-10-24 09:59:00", amount: 50000, paid_status: 1, game_name: game, username: "u" + ref });
	const wdRow = (ref: string, amount: number, extra: Record<string, unknown>) => ({ reference_no: ref, amount, created_at: "2026-10-24 10:00:00", ...extra });
	const res = async (tok: string, w: string) => JSON.parse(await ((await lapGetResults(env, tok, ["_motionMeta", "motionDpPga", "motionPendingError", "motionWd"], w)) as Response).text()).results;

	it("SATU skrip Deposit untuk semua website: baris dipilah otomatis ke website pemiliknya (nama website di data Motion), dihitung per website", async () => {
		const tok = await login(["HUGO", "FOLA"]);
		const paid = [paidRow("A", "HUGOTOGEL"), paidRow("B", "FOLATOTO"), paidRow("C", "folatoto.com")];
		const r = (await lapMotionImport(env, tok, "2026-10-24", "2026-10-24", paid, paid, undefined)) as { dp: number; perSite: Record<string, { dp: number }>; shared: boolean };
		expect(r.perSite).toEqual({ HUGOTOGEL: { dp: 1, pending: 0, wd: 0 }, FOLATOTO: { dp: 2, pending: 0, wd: 0 } });
		expect([r.dp, r.shared]).toEqual([3, false]);
		const hugo = await res(tok, "HUGO"), fola = await res(tok, "FOLA");
		expect(hugo.motionDpPga.map((x: { refNo: string }) => x.refNo)).toEqual(["A"]);
		expect(fola.motionDpPga.map((x: { refNo: string }) => x.refNo).sort()).toEqual(["B", "C"]);
		expect(fola._motionMeta[0].summary).toMatchObject({ totalTransaksiPaid: 2, totalNominalPaidAt: 100000 });
		expect(fola._motionShared).toBeUndefined();
		const jobs = (await lapJobs(env, tok)) as { jobs: { kind: string; brand: string }[] };
		expect(jobs.jobs.filter((j) => j.kind === "motion").map((j) => j.brand).sort()).toEqual(["FOLATOTO", "HUGOTOGEL"]);
	});

	it("Withdraw: nama website tidak ada -> pakai Vendor ID Motion per website di Setting; baris yang tetap tidak pasti -> GABUNGAN (tidak menebak)", async () => {
		const tok = await login(["HUGO", "FOLA"]);
		await lapSaveConfig(env, tok, { adminSites: [{ website: "HUGO", vendorIdMotion: "12" }, { website: "FOLA", vendorIdMotion: "15, 16" }] });
		const cfg = (await lapGetConfig(env, tok)) as { config: { adminSites: { website: string; vendorIdMotion: string }[] } };
		expect(cfg.config.adminSites.map((x) => [x.website, x.vendorIdMotion])).toEqual([["HUGO", "12"], ["FOLA", "15,16"]]);
		// Link & Token Motion per website (kosong = bawaan semua website)
		await lapSaveConfig(env, tok, { adminSites: [{ website: "FOLA", linkMotion: "https://motionv2.com/riwayat-pga", tokenMotion: "Bearer eyJ.abc. def" }] });
		const c2 = (await lapGetConfig(env, tok)) as { config: { adminSites: { website: string; linkMotion: string; tokenMotion: string; vendorIdMotion: string }[] } };
		expect(c2.config.adminSites.map((x) => [x.website, x.linkMotion, x.tokenMotion, x.vendorIdMotion])).toEqual([["HUGO", "", "", "12"], ["FOLA", "https://motionv2.com", "eyJ.abc.def", "15,16"]]);
		const ok = (await lapMotionImport(env, tok, "2026-10-24", "2026-10-24", undefined, undefined, [wdRow("W1", 100, { vendor_id: 12 }), wdRow("W2", 200, { vendor_id: 16 }), wdRow("W3", 300, { game_name: "FOLATOTO" })])) as { perSite: Record<string, { wd: number }> };
		expect(ok.perSite).toEqual({ HUGOTOGEL: { dp: 0, pending: 0, wd: 1 }, FOLATOTO: { dp: 0, pending: 0, wd: 2 } });
		const fola = await res(tok, "FOLA");
		expect(fola.motionWd.map((x: { refNo: string }) => x.refNo)).toEqual(["W2", "W3"]);
		expect(fola._motionMeta[0].summary).toMatchObject({ totalWdRecords: 2, totalWdAmount: 500 });

		const mixed = (await lapMotionImport(env, tok, "2026-10-25", "2026-10-25", undefined, undefined, [wdRow("X1", 100, { vendor_id: 12 }), wdRow("X2", 200, { game_name: "XOTOGEL" })])) as { shared: boolean; perSite?: unknown };
		expect([mixed.shared, mixed.perSite]).toEqual([true, undefined]);
		expect((await res(tok, "HUGO")).motionWd.map((x: { refNo: string }) => x.refNo)).toEqual(["W1"]); // data khusus HUGO tetap dipakai
	});

	it("website tanpa data Motion sendiri (data lama) memakai data gabungan dengan tanda _motionShared", async () => {
		const tok = await login(["HUGO", "FOLA"]);
		raw().prepare(`INSERT INTO lap_result (username, module, data, updated_at) VALUES ('Op', 'motionDpPga', '[{"refNo":"lama"}]', 'x')`).run();
		const r = await res(tok, "HUGO");
		expect(r.motionDpPga).toEqual([{ refNo: "lama" }]);
		expect(r._motionShared).toEqual(["motionDpPga"]);
	});

	it("akun tanpa daftar website: Motion tetap seperti dulu (satu set, tanpa tanda)", async () => {
		const tok = await login([]);
		const r = (await lapMotionImport(env, tok, "2026-10-24", "2026-10-24", [paidRow("A", "HUGOTOGEL")], [paidRow("A", "HUGOTOGEL")], undefined)) as { dp: number; shared: boolean };
		expect([r.dp, r.shared]).toEqual([1, false]);
		expect((await res(tok, "")).motionDpPga).toHaveLength(1);
	});
});
