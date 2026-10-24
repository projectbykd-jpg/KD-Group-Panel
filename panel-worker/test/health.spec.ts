import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({
	current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync },
	broken: false,
	status: { active: "primary", spareConfigured: false, spareSyncedAt: "", spareSince: "" },
}));
vi.mock("../src/lib/turso", () => ({
	getTurso: () => {
		if (turso.broken) return { prepare: () => ({ all: async () => { throw new Error("Turso down"); } }) };
		return turso.current!.d1;
	},
	tursoStatus: async () => turso.status,
	tursoGeneration: () => 0,
}));

import { autoInputWhy, deepHealth } from "../src/lib/health";
import { resetSysCache } from "../src/lib/settings";
import { fakeEnv, fakeTurso } from "./helpers/fake-env";

const now = Date.parse("2026-10-11T00:30:00Z");
const beat = (minAgo: number) => new Date(now + 7 * 3600_000 - minAgo * 60_000).toISOString().slice(0, 19).replace("T", " ") + " | cron=* * * * *";

let ctx: ReturnType<typeof fakeEnv>;
beforeEach(() => {
	turso.current = fakeTurso();
	turso.broken = false;
	turso.status = { active: "primary", spareConfigured: false, spareSyncedAt: "", spareSince: "" };
	ctx = fakeEnv();
	resetSysCache();
	Object.assign(ctx.env, { TURSO_URL: "libsql://fake", TURSO_TOKEN: "x" });
	ctx.db.prepare(`INSERT INTO settings (key, value) VALUES ('cron_heartbeat', ?)`).run(beat(1));
});

describe("deepHealth + Turso", () => {
	it("Turso sehat & channel Telegram normal -> tanpa peringatan", async () => {
		const h = await deepHealth(ctx.env, now);
		expect(h.ok).toBe(true);
		expect(h.checks.turso.ok).toBe(true);
		expect(h.warnings).toEqual([]);
	});

	it("channel Telegram aktif tapi galat konfigurasi -> peringatan (panel tetap ok)", async () => {
		const ins = turso.current!.raw.prepare(`INSERT INTO bot_kv (k, v, updated_at) VALUES (?, ?, '2026-10-11 07:00:00')`);
		ins.run("tg_channel_enabled", "1");
		ins.run("tg_channel_last_error", "2026-10-11 07:00:00 | Chat ID tidak ditemukan");
		const h = await deepHealth(ctx.env, now);
		expect(h.ok).toBe(true);
		expect(h.warnings[0]).toContain("Chat ID tidak ditemukan");
	});

	it("channel nonaktif -> galat lama tidak dilaporkan", async () => {
		turso.current!.raw.prepare(`INSERT INTO bot_kv (k, v, updated_at) VALUES ('tg_channel_last_error', 'x', 'y')`).run();
		expect((await deepHealth(ctx.env, now)).warnings).toEqual([]);
	});

	it("Turso mati -> GAGAL dengan alasan", async () => {
		turso.broken = true;
		const h = await deepHealth(ctx.env, now);
		expect(h.ok).toBe(false);
		expect(h.checks.turso.error).toContain("Turso down");
	});

	it("database cadangan: sedang dipakai / belum pernah disalin / salinan basi -> peringatan; salinan segar -> tanpa peringatan", async () => {
		turso.status = { active: "spare", spareConfigured: true, spareSyncedAt: "2026-10-11 07:00:00", spareSince: "2026-10-11 07:10:00" };
		expect((await deepHealth(ctx.env, now)).warnings.join(" ")).toContain("database CADANGAN sejak 2026-10-11 07:10:00");
		turso.status = { active: "primary", spareConfigured: true, spareSyncedAt: "", spareSince: "" };
		expect((await deepHealth(ctx.env, now)).warnings.join(" ")).toContain("belum pernah disalin");
		turso.status = { active: "primary", spareConfigured: true, spareSyncedAt: "2026-10-11 02:00:00", spareSince: "" }; // 5,5 jam lalu
		expect((await deepHealth(ctx.env, now)).warnings.join(" ")).toContain("basi");
		turso.status = { active: "primary", spareConfigured: true, spareSyncedAt: "2026-10-11 07:20:00", spareSince: "" }; // 10 menit lalu
		const h = await deepHealth(ctx.env, now);
		expect(h.warnings).toEqual([]);
		expect(h.checks.turso.note).toContain("cadangan disalin 2026-10-11 07:20:00");
	});
});

