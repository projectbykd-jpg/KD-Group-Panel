import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import {
	adminNotifyTick,
	buildDigest,
	enqueueNotify,
	flushNotify,
	queueDailyReport,
	resetAdminNotifyGuard,
	resetNotifyScanGuard,
	scanFinalFailures,
} from "../src/lib/admin-notify";
import { recordError, resetErrorThrottle, setErrorStatus } from "../src/lib/error-log";
import { ensureAutoInputTables, resetAutoInputTablesFlag } from "../src/lib/auto-input";
import { pendingTotoAlerts, resetTotoTablesFlag } from "../src/lib/toto-macau";
import { ensureNewsCategoryColumns, resetNewsColumnsGuard } from "../src/lib/bot-news";
import { resetIntegrationsCache, saveIntegrations } from "../src/lib/integrations";
import { resetSysCache, saveSys } from "../src/lib/settings";
import { autoPostFailText } from "../src/api/prediction";
import { fakeEnv, fakeTurso } from "./helpers/fake-env";
import { adminDailyReportSend } from "../src/api/error-log";
import { checkLogin } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";

const TOKEN = "123456789:AAEhBOweik6ad9r_QXMENQjcrEZhGbbpR_H";
let ctx: ReturnType<typeof fakeEnv>;
const sent: string[] = [];
let tgOk = true;
const wib = (minAgo = 0) => new Date(Date.now() + 7 * 3600_000 - minAgo * 60_000).toISOString().slice(0, 19).replace("T", " ");
const wibDay = (daysAgo: number) => new Date(Date.now() + 7 * 3600_000 - daysAgo * 86400_000).toISOString().slice(0, 10);
const queue = () => ctx.db.prepare(`SELECT nkey, kind, text, sent_at, tries FROM admin_notify ORDER BY id`).all() as { nkey: string; kind: string; text: string; sent_at: string; tries: number }[];
const openGap = () => ctx.db.prepare(`UPDATE settings SET value = '0' WHERE key = 'errlog_alert_at'`).run();

async function configure() {
	await saveIntegrations(ctx.env, { int_alert_tg_token: TOKEN, int_alert_tg_chat: "-1003723948512" });
	resetIntegrationsCache();
}

beforeEach(async () => {
	turso.current = fakeTurso();
	ctx = fakeEnv();
	Object.assign(ctx.env, { TURSO_URL: "libsql://fake", TURSO_TOKEN: "x" });
	sent.length = 0;
	tgOk = true;
	resetSysCache();
	resetIntegrationsCache();
	resetErrorThrottle();
	resetAdminNotifyGuard();
	resetNotifyScanGuard();
	resetAutoInputTablesFlag();
	resetTotoTablesFlag();
	resetNewsColumnsGuard();
	vi.stubGlobal("fetch", async (_u: string, init: { body: URLSearchParams }) => {
		sent.push(init.body.get("text") ?? "");
		return tgOk ? new Response('{"ok":true}', { status: 200 }) : new Response('{"ok":false,"description":"Bad Gateway"}', { status: 502 });
	});
});
afterEach(() => vi.unstubAllGlobals());

