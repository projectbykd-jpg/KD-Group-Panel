import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminErrorAlertTest, adminErrorDelete, adminErrorList, adminErrorSet, clientErrorReport, resetClientReportLimit } from "../src/api/error-log";
import { checkLogin } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { cronFail, deleteErrors, fingerprint, isUnexpectedError, listErrors, pruneErrorLog, recordError, resetErrorThrottle, scrub, setErrorStatus } from "../src/lib/error-log";
import { resetIntegrationsCache, saveIntegrations } from "../src/lib/integrations";
import { resetSysCache, saveSys } from "../src/lib/settings";
import { fakeEnv } from "./helpers/fake-env";

let ctx: ReturnType<typeof fakeEnv>;
const rec = (message: string, extra: Record<string, unknown> = {}) => recordError(ctx.env, { source: "api", loc: "aksiX", message, ...extra });
const rows = () => {
	// tabel dibuat malas saat galat pertama dicatat; "belum ada tabel" = tidak ada baris
	if (!ctx.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'error_log'`).get()) return [] as Array<Record<string, unknown>>;
	return ctx.db.prepare(`SELECT * FROM error_log ORDER BY id`).all() as Array<Record<string, unknown>>;
};

async function addUser(username: string, role: string) {
	ctx.db
		.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES (?, ?, ?, ?, 'AKTIF')`)
		.run(username, username.toLowerCase(), await hashPassword("pw"), role);
	return ((await checkLogin(ctx.env, username, "pw", "")) as { sessionToken: string }).sessionToken;
}

beforeEach(() => {
	ctx = fakeEnv();
	resetErrorThrottle();
	resetClientReportLimit();
	resetSysCache();
});

describe("scrub: rahasia dibuang sebelum disimpan", () => {
	it("password/token/cookie/key/Bearer", () => {
		const out = scrub('login gagal password=Rahasia123 token: abcDEF123 "cookie":"PHPSESSID=zzz" Authorization: Bearer abc.def-ghi api_key=sk-ABCDEFGHIJKLMNOP1234');
		expect(out).not.toMatch(/Rahasia123|abcDEF123|zzz|abc\.def|ABCDEFGHIJKLMNOP/);
		expect(out).toContain("***");
	});
	it("string acak panjang (token sesi) dibuang, kata biasa tidak", () => {
		const out = scrub("sesi 3f9a8c7d6e5b4a39281706f5e4d3c2b1a0987654 gagal pada fungsi renderTabel");
		expect(out).not.toContain("3f9a8c7d6e5b4a39");
		expect(out).toContain("renderTabel");
	});
	it("JSON body dengan password", () => {
		expect(scrub('{"username":"a","password":"p@ss word"}')).not.toContain("p@ss");
	});
	it("dipotong sesuai batas", () => {
		expect(scrub("x".repeat(1000), 100).length).toBeLessThanOrEqual(101);
	});
});

describe("fingerprint & penggabungan", () => {
	it("angka/ID/tanggal berbeda = galat yang sama", () => {
		expect(fingerprint("api", "a", "Gagal baris 12 pada 2026-10-09")).toBe(fingerprint("api", "a", "Gagal baris 97 pada 2026-10-10"));
		expect(fingerprint("api", "a", "Gagal baris 12")).not.toBe(fingerprint("api", "b", "Gagal baris 12"));
		expect(fingerprint("api", "a", "pesan satu")).not.toBe(fingerprint("api", "a", "pesan dua"));
	});
	it("galat berulang jadi satu baris dengan hitungan (throttle 30 dtk menahan beruntun)", async () => {
		await rec("D1_ERROR no such column x");
		await rec("D1_ERROR no such column x"); // ditahan throttle
		expect(rows()).toHaveLength(1);
		expect(rows()[0].count).toBe(1);
		resetErrorThrottle();
		await rec("D1_ERROR no such column x");
		expect(rows()).toHaveLength(1);
		expect(rows()[0].count).toBe(2);
	});
	it("Selesai lalu muncul lagi -> terbuka kembali + penanda reopened; Diabaikan tetap diabaikan", async () => {
		await rec("kejadian A");
		await rec("kejadian B");
		const [a, b] = rows().map((r) => Number(r.id));
		await setErrorStatus(ctx.env, [a, b], "resolved");
		await setErrorStatus(ctx.env, [b], "ignored");
		resetErrorThrottle();
		await rec("kejadian A");
		await rec("kejadian B");
		const [ra, rb] = rows();
		expect(ra.status).toBe("open");
		expect(ra.reopened).toBe(1);
		expect(rb.status).toBe("ignored");
		expect(rb.count).toBe(2);
	});
});