describe("deepHealth ?session=1 (uji tulis-baca sesi login)", () => {
	const sessionRows = () => (ctx.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
	it("tanpa opsi: TIDAK menulis apa pun ke KV/D1 (aman dipanggil watchdog berkala)", async () => {
		const h = await deepHealth(ctx.env, now);
		expect(h.checks.session).toBeUndefined();
		expect(ctx.kv.store.size).toBe(0);
		expect(sessionRows()).toBe(0);
	});
	it("sehat: sesi percobaan ditulis, terbaca, lalu dibersihkan", async () => {
		const h = await deepHealth(ctx.env, now, { session: true });
		expect(h.checks.session).toMatchObject({ ok: true, note: "tulis + baca KV & D1 OK" });
		expect(ctx.kv.store.size).toBe(0);
		expect(sessionRows()).toBe(0);
	});
	it("KV tidak bisa ditulis (kuota) tapi D1 OK -> tetap terbaca, tapi ada peringatan", async () => {
		ctx.kv.put = async () => { throw new Error("KV put() limit exceeded for the day."); };
		const h = await deepHealth(ctx.env, now, { session: true });
		expect(h.checks.session.ok).toBe(true);
		expect(h.warnings.join(" ")).toMatch(/tulis KV: KV put\(\) limit exceeded/);
	});
	it("KV DAN D1 sama-sama gagal menulis (gejala 'login berhasil lalu Sesi tidak valid') -> GAGAL dengan alasan keduanya", async () => {
		ctx.kv.put = async () => { throw new Error("KV put() limit exceeded for the day."); };
		ctx.db.exec(`DROP TABLE sessions`);
		const h = await deepHealth(ctx.env, now, { session: true });
		expect(h.ok).toBe(false);
		expect(h.checks.session.error).toMatch(/TIDAK terbaca/);
		expect(h.checks.session.error).toMatch(/tulis D1/);
		expect(h.checks.session.error).toMatch(/tulis KV: KV put\(\) limit exceeded/);
	});
});

describe("deepHealth: ringkasan Auto Prediksi untuk watchdog (tanpa data rahasia)", () => {
	it("saklar, PHPSESSID tersimpan & kategori alasan job terakhir; TIDAK memuat PHPSESSID, username, angka, atau isi Keterangan", async () => {
		const raw = turso.current!.raw;
		raw.exec(`CREATE TABLE auto_input_config (username TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '')`);
		raw.exec(`CREATE TABLE auto_input_session (username TEXT, website TEXT, base_url TEXT, phpsessid TEXT, updated_at TEXT)`);
		raw.exec(`CREATE TABLE auto_input_job (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, website TEXT, market TEXT, prizes TEXT, result_date TEXT, result_key TEXT, status TEXT, stage TEXT, detail TEXT, period TEXT, created_at TEXT, updated_at TEXT)`);
		raw.exec(`INSERT INTO auto_input_config VALUES ('RahasiaOp', 1, ''), ('Lain', 0, '')`);
		raw.exec(`INSERT INTO auto_input_session VALUES ('RahasiaOp', 'HUGOTOGEL', 'https://x', 'PHPSESSID=sangatrahasia123', '2026-10-20 10:00:00')`);
		raw.exec(`INSERT INTO auto_input_job (username, website, market, prizes, result_key, status, stage, detail, created_at) VALUES
			('RahasiaOp','HUGOTOGEL','OREGON03','["1022"]','K1','DONE','selesai','Periode 120 OREGON03: angka 1022 masuk [Omset 21,700 · Referal 0 · Menang 0]','2026-10-24 20:00:00'),
			('RahasiaOp','HUGOTOGEL','OREGON03','["1022"]','manual:x','DONE','prediksi','Total dibaca 9999','2026-10-24 20:30:00'),
			('RahasiaOp','FOLATOTO','OREGON03','["1022"]','K2','FAILED','cek','Belum login (halaman login.php) — PHPSESSID kedaluwarsa','2026-10-24 21:00:00')`);
		const h = await deepHealth(ctx.env, now);
		expect(h.ok).toBe(true);
		expect(h.autoInput).toMatchObject({ switchOn: 1, accounts: 2, sessions: 1, lastSessionSaved: "2026-10-20 10:00:00" });
		expect(h.autoInput!.lastJobs).toEqual([
			{ status: "FAILED", stage: "cek", at: "2026-10-24 21:00:00", why: "sesi admin habis (PHPSESSID)" },
			{ status: "DONE", stage: "selesai", at: "2026-10-24 20:00:00", why: "dihitung + Total tercatat" },
		]);
		const out = JSON.stringify(h);
		for (const leak of ["sangatrahasia", "RahasiaOp", "1022", "21,700", "9999", "login.php"]) expect(out).not.toContain(leak);
	});

	it("tabel belum ada / Turso mati -> ringkasan kosong, kesehatan panel TIDAK ikut gagal karenanya", async () => {
		const h = await deepHealth(ctx.env, now);
		expect(h.ok).toBe(true);
		expect(h.autoInput).toMatchObject({ switchOn: 0, sessions: 0, lastJobs: [] });
	});

	it("kategori alasan", () => {
		expect(autoInputWhy("PHPSESSID belum disimpan.", "FAILED")).toBe("PHPSESSID belum disimpan");
		expect(autoInputWhy("Pasaran X tidak di-auto — input manual.", "SKIPPED")).toBe("pasaran tidak di-auto");
		expect(autoInputWhy("x [Omset belum terbaca: HTTP 404]", "DONE")).toBe("dihitung, Total belum terbaca");
		expect(autoInputWhy("", "QUEUED")).toBe("antre (belum dijalankan browser)");
		expect(autoInputWhy("Admin tidak menjawab 25 dtk (timeout)", "FAILED")).toBe("admin tidak menjawab (timeout/jaringan)");
		// pesan ASLI dari auto-input-run.ts (tahap cek)
		expect(autoInputWhy('Server tidak dianggap sedang login di HUGOTOGEL (sidebar "Agent (...)" tidak ada) — PHPSESSID salah/habis', "FAILED")).toBe("sesi admin habis (PHPSESSID)");
		expect(autoInputWhy("Sesi (PHPSESSID) sudah habis — ambil yang baru dari Chrome", "FAILED")).toBe("sesi admin habis (PHPSESSID)");
		expect(autoInputWhy("Tanggal form 2026-10-25 ≠ tanggal result 2026-10-24. Input manual.", "FAILED")).toBe("tanggal form admin ≠ tanggal result");
		expect(autoInputWhy("Periode form 120 ≠ periode terakhir 118 + 1. Ada periode terlewat / sudah terinput.", "FAILED")).toBe("periode admin tidak berurutan (terlewat/sudah terinput)");
		expect(autoInputWhy('Pasaran "X" tidak ditemukan (atau ganda) di dropdown website ini.', "FAILED")).toBe("pasaran tidak ada di dropdown admin");
		expect(autoInputWhy("Halaman Nomor Keluar X tidak berisi form input (sesi login OK)", "FAILED")).toBe("halaman Nomor Keluar tanpa form (pasaran diinput di halaman lain?)");
		expect(autoInputWhy("Cookie ini milik SENJATOGEL.COM (agen a), bukan HUGOTOGEL", "FAILED")).toBe("cookie website lain");
	});
});