describe("antrean notifikasi admin", () => {
	it("dedupe per kunci; kategori mati tidak masuk antrean", async () => {
		await configure();
		expect(await enqueueNotify(ctx.env, "autopost", "k1", "satu")).toBe(true);
		expect(await enqueueNotify(ctx.env, "autopost", "k1", "satu lagi")).toBe(false);
		await saveSys(ctx.env, { sys_tgn_toto: 0 });
		resetSysCache();
		expect(await enqueueNotify(ctx.env, "toto", "t1", "x")).toBe(false);
		expect(queue().map((q) => q.nkey)).toEqual(["k1"]);
	});

	it("belum diatur: tidak menumpuk (tidak membanjiri grup saat Token baru diisi); setelah diatur terkirim sekali", async () => {
		expect(await enqueueNotify(ctx.env, "autoinput", "ai:0", "kejadian saat belum diatur")).toBe(false);
		await configure();
		await enqueueNotify(ctx.env, "autoinput", "ai:1", "HUGO · TOTO: gagal");
		expect(await flushNotify(ctx.env)).toBe(1);
		expect(sent[0]).toContain("Auto Prediksi gagal");
		expect(sent[0]).toContain("HUGO · TOTO: gagal");
		expect(sent[0]).not.toContain("kejadian saat belum diatur");
		expect(await flushNotify(ctx.env)).toBe(0);
		expect(sent).toHaveLength(1);
	});

	it("retensi: tak terkirim > 3 hari dibuang, terkirim disimpan 14 hari", async () => {
		await configure();
		await enqueueNotify(ctx.env, "toto", "lama", "basi");
		await enqueueNotify(ctx.env, "toto", "baru", "segar");
		ctx.db.prepare(`UPDATE admin_notify SET created_at = '2000-01-01 00:00:00' WHERE nkey = 'lama'`).run();
		const { pruneAdminNotify } = await import("../src/lib/admin-notify");
		await pruneAdminNotify(ctx.env);
		expect(queue().map((q) => q.nkey)).toEqual(["baru"]);
	});

	it("Telegram gagal: dicoba lagi tick berikutnya, setelah 5x ditandai GAGAL (tidak berulang selamanya)", async () => {
		await configure();
		await enqueueNotify(ctx.env, "channel", "ch:1", "Chat ID tidak ditemukan");
		tgOk = false;
		for (let i = 0; i < 5; i++) await flushNotify(ctx.env);
		expect(queue()[0]).toMatchObject({ sent_at: "GAGAL", tries: 5 });
		tgOk = true;
		sent.length = 0;
		await flushNotify(ctx.env);
		expect(sent).toHaveLength(0);
	});

	it("ringkasan dikelompokkan, dipotong di bawah batas Telegram; item yang tidak muat tetap menunggu", () => {
		const items = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, kind: (i % 2 ? "toto" : "err") as "toto" | "err", text: JSON.stringify({ r: "alasan " + i + " " + "x".repeat(200), s: "S" + i }), tries: 0 }));
		const d = buildDigest(items);
		expect(d.text.length).toBeLessThan(4096);
		expect(d.ids.length).toBeGreaterThan(0);
		expect(d.ids.length).toBeLessThan(40);
		expect(d.text.indexOf("Error — menghambat user")).toBeLessThan(d.text.indexOf("Toto Macau perlu dicek") === -1 ? Infinity : d.text.indexOf("Toto Macau perlu dicek"));
	});
});

describe("Error & Bug: tidak ada galat yang hilang", () => {
	const rec = (message: string, source: "api" | "cron" = "api", loc = "aksiX") => recordError(ctx.env, { source, loc, message });

	it("galat BARU kedua dalam jeda tidak dibuang: masuk antrean, terkirim sebagai ringkasan begitu jeda lewat", async () => {
		await configure();
		expect((await rec("galat pertama")).alert).toBe("terkirim");
		const r2 = await rec("galat kedua lain", "api", "aksiY");
		expect(r2.alert).toBe("jeda");
		expect(sent).toHaveLength(1);
		await flushNotify(ctx.env); // jeda belum lewat -> masih ditahan
		expect(sent).toHaveLength(1);
		openGap();
		expect(await flushNotify(ctx.env)).toBe(1);
		expect(sent[1]).toContain("galat kedua lain");
		// pengulangan galat yang sama tidak masuk antrean lagi
		resetErrorThrottle();
		await rec("galat kedua lain", "api", "aksiY");
		openGap();
		await flushNotify(ctx.env);
		expect(sent).toHaveLength(2);
	});

	it("galat latar (cron) kini ikut ke Telegram lewat antrean; sekali per galat baru; muncul lagi setelah Selesai dikirim lagi", async () => {
		await configure();
		const bg = await rec("cron mati", "cron", "auto-post router");
		expect(bg.alert).toBe("");
		expect(sent).toHaveLength(0); // tidak langsung, lewat antrean
		openGap();
		await flushNotify(ctx.env);
		expect(sent[0]).toContain("Error latar");
		expect(sent[0]).toContain("cron mati");
		resetErrorThrottle();
		await rec("cron mati", "cron", "auto-post router");
		openGap();
		await flushNotify(ctx.env);
		expect(sent).toHaveLength(1);
		const id = Number((ctx.db.prepare(`SELECT id FROM error_log`).get() as { id: number }).id);
		await setErrorStatus(ctx.env, [id], "resolved");
		resetErrorThrottle();
		await rec("cron mati", "cron", "auto-post router");
		openGap();
		await flushNotify(ctx.env);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toContain("muncul lagi");
	});

	it("galat latar sebelum Telegram diatur tidak menumpuk (tidak membanjiri chat saat baru dipasang)", async () => {
		await rec("cron lama", "cron");
		await configure();
		openGap();
		await flushNotify(ctx.env);
		expect(sent).toHaveLength(0);
	});

	it("saklar galat menghambat = 0: tidak dikirim langsung", async () => {
		await configure();
		await saveSys(ctx.env, { sys_tgn_err_block: 0 });
		resetSysCache();
		await rec("api rusak tapi notif dimatikan");
		expect(sent).toHaveLength(0);
	});
});

