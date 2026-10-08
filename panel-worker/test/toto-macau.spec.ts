import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { dueGames, listTotoLog, parseTotoRows, pendingTotoAlerts, ackTotoAlerts, resetTotoTablesFlag, slotDate, totoMacauTick } from "../src/lib/toto-macau";
import { resetAutoInputTablesFlag, saveSession, setEnabled, defaultAdminBase } from "../src/lib/auto-input";
import { resetSysCache, saveSys } from "../src/lib/settings";
import { fakeD1, fakeEnv } from "./helpers/fake-env";

const SID = "FAKEsession000000000000001";

// Bentuk HTML ADMIN asli: baris tanpa </tr>, <form> di dalam <tr>, judul "Daftar Nomor ... Yang Keluar".
const page = (title: string, rows: [string, string, string, string][]) => `<div align=center><font color=blue size=3><b>Daftar&nbsp;&nbsp;Nomor&nbsp;&nbsp;${title}&nbsp;&nbsp;Yang&nbsp;&nbsp;Keluar</b>
<TABLE width='80%'><tr bgcolor=#497b00><td><B>No</B></td><td><B>Tanggal</B></td><td><B>Periode</B></td><td width=15%><B>Nomor Keluar</B></td><td><B>Hitung</B></td></tr>${rows
	.map(
		(r, i) => `<tr bgcolor=#c2ff6a><form method="POST">
			<td>${i + 1}</td>
			<td>${r[0]}</td>
			<td>${r[1]}</td><td width=15%>${r[2]}</td><td>${r[3]}</td>
			</form>`,
	)
	.join("")}</TABLE></div>`;

// 08-10-2026 13:15 WIB = 06:15 UTC
const NOW = Date.UTC(2026, 9, 8, 6, 15);

describe("pembaca tabel admin", () => {
	it("membaca tanggal, jam, periode, angka, Hitung dari HTML apa adanya", () => {
		const rows = parseTotoRows(page("Toto Macau", [["09-10-2026 00:10:19", "14226", "2412", "Yes"], ["08-10-2026 23:09:06", "14225", "5747", "No"]]));
		expect(rows).toEqual([
			{ no: 1, date: "2026-10-09", time: "00:10:19", hour: 0, period: 14226, number: "2412", hitung: "yes" },
			{ no: 2, date: "2026-10-08", time: "23:09:06", hour: 23, period: 14225, number: "5747", hitung: "no" },
		]);
	});
	it("slot jatuh tempo mengikuti jam draw", () => {
		expect(dueGames(NOW).map((d) => d.game.game + "@" + d.hour)).toEqual(["m17@13"]);
		expect(dueGames(Date.UTC(2026, 9, 8, 6, 2)).length).toBe(0); // 13:02 -> belum 3 menit setelah jam draw
		expect(dueGames(Date.UTC(2026, 9, 8, 8, 30)).length).toBe(1); // 15:30 -> hanya 5D@15

	});
	it("jam 23 dicek lewat tengah malam = slot kemarin", () => {
		const t = Date.UTC(2026, 9, 8, 17, 5); // 00:05 WIB 09-10
		expect(slotDate(t, 23)).toBe("2026-10-08");
		expect(slotDate(t, 0)).toBe("2026-10-09");
	});
});