describe("penyaring noise & galat tak terduga", () => {
	it("jaringan putus, ResizeObserver, ekstensi tidak dicatat", async () => {
		await recordError(ctx.env, { source: "browser", message: "Failed to fetch" });
		await recordError(ctx.env, { source: "browser", message: "ResizeObserver loop limit exceeded" });
		await recordError(ctx.env, { source: "browser", message: "Script error." });
		await recordError(ctx.env, { source: "browser", message: "x", detail: "at chrome-extension://abc/content.js:1" });
		expect(rows()).toHaveLength(0);
	});
	it("isUnexpectedError membedakan crash dari pesan validasi", () => {
		expect(isUnexpectedError(new TypeError("x"))).toBe(true);
		expect(isUnexpectedError(new Error("D1_ERROR: no such table"))).toBe(true);
		expect(isUnexpectedError(new Error("Too many subrequests by single Worker invocation."))).toBe(true);
		expect(isUnexpectedError(new Error("Cannot read properties of undefined (reading 'a')"))).toBe(true);
		expect(isUnexpectedError("string")).toBe(true);
		expect(isUnexpectedError(new Error("Password salah."))).toBe(false);
		expect(isUnexpectedError(new Error("Sesi tidak valid atau telah berakhir. Silakan login kembali."))).toBe(false);
		expect(isUnexpectedError(new Error("Username wajib diisi."))).toBe(false);
	});
	it("recordError tidak pernah melempar walau D1 rusak", async () => {
		const broken = { ...ctx.env, DB: { prepare: () => { throw new Error("D1 mati"); } } } as unknown as Env;
		await expect(recordError(broken, { source: "api", message: "apa saja" })).resolves.toBeUndefined();
	});
	it("rahasia di pesan/stack tidak sampai ke tabel", async () => {
		await rec("gagal login password=Hunter2xyz", { detail: "at x cookie: PHPSESSID=abcdef" });
		const r = JSON.stringify(rows());
		expect(r).not.toMatch(/Hunter2xyz|abcdef/);
	});
});

describe("API admin Error & Bug", () => {
	it("hanya ADMIN yang boleh melihat/mengubah", async () => {
		const op = await addUser("Op", "OPERATOR");
		await expect(adminErrorList(ctx.env, op, {})).rejects.toThrow();
		await expect(adminErrorSet(ctx.env, op, [1], "resolved")).rejects.toThrow();
		await expect(adminErrorDelete(ctx.env, op, [1], "")).rejects.toThrow();
	});
	it("daftar: terbuka dulu, filter status & sumber, hitungan", async () => {
		const boss = await addUser("Boss", "ADMIN");
		await rec("api satu");
		await recordError(ctx.env, { source: "cron", loc: "c", message: "cron dua" });
		await recordError(ctx.env, { source: "toto", loc: "t", message: "toto tiga" });
		const all = await adminErrorList(ctx.env, boss, {});
		expect(all.counts).toMatchObject({ open: 3, total: 3 });
		const cron = await adminErrorList(ctx.env, boss, { source: "cron" });
		expect(cron.rows.map((r) => r.message)).toEqual(["cron dua"]);
		await adminErrorSet(ctx.env, boss, [cron.rows[0].id], "resolved");
		const open = await adminErrorList(ctx.env, boss, { status: "open" });
		expect(open.rows).toHaveLength(2);
		expect((await adminErrorList(ctx.env, boss, {})).counts).toMatchObject({ open: 2, resolved: 1 });
		await expect(adminErrorSet(ctx.env, boss, [1], "bukan-status")).rejects.toThrow();
	});
	it("hapus terpilih & bersihkan selesai/diabaikan (yang terbuka aman)", async () => {
		const boss = await addUser("Boss", "ADMIN");
		await rec("satu");
		await rec("dua");
		await rec("tiga");
		const ids = rows().map((r) => Number(r.id));
		await setErrorStatus(ctx.env, [ids[0]], "resolved");
		await setErrorStatus(ctx.env, [ids[1]], "ignored");
		expect((await adminErrorDelete(ctx.env, boss, [], "done")).removed).toBe(2);
		expect(rows().map((r) => r.message)).toEqual(["tiga"]);
		expect(await deleteErrors(ctx.env, [ids[2]])).toBe(1);
		expect(await deleteErrors(ctx.env, "bukan-array")).toBe(0);
	});
});