describe("pemindai kegagalan final (dulu hanya popup di panel)", () => {
	it("Auto Prediksi gagal setelah percobaan habis -> sekali ke Telegram; yang masih bisa dicoba ulang tidak", async () => {
		await configure();
		await ensureAutoInputTables(ctx.env);
		const ins = turso.current!.raw.prepare(
			`INSERT INTO auto_input_job (username, website, market, result_key, status, stage, detail, created_at, updated_at, attempts) VALUES ('ani', ?, ?, ?, 'FAILED', 'kirim', ?, ?, ?, ?)`,
		);
		ins.run("HUGO", "TOTO MACAU", "k1", "PHPSESSID habis", wib(10), wib(1), 2); // percobaan habis (bawaan 2)
		ins.run("FOLA", "SYDNEY", "k2", "timeout", wib(10), wib(1), 0); // masih akan dicoba ulang
		ins.run("XO", "HK", "k3", "lama", wib(60 * 24), wib(60 * 24), 2); // lama -> tidak membanjiri
		expect(await scanFinalFailures(ctx.env)).toBe(1);
		expect(await scanFinalFailures(ctx.env)).toBe(0);
		await flushNotify(ctx.env);
		expect(sent[0]).toContain("<i>PHPSESSID habis</i>");
		expect(sent[0]).toContain("<b>TOTO MACAU</b>: HUGO");
		expect(sent[0]).not.toContain("FOLA");
		expect(sent[0]).not.toContain("XO");
	});

	it("Toto Macau GAGAL final & BEDA ANGKA -> Telegram", async () => {
		await configure();
		await pendingTotoAlerts(ctx.env, ["HUGO"]); // membuat tabel
		const ins = turso.current!.raw.prepare(
			`INSERT INTO toto_macau_log (website, game, period, market, number, row_at, status, attempts, detail, created_at, updated_at) VALUES (?, 'm4', ?, 'TOTO MACAU', ?, ?, ?, ?, ?, ?, ?)`,
		);
		ins.run("HUGO", 101, "1234", wibDay(0) + " 13:00", "CONFLICT", 0, "Panel-Z berisi 9999", wib(5), wib(1));
		ins.run("HUGO", 102, "5678", wibDay(0) + " 16:00", "FAILED", 3, "Panel-Z menolak", wib(5), wib(1));
		ins.run("HUGO", 103, "1111", wibDay(0) + " 19:00", "FAILED", 1, "sementara", wib(5), wib(1));
		expect(await scanFinalFailures(ctx.env)).toBe(2);
		await flushNotify(ctx.env);
		expect(sent[0]).toContain("Beda angka dengan admin — Panel-Z berisi 9999");
		expect(sent[0]).toContain("HUGO (admin 1234)");
		expect(sent[0]).toContain("Angka belum masuk ke Panel-Z — Panel-Z menolak");
		expect(sent[0]).toContain("HUGO (admin 5678)");
		expect(sent[0]).not.toContain("1111");
	});
});

