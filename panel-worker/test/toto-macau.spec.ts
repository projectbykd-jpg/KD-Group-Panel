import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { ackTotoAlerts, listTotoLog, parseTotoRows, passIntervalMin, pendingTotoAlerts, resetTotoTablesFlag, totoMacauRun } from "../src/lib/toto-macau";
import { parsePanelZRows, type PanelZHandle } from "../src/senders/panelz";
import { defaultAdminBase, resetAutoInputTablesFlag, saveSession, setEnabled } from "../src/lib/auto-input";
import { resetSysCache, saveSys } from "../src/lib/settings";
import { fakeD1, fakeEnv } from "./helpers/fake-env";

const SID = "FAKEsession000000000000001";

// Bentuk HTML ADMIN asli: baris tanpa </tr>, <form> di dalam <tr>, judul "Daftar Nomor ... Yang Keluar".
const adminPage = (title: string, rows: [string, string, string, string][]) => `<div align=center><font color=blue size=3><b>Daftar&nbsp;&nbsp;Nomor&nbsp;&nbsp;${title}&nbsp;&nbsp;Yang&nbsp;&nbsp;Keluar</b>
<TABLE width='80%'><tr bgcolor=#497b00><td><B>No</B></td><td><B>Tanggal</B></td><td><B>Periode</B></td><td width=15%><B>Nomor Keluar</B></td><td><B>Hitung</B></td></tr>${rows
	.map(
		(r, i) => `<tr bgcolor=#c2ff6a><form method="POST">
			<td>${i + 1}</td>
			<td>${r[0]}</td>
			<td>${r[1]}</td><td width=15%>${r[2]}</td><td>${r[3]}</td>
			</form>`,
	)
	.join("")}</TABLE></div>`;

// Tabel "Semua Result" Panel-Z (pendekatan dari screenshot pemilik: #, Pasaran, Angka (xxxx = kosong), Tanggal, Action).
type ZRow = { id: number; market: string; date: string; value: string };
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const zHtml = (rows: ZRow[]) =>
	`<table id="tbl"><thead><tr><th>#</th><th>Pasaran</th><th>Angka</th><th>Tanggal</th><th>Action</th></tr></thead><tbody>${rows
		.map((r) => {
			const [y, m, d] = r.date.split("-");
			return `<tr><td>${r.id}</td><td><img src="assets/img/${r.market.toLowerCase()}.png"> ${r.market}</td><td><input type="text" class="form-control" value="${r.value}" placeholder="xxxx"></td><td>${d} ${MONTH[Number(m) - 1]} ${y} | 00:25:02</td><td><form action="config/update-resultlotto.php?row=${r.id}" method="post"><button>Edit</button></form><a href="hapus.php?id=${r.id}">Hapus</a></td></tr>`;
		})
		.join("")}</tbody></table>`;

// 09-10-2026 01:52 WIB (saat pemilik menekan tombol) = 18:52 UTC 08-10
const NOW = Date.UTC(2026, 9, 8, 18, 52);

describe("pembaca tabel admin & Panel-Z", () => {
	it("admin: tanggal, jam, periode, angka, Hitung dari HTML apa adanya", () => {
		const rows = parseTotoRows(adminPage("Toto Macau", [["09-10-2026 00:10:19", "14226", "2412", "Yes"], ["08-10-2026 23:09:06", "14225", "5747", "No"]]));
		expect(rows).toEqual([
			{ no: 1, date: "2026-10-09", time: "00:10:19", hour: 0, period: 14226, number: "2412", hitung: "yes" },
			{ no: 2, date: "2026-10-08", time: "23:09:06", hour: 23, period: 14225, number: "5747", hitung: "no" },
		]);
	});
	it("Panel-Z: id baris, pasaran, TANGGAL, nilai (kosong/xxxx vs terisi), 5D", () => {
		const rows = parsePanelZRows(
			zHtml([
				{ id: 28, market: "TOTOMACAU-13", date: "2026-10-09", value: "" },
				{ id: 60, market: "TOTOMACAU-15-5D", date: "2026-10-09", value: "xxxx" },
				{ id: 100, market: "TOTOMACAU-13", date: "2026-10-08", value: "4518" },
			]),
		);
		expect(rows).toEqual([
			{ id: "28", market: "TOTOMACAU-13", date: "2026-10-09", value: "", filled: false },
			{ id: "60", market: "TOTOMACAU-15-5D", date: "2026-10-09", value: "xxxx", filled: false },
			{ id: "100", market: "TOTOMACAU-13", date: "2026-10-08", value: "4518", filled: true },
		]);
	});
	it("Panel-Z: baris tanpa tautan update / tanggal tidak terbaca dilewati (tidak ditebak)", () => {
		expect(parsePanelZRows(`<table><tr><td>1</td><td>TOTOMACAU-13</td><td><input value=""></td><td>besok</td></tr></table>`)).toEqual([]);
	});
	it("jeda putaran: 3 menit setelah jam draw, 30 menit di luar itu", () => {
		expect(passIntervalMin(Date.UTC(2026, 9, 8, 6, 20))).toBe(3); // 13:20 WIB
		expect(passIntervalMin(Date.UTC(2026, 9, 8, 4, 0))).toBe(30); // 11:00 WIB
	});
});

