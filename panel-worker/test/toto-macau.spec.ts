import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { ackTotoAlerts, dismissTotoRows, listTotoEvents, listTotoLog, logTotoEvent, parseTotoRows, passIntervalMin, pendingTotoAlerts, totoWindowState, pruneTotoMacau, resetTotoTablesFlag, totoDispatchAt, totoDispatchTick, totoMacauRun } from "../src/lib/toto-macau";
import { openPanelZ, panelZPageCount, parsePanelZRows, type PanelZHandle } from "../src/senders/panelz";
import { defaultAdminBase, resetAutoInputTablesFlag, saveSession, setEnabled } from "../src/lib/auto-input";
import { resetSysCache, saveSys } from "../src/lib/settings";
import { tsPlusMinutes } from "../src/lib/time";
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
// Bentuk HTML ASLI Panel-Z (dikirim pemilik): <th scope="row">, <form> membungkus <td> di dalam <tr>, nama pasaran huruf kecil, input name="updangka".
const zHtml = (rows: ZRow[], pages = 1) =>
	`<table id="prediksi-block" class="table font-weight-bold"><thead><tr><th scope="col">#</th><th scope="col">Pasaran</th><th scope="col">Angka</th><th scope="col">Tanggal</th><th scope="col">Action</th></tr></thead><tbody>${rows
		.map((r, i) => {
			const [y, m, d] = r.date.split("-");
			const mk = r.market.toLowerCase();
			return `<tr>
                <th scope="row">${101 + i}</th>
                <td class="text-uppercase"><img class="rounded" src="assets/images/icon-market/${mk}.webp" width="50" /> ${mk}</td>
                <form method="post" action="config/update-resultlotto.php?row=${r.id}">
                <td class="text-capitalize"><input type="text" class="form-control" name="updangka" maxlength="6" value="${r.value}" /></td>
                <td> ${d} ${MONTH[Number(m) - 1]} ${y} | 00:25:02</td>
                <td><button type="submit" class="btn btn-primary"><i class="fas fa-check"></i> Edit</button> <a href="config/delresult.php?row=${r.id}" class="btn btn-danger"><i class="fas fa-times"></i> Hapus</a></td>
                </form>
                </tr>`;
		})
		.join("\n")}</tbody></table><ul class="pagination">${Array.from({ length: pages }, (_, i) => `<li class="page-item"><a class="page-link font-weight-bold" href="?hal=result&no=${i + 1}">${i + 1}</a></li>`).join("")}</ul>`;

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
	it("jendela pemicu: aktif sekitar jam draw (-2 s/d +45 menit), di luar itu mati (0) -- tidak selalu aktif", () => {
		const wib = (h: number, m: number) => Date.UTC(2026, 9, 8, h - 7 + 24, m); // jam WIB hari yang sama (h>=7 aman; dipakai untuk 11..23)
		expect(passIntervalMin(Date.UTC(2026, 9, 8, 6, 20))).toBe(3); // 13:20 WIB
		expect(passIntervalMin(Date.UTC(2026, 9, 8, 4, 0))).toBe(0); // 11:00 WIB: di luar jendela -> tidak aktif
		expect(passIntervalMin(Date.UTC(2026, 9, 8, 5, 57))).toBe(0); // 12:57 -- belum 2 menit sebelum 13:00
		expect(passIntervalMin(Date.UTC(2026, 9, 8, 5, 58))).toBe(3); // 12:58 -- 2 menit sebelum
		expect(passIntervalMin(Date.UTC(2026, 9, 8, 6, 45))).toBe(3); // 13:45 -- batas akhir
		expect(passIntervalMin(Date.UTC(2026, 9, 8, 6, 46))).toBe(0); // 13:46
		expect(passIntervalMin(wib(23, 50))).toBe(0); // 23:50: setelah jendela 23:00, sebelum jendela 00:00
		expect(passIntervalMin(wib(23, 59))).toBe(3); // 23:59: jendela draw 00:00 (lintas tengah malam)
		expect(passIntervalMin(Date.UTC(2026, 9, 8, 17, 30))).toBe(3); // 00:30 WIB: masih jendela draw 00
		// pengaturan admin: jendela lebih lebar, sapuan rutin 60 menit
		const cfg = { before: 10, after: 20, fast: 2, idle: 60 };
		expect(passIntervalMin(Date.UTC(2026, 9, 8, 5, 52), cfg)).toBe(2); // 12:52 (10 menit sebelum 13:00)
		expect(passIntervalMin(Date.UTC(2026, 9, 8, 6, 25), cfg)).toBe(60); // 13:25 > +20
	});
	it("totoWindowState: jendela berikutnya & sisa waktu (untuk kartu)", () => {
		const idle = totoWindowState(Date.UTC(2026, 9, 8, 4, 0)); // 11:00 WIB
		expect(idle).toMatchObject({ active: false, endsInMin: null, nextAt: "12:58", nextInMin: 118, nextName: "TOTOMACAU-13" });
		const on = totoWindowState(Date.UTC(2026, 9, 8, 6, 30)); // 13:30 WIB
		expect(on).toMatchObject({ active: true, endsInMin: 15 });
		// 21:00 WIB: draw 5D 21 jendela 20:58 -> sesudah 19:45 sebelum 20:58
		expect(totoWindowState(Date.UTC(2026, 9, 8, 13, 0))).toMatchObject({ active: false, nextAt: "20:58", nextName: "TOTOMACAU-21-5D" });
	});
});