describe("laporan harian", () => {
	it("sekali sehari setelah jam yang diatur, isi = angka KEMARIN", async () => {
		await configure();
		await ensureAutoInputTables(ctx.env);
		await ensureNewsCategoryColumns(ctx.env);
		await recordError(ctx.env, { source: "cron", loc: "x", message: "contoh" });
		const y = wibDay(1);
		const reg = ctx.db.prepare(`INSERT INTO prediction_registry (date_key, schedule_id, website, status, unique_key) VALUES (?, 'PRED-1', ?, ?, ?)`);
		reg.run(y, "HUGO", "BERHASIL", "a");
		reg.run(y, "FOLA", "GAGAL", "b");
		turso.current!.raw.prepare(`INSERT INTO auto_input_job (username, website, market, result_key, status, created_at, updated_at) VALUES ('a','HUGO','HK','r1','DONE',?,?)`).run(y + " 10:00:00", y + " 10:00:00");
		const now = Date.parse(wibDay(0) + "T08:00:00+07:00");
		await saveSys(ctx.env, { sys_tgn_daily_hour: 7 }); // jam diatur admin
		resetSysCache();
		expect(await queueDailyReport(ctx.env, Date.parse(wibDay(0) + "T06:00:00+07:00"))).toBe(false); // sebelum jam 7
		expect(await queueDailyReport(ctx.env, now)).toBe(true);
		expect(await queueDailyReport(ctx.env, now + 3600_000)).toBe(false); // sekali sehari
		// bawaan (tidak diatur admin) = 00 WIB: laporan hari yang baru selesai keluar ±00:00-00:05
		await ctx.env.DB.prepare(`DELETE FROM settings WHERE key = 'sys_tgn_daily_hour'`).run();
		resetSysCache();
		expect(await queueDailyReport(ctx.env, Date.parse(wibDay(-1) + "T00:05:00+07:00"))).toBe(true);
		openGap();
		await flushNotify(ctx.env);
		const msg = sent.find((m) => m.includes("Laporan harian"))!;
		const { tanggalIndo } = await import("../src/lib/admin-notify");
		expect(msg).toContain(`<i>${tanggalIndo(y)} (WIB)</i>`);
		expect(msg).toContain("⚠️ 📤 <b>Auto Posting prediksi</b> — 1 terkirim · <b>1 gagal</b> (50%)");
		expect(msg).toContain("✅ 🎯 <b>Auto Prediksi</b> — 1 berhasil");
		expect(msg).toContain("📰 <b>BOT News</b>");
		expect(msg).toContain("Website: <b>0</b> · Blogger: <b>0</b>");
		expect(msg).toContain("Template FB: <b>0</b> · Channel Telegram: <b>0</b>");
		expect(msg).toContain("<b>Error &amp; Bug</b>");
	});

	it("tick cron: pindai + laporan + kirim; kategori laporan dimatikan -> tidak ada laporan", async () => {
		await configure();
		await saveSys(ctx.env, { sys_tgn_daily: 0 });
		resetSysCache();
		await adminNotifyTick(ctx.env);
		expect(sent.some((m) => m.includes("Laporan harian"))).toBe(false);
	});
});