describe("rekonsiliasi admin <-> Panel-Z", () => {
	let env: Env;
	let raw: import("node:sqlite").DatabaseSync;
	let zRows: ZRow[];
	let pushed: { id: string; angka: string }[];
	let adminHits: string[];
	let panelOpts: { failOpen?: boolean; noApply?: boolean; failPush?: boolean };

	// Admin: 08-10 & 09-10 (data seperti kiriman pemilik); semua Hitung=Yes
	const m17: [string, string, string, string][] = [
		["09-10-2026 00:10:19", "14226", "2412", "Yes"],
		["08-10-2026 23:09:06", "14225", "5747", "Yes"],
		["08-10-2026 22:09:52", "14224", "0522", "Yes"],
		["08-10-2026 19:08:49", "14223", "2144", "Yes"],
		["08-10-2026 16:10:46", "14222", "6360", "Yes"],
		["08-10-2026 13:10:13", "14221", "4518", "Yes"],
		["08-10-2026 00:10:02", "14220", "7036", "Yes"],
	];
	const m51: [string, string, string, string][] = [
		["08-10-2026 21:30:37", "3614", "08346", "Yes"],
		["08-10-2026 15:28:26", "3613", "92018", "Yes"],
	];
	const fetchFn = async (url: string) => {
		adminHits.push(url);
		return new Response(url.includes("sar=m17") ? adminPage("Toto Macau", m17) : adminPage("Toto Macao 5D", m51), { status: 200 });
	};
	const panel = async (): Promise<PanelZHandle | string> => {
		if (panelOpts.failOpen) return "Error: PHPSESSID tidak ditemukan";
		return {
			html: zHtml(zRows),
			push: async (id, angka) => {
				if (panelOpts.failPush) return "Gagal (500)";
				pushed.push({ id, angka });
				if (!panelOpts.noApply) zRows.find((r) => String(r.id) === id)!.value = angka;
				return "Berhasil dikirim";
			},
			reload: async () => zHtml(zRows),
		};
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
	const run = (o: Parameters<typeof totoMacauRun>[1] = {}) => totoMacauRun(env, { fetchFn, panel, nowMs: NOW, force: true, ...o });
	const byMarketDate = async () => Object.fromEntries((await listTotoLog(env, ["HUGOTOGEL"])).map((r) => [`${r.market} ${r.rowAt.slice(0, 10)}`, r.status]));

	beforeEach(() => {
		turso.current = fakeD1([]);
		resetAutoInputTablesFlag();
		resetTotoTablesFlag();
		resetSysCache();
		const f = fakeEnv();
		env = f.env;
		raw = f.db;
		pushed = [];
		adminHits = [];
		panelOpts = {};
		// Panel-Z mirip screenshot: baris 09 Oct kosong (-13,-16,-19,-22,-23,-00, 5D), 08 Oct -00 kosong, 08 Oct -13 sudah 4518
		zRows = [
			{ id: 28, market: "TOTOMACAU-13", date: "2026-10-09", value: "" },
			{ id: 35, market: "TOTOMACAU-16", date: "2026-10-09", value: "" },
			{ id: 44, market: "TOTOMACAU-19", date: "2026-10-09", value: "" },
			{ id: 52, market: "TOTOMACAU-22", date: "2026-10-09", value: "" },
			{ id: 60, market: "TOTOMACAU-15-5D", date: "2026-10-09", value: "" },
			{ id: 61, market: "TOTOMACAU-21-5D", date: "2026-10-09", value: "" },
			{ id: 62, market: "TOTOMACAU-23", date: "2026-10-09", value: "" },
			{ id: 69, market: "TOTOMACAU-00", date: "2026-10-09", value: "" },
			{ id: 71, market: "TOTOMACAU-00", date: "2026-10-08", value: "" },
			{ id: 100, market: "TOTOMACAU-13", date: "2026-10-08", value: "4518" },
		];
	});

	it("hemat subrequest: satu putaran penuh (9 baris admin) memakai jauh di bawah 50 panggilan Turso + jaringan", async () => {
		await addUser("tester");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("tester");
		await setMode(2);
		const real = turso.current!.d1 as { prepare: (s: string) => unknown; batch: (s: unknown[]) => Promise<unknown> };
		let calls = 0;
		const origPrepare = real.prepare.bind(real);
		const origBatch = real.batch.bind(real);
		real.prepare = (sql: string) => {
			const st = origPrepare(sql) as Record<string, (...a: unknown[]) => unknown>;
			for (const k of ["run", "all", "first"]) {
				const fn = st[k].bind(st);
				st[k] = (...a: unknown[]) => (calls++, fn(...a));
			}
			return st;
		};
		real.batch = (s: unknown[]) => (calls++, origBatch(s));
		await run();
		expect(pushed.length).toBeGreaterThan(0);
		// jaringan panel/admin: 2 halaman admin + 2 login/daftar Panel-Z + 1 baca ulang + 1 push per baris
		const net = adminHits.length + 3 + pushed.length;
		expect(calls + net).toBeLessThan(45);
	});
	it("mode 1: membandingkan saja -- tidak ada yang dikirim; status per (pasaran, tanggal)", async () => {
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		const sum = await run();
		expect(pushed).toHaveLength(0);
		const st = await byMarketDate();
		expect(st["TOTOMACAU-13 2026-10-08"]).toBe("VERIFIED"); // 4518 sudah ada & sama
		expect(st["TOTOMACAU-00 2026-10-09"]).toBe("PENDING"); // 2412 belum terisi
		expect(st["TOTOMACAU-00 2026-10-08"]).toBe("PENDING"); // 7036 belum terisi
		expect(st["TOTOMACAU-16 2026-10-08"]).toBe("MISSING"); // baris 08 Oct -16 tidak ada di Panel-Z
		expect(sum.pending).toBeGreaterThan(0);
	});

	it("mode 2: mengisi HANYA baris (pasaran+TANGGAL) yang benar & kosong; yang sudah terisi / tidak ada tidak disentuh", async () => {
		await setMode(2);
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		await run();
		// 09-10 00:10 -> baris #69 (00, 09 Oct); 08-10 00:10 -> baris #71 (00, 08 Oct); bukan sebaliknya
		expect(pushed.sort((a, b) => Number(a.id) - Number(b.id))).toEqual([
			{ id: "69", angka: "2412" },
			{ id: "71", angka: "7036" },
		]);
		expect(zRows.find((r) => r.id === 100)!.value).toBe("4518"); // tidak disentuh
		expect(zRows.find((r) => r.id === 28)!.value).toBe(""); // baris 09 Oct -13 (draw besok) tidak diisi dengan angka 08 Oct
		const st = await byMarketDate();
		expect(st["TOTOMACAU-00 2026-10-09"]).toBe("SENT");
		expect(st["TOTOMACAU-00 2026-10-08"]).toBe("SENT");
		expect(st["TOTOMACAU-23 2026-10-08"]).toBe("MISSING");
	});

	it("putaran berikutnya tidak mengirim ulang; baris yang sudah SENT terbaca 'sudah ada'", async () => {
		await setMode(2);
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		await run();
		const n = pushed.length;
		await run();
		await run();
		expect(pushed).toHaveLength(n);
		expect((await byMarketDate())["TOTOMACAU-00 2026-10-09"]).toBe("SENT");
	});

	it("Panel-Z berisi angka BEDA -> tidak ditimpa, jadi peringatan", async () => {
		await setMode(2);
		zRows.find((r) => r.id === 100)!.value = "9999"; // admin 13:10 = 4518
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		await run();
		expect(zRows.find((r) => r.id === 100)!.value).toBe("9999");
		expect((await byMarketDate())["TOTOMACAU-13 2026-10-08"]).toBe("CONFLICT");
		const al = await pendingTotoAlerts(env, ["HUGOTOGEL"]);
		expect(al.length).toBeGreaterThanOrEqual(1);
		await ackTotoAlerts(env, al.map((a) => a.id));
		expect(await pendingTotoAlerts(env, ["HUGOTOGEL"])).toHaveLength(0);
	});

	it("terkirim tetapi tidak tampil saat dibaca ulang -> GAGAL (tidak dianggap berhasil)", async () => {
		await setMode(2);
		panelOpts.noApply = true;
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		await run();
		const st = await byMarketDate();
		expect(st["TOTOMACAU-00 2026-10-09"]).toBe("FAILED");
	});

	it("gagal kirim dicoba lagi tiap putaran sampai 3x lalu berhenti", async () => {
		await setMode(2);
		panelOpts.failPush = true;
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		for (let i = 0; i < 5; i++) await run();
		const rows = await listTotoLog(env, ["HUGOTOGEL"]);
		const r = rows.find((x) => x.market === "TOTOMACAU-00" && x.rowAt.startsWith("2026-10-09"))!;
		expect(r).toMatchObject({ status: "FAILED", attempts: 3 });
	});

	it("Panel-Z tidak bisa dibuka -> dicatat sebagai kegagalan (tidak ada yang dikirim)", async () => {
		await setMode(2);
		panelOpts.failOpen = true;
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		const sum = await run();
		expect(pushed).toHaveLength(0);
		expect(sum.failed).toBeGreaterThan(0);
	});

	it("jeda antar putaran dihormati (tanpa force), tombol 'sekarang' mengabaikannya", async () => {
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		const t = Date.UTC(2026, 9, 8, 4, 0); // 11:00 WIB -> jeda 30 menit
		await totoMacauRun(env, { fetchFn, panel, nowMs: t });
		const hits = adminHits.length;
		await totoMacauRun(env, { fetchFn, panel, nowMs: t + 60_000 });
		expect(adminHits.length).toBe(hits);
		await totoMacauRun(env, { fetchFn, panel, nowMs: t + 60_000, force: true });
		expect(adminHits.length).toBeGreaterThan(hits);
	});

	it("aturan akses = menu Result: tanpa izin Panel-Z / nonaktif / VIEWER / website bukan miliknya tidak dipakai", async () => {
		await setMode(2);
		addPanelZ("HUGOTOGEL");
		addUser("NoPz", { panelz: 0 });
		addUser("Off", { status: "NONAKTIF" });
		addUser("View", { role: "VIEWER" });
		addUser("Other", { websites: ["FOLATOTO"] });
		for (const u of ["NoPz", "Off", "View"]) await enableWithSession(u);
		await setEnabled(env, "Other", true);
		await saveSession(env, "Other", "HUGOTOGEL", defaultAdminBase("HUGOTOGEL"), "PHPSESSID=" + SID);
		const sum = await run();
		expect(sum.websites).toBe(0);
		expect(adminHits).toHaveLength(0);
		expect(pushed).toHaveLength(0);
	});

	it("website tanpa Panel-Z terisi dilewati; dua user satu website = diproses sekali", async () => {
		await setMode(2);
		addUser("A");
		addUser("B");
		await enableWithSession("A");
		await enableWithSession("B");
		expect((await run()).websites).toBe(0); // belum ada Panel-Z
		addPanelZ("HUGOTOGEL");
		const sum = await run();
		expect(sum.websites).toBe(1);
		expect(adminHits).toHaveLength(2); // m17 + m51 sekali (sesi user pertama)
	});

	it("sesi pertama habis -> pakai sesi user berikutnya", async () => {
		await setMode(2);
		addUser("A");
		addUser("B");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("A");
		await enableWithSession("B");
		let call = 0;
		const loginPage = () => new Response(`<form action="login.php" method="post"><input name="entered_login"></form>`, { status: 200 });
		const f = async (url: string) => (/login\.php/.test(url) ? loginPage() : ++call === 1 ? new Response("", { status: 302, headers: { location: "login.php" } }) : fetchFn(url));
		const sum = await totoMacauRun(env, { fetchFn: f, panel, nowMs: NOW, force: true });
		expect(sum.failed).toBe(0);
		expect(pushed.length).toBeGreaterThan(0);
	});

	it("semua sesi habis 3 putaran -> peringatan", async () => {
		await setMode(2);
		addUser("A");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("A");
		const dead = async (url: string) => (/login\.php/.test(url) ? new Response(`<form action="login.php"><input name="entered_login"></form>`, { status: 200 }) : new Response("", { status: 302, headers: { location: "login.php" } }));
		for (let i = 0; i < 3; i++) await totoMacauRun(env, { fetchFn: dead, panel, nowMs: NOW, force: true });
		const al = await pendingTotoAlerts(env, ["HUGOTOGEL"]);
		expect(al.length).toBeGreaterThanOrEqual(1);
		expect(al[0].detail).toMatch(/Sesi/);
	});

	it("mode 0 = mati total", async () => {
		await setMode(0);
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		const sum = await run();
		expect(sum.websites).toBe(0);
		expect(adminHits).toHaveLength(0);
	});

	it("baris admin Hitung=No, digit salah, atau lebih tua dari 3 hari tidak dikirim", async () => {
		await setMode(2);
		m17.unshift(["09-10-2026 00:20:00", "14227", "123", "Yes"], ["09-10-2026 00:30:00", "14228", "1111", "No"], ["01-10-2026 00:10:00", "14000", "9999", "Yes"]);
		try {
			addUser("Op");
			addPanelZ("HUGOTOGEL");
			await enableWithSession("Op");
			await run();
			expect(pushed.map((p) => p.angka)).not.toContain("123");
			expect(pushed.map((p) => p.angka)).not.toContain("1111");
			expect(pushed.map((p) => p.angka)).not.toContain("9999");
		} finally {
			m17.splice(0, 3);
		}
	});
});