describe("tick Auto Check Toto Macau", () => {
	let env: Env;
	let raw: import("node:sqlite").DatabaseSync;
	let admin: ReturnType<typeof makeAdmin>;
	const sent: { market: string; number: string; url: string }[] = [];

	function makeAdmin(rows: [string, string, string, string][], opts: { expired?: boolean } = {}) {
		const hits: string[] = [];
		const fetchFn = async (url: string) => {
			hits.push(url);
			if (opts.expired) return new Response("", { status: 302, headers: { location: "login.php" } });
			return new Response(page("Toto Macau", rows), { status: 200 });
		};
		return { fetchFn, hits };
	}
	const send = async (market: string, number: string, cfg: { url: string }) => {
		sent.push({ market, number, url: cfg.url });
		return "Berhasil dikirim";
	};
	const addUser = (u: string, o: { panelz?: number; role?: string; websites?: string[]; status?: string } = {}) =>
		raw.prepare(`INSERT INTO users (username, username_lc, password_hash, websites, perm_panelz, role, status) VALUES (?, ?, 'x', ?, ?, ?, ?)`).run(u, u.toLowerCase(), JSON.stringify(o.websites ?? ["HUGOTOGEL"]), o.panelz ?? 1, o.role ?? "OPERATOR", o.status ?? "AKTIF");
	const addPanelZ = (w: string) => raw.prepare(`INSERT INTO site_accounts (website, pz_user, pz_pass, pz_user2, pz_pass2, pz_url) VALUES (?, 'u', 'p', 'u2', 'p2', 'https://pz.test')`).run(w);
	async function enableWithSession(u: string, w = "HUGOTOGEL") {
		await setEnabled(env, u, true);
		await saveSession(env, u, w, defaultAdminBase(w), "PHPSESSID=" + SID);
	}
	const setMode = async (m: number) => {
		await saveSys(env, { sys_totomacau_mode: m });
		resetSysCache();
	};

	beforeEach(() => {
		turso.current = fakeD1([]);
		resetAutoInputTablesFlag();
		resetTotoTablesFlag();
		resetSysCache();
		const f = fakeEnv();
		env = f.env;
		raw = f.db;
		sent.length = 0;
		admin = makeAdmin([["08-10-2026 13:10:13", "14221", "4518", "Yes"], ["08-10-2026 00:10:02", "14220", "7036", "Yes"]]);
	});

	it("mode 1 (bawaan): mencatat tanggal+jam+angka, TIDAK mengirim ke Panel-Z", async () => {
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		expect(await totoMacauTick(env, { fetchFn: admin.fetchFn, send, nowMs: NOW })).toBe(true);
		const rows = await listTotoLog(env, ["HUGOTOGEL"]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ market: "TOTOMACAU-13", number: "4518", period: 14221, status: "RECORDED", rowAt: "2026-10-08 13:10:13" });
		expect(sent).toHaveLength(0);
	});

	it("mode 2: mengirim ke Panel-Z SEKALI per draw (tick berikutnya tidak membuka admin lagi)", async () => {
		await setMode(2);
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		await totoMacauTick(env, { fetchFn: admin.fetchFn, send, nowMs: NOW });
		expect(sent).toEqual([{ market: "TOTOMACAU-13", number: "4518", url: "https://pz.test" }]);
		const reads = admin.hits.length;
		await totoMacauTick(env, { fetchFn: admin.fetchFn, send, nowMs: NOW + 60_000 });
		await totoMacauTick(env, { fetchFn: admin.fetchFn, send, nowMs: NOW + 120_000 });
		expect(sent).toHaveLength(1);
		expect(admin.hits.length).toBe(reads);
		expect((await listTotoLog(env, ["HUGOTOGEL"]))[0].status).toBe("SENT");
	});

	it("mode 1 lalu mode 2: draw yang sudah tercatat (masih segar) ikut terkirim, tetap sekali", async () => {
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		await totoMacauTick(env, { fetchFn: admin.fetchFn, send, nowMs: NOW });
		expect(sent).toHaveLength(0);
		await setMode(2);
		await totoMacauTick(env, { fetchFn: admin.fetchFn, send, nowMs: NOW + 60_000 });
		await totoMacauTick(env, { fetchFn: admin.fetchFn, send, nowMs: NOW + 120_000 });
		expect(sent).toHaveLength(1);
	});

	it("baris Hitung=No belum diproses (ditunggu)", async () => {
		await setMode(2);
		admin = makeAdmin([["08-10-2026 13:10:13", "14221", "4518", "No"]]);
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		await totoMacauTick(env, { fetchFn: admin.fetchFn, send, nowMs: NOW });
		expect(sent).toHaveLength(0);
		expect(await listTotoLog(env, ["HUGOTOGEL"])).toHaveLength(0);
	});

	it("baris basi (>2 jam) dan angka dengan digit salah tidak dikirim", async () => {
		await setMode(2);
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		admin = makeAdmin([["08-10-2026 13:10:13", "14221", "451", "Yes"]]); // 3 digit
		await totoMacauTick(env, { fetchFn: admin.fetchFn, send, nowMs: NOW });
		expect(sent).toHaveLength(0);
		expect((await listTotoLog(env, ["HUGOTOGEL"]))[0]).toMatchObject({ status: "SKIPPED" });
		admin = makeAdmin([["08-10-2026 13:10:13", "14222", "4518", "Yes"]]);
		await totoMacauTick(env, { fetchFn: admin.fetchFn, send, nowMs: NOW + 150 * 60_000 }); // 15:45 -> tidak jatuh tempo
		expect(sent).toHaveLength(0);
	});

	it("aturan akses = menu Result: tanpa izin Panel-Z / akun nonaktif / VIEWER / website bukan miliknya tidak dipakai", async () => {
		await setMode(2);
		addPanelZ("HUGOTOGEL");
		addUser("NoPz", { panelz: 0 });
		addUser("Off", { status: "NONAKTIF" });
		addUser("View", { role: "VIEWER" });
		addUser("Other", { websites: ["FOLATOTO"] });
		for (const u of ["NoPz", "Off", "View"]) await enableWithSession(u);
		await setEnabled(env, "Other", true);
		await saveSession(env, "Other", "HUGOTOGEL", defaultAdminBase("HUGOTOGEL"), "PHPSESSID=" + SID);
		expect(await totoMacauTick(env, { fetchFn: admin.fetchFn, send, nowMs: NOW })).toBe(false);
		expect(admin.hits).toHaveLength(0);
		expect(sent).toHaveLength(0);
	});

	it("website tanpa Panel-Z terisi dilewati; dua user satu website = diproses sekali", async () => {
		await setMode(2);
		addUser("A");
		addUser("B");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("A");
		await enableWithSession("B");
		await totoMacauTick(env, { fetchFn: admin.fetchFn, send, nowMs: NOW });
		expect(sent).toHaveLength(1);
		expect(admin.hits).toHaveLength(1);
	});

	it("sesi pertama habis -> pakai sesi user berikutnya; semua habis -> gagal tercatat & jadi peringatan", async () => {
		await setMode(2);
		addUser("A");
		addUser("B");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("A");
		await enableWithSession("B");
		let call = 0;
		const f = async (url: string) => (++call === 1 ? new Response("", { status: 302, headers: { location: "login.php" } }) : new Response(page("Toto Macau", [["08-10-2026 13:10:13", "14221", "4518", "Yes"]]), { status: 200 }));
		await totoMacauTick(env, { fetchFn: f, send, nowMs: NOW });
		expect(sent).toHaveLength(1);

		// semua sesi habis di slot lain
		const dead = makeAdmin([], { expired: true });
		for (let i = 0; i < 3; i++) await totoMacauTick(env, { fetchFn: dead.fetchFn, send, nowMs: Date.UTC(2026, 9, 8, 9, 15 + i) }); // 16:15 WIB
		const al = await pendingTotoAlerts(env, ["HUGOTOGEL"]);
		expect(al).toHaveLength(1); // Toto Macau jam 16 (5D jam 15 sudah >40 menit -> hanya dicek tiap 5 menit)
		expect(al[0].detail).toMatch(/Sesi/);
		await ackTotoAlerts(env, al.map((a) => a.id));
		expect(await pendingTotoAlerts(env, ["HUGOTOGEL"])).toHaveLength(0);
	});

	it("Panel-Z gagal -> dicoba lagi sampai 3x lalu berhenti (jadi peringatan)", async () => {
		await setMode(2);
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		const bad = vi.fn(async () => "Row tidak ditemukan");
		for (let i = 0; i < 5; i++) await totoMacauTick(env, { fetchFn: admin.fetchFn, send: bad, nowMs: NOW + i * 60_000 });
		expect(bad).toHaveBeenCalledTimes(3);
		const row = (await listTotoLog(env, ["HUGOTOGEL"]))[0];
		expect(row).toMatchObject({ status: "FAILED", attempts: 3 });
		expect(await pendingTotoAlerts(env, ["HUGOTOGEL"])).toHaveLength(1);
	});

	it("mode 0 = mati total (tanpa query jaringan)", async () => {
		await setMode(0);
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		expect(await totoMacauTick(env, { fetchFn: admin.fetchFn, send, nowMs: NOW })).toBe(false);
		expect(admin.hits).toHaveLength(0);
	});
});