describe("format rapi (keluhan pemilik: 6 baris alasan sama bikin pening)", () => {
	it("alasan yang sama ditulis SEKALI, website dikelompokkan per pasaran, teks teknis dibuang", async () => {
		await configure();
		const reason = "[Percobaan ulang 2/2] Halaman Nomor Keluar tidak dikenali (judul 'Silahkan isi Angka baru' tidak ada) — sesi mungkin habis atau tampilan situs berubah. (percobaan otomatis habis — CEK MANUAL)";
		const { cleanReason } = await import("../src/lib/admin-notify");
		const rows: [string, string][] = [["HUGO", "ARIZONA"], ["FOLA", "ARIZONA"], ["XO", "ARIZONA"], ["SENJA", "ARIZONA"], ["HUGO", "CANADA"], ["FOLA", "CANADA"]];
		for (const [i, [site, market]] of rows.entries()) await enqueueNotify(ctx.env, "autoinput", "ai:" + i, { r: cleanReason(reason), m: market, s: site });
		await flushNotify(ctx.env);
		const msg = sent[0];
		expect(msg.match(/Halaman Nomor Keluar tidak dikenali/g)).toHaveLength(1);
		expect(msg).not.toContain("Percobaan ulang 2/2");
		expect(msg).not.toContain("CEK MANUAL");
		expect(msg).not.toContain("Silahkan isi Angka baru");
		expect(msg).toContain("<b>ARIZONA</b>: HUGO, FOLA, XO, SENJA");
		expect(msg).toContain("<b>CANADA</b>: HUGO, FOLA");
		expect(msg).toContain("<b>🎯 Auto Prediksi gagal — input manual</b> (6)");
	});

	it("teks dinamis di-escape (tidak bisa merusak format HTML Telegram)", () => {
		const d = buildDigest([{ id: 1, kind: "err", text: JSON.stringify({ r: "<script>x</script> & y", s: "loc<b>" }), tries: 0 }]);
		expect(d.text).toContain("&lt;script&gt;x&lt;/script&gt; &amp; y");
		expect(d.text).not.toContain("<script>");
	});
});

describe("Auto Posting prediksi gagal final", () => {
	it("pesan menyebut sesi, tanggal, jumlah percobaan, website & alasan", () => {
		const t = autoPostFailText(
			{
				predictionName: "PREDIKSI 1",
				websiteResults: [
					{ website: "HUGO", status: "BERHASIL" },
					{ website: "FOLA", status: "GAGAL", reason: "Tele Error: chat not found" },
				],
			},
			"PRED-1",
			"2026-10-11",
			3,
		);
		expect(t).toBe("PREDIKSI 1 2026-10-11: gagal setelah 3x percobaan — FOLA (Tele Error: chat not found)");
		expect(autoPostFailText(undefined, "PRED-2", "2026-10-11", 3)).toContain("PRED-2 2026-10-11");
	});
});

describe("tombol Kirim Laporan Harian (Admin › Error & Bug)", () => {
	const login = async (u: string, role: string) => {
		ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES (?, ?, ?, ?, 'AKTIF')`).run(u, u.toLowerCase(), await hashPassword("pw-" + u), role);
		return ((await checkLogin(ctx.env, u, "pw-" + u, "")) as { sessionToken: string }).sessionToken;
	};
	it("admin: laporan kemarin langsung terkirim (tanpa menunggu jam 07 / antrean); operator ditolak; belum diatur -> petunjuk", async () => {
		const boss = await login("Boss", "ADMIN");
		expect((await adminDailyReportSend(ctx.env, boss, "")).success).toBe(false); // belum diatur
		await configure();
		await ensureAutoInputTables(ctx.env);
		await ensureNewsCategoryColumns(ctx.env);
		const r = await adminDailyReportSend(ctx.env, boss, "");
		expect(r.success).toBe(true);
		const msg = sent.at(-1)!;
		expect(msg).toContain("📊 <b>Laporan harian</b>");
		expect(msg).toContain("Dikirim ulang dari panel");
		expect(msg).toContain("📰 <b>BOT News</b>");
		// tidak mengganggu laporan otomatis: antrean laporan hari ini tetap kosong
		const hasQueue = ctx.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'admin_notify'`).get();
		expect(hasQueue ? queue().filter((q) => q.kind === "daily") : []).toHaveLength(0);
		const op = await login("Ani", "OPERATOR");
		await expect(adminDailyReportSend(ctx.env, op, "")).rejects.toThrow();
	});
});