describe("laporan dari browser", () => {
	it("user biasa boleh melapor; tercatat dengan username & dibatasi 20/menit", async () => {
		const op = await addUser("Op", "OPERATOR");
		for (let i = 0; i < 25; i++) await clientErrorReport(ctx.env, op, { message: `galat unik ${"abcdefghijklmnopqrstuvwxy"[i]}${i % 2 ? "x" : "y"}${"-".repeat(i)}`, loc: "menu:home" });
		const n = rows().length;
		expect(n).toBeGreaterThan(0);
		expect(n).toBeLessThanOrEqual(20);
		expect(rows()[0].username).toBe("Op");
		expect(rows()[0].source).toBe("browser");
	});
	it("tanpa sesi valid ditolak (tidak bisa dipakai membanjiri dari luar)", async () => {
		await expect(clientErrorReport(ctx.env, "token-palsu", { message: "x" })).rejects.toThrow();
		expect(rows()).toHaveLength(0);
	});
});

describe("retensi & batas baris", () => {
	it("pruneErrorLog menghapus yang terakhir terjadi lebih lama dari sys_errorlog_days", async () => {
		await rec("lama");
		await rec("baru");
		ctx.db.prepare(`UPDATE error_log SET last_at = '2000-01-01 00:00:00' WHERE message = 'lama'`).run();
		expect(await pruneErrorLog(ctx.env)).toBe(1);
		expect(rows().map((r) => r.message)).toEqual(["baru"]);
	});
	it("batas baris: yang terbuka & terbaru dipertahankan", async () => {
		ctx.db.prepare(`INSERT INTO settings (key, value) VALUES ('sys_errorlog_max_rows', '50')`).run();
		resetSysCache();
		await rec("pertama");
		for (let i = 0; i < 60; i++) {
			ctx.db.prepare(`INSERT INTO error_log (fp, source, message, first_at, last_at) VALUES (?, 'api', ?, '2026-10-01 00:00:00', ?)`).run("fp" + i, "m" + i, `2026-10-01 00:${String(i).padStart(2, "0")}:00`);
		}
		await pruneErrorLog(ctx.env);
		expect(rows().length).toBe(50);
		const l = await listErrors(ctx.env, {});
		expect(l.rows.length).toBe(50);
	});
	it("cronFail mencatat sumber cron dan tidak melempar", async () => {
		await cronFail(ctx.env, "uji cron")(new Error("D1_ERROR boom"));
		expect(rows()[0]).toMatchObject({ source: "cron", loc: "uji cron" });
	});
});