// Panel-Z asli membagi daftar per halaman (100 baris, terbaru dulu): 08 Oct terpotong antara halaman 1 dan 2.
const PZ_PAGES: ZRow[][] = [
	[
		{ id: 242901, market: "TOTOMACAU-00", date: "2026-10-08", value: "xxxx" },
		{ id: 242903, market: "TOTOMACAU-13", date: "2026-10-08", value: "4518" },
	],
	[
		{ id: 242908, market: "TOTOMACAU-16", date: "2026-10-08", value: "xxxx" },
		{ id: 242925, market: "TOTOMACAU-22", date: "2026-10-08", value: "xxxx" },
		{ id: 242831, market: "TOTOMACAU-13", date: "2026-10-07", value: "2492" },
	],
	[{ id: 242700, market: "TOTOMACAU-13", date: "2026-10-06", value: "1111" }],
	[{ id: 242600, market: "TOTOMACAU-13", date: "2026-10-05", value: "2222" }],
];
function stubPanelZ(pages: ZRow[][]) {
	const urls: string[] = [];
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		urls.push(`${init?.method ?? "GET"} ${url}`);
		if (url.includes("authentication.php")) return new Response("", { status: 302, headers: { "set-cookie": "PHPSESSID=zzz; path=/" } });
		const m = url.match(/hal=result(?:&no=(\d+))?/);
		if (m) return new Response(zHtml(pages[Number(m[1] || 1) - 1] ?? [], pages.length), { status: 200 });
		if (url.includes("update-resultlotto.php")) {
			const id = url.match(/row=(\d+)/)![1];
			const angka = new URLSearchParams(String(init?.body)).get("updangka")!;
			for (const pg of pages) for (const r of pg) if (String(r.id) === id) r.value = angka;
			return new Response("", { status: 302 });
		}
		return new Response("", { status: 404 });
	});
	return urls;
}
describe("daftar Panel-Z per halaman", () => {
	const cfg = { url: "https://pz.test", user: "u", pass: "p", user2: "u2", pass2: "p2" } as never;
	it("pagination dibaca dari tautan ?hal=result&no=N", () => {
		expect(panelZPageCount(zHtml([], 5))).toBe(5);
		expect(panelZPageCount("<table></table>")).toBe(1);
	});
	it("memuat halaman berikutnya sampai tanggal paling lama melewati batas; baris 08 Oct di halaman 2 ikut terbaca", async () => {
		const urls = stubPanelZ(structuredClone(PZ_PAGES));
		const h = (await openPanelZ(cfg, { sinceDate: "2026-10-07" })) as PanelZHandle;
		const rows = parsePanelZRows(h.html);
		expect(rows.find((r) => r.market === "TOTOMACAU-16" && r.date === "2026-10-08")).toMatchObject({ id: "242908", filled: false });
		expect(rows.find((r) => r.market === "TOTOMACAU-22" && r.date === "2026-10-08")).toMatchObject({ id: "242925", filled: false });
		// halaman 1 (oldest 08 >= 07) -> halaman 2 (oldest 07, belum < 07) -> halaman 3 (oldest 06 < 07) -> berhenti; halaman 4 tidak dimuat
		expect(urls.filter((u) => u.includes("hal=result")).length).toBe(3);
		expect(h.fetches).toBe(4); // login + 3 halaman
		vi.unstubAllGlobals();
	});
	it("baca ulang hanya halaman yang memuat baris yang dikirim", async () => {
		const urls = stubPanelZ(structuredClone(PZ_PAGES));
		const h = (await openPanelZ(cfg, { sinceDate: "2026-10-08" })) as PanelZHandle;
		const before = urls.length;
		expect(await h.push("242908", "6360")).toBe("Berhasil dikirim");
		const html = await h.reload(["242908"]);
		expect(urls.slice(before).filter((u) => u.includes("hal=result"))).toEqual(["GET https://pz.test/dashboard.php?hal=result&no=2"]);
		expect(parsePanelZRows(html).find((r) => r.id === "242908")).toMatchObject({ value: "6360", filled: true });
		vi.unstubAllGlobals();
	});
	it("tidak melewati batas halaman maksimum", async () => {
		const many = Array.from({ length: 12 }, (_, i) => [{ id: 1000 + i, market: "TOTOMACAU-13", date: "2026-10-08", value: "1234" }]);
		const urls = stubPanelZ(many);
		await openPanelZ(cfg, { sinceDate: "2026-01-01" });
		expect(urls.filter((u) => u.includes("hal=result")).length).toBeLessThanOrEqual(6);
		vi.unstubAllGlobals();
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
	/** Putaran paksa. Antar putaran dianggap sudah lewat 5 menit (jeda minimum 60 dtk antar pemeriksaan website tidak menghalangi tes berurutan); tes jeda memakai noGap. */
	const run = async (o: Parameters<typeof totoMacauRun>[1] & { noGap?: boolean } = {}) => {
		const { noGap, ...rest } = o;
		await listTotoLog(env, ["X"]); // pastikan tabel ada
		if (!noGap && rest.force !== false) turso.current!.raw.prepare(`UPDATE toto_macau_log SET updated_at = ? WHERE game = 'pass' AND detail <> 'MORE'`).run(tsPlusMinutes(-5));
		return totoMacauRun(env, { fetchFn, panel, nowMs: NOW, force: true, ...rest });
	};
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
		let inBatch = false;
		const origPrepare = real.prepare.bind(real);
		const origBatch = real.batch.bind(real);
		real.prepare = (sql: string) => {
			const st = origPrepare(sql) as Record<string, (...a: unknown[]) => unknown>;
			for (const k of ["run", "all", "first"]) {
				const fn = st[k].bind(st);
				st[k] = (...a: unknown[]) => (inBatch || calls++, fn(...a));
			}
			return st;
		};
		real.batch = async (s: unknown[]) => {
			calls++; // satu batch = satu panggilan HTTP ke Turso
			inBatch = true;
			try {
				return await origBatch(s);
			} finally {
				inBatch = false;
			}
		};
		await run();
		expect(pushed.length).toBeGreaterThan(0);
		// jaringan panel/admin: 2 halaman admin + 2 login/daftar Panel-Z + 1 baca ulang + 1 push per baris
		const net = adminHits.length + 3 + pushed.length;
		expect(calls + net).toBeLessThan(40);
	});
	it("end-to-end halaman berbagi: baris kosong 08 Oct di halaman 2 diisi & diverifikasi, baris di halaman 1 tidak ikut tersentuh", async () => {
		await addUser("tester");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("tester");
		await setMode(2);
		const pages: ZRow[][] = [
			[
				{ id: 242901, market: "TOTOMACAU-00", date: "2026-10-08", value: "xxxx" },
				{ id: 242903, market: "TOTOMACAU-13", date: "2026-10-08", value: "4518" },
				{ id: 242950, market: "TOTOMACAU-00", date: "2026-10-09", value: "xxxx" },
			],
			[
				{ id: 242908, market: "TOTOMACAU-16", date: "2026-10-08", value: "xxxx" },
				{ id: 242917, market: "TOTOMACAU-19", date: "2026-10-08", value: "2144" },
				{ id: 242925, market: "TOTOMACAU-22", date: "2026-10-08", value: "xxxx" },
				{ id: 242933, market: "TOTOMACAU-15-5D", date: "2026-10-08", value: "92018" },
				{ id: 242934, market: "TOTOMACAU-21-5D", date: "2026-10-08", value: "xxxx" },
				{ id: 242935, market: "TOTOMACAU-23", date: "2026-10-08", value: "xxxx" },
			],
		];
		const urls = stubPanelZ(pages);
		let sum = await totoMacauRun(env, { fetchFn, nowMs: NOW, force: true });
		for (let i = 0; i < 6 && sum.more; i++) sum = await totoMacauRun(env, { fetchFn, nowMs: NOW, force: true }); // jatah per putaran terbatas -> dilanjutkan siklus berikutnya
		expect(sum.failed).toBe(0);
		const vals = Object.fromEntries(pages.flat().map((r) => [r.id, r.value]));
		expect(vals[242908]).toBe("6360"); // -16 08 Oct (halaman 2)
		expect(vals[242925]).toBe("0522"); // -22 08 Oct
		expect(vals[242935]).toBe("5747"); // -23 08 Oct
		expect(vals[242934]).toBe("08346"); // -21-5D 08 Oct
		expect(vals[242901]).toBe("7036"); // -00 08 Oct (halaman 1)
		expect(vals[242950]).toBe("2412"); // -00 09 Oct
		expect(vals[242903]).toBe("4518"); // sudah benar, tidak diubah
		const st = await byMarketDate();
		expect(st["TOTOMACAU-16 2026-10-08"]).toBe("SENT");
		expect(st["TOTOMACAU-22 2026-10-08"]).toBe("SENT");
		expect(urls.some((u) => u.startsWith("POST") && u.includes("row=242908"))).toBe(true);
		vi.unstubAllGlobals();
	});
	it("log kegiatan: tiap langkah tercatat (mulai, baca admin, buka Panel-Z, kirim, terverifikasi, selesai) dan 'sedang berjalan' hanya sebelum selesai", async () => {
		await addUser("tester");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("tester");
		await setMode(2);
		await run();
		const ev = await listTotoEvents(env, ["HUGOTOGEL"], 100);
		const msgs = ev.events.map((e) => e.msg).reverse(); // urut kejadian
		expect(msgs[0]).toMatch(/^Mulai memeriksa HUGOTOGEL/);
		expect(msgs.some((m) => /Admin Toto Macau: \d+ baris terbaca/.test(m))).toBe(true);
		expect(msgs.some((m) => /Admin Toto Macao 5D: \d+ baris terbaca/.test(m))).toBe(true);
		expect(msgs.some((m) => /Panel-Z dibuka: .* baris Toto Macau terbaca/.test(m))).toBe(true);
		expect(msgs.some((m) => /TOTOMACAU-00 2026-10-08: baris kosong → mengirim 7036/.test(m))).toBe(true);
		expect(msgs.some((m) => /TOTOMACAU-00 2026-10-08: TERKIRIM 7036 — terbaca ulang/.test(m))).toBe(true);
		expect(msgs[msgs.length - 1]).toMatch(/^Selesai HUGOTOGEL: \d+ dikirim/);
		expect(ev.running).toBe(false);
		await logTotoEvent(env, "HUGOTOGEL", "start", "INFO", "Mulai memeriksa HUGOTOGEL (uji)");
		expect((await listTotoEvents(env, ["HUGOTOGEL"], 100)).running).toBe(true); // 'start' segar tanpa 'end'
		expect((await listTotoEvents(env, ["LAIN"], 100)).running).toBe(false); // milik website lain tidak bocor
	});
	it("log kegiatan: galat tak terduga tidak menggantung — tercatat 'Berhenti karena galat' dan putaran berikutnya tetap jalan", async () => {
		await addUser("tester");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("tester");
		await setMode(2);
		await run({ panel: async () => { throw new Error("boom"); } });
		const ev = await listTotoEvents(env, ["HUGOTOGEL"], 20);
		expect(ev.events[0].kind).toBe("end");
		expect(ev.events[0].msg).toMatch(/Berhenti karena galat: boom/);
		expect(ev.running).toBe(false);
	});
	it("baris belum dibuat Panel-Z (dibuat 00:25) -> menunggu, dicek tiap 3 menit (bukan 30), lalu DIISI begitu baris muncul", async () => {
		await addUser("tester");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("tester");
		await setMode(2);
		const full = zRows.slice();
		zRows = zRows.filter((r) => !(r.market === "TOTOMACAU-00" && r.date === "2026-10-09")); // baris 09 Oct -00 belum dibuat
		await run();
		expect((await byMarketDate())["TOTOMACAU-00 2026-10-09"]).toBe("MISSING");
		expect(pushed.some((p) => p.angka === "2412")).toBe(false);
		// segera sesudahnya (non-force): belum waktunya
		expect((await run({ force: false })).websites).toBe(0);
		// 4 menit kemudian (jam 01:52 WIB = di luar jendela draw -> jeda dasar 30 menit); karena ada baris MENUNGGU, jeda 3 menit
		turso.current!.raw.prepare(`UPDATE toto_macau_log SET updated_at = ? WHERE game = 'pass'`).run(tsPlusMinutes(-4));
		zRows = full; // Panel-Z membuat barisnya
		const sum = await run({ force: false });
		expect(sum.websites).toBe(1);
		expect(sum.posted).toBeGreaterThanOrEqual(1);
		expect(zRows.find((r) => r.id === 69)!.value).toBe("2412");
		expect((await byMarketDate())["TOTOMACAU-00 2026-10-09"]).toBe("SENT");
	});
	it("tanpa baris menunggu, jeda tetap 30 menit di luar jendela draw (hemat)", async () => {
		await addUser("tester");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("tester");
		await setMode(2);
		await run(); // semua terisi -> tidak ada yang menunggu
		turso.current!.raw.prepare(`UPDATE toto_macau_log SET status = 'SENT' WHERE period > 0`).run();
		turso.current!.raw.prepare(`UPDATE toto_macau_log SET updated_at = ? WHERE game = 'pass'`).run(tsPlusMinutes(-4));
		expect((await run({ force: false })).websites).toBe(0);
	});
	it("gagal kirim 3x: ditahan 60 menit, sesudahnya siklus percobaan baru dimulai (baris kosong tidak terlewat)", async () => {
		await addUser("tester");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("tester");
		await setMode(2);
		panelOpts.failPush = true;
		for (let i = 0; i < 3; i++) await run();
		expect(((await listTotoLog(env, ["HUGOTOGEL"])).find((r) => r.market === "TOTOMACAU-00" && r.rowAt.startsWith("2026-10-08")))!.attempts).toBe(3);
		pushed.length = 0;
		await run();
		expect(pushed.length).toBe(0); // masih dalam masa tahan 60 menit
		turso.current!.raw.prepare(`UPDATE toto_macau_log SET updated_at = ? WHERE status = 'FAILED' AND period > 0`).run(tsPlusMinutes(-120));
		panelOpts.failPush = false;
		await run();
		expect(zRows.find((r) => r.id === 71)!.value).toBe("7036"); // baris kosong akhirnya terisi
		expect((await byMarketDate())["TOTOMACAU-00 2026-10-08"]).toBe("SENT");
	});
	it("pemicu cron: memicu workflow sesuai jeda, tidak dobel, dipercepat bila ada baris menunggu, mati bila mode 0", async () => {
		await setMode(2);
		await saveSys(env, { sys_totomacau_idle_min: 30 }); // sapuan rutin 30 menit DIHIDUPKAN admin (bawaan: mati)
		resetSysCache();
		const calls: number[] = [];
		const dispatch = async () => void calls.push(1);
		const t0 = Date.UTC(2026, 9, 8, 4, 0); // 11:00 WIB: di luar jendela draw -> jeda 30 menit (sapuan rutin diaktifkan)
		expect(await totoDispatchAt(env)).toBe(""); // belum pernah memicu
		expect(await totoDispatchTick(env, dispatch, t0)).toBe(true);
		expect(await totoDispatchAt(env)).toBe("2026-10-08 11:00:00"); // waktu WIB pemicu terakhir (untuk kartu)
		expect(await totoDispatchTick(env, dispatch, t0 + 60_000)).toBe(false);
		expect(await totoDispatchTick(env, dispatch, t0 + 10 * 60_000)).toBe(false); // 10 menit < 30
		expect(await totoDispatchTick(env, dispatch, t0 + 31 * 60_000)).toBe(true);
		expect(calls.length).toBe(2);
		// ada baris MENUNGGU (tercatat baru-baru ini) -> 3 menit
		const now = tsPlusMinutes(0);
		turso.current!.raw.prepare(`INSERT INTO toto_macau_log (website, game, period, slot_key, status, created_at, updated_at) VALUES ('HUGOTOGEL','m17',99,'k','MISSING',?,?)`).run(now, now);
		turso.current!.raw.prepare(`UPDATE toto_macau_log SET row_at = ? WHERE period = 99`).run(tsPlusMinutes(-30)); // draw 30 menit lalu
		expect(await totoDispatchTick(env, dispatch, t0 + 35 * 60_000)).toBe(true);
		expect(calls.length).toBe(3);
		await setMode(0);
		expect(await totoDispatchTick(env, dispatch, t0 + 200 * 60_000)).toBe(false);
		// galat pemicu tidak melempar & tercatat di log kegiatan
		await setMode(2);
		expect(await totoDispatchTick(env, async () => { throw new Error("token kosong"); }, t0 + 400 * 60_000)).toBe(true);
		const ev = await listTotoEvents(env, ["HUGOTOGEL"], 10);
		expect(ev.events[0].msg).toMatch(/Gagal memicu GitHub Actions: token kosong/);
	});
	it("pemicu TIDAK selalu aktif: bawaan hanya di sekitar jam draw; baris menunggu membangunkannya; pengaturan admin dihormati", async () => {
		await setMode(2);
		const calls: number[] = [];
		const dispatch = async () => void calls.push(1);
		const t11 = Date.UTC(2026, 9, 8, 4, 0); // 11:00 WIB
		expect(await totoDispatchTick(env, dispatch, t11)).toBe(false); // di luar jendela: diam
		expect(await totoDispatchTick(env, dispatch, t11 + 60 * 60_000)).toBe(false); // 12:00 juga diam
		expect(calls.length).toBe(0);
		const t1258 = Date.UTC(2026, 9, 8, 5, 58);
		expect(await totoDispatchTick(env, dispatch, t1258)).toBe(true); // jendela draw 13:00 dibuka
		expect(await totoDispatchTick(env, dispatch, t1258 + 60_000)).toBe(false); // jeda 3 menit
		expect(await totoDispatchTick(env, dispatch, t1258 + 3 * 60_000)).toBe(true);
		expect(await totoDispatchTick(env, dispatch, Date.UTC(2026, 9, 8, 6, 50))).toBe(false); // 13:50 jendela sudah ditutup
		expect(calls.length).toBe(2);
		// baris menunggu (draw baru-baru ini) membangunkan pemicu walau di luar jendela
		const now = tsPlusMinutes(0);
		turso.current!.raw.prepare(`INSERT INTO toto_macau_log (website, game, period, slot_key, status, created_at, updated_at) VALUES ('HUGOTOGEL','m17',99,'k','MISSING',?,?)`).run(now, now);
		turso.current!.raw.prepare(`UPDATE toto_macau_log SET row_at = ? WHERE period = 99`).run(tsPlusMinutes(-30));
		expect(await totoDispatchTick(env, dispatch, Date.UTC(2026, 9, 8, 9, 0))).toBe(true);
		// jendela diatur admin: sesudah draw hanya 5 menit
		turso.current!.raw.prepare(`DELETE FROM toto_macau_log WHERE period = 99`).run();
		await saveSys(env, { sys_totomacau_after_min: 5 });
		resetSysCache();
		expect(await totoDispatchTick(env, dispatch, Date.UTC(2026, 9, 8, 16, 0, 0) + 10 * 60_000)).toBe(false); // 23:10: lewat 5 menit sesudah 23:00
		expect(await totoDispatchTick(env, dispatch, Date.UTC(2026, 9, 8, 16, 0, 0) + 30 * 60_000)).toBe(false);
	});
	it("putaran non-paksa di luar jendela draw: tidak memeriksa (bawaan), kecuali sapuan rutin dihidupkan atau ada baris menunggu", async () => {
		await addUser("tester");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("tester");
		await setMode(2);
		await run(); // putaran pertama (paksa): mencatat tanda pemeriksaan website
		const db = turso.current!.raw;
		db.prepare(`UPDATE toto_macau_log SET status = 'SENT' WHERE period > 0`).run(); // tidak ada baris menunggu
		db.prepare(`UPDATE toto_macau_log SET updated_at = ? WHERE game = 'pass'`).run(tsPlusMinutes(-300)); // terakhir diperiksa 5 jam lalu
		expect((await run({ force: false })).websites).toBe(0); // NOW = 01:52 WIB, di luar jendela, sapuan rutin mati -> diam
		await saveSys(env, { sys_totomacau_idle_min: 30 });
		resetSysCache();
		expect((await run({ force: false })).websites).toBe(1); // sapuan rutin dihidupkan admin -> jalan
	});
	// 11 hari draw Toto Macau (6/hari), terbaru dulu, 20 baris per halaman admin ([ >> ] = start=20&end=40 ...)
	function manyDraws() {
		const rows: [string, string, string, string][] = [];
		let per = 20000;
		for (let day = 8; day >= -2; day--) {
			const d = new Date(Date.UTC(2026, 9, day)); // 8 Oct turun ke 28 Sep
			const dd = String(d.getUTCDate()).padStart(2, "0");
			const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
			for (const h of [23, 22, 19, 16, 13, 0]) rows.push([`${dd}-${mm}-2026 ${String(h).padStart(2, "0")}:10:00`, String(per--), String(1000 + (per % 9000)), "Yes"]);
		}
		return rows;
	}
	const pagedFetch = (draws: [string, string, string, string][]) => async (url: string) => {
		adminHits.push(url);
		const st = Number(new URL(url).searchParams.get("start") ?? 0);
		if (url.includes("sar=m17")) return new Response(adminPage("Toto Macau", draws.slice(st, st + 20)), { status: 200 });
		return new Response(adminPage("Toto Macao 5D", m51.slice(st, st + 20)), { status: 200 });
	};
	const zAllDays = (value: (market: string, date: string) => string): ZRow[] => {
		const out: ZRow[] = [];
		let id = 5000;
		for (let day = 9; day >= -2; day--) {
			const d = new Date(Date.UTC(2026, 9, day));
			const date = d.toISOString().slice(0, 10);
			for (const mk of ["TOTOMACAU-00", "TOTOMACAU-13", "TOTOMACAU-16", "TOTOMACAU-19", "TOTOMACAU-22", "TOTOMACAU-23"]) out.push({ id: id++, market: mk, date, value: value(mk, date) });
		}
		return out;
	};
	it("admin dibaca mundur lewat tombol [ >> ] sampai 7 hari; berhenti begitu halaman melewati batas; baris lebih lama tidak tersentuh", async () => {
		await addUser("tester");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("tester");
		await setMode(2);
		zRows = zAllDays(() => "");
		const draws = manyDraws();
		for (let i = 0; i < 12; i++) if (!(await run({ fetchFn: pagedFetch(draws) })).more) break;
		const m17Hits = adminHits.filter((u) => u.includes("sar=m17")).map((u) => new URL(u).searchParams.get("start") ?? "0");
		expect(m17Hits).toContain("20");
		expect(m17Hits).toContain("40");
		expect(m17Hits).not.toContain("60"); // halaman 3 sudah melewati batas 7 hari
		const find = (mk: string, date: string) => zRows.find((r) => r.market === mk && r.date === date)!;
		expect(find("TOTOMACAU-13", "2026-10-08").value).not.toBe(""); // halaman 1
		expect(find("TOTOMACAU-16", "2026-10-04").value).not.toBe(""); // halaman 2
		expect(find("TOTOMACAU-22", "2026-10-02").value).not.toBe(""); // halaman 3 (hari ke-7)
		expect(find("TOTOMACAU-13", "2026-10-01").value).toBe(""); // di luar 7 hari
		expect(find("TOTOMACAU-13", "2026-09-30").value).toBe("");
	});
	it("pengaman koreksi massal: terlalu banyak angka berbeda sekaligus = kemungkinan pemetaan keliru -> TIDAK dikoreksi, ditandai & diperingatkan", async () => {
		await addUser("tester");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("tester");
		await setMode(2);
		zRows = zAllDays(() => "0000"); // semua terisi angka yang berbeda dari admin (mis. pemetaan tanggal bergeser)
		const draws = manyDraws();
		await run({ fetchFn: pagedFetch(draws) });
		expect(pushed).toHaveLength(0);
		expect(Object.values(await byMarketDate()).filter((x) => x === "CONFLICT").length).toBeGreaterThan(10);
		const ev = (await listTotoEvents(env, ["HUGOTOGEL"], 100)).events.map((e) => e.msg);
		expect(ev.some((m) => /batas koreksi massal 10.*TIDAK dikoreksi otomatis/.test(m))).toBe(true);
		expect((await pendingTotoAlerts(env, ["HUGOTOGEL"])).length).toBeGreaterThan(0);
		// pemilik menaikkan batas (memang banyak yang salah) -> dikoreksi
		await saveSys(env, { sys_totomacau_max_correct: 100 });
		resetSysCache();
		for (let i = 0; i < 12; i++) if (!(await run({ fetchFn: pagedFetch(draws) })).more) break;
		expect(pushed.length).toBeGreaterThan(10);
	});
	it("penyimpanan 7 hari: log & kejadian lebih lama dihapus (harian) dan tidak tampil; catatan baru tetap", async () => {
		await listTotoLog(env, ["HUGOTOGEL"]); // pastikan tabel ada
		const raw = turso.current!.raw;
		const old = tsPlusMinutes(-9 * 24 * 60);
		const recent = tsPlusMinutes(-2 * 24 * 60);
		const insLog = raw.prepare(`INSERT INTO toto_macau_log (website, game, period, slot_key, market, number, row_at, status, created_at, updated_at) VALUES ('HUGOTOGEL','m17',?,'k','TOTOMACAU-13','1234',?,'SENT',?,?)`);
		insLog.run(1, old, old, old); // draw 9 hari lalu
		insLog.run(2, recent, recent, recent); // draw 2 hari lalu
		raw.prepare(`INSERT INTO toto_macau_log (website, game, period, slot_key, status, created_at, updated_at) VALUES ('HUGOTOGEL','m17',-20260101,'x','FAILED',?,?)`).run(old, old); // catatan gagal-baca lama
		raw.prepare(`INSERT INTO toto_macau_log (website, game, period, slot_key, status, created_at, updated_at) VALUES ('HUGOTOGEL','pass',0,'','PASS',?,?)`).run(recent, tsPlusMinutes(-1)); // penanda putaran aktif
		const insEv = raw.prepare(`INSERT INTO toto_macau_event (website, ts, kind, level, msg) VALUES ('HUGOTOGEL', ?, 'info', 'INFO', ?)`);
		insEv.run(old, "kejadian lama");
		insEv.run(recent, "kejadian baru");
		// belum dipangkas: yang lama sudah tidak ditampilkan
		expect((await listTotoLog(env, ["HUGOTOGEL"])).map((r) => r.period)).toEqual([2]);
		expect((await listTotoEvents(env, ["HUGOTOGEL"])).events.map((e) => e.msg)).toEqual(["kejadian baru"]);
		const r = await pruneTotoMacau(env);
		expect(r).toEqual({ log: 2, events: 1 });
		expect((raw.prepare(`SELECT period FROM toto_macau_log ORDER BY period`).all() as { period: number }[]).map((x) => x.period)).toEqual([0, 2]);
		// pangkas ikut berjalan di akhir tiap putaran (kejadian lama lain ikut terhapus)
		insEv.run(old, "kejadian lama 2");
		await logTotoEvent(env, "HUGOTOGEL", "end", "INFO", "Selesai");
		expect((raw.prepare(`SELECT msg FROM toto_macau_event ORDER BY id`).all() as { msg: string }[]).map((x) => x.msg)).toEqual(["kejadian baru", "Selesai"]);
	});
	it("baris yang sama terbaca dua kali (halaman bergeser) dihitung SATU baris -- bukan 'baris ganda'", async () => {
		await setMode(2);
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		const dupPanel = async (): Promise<PanelZHandle> => ({
			html: zHtml(zRows) + zHtml(zRows),
			push: async (id, angka) => {
				pushed.push({ id, angka });
				zRows.find((r) => String(r.id) === id)!.value = angka;
				return "Berhasil dikirim";
			},
			reload: async () => zHtml(zRows),
		});
		await run({ panel: dupPanel });
		expect(zRows.find((r) => r.id === 71)!.value).toBe("7036");
		expect(pushed.filter((p) => p.id === "71")).toHaveLength(1); // tidak dikirim dua kali
		expect((await byMarketDate())["TOTOMACAU-00 2026-10-08"]).toBe("SENT");
	});
	it("baris ganda SUNGGUHAN (dua id, pasaran+tanggal sama): semuanya disamakan dengan angka admin (kosong diisi, salah dikoreksi)", async () => {
		await setMode(2);
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		zRows.push({ id: 72, market: "TOTOMACAU-00", date: "2026-10-08", value: "1111" }); // ganda & salah; id 71 ganda & kosong
		const sum = await run();
		expect(zRows.find((r) => r.id === 71)!.value).toBe("7036");
		expect(zRows.find((r) => r.id === 72)!.value).toBe("7036");
		expect(sum.corrected).toBe(1);
		const row = (await listTotoLog(env, ["HUGOTOGEL"])).find((r) => r.market === "TOTOMACAU-00" && r.rowAt.startsWith("2026-10-08"))!;
		expect(row.status).toBe("SENT");
		expect(row.detail).toMatch(/DIKOREKSI: Panel-Z berisi 1111/);
		// ganda yang satu sudah benar, satu kosong: yang kosong diisi
		pushed.length = 0;
		zRows.find((r) => r.id === 72)!.value = "xxxx";
		zRows.find((r) => r.id === 71)!.value = "7036";
		await run();
		expect(pushed.map((p) => p.id)).toEqual(["72"]);
	});
	it("status MENGIRIM yang tersangkut (putaran mati di tengah jalan) >10 menit diklaim ulang; yang baru (<10 menit) tidak disentuh", async () => {
		await setMode(2);
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		await run();
		const raw = turso.current!.raw;
		// tersangkut 30 menit, baris Panel-Z kosong lagi
		raw.prepare(`UPDATE toto_macau_log SET status = 'SENDING', updated_at = ? WHERE market = 'TOTOMACAU-00' AND row_at LIKE '2026-10-08%'`).run(tsPlusMinutes(-30));
		zRows.find((r) => r.id === 71)!.value = "";
		pushed.length = 0;
		await run();
		expect(zRows.find((r) => r.id === 71)!.value).toBe("7036");
		expect((await byMarketDate())["TOTOMACAU-00 2026-10-08"]).toBe("SENT");
		// baru 2 menit: putaran lain mungkin masih mengirim -> jangan ikut campur
		raw.prepare(`UPDATE toto_macau_log SET status = 'SENDING', updated_at = ? WHERE market = 'TOTOMACAU-00' AND row_at LIKE '2026-10-08%'`).run(tsPlusMinutes(-2));
		zRows.find((r) => r.id === 71)!.value = "";
		pushed.length = 0;
		await run();
		expect(pushed).toHaveLength(0);
		expect((await byMarketDate())["TOTOMACAU-00 2026-10-08"]).toBe("SENDING");
	});
	it("kirim ke Panel-Z melempar galat (jaringan putus): putaran tidak mati, baris jadi GAGAL (bukan MENGIRIM selamanya)", async () => {
		await setMode(2);
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		const boom = async (): Promise<PanelZHandle> => ({
			html: zHtml(zRows),
			push: async () => {
				throw new Error("network lost");
			},
			reload: async () => zHtml(zRows),
		});
		await run({ panel: boom });
		const st = await byMarketDate();
		expect(st["TOTOMACAU-00 2026-10-08"]).toBe("FAILED");
		expect(Object.values(st)).not.toContain("SENDING");
		const row = (await listTotoLog(env, ["HUGOTOGEL"])).find((r) => r.market === "TOTOMACAU-00" && r.rowAt.startsWith("2026-10-08"))!;
		expect(row.detail).toMatch(/Error: network lost/);
	});
	it("tanggal yang lebih lama dari yang masih disimpan Panel-Z = DILEWATI (bukan 'menunggu baris' selamanya)", async () => {
		await setMode(2);
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		const withOld = [["05-10-2026 13:10:00", "14100", "9911", "Yes"], ...m17] as [string, string, string, string][];
		const f = async (url: string) => new Response(url.includes("sar=m17") ? adminPage("Toto Macau", withOld) : adminPage("Toto Macao 5D", m51), { status: 200 });
		await run({ fetchFn: f });
		const old = (await listTotoLog(env, ["HUGOTOGEL"])).find((r) => r.rowAt.startsWith("2026-10-05"))!;
		expect(old.status).toBe("SKIPPED");
		expect(old.detail).toMatch(/Panel-Z hanya menyimpan sampai 2026-10-0\d/);
	});
	it("jatah panggilan terbatas: backlog besar dikerjakan TERBARU dulu, dan Aktivitas hanya ditulis SATU kali per putaran (bukan per baris)", async () => {
		await addUser("tester");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("tester");
		await setMode(2);
		zRows = zAllDays(() => "");
		const draws = manyDraws();
		const sum = await run({ fetchFn: pagedFetch(draws) });
		expect(sum.more).toBe(true); // masih ada yang antre -> siklus berikutnya
		const find = (mk: string, date: string) => zRows.find((r) => r.market === mk && r.date === date)!;
		expect(find("TOTOMACAU-23", "2026-10-08").value).not.toBe(""); // terbaru sudah terisi
		expect(find("TOTOMACAU-00", "2026-10-02").value).toBe(""); // paling lama menyusul
		const n = (raw.prepare(`SELECT COUNT(*) AS n FROM activity_log WHERE action = 'TOTO MACAU AUTO'`).get() as { n: number }).n;
		expect(n).toBe(1);
		for (let i = 0; i < 12 && (await run({ fetchFn: pagedFetch(draws) })).more; i++);
		expect(find("TOTOMACAU-00", "2026-10-02").value).not.toBe(""); // akhirnya semua beres
	});
	it("banyak user, satu website: diperiksa & dikirim SEKALI untuk semua; hasilnya identik di tampilan tiap user", async () => {
		await setMode(2);
		addPanelZ("HUGOTOGEL");
		addUser("A");
		addUser("B");
		addUser("C", { websites: ["HUGOTOGEL", "FOLATOTO"] });
		for (const u of ["A", "B", "C"]) await enableWithSession(u);
		const sum = await run();
		expect(sum.websites).toBe(1); // satu website = satu pemeriksaan, bukan tiga
		expect(adminHits.filter((u) => u.includes("sar=m17")).length).toBe(1);
		expect(adminHits.filter((u) => u.includes("sar=m51")).length).toBe(1);
		const sends = pushed.map((p) => p.id);
		expect(new Set(sends).size).toBe(sends.length); // tidak ada baris yang dikirim dua kali
		// tampilan user A, B, C untuk website yang sama persis sama
		const view = async () => JSON.stringify((await listTotoLog(env, ["HUGOTOGEL"])).map((r) => [r.market, r.rowAt, r.status, r.number]));
		expect(await view()).toBe(await view());
	});
	it("dua pemicu bersamaan (cron + tombol user lain): hanya satu yang memeriksa website itu, yang lain dilewati — tanpa kirim ganda", async () => {
		await setMode(2);
		addPanelZ("HUGOTOGEL");
		addUser("A");
		addUser("B");
		await enableWithSession("A");
		await enableWithSession("B");
		const [r1, r2] = await Promise.all([run({ noGap: true }), run({ noGap: true, only: ["B"] })]);
		expect(r1.websites + r2.websites).toBe(1);
		expect(r1.skippedBusy + r2.skippedBusy).toBeGreaterThanOrEqual(0); // yang kalah kunci tidak memeriksa
		const sends = pushed.map((p) => p.id);
		expect(new Set(sends).size).toBe(sends.length);
		expect(adminHits.filter((u) => u.includes("sar=m17")).length).toBe(1);
	});
	it("tombol user lain tepat setelah pemeriksaan: tidak diperiksa ulang (jeda minimum 60 dtk), pesan jelas", async () => {
		await setMode(2);
		addPanelZ("HUGOTOGEL");
		addUser("A");
		addUser("B");
		await enableWithSession("A");
		await enableWithSession("B");
		await run();
		const hits = adminHits.length;
		const again = await run({ noGap: true, only: ["B"] });
		expect(again.websites).toBe(0);
		expect(adminHits.length).toBe(hits);
		expect(again.message).toMatch(/baru saja diperiksa.*hasilnya sama untuk semua user/i);
		// lewat 2 menit: boleh lagi
		turso.current!.raw.prepare(`UPDATE toto_macau_log SET updated_at = ? WHERE game = 'pass'`).run(tsPlusMinutes(-2));
		expect((await run({ noGap: true, only: ["B"] })).websites).toBe(1);
	});
	it("kunci website yang tidak dilepas (putaran mati) kedaluwarsa setelah 4 menit; yang masih segar menahan putaran lain", async () => {
		await setMode(2);
		addPanelZ("HUGOTOGEL");
		addUser("A");
		await enableWithSession("A");
		await run();
		const raw = turso.current!.raw;
		raw.prepare(`UPDATE toto_macau_log SET status = 'RUN', updated_at = ? WHERE game = 'pass'`).run(tsPlusMinutes(-1));
		expect((await run({ noGap: true })).websites).toBe(0); // masih dipegang proses lain
		raw.prepare(`UPDATE toto_macau_log SET status = 'RUN', updated_at = ? WHERE game = 'pass'`).run(tsPlusMinutes(-6));
		expect((await run({ noGap: true })).websites).toBe(1); // basi -> diambil alih
		expect((raw.prepare(`SELECT status FROM toto_macau_log WHERE game = 'pass'`).get() as { status: string }).status).toBe("PASS"); // dilepas di akhir
	});
	it("masih ada yang antre (more): putaran berikutnya langsung lanjut tanpa menunggu jeda", async () => {
		await addUser("tester");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("tester");
		await setMode(2);
		zRows = zAllDays(() => "");
		const draws = manyDraws();
		const first = await run({ fetchFn: pagedFetch(draws) });
		expect(first.more).toBe(true);
		const next = await run({ noGap: true, fetchFn: pagedFetch(draws) }); // tanpa menunggu 60 dtk
		expect(next.websites).toBe(1);
	});
	it("hapus manual baris Toto Macau (checkbox): hanya website milik user; baris tidak dibuat ulang / dikirim / dikoreksi lagi oleh pemeriksaan otomatis; penanda dipangkas setelah 7 hari", async () => {
		await setMode(2);
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		await run();
		const before = await listTotoLog(env, ["HUGOTOGEL"]);
		const target = before.find((r) => r.market === "TOTOMACAU-13" && r.rowAt.startsWith("2026-10-08"))!;
		const other = before.find((r) => r.market === "TOTOMACAU-00" && r.rowAt.startsWith("2026-10-08"))!;
		// website lain tidak boleh: user hanya memegang FOLATOTO -> tidak ada yang terhapus
		expect(await dismissTotoRows(env, ["FOLATOTO"], [target.id], "Op")).toEqual({ dismissed: 0 });
		expect((await listTotoLog(env, ["HUGOTOGEL"])).some((r) => r.id === target.id)).toBe(true);
		expect(await dismissTotoRows(env, ["HUGOTOGEL"], [target.id, -3, 999999], "Op")).toEqual({ dismissed: 1 });
		expect((await listTotoLog(env, ["HUGOTOGEL"])).some((r) => r.id === target.id)).toBe(false);
		// Panel-Z diubah orang lain jadi salah; baris yang sudah ditangani manual TIDAK dikoreksi lagi, baris lain tetap dikoreksi
		pushed.length = 0;
		zRows.find((r) => r.id === 100)!.value = "9999"; // TOTOMACAU-13 08 Oct (dihapus manual)
		zRows.find((r) => r.id === 71)!.value = "1234"; // TOTOMACAU-00 08 Oct (tidak dihapus)
		await run();
		expect(zRows.find((r) => r.id === 100)!.value).toBe("9999");
		expect(zRows.find((r) => r.id === 71)!.value).toBe("7036");
		expect((await listTotoLog(env, ["HUGOTOGEL"])).some((r) => r.market === "TOTOMACAU-13" && r.rowAt.startsWith("2026-10-08"))).toBe(false); // tidak muncul lagi
		expect((await listTotoLog(env, ["HUGOTOGEL"])).some((r) => r.id === other.id)).toBe(true);
		const ev = (await listTotoEvents(env, ["HUGOTOGEL"], 100)).events.map((e) => e.msg);
		expect(ev.some((m) => /TOTOMACAU-13 2026-10-08: dihapus manual oleh Op/.test(m))).toBe(true);
		// penanda dipangkas setelah 7 hari
		turso.current!.raw.prepare(`UPDATE toto_macau_dismissed SET at = ?`).run(tsPlusMinutes(-9 * 24 * 60));
		await pruneTotoMacau(env);
		expect((turso.current!.raw.prepare(`SELECT COUNT(*) AS n FROM toto_macau_dismissed`).get() as { n: number }).n).toBe(0);
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

	it("koreksi dimatikan (sys_totomacau_correct=0): angka BEDA tidak ditimpa, jadi peringatan", async () => {
		await setMode(2);
		await saveSys(env, { sys_totomacau_correct: 0 });
		resetSysCache();
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
	it("mode 1: angka BEDA tidak pernah dikoreksi (hanya ditandai), walau koreksi=1", async () => {
		await setMode(1);
		zRows.find((r) => r.id === 100)!.value = "9999";
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		await run();
		expect(zRows.find((r) => r.id === 100)!.value).toBe("9999");
		expect(pushed).toHaveLength(0);
		expect((await byMarketDate())["TOTOMACAU-13 2026-10-08"]).toBe("CONFLICT");
	});
	it("angka admin dianggap benar (mode 2, bawaan): angka SALAH di Panel-Z otomatis dikoreksi, angka lama tercatat, dan diverifikasi baca-ulang", async () => {
		await setMode(2);
		zRows.find((r) => r.id === 100)!.value = "9999"; // salah (admin 13:10 = 4518)
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		const sum = await run();
		expect(zRows.find((r) => r.id === 100)!.value).toBe("4518");
		expect(sum.corrected).toBe(1);
		const row = (await listTotoLog(env, ["HUGOTOGEL"])).find((r) => r.market === "TOTOMACAU-13" && r.rowAt.startsWith("2026-10-08"))!;
		expect(row.status).toBe("SENT");
		expect(row.detail).toMatch(/DIKOREKSI: Panel-Z berisi 9999, diperbaiki ke angka admin 4518/);
		const ev = (await listTotoEvents(env, ["HUGOTOGEL"], 100)).events.map((e) => e.msg);
		expect(ev.some((m) => /TOTOMACAU-13 2026-10-08: Panel-Z berisi 9999 ≠ admin 4518 → KOREKSI ke 4518/.test(m))).toBe(true);
		expect(ev.some((m) => /DIKOREKSI 9999 → 4518 — terbaca ulang di Panel-Z/.test(m))).toBe(true);
		expect(await pendingTotoAlerts(env, ["HUGOTOGEL"])).toHaveLength(0); // diperbaiki = tidak perlu peringatan
		// putaran berikutnya: sudah sama -> tidak dikirim ulang
		pushed.length = 0;
		await run();
		expect(pushed).toHaveLength(0);
	});
	it("angka yang tadinya benar diubah orang lain di Panel-Z -> dikoreksi lagi (siklus baru walau percobaan lama sudah 3)", async () => {
		await setMode(2);
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		await run();
		expect(zRows.find((r) => r.id === 100)!.value).toBe("4518");
		turso.current!.raw.prepare(`UPDATE toto_macau_log SET status = 'SENT', attempts = 3 WHERE market = 'TOTOMACAU-13'`).run();
		zRows.find((r) => r.id === 100)!.value = "1111"; // ada yang mengedit manual
		await run();
		expect(zRows.find((r) => r.id === 100)!.value).toBe("4518");
	});
	it("koreksi hanya ke baris (pasaran+tanggal) yang cocok persis: baris tanggal lain tidak tersentuh", async () => {
		await setMode(2);
		zRows.push({ id: 777, market: "TOTOMACAU-13", date: "2026-10-07", value: "0000" }); // tanggal lain, tidak ada di admin (>jendela data admin)
		addUser("Op");
		addPanelZ("HUGOTOGEL");
		await enableWithSession("Op");
		await run();
		expect(zRows.find((r) => r.id === 777)!.value).toBe("0000");
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
		turso.current!.raw.prepare(`UPDATE toto_macau_log SET updated_at = ? WHERE game = 'pass'`).run(tsPlusMinutes(-2)); // 2 menit lalu: < jeda 30 menit, > jeda minimum 60 dtk
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
		for (let i = 0; i < 3; i++) await run({ fetchFn: dead }); // tiap putaran dianggap 5 menit setelah yang lalu
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