describe("notifikasi Telegram galat baru", () => {
	const sent: { url: string; body: string }[] = [];
	const setup = async (chat = "123456789", gapMin?: number) => {
		sent.length = 0;
		vi.stubGlobal("fetch", async (url: string, init: { body: URLSearchParams }) => {
			sent.push({ url: String(url), body: init.body.toString() });
			return new Response("{}", { status: 200 });
		});
		const r = await saveIntegrations(ctx.env, { int_alert_tg_token: "123456789:AAEhBOweik6ad9r_QXMENQjcrEZhGbbpR_H", int_alert_tg_chat: chat });
		expect(r.ok).toBe(true);
		resetIntegrationsCache();
		if (gapMin) {
			await saveSys(ctx.env, { sys_errorlog_alert_gap_min: gapMin });
		}
		resetSysCache();
	};
	afterEach(() => vi.unstubAllGlobals());

	it("tanpa token/chat: tidak mengirim apa pun", async () => {
		sent.length = 0;
		vi.stubGlobal("fetch", async () => { sent.push({ url: "x", body: "" }); return new Response("{}"); });
		await rec("galat tanpa konfigurasi");
		expect(sent).toHaveLength(0);
		expect(rows()).toHaveLength(1);
	});
	it("galat BARU dikirim; pengulangan & galat lain dalam jeda minimum tidak (anti banjir)", async () => {
		await setup();
		await rec("galat pertama D1_ERROR");
		expect(sent).toHaveLength(1);
		expect(sent[0].url).toContain("api.telegram.org/bot123456789:");
		expect(decodeURIComponent(sent[0].body.replace(/\+/g, " "))).toMatch(/Error baru.*\n\(api\) aksiX\ngalat pertama/s);
		resetErrorThrottle();
		await rec("galat pertama D1_ERROR"); // pengulangan: bukan baru
		await rec("galat kedua lain sama sekali"); // baru tapi masih dalam jeda 60 menit
		expect(sent).toHaveLength(1);
		expect(rows()).toHaveLength(2); // tetap tercatat di menu
	});
	it("muncul lagi setelah ditandai Selesai -> dikirim lagi (setelah jeda)", async () => {
		await setup();
		await rec("galat bisa kambuh");
		await setErrorStatus(ctx.env, [Number(rows()[0].id)], "resolved");
		ctx.db.prepare(`UPDATE settings SET value = '0' WHERE key = 'errlog_alert_at'`).run(); // jeda sudah lewat
		resetErrorThrottle();
		await rec("galat bisa kambuh");
		expect(sent).toHaveLength(2);
		expect(decodeURIComponent(sent[1].body.replace(/\+/g, " "))).toContain("Error muncul lagi");
	});
	it("Telegram gagal tidak menggagalkan pencatatan; tes Telegram admin: butuh konfigurasi & token tidak bocor di pesan galat", async () => {
		await setup();
		vi.stubGlobal("fetch", async () => new Response('{"ok":false,"description":"Unauthorized 123456789:AAEhBOweik6ad9r_QXMENQjcrEZhGbbpR_H"}', { status: 401 }));
		await rec("galat saat telegram mati");
		expect(rows()).toHaveLength(1);
		const boss = await addUser("Boss", "ADMIN");
		const r = await adminErrorAlertTest(ctx.env, boss);
		expect(r.success).toBe(false);
		expect(r.message).not.toContain("AAEhBOweik6ad9r");
		const op = await addUser("Op", "OPERATOR");
		await expect(adminErrorAlertTest(ctx.env, op)).rejects.toThrow();
	});
	it("tes Telegram tanpa konfigurasi memberi petunjuk; format token/chat ditolak saat simpan", async () => {
		const boss = await addUser("Boss", "ADMIN");
		expect((await adminErrorAlertTest(ctx.env, boss)).success).toBe(false);
		const bad = await saveIntegrations(ctx.env, { int_alert_tg_token: "bukan-token", int_alert_tg_chat: "123456789" });
		expect(bad.ok).toBe(false);
		const bad2 = await saveIntegrations(ctx.env, { int_alert_tg_chat: "abc def" });
		expect(bad2.ok).toBe(false);
	});
});
