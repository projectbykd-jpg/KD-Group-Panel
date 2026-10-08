import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { autoInputAfterSend, autoInputRetryTick, runQueuedJob, type AutoInputNotice } from "../src/api/auto-input";
import { claimJob, parseCookieInput, adminBaseProblem, defaultAdminBase, clearRetryable, resetAutoInputTablesFlag, getSessions, listJobs, parsePhpSessId, parseResultDate, planAutoInput, saveSession, setEnabled } from "../src/lib/auto-input";
import { frameSources, parseAngkaPage, readTopRow, parseHitungPage, runAutoInput, buildPayload, parseForms } from "../src/lib/auto-input-run";
import { processText } from "../src/lib/parser";
import { fakeD1, fakeEnv } from "./helpers/fake-env";
import type { UserProfile } from "../src/lib/db";

// Nilai sesi PALSU untuk test -- jangan pernah menaruh PHPSESSID asli di repo.
const SID1 = "FAKEsession000000000000001";
const SID2 = "FAKEsession000000000000002";

const RAW = `Hasil Pengeluaran Pasaran FLORIDAEVE
Hari Selasa , 06 October 2026

Prize 1 : 9808
Shio : BABI

Selamat kepada para pemenang jackpot`;

const plan = () => {
	const p = planAutoInput(RAW, processText(RAW));
	if (!p.ok) throw new Error(p.reason);
	return p;
};

// ---- situs admin tiruan (bentuk mengikuti screenshot) ----
interface SiteOpts {
	market?: string;
	formDay?: number;
	prizeCols?: number;
	ignoreKirimPost?: boolean;
	hitungShows?: string; // angka yang ditampilkan halaman Hitung
	prefilled?: boolean;
	lastPeriod?: number;
	formPeriod?: number; // periode yang tampil di form (default: terakhir + 1)
	lastDate?: string;
	expired?: boolean;
	hitungNomorField?: string; // nilai hidden field `nomor` di form Hitung (default: angka pertama)
}
function mockSite(o: SiteOpts = {}) {
	const market = o.market ?? "FLORIDAEVE";
	const code = "p21545";
	const cols = o.prizeCols ?? 1;
	const rows = [{ period: o.lastPeriod ?? 1629, date: o.lastDate ?? "05-10-2026 08:52:09", nums: ["7283", "1111", "2222"].slice(0, cols) }];
	const st = { calc: false, posts: [] as { path: string; search: string; body: URLSearchParams; cookie: string }[], calcPosts: 0 };
	const nextPeriod = () => rows[0].period + 1;
	const opt = (n: number, sel: number) => Array.from({ length: n }, (_, i) => `<option value="${i + 1}"${i + 1 === sel ? " selected" : ""}>${i + 1}</option>`).join("");
	const angka = () => `<html><body><div>Agent (fakeagent)</div>
<select style="width:100%" onchange="gantipasar(this.value)"><option>Pilih Pasar</option>
<option value="ARIZONA,p33190">ARIZONA</option><option value="${market},${code}">${market}</option>
<option style="display:none;" id="paramp21545" value="pool-14-0-1-"></option></select>
<h2>Silahkan isi Angka baru ${market}</h2>
<form method="post" action="admin_angka13.php?psr=${code}">Tanggal
<select name="tgl">${opt(31, o.formDay ?? 6)}</select><select name="bln">${opt(12, 10)}</select>
<select name="thn"><option value="2025">2025</option><option value="2026" selected>2026</option></select>
Periode <input type="text" name="periode" value="${o.formPeriod ?? nextPeriod()}">
Nomor Keluar ${Array.from({ length: cols }, (_, i) => `<input type="text" name="${i === 0 ? "angka" : "angka" + (i + 1)}" maxlength="4" value="${o.prefilled ? "1234" : ""}">`).join("")}
<input type="hidden" name="psr" value="${code}">
<input name="cmdsend" type="button" onclick="return myFunction('${market}');" value="&nbsp;Kirim&nbsp;">
<input type="submit" name="cmdhapus" value="Hapus"></form>
<h3>Daftar  Nomor ${market}</h3><table><tr><th>No</th><th>Tanggal</th><th>Hari</th><th>Periode</th>${Array.from({ length: cols }, (_, i) => `<th>Nomor Keluar ${i + 1}</th>`).join("")}<th>Hitung</th></tr>
${rows.map((r, i) => `<tr><td>${i + 1}</td><td><input value="${r.date}"><input type="button" value="E"></td><td>Senin</td><td>${r.period}</td>${r.nums.map((n) => `<td><input value="${n}"></td>`).join("")}<td>Yes</td></tr>`).join("")}
</table></body></html>`;
	const hitung = () =>
		`<html><body><select onchange="gantipasar(this.value)"><option value="${market},${code}">${market}</option></select>
(vldaa) TOTO Periode : ${rows[0].period} - ${market} - (${code}) Terdapat Invoice Pemenang : 0 Nomor Keluar : ${o.hitungShows ?? rows[0].nums[0]}
${st.calc ? "" : `<form method="post" action="admin_hitungtimte.php?psr=${code}"><input type="hidden" name="per" value="${rows[0].period}"><input type="hidden" name="nomor" value="${o.hitungNomorField ?? rows[0].nums[0]}"><input type="hidden" name="sar" value="${code}"><input type="submit" name="cmdhitung" id="xxx" onclick="hilang()" value="Hitung Periode : ${rows[0].period} - ${market}"></form>`}</body></html>`;
	const fetchFn = async (url: string, init?: RequestInit) => {
		const path = new URL(url).pathname.replace(/^\//, "");
		const html = (b: string, status = 200) => new Response(b, { status });
		if (o.expired) return new Response("", { status: 302, headers: { location: "login.php" } });
		if (!String(init?.headers && (init.headers as Record<string, string>).Cookie).includes("PHPSESSID=")) return html("no cookie", 403);
		const isPost = init?.method === "POST";
		const body = isPost ? new URLSearchParams(String(init!.body)) : new URLSearchParams();
		if (path === "index.php") return html(angka());
		if (path === "admin_angka13.php") {
			if (isPost) {
				st.posts.push({ path, search: new URL(url).search, body, cookie: String((init!.headers as Record<string, string>).Cookie) });
				if (!o.ignoreKirimPost && body.get("periode") === String(nextPeriod())) {
					const nums = Array.from({ length: cols }, (_, i) => body.get(i === 0 ? "angka" : "angka" + (i + 1)) ?? "");
					rows.unshift({ period: nextPeriod(), date: "06-10-2026 21:00:00", nums });
				}
			}
			return html(angka());
		}
		if (path === "admin_hitungtimte.php") {
			if (isPost) {
				st.posts.push({ path, search: new URL(url).search, body, cookie: String((init!.headers as Record<string, string>).Cookie) });
				st.calcPosts++;
				st.calc = true;
				return new Response("", { status: 302, headers: { location: "admin_hitungtimte.php?psr=" + code } });
			}
			return html(hitung());
		}
		return html("404", 404);
	};
	return { fetchFn, st, rows };
}
const sess = { website: "HUGOTOGEL", baseUrl: "https://ag.suksesbogil.com/", phpsessid: SID1 };

describe("pembantu murni", () => {
	it("parsePhpSessId menerima bentuk salin dari Chrome & menolak sampah", () => {
		expect(parsePhpSessId("PHPSESSID=" + SID1)).toBe(SID1);
		expect(parsePhpSessId(`a=1; PHPSESSID=${SID2}; x=2`)).toBe(SID2);
		expect(parsePhpSessId(SID1)).toBe(SID1);
		expect(parsePhpSessId("rusak")).toBe("");
		expect(parseCookieInput(SID1)).toBe("PHPSESSID=" + SID1);
		expect(parseCookieInput(`Cookie: PHPSESSID=${SID1}; lastuser=fakeagent; fakeagent=HUGOTOGEL.COM; fakeagentkoderedis=952`)).toBe(
			`PHPSESSID=${SID1}; lastuser=fakeagent; fakeagent=HUGOTOGEL.COM; fakeagentkoderedis=952`,
		);
		expect(parseCookieInput("lastuser=a; b=c")).toBe(""); // tanpa PHPSESSID
		expect(parseCookieInput(`PHPSESSID=${SID1}; x=1\r\nHost: evil`)).toBe(""); // header injection
		expect(parseCookieInput(`PHPSESSID=${SID1}; x=<script>`)).toBe("");
		expect(parsePhpSessId("PHPSESSID=<script>")).toBe("");
	});
	it("parseResultDate: Inggris & Indonesia, tanggal ngawur ditolak", () => {
		expect(parseResultDate("Hari Selasa , 06 October 2026")).toBe("2026-10-06");
		expect(parseResultDate("Senin, 5 Oktober 2026")).toBe("2026-10-05");
		expect(parseResultDate("31 February 2026")).toBeNull();
		expect(parseResultDate("tanpa tanggal")).toBeNull();
	});
	it("planAutoInput: konservatif", () => {
		expect(plan()).toMatchObject({ market: "FLORIDAEVE", date: "2026-10-06", prizes: ["9808"] });
		const bad = (t: string) => planAutoInput(t, processText(t));
		expect(bad(RAW.replace("Shio : BABI", "Shio : NAGA"))).toMatchObject({ ok: false });
		expect(bad(RAW.replace(/Hari.*\n/, ""))).toMatchObject({ ok: false });
		expect(bad(RAW.replace("FLORIDAEVE", "TOTOMACAU-19"))).toMatchObject({ ok: false });
		expect(bad("Pasaran X\nPrize 1 : 12")).toMatchObject({ ok: false });
		const three = RAW.replace("Prize 1 : 9808", "Prize 1 : 9808\nPrize 2 : 1234\nPrize 3 : 5678");
		expect(bad(three)).toMatchObject({ ok: true, prizes: ["9808", "1234", "5678"] });
		expect(bad(RAW.replace("Prize 1 : 9808", "Prize 1 : 9808\nPrize 3 : 5678"))).toMatchObject({ ok: false });
	});
});

describe("parseAngkaPage", () => {
	const html = async (o?: SiteOpts) => (await mockSite(o).fetchFn("https://x/admin_angka13.php", { headers: { Cookie: "PHPSESSID=x" } })).text();
	it("halaman normal lolos", async () => {
		const p = parseAngkaPage(await html(), plan());
		expect(p).toMatchObject({ period: 1630, prizeFields: ["angka"], prev: { period: 1629, date: "2026-10-05", numbers: ["7283"] } });
	});
	it.each<[string, SiteOpts, RegExp]>([
		["pasaran beda", { market: "OSAKA" }, /Pasaran di halaman/],
		["tanggal form beda", { formDay: 7 }, /Tanggal form/],
		["periode loncat", { formPeriod: 1635 }, /Periode form/],
		["kolom sudah terisi", { prefilled: true }, /sudah terisi/],
		["baris terakhir sudah hari ini", { lastDate: "06-10-2026 08:00:00" }, /sudah terinput/],
		["butuh 3 angka, teks cuma 1 prize", { prizeCols: 3 }, /butuh 3 angka/],
	])("tolak: %s", async (_n, o, re) => {
		const h = await html(o);
		expect(() => parseAngkaPage(h, plan())).toThrow(re);
	});
	it("3 prize di teks untuk 3 kolom", async () => {
		const t = RAW.replace("Prize 1 : 9808", "Prize 1 : 9808\nPrize 2 : 1234\nPrize 3 : 5678");
		const p = planAutoInput(t, processText(t));
		if (!p.ok) throw new Error(p.reason);
		expect(parseAngkaPage(await html({ prizeCols: 3 }), p).prizeFields).toEqual(["angka", "angka2", "angka3"]);
	});
});

describe("tabel Daftar Nomor dengan HTML 'liar' (tag tidak ditutup, judul di dalam tabel)", () => {
	const messy = (rows: string) => `<h1>Silahkan isi Angka baru LAOS MALAM</h1>
<table><tr><td colspan=9><b>Daftar&nbsp; Nomor LAOS MALAM</b>
<tr bgcolor=#6600ff><td>No<td>Tanggal<td>Hari<td>Periode<td>Nomor Keluar 1<td>Nomor Keluar 2<td>Nomor Keluar 3<td>Hitung<td>
${rows}</table>`;
	it("baca baris teratas dari teks", () => {
		const html = messy(`<tr bgcolor=#00cc33><td>1<td><input value="05-10-2026 &nbsp;23:30:35" size=20><input type=button value="E"><td>Senin<td>80<td><input value="7830"><td><input value="4918"><td><input value="0285"><td>Yes
<tr><td>2<td><input value="04-10-2026 23:31:28"><input type=button value="E"><td>Minggu<td>79<td><input value="3392"><td><input value="1829"><td><input value="0295"><td>Yes`);
		expect(readTopRow(html)).toEqual({ period: 80, date: "2026-10-05", numbers: ["7830", "4918", "0285"] });
	});
	it("satu kolom nomor (FLORIDAEVE) juga terbaca & angka berawalan 0 dipertahankan", () => {
		const html = `<b>Daftar Nomor X</b><table><tr><td>No<td>Tanggal<td>Hari<td>Periode<td>Nomor Keluar 1<td>Hitung
<tr><td>1<td><input value="05-10-2026 08:52:09"><input type=button value="E"><td>Senin<td>1629<td><input value="0283"><td>Yes`;
		expect(readTopRow(html)).toEqual({ period: 1629, date: "2026-10-05", numbers: ["0283"] });
	});
	it("kalau tetap tak terbaca, pesan error menunjukkan apa yang terbaca", () => {
		const html = `<h2>Silahkan isi Angka baru FLORIDAEVE</h2>` + "x";
		expect(readTopRow(html)).toBeNull();
	});
});

describe("runAutoInput", () => {
	it("uji kering: validasi lolos, TIDAK ada POST", async () => {
		const m = mockSite();
		const r = await runAutoInput({ session: sess, plan: plan(), dryRun: true, fetchFn: m.fetchFn });
		expect(r.ok).toBe(true);
		expect(m.st.posts).toHaveLength(0);
		expect(r.preview).toMatchObject({ code: "p21545", post: "admin_angka13.php", fields: { angka: "9808", periode: "1630", psr: "p21545" } });
	});
	it("anggaran request: satu website penuh memakai <= 14 fetch (batas Worker gratis 50 per panggilan)", async () => {
		const m = mockSite();
		let n = 0;
		const f = async (u: string, i?: RequestInit) => (n++, m.fetchFn(u, i));
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: f });
		expect(r.ok).toBe(true);
		expect(n).toBeLessThanOrEqual(14);
	});
	it("alur penuh: Kirim -> verifikasi -> Hitung; payload membawa field tersembunyi & TIDAK membawa Hapus", async () => {
		const m = mockSite();
		const stages: string[] = [];
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: m.fetchFn, onStage: async (s) => void stages.push(s) });
		expect(r).toMatchObject({ ok: true, stage: "selesai", period: "1630" });
		expect(stages).toEqual(["kirim", "hitung"]);
		// Persis request asli browser: POST tanpa query, field form + psr, tanpa nilai tombol Kirim.
		expect(m.st.posts[0]).toMatchObject({ path: "admin_angka13.php", search: "" });
		expect(Object.fromEntries(m.st.posts[0].body)).toEqual({ tgl: "6", bln: "10", thn: "2026", periode: "1630", angka: "9808", psr: "p21545" });
		expect(m.st.posts[1]).toMatchObject({ path: "admin_hitungtimte.php", search: "" });
		expect(Object.fromEntries(m.st.posts[1].body)).toEqual({ per: "1630", nomor: "9808", sar: "p21545", cmdhitung: "Hitung Periode : 1630 - FLORIDAEVE" });
		expect(m.st.calcPosts).toBe(1);
	});
	it("Kirim tak berefek -> berhenti di tahap kirim TANPA kirim ulang, Hitung TIDAK dijalankan", async () => {
		const m = mockSite({ ignoreKirimPost: true });
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: m.fetchFn });
		expect(r).toMatchObject({ ok: false, stage: "kirim" });
		expect(m.st.posts).toHaveLength(1);
		expect(m.st.calcPosts).toBe(0);
	});
	it("3 prize (BERLIN): angka/angka2/angka3; Hitung cukup menunjukkan angka pertama (field nomor)", async () => {
		const t = RAW.replace("Prize 1 : 9808", "Prize 1 : 4480\nPrize 2 : 2896\nPrize 3 : 6109");
		const p = planAutoInput(t, processText(t));
		if (!p.ok) throw new Error(p.reason);
		const m = mockSite({ prizeCols: 3 });
		const r = await runAutoInput({ session: sess, plan: p, fetchFn: m.fetchFn });
		expect(r).toMatchObject({ ok: true, stage: "selesai" });
		expect(Object.fromEntries(m.st.posts[0].body)).toMatchObject({ angka: "4480", angka2: "2896", angka3: "6109", periode: "1630", psr: "p21545" });
		expect(m.st.posts[1].body.get("nomor")).toBe("4480");
	});
	it("field tersembunyi form Hitung tidak cocok (nomor) -> Hitung TIDAK dijalankan", async () => {
		const m = mockSite({ hitungNomorField: "1111" });
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: m.fetchFn });
		expect(r).toMatchObject({ ok: false, stage: "hitung" });
		expect(r.detail).toMatch(/field nomor/);
		expect(m.st.calcPosts).toBe(0);
	});
	it("seluruh cookie tersimpan dikirim apa adanya (bukan cuma PHPSESSID)", async () => {
		const m = mockSite();
		const full = `PHPSESSID=${SID1}; lastuser=fakeagent; fakeagent=HUGOTOGEL.COM; fakeagentkoderedis=123`;
		await runAutoInput({ session: { ...sess, phpsessid: full }, plan: plan(), fetchFn: m.fetchFn });
		expect(m.st.posts[0].cookie).toBe(full);
	});
	it("halaman Hitung menampilkan angka lain -> Hitung TIDAK dijalankan", async () => {
		const m = mockSite({ hitungShows: "1111" });
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: m.fetchFn });
		expect(r).toMatchObject({ ok: false, stage: "hitung" });
		expect(r.detail).toMatch(/tidak cocok/);
		expect(m.st.calcPosts).toBe(0);
	});
	it("sesi habis -> gagal di tahap cek (aman diulang)", async () => {
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: mockSite({ expired: true }).fetchFn });
		expect(r.stage).toBe("cek");
		expect(r.ok).toBe(false);
	});
	it("pasaran tak ada di dropdown", async () => {
		const r = await runAutoInput({ session: sess, plan: { ...plan(), market: "NARNIA" }, fetchFn: mockSite().fetchFn });
		expect(r).toMatchObject({ ok: false, stage: "cek" });
	});
	it("buildPayload tidak pernah menyertakan tombol Hapus", () => {
		const f = parseForms(`<form><input name="a" value="1"><input type="submit" name="cmdhapus" value="Hapus"></form>`)[0];
		expect([...buildPayload(f, {})]).toEqual([["a", "1"]]);
	});
	it("parseHitungPage membaca periode/pasaran/kode/angka", async () => {
		const h = await (await mockSite().fetchFn("https://x/admin_hitungtimte.php", { headers: { Cookie: "PHPSESSID=x" } })).text();
		expect(parseHitungPage(h)).toMatchObject({ period: 1629, market: "FLORIDAEVE", code: "p21545", numbers: ["7283"] });
	});
});

describe("URL admin hanya tiga host yang diizinkan", () => {
	it("kode singkat panel (HUGO / FOLA / SOHO) sama dengan nama panjangnya", () => {
		expect(adminBaseProblem("HUGO", "https://ag.suksesbogil.com/")).toBeNull();
		expect(adminBaseProblem("FOLA", "https://agwl12.suksesbogil.com/")).toBeNull();
		expect(adminBaseProblem("SOHO", "https://agwl5.suksesbogil.com/")).toBeNull();
		expect(adminBaseProblem("hugo", "https://ag.suksesbogil.com/")).toBeNull();
		expect(adminBaseProblem("HUGO", "https://agwl12.suksesbogil.com/")).toMatch(/harus memakai/);
		expect(adminBaseProblem("FOLA", "https://ag.suksesbogil.com/")).toMatch(/harus memakai/);
		expect(adminBaseProblem("SENJA", "https://ag.suksesbogil.com/")).toBeNull();
		expect(defaultAdminBase("HUGO")).toBe("https://ag.suksesbogil.com/");
		expect(defaultAdminBase("SOHO")).toBe("https://agwl5.suksesbogil.com/");
	});
	it("website HUGO (kode singkat) lolos", async () => {
		const m = mockSite();
		const r = await runAutoInput({ session: { ...sess, website: "HUGO" }, plan: plan(), dryRun: true, fetchFn: m.fetchFn });
		expect(r.ok).toBe(true);
	});
	it("tiap website dikunci ke server-nya sesuai daftar pemilik panel", () => {
		const ok = (w: string, u: string) => adminBaseProblem(w, u);
		const AG = "https://ag.suksesbogil.com/", W5 = "https://agwl5.suksesbogil.com/", W12 = "https://agwl12.suksesbogil.com/";
		for (const w of ["AXIS", "DODO", "XO", "SENJA", "HUGO", "RETRO"]) {
			expect(ok(w, AG)).toBeNull();
			expect(ok(w, W5)).toMatch(/harus memakai ag\.suksesbogil\.com/);
			expect(ok(w, W12)).toMatch(/harus memakai/);
		}
		for (const w of ["LIMA", "SOHO"]) {
			expect(ok(w, W5)).toBeNull();
			expect(ok(w, AG)).toMatch(/harus memakai agwl5/);
		}
		for (const w of ["YEL", "FOLA"]) {
			expect(ok(w, W12)).toBeNull();
			expect(ok(w, AG)).toMatch(/harus memakai agwl12/);
		}
		// nama panjang & huruf kecil dikenali sama
		expect(ok("HUGOTOGEL", AG)).toBeNull();
		expect(ok("senjatogel", AG)).toBeNull();
		expect(ok("FOLATOTO", W12)).toBeNull();
		expect(ok("SOHOTOGEL", AG)).toMatch(/harus memakai agwl5/);
		// kode yang belum ada di daftar (REMBO, HELEN, baru) bebas di *.suksesbogil.com
		expect(ok("REMBO", "https://agwl9.suksesbogil.com/")).toBeNull();
		// domain lain / skema tidak aman tetap ditolak, untuk semua
		expect(ok("SENJA", "https://evil.example.com/")).toMatch(/bukan admin yang diizinkan/);
		expect(ok("REMBO", "https://ag.suksesbogil.com.evil.com/")).toMatch(/bukan admin yang diizinkan/);
		expect(ok("REMBO", "https://evilsuksesbogil.com/")).toMatch(/bukan admin yang diizinkan/);
		expect(ok("SENJA", "http://ag.suksesbogil.com/")).toMatch(/https/);
		// URL terisi otomatis
		expect(defaultAdminBase("XO")).toBe(AG);
		expect(defaultAdminBase("LIMA")).toBe(W5);
		expect(defaultAdminBase("YEL")).toBe(W12);
		expect(defaultAdminBase("REMBO")).toBe("");
	});
	it("cookie milik website lain di host yang sama ditolak bila nama website terbaca di sidebar", async () => {
		const m = mockSite();
		const withBrand = (brand: string) => async (u: string, i?: RequestInit) =>
			new Response((await (await m.fetchFn(u, i)).text()).replace("Agent (fakeagent)", `Agent (fakeagent) ${brand}.COM`));
		const dry = (website: string, brand: string) => runAutoInput({ session: { ...sess, website }, plan: plan(), dryRun: true, fetchFn: withBrand(brand) });
		// SENJA di host bersama, tapi cookie-nya milik HUGOTOGEL -> berhenti
		expect(await dry("SENJA", "HUGOTOGEL")).toMatchObject({ ok: false, stage: "cek" });
		expect((await dry("SENJA", "HUGOTOGEL")).detail).toMatch(/milik HUGOTOGEL\.COM.*bukan SENJATOGEL/);
		// cookie yang benar lolos, dan nama website ikut ditampilkan
		const good = await dry("SENJA", "SENJATOGEL");
		expect(good.ok).toBe(true);
		expect(good.detail).toMatch(/di SENJATOGEL\.COM/);
		// nama website tidak terbaca (cookie hanya PHPSESSID) -> tidak menghalangi, agen tetap ditampilkan
		const bare = await runAutoInput({ session: { ...sess, website: "SENJA" }, plan: plan(), dryRun: true, fetchFn: mockSite().fetchFn });
		expect(bare.ok).toBe(true);
		expect(bare.detail).toMatch(/login sebagai \(fakeagent\)/);
	});
	it("saveSession menolak host salah & mengisi default kalau URL kosong", async () => {
		turso.current = fakeD1([]);
		resetAutoInputTablesFlag();
		const env = fakeEnv().env;
		await expect(saveSession(env, "Op", "HUGOTOGEL", "https://agwl12.suksesbogil.com", SID1)).rejects.toThrow(/harus memakai/);
		await expect(saveSession(env, "Op", "HUGOTOGEL", "https://evil.example.com", SID1)).rejects.toThrow(/bukan admin yang diizinkan/);
		await saveSession(env, "Op", "FOLATOTO", "", SID2);
		expect((await getSessions(env, "Op"))[0].baseUrl).toBe("https://agwl12.suksesbogil.com/");
	});
	it("URL tersimpan yang melenceng ditolak saat dijalankan (tidak ada request sama sekali)", async () => {
		let hits = 0;
		const r = await runAutoInput({ session: { ...sess, baseUrl: "https://agwl12.suksesbogil.com/" }, plan: plan(), fetchFn: async () => (hits++, new Response("")) });
		expect(r).toMatchObject({ ok: false, stage: "cek" });
		expect(hits).toBe(0);
	});
	it("index.php berupa FRAMESET (judul 'Administration'): sidebar & dropdown dibaca dari frame", async () => {
		const m = mockSite();
		const f = async (u: string, i?: RequestInit) => {
			const path = new URL(u).pathname;
			if (path === "/index.php") {
				return new Response('<html><head><title>Administration</title></head><frameset cols="170,*"><frame src="menu.php" name="l"><frame src="/over.php?x=1" name="r"><frame src="https://evil.example/x.php"></frameset></html>');
			}
			if (path === "/menu.php") return mockSite().fetchFn("https://ag.suksesbogil.com/index.php", i);
			if (path === "/over.php") return new Response("<html>OVERVIEW</html>");
			return m.fetchFn(u, i);
		};
		const r = await runAutoInput({ session: sess, plan: plan(), dryRun: true, fetchFn: f });
		expect(r.ok).toBe(true);
		expect(frameSources('<frame src="a.php"><IFRAME src=\'/b.php?q=1\'><frame src="https://x.com/c.php"><frame src="javascript:void(0)">', "https://ag.suksesbogil.com/index.php")).toEqual(["a.php", "b.php?q=1"]);
	});
	it("halaman yang diterima server ikut dilaporkan (status, redirect, judul, isi) saat bukan halaman admin", async () => {
		let n = 0;
		const f = async (u: string) =>
			n++ === 0
				? new Response("", { status: 302, headers: { location: "main.php?x=1" } })
				: new Response("<html><head><title>Akses Ditolak</title></head><body>IP anda tidak diizinkan</body></html>");
		const r = await runAutoInput({ session: sess, plan: plan(), dryRun: true, fetchFn: f });
		expect(r).toMatchObject({ ok: false, stage: "cek" });
		expect(r.detail).toMatch(/HTTP 200/);
		expect(r.detail).toMatch(/302 -> \/main\.php\?x=1/);
		expect(r.detail).toMatch(/Akses Ditolak/);
		expect(r.detail).toMatch(/IP anda tidak diizinkan/);
	});
	it("belum login (tidak ada sidebar 'Agent (...)') -> berhenti di tahap cek, tanpa menyentuh apa pun", async () => {
		const m = mockSite();
		const f = async (u: string, i?: RequestInit) => new Response((await (await m.fetchFn(u, i)).text()).replace("Agent (fakeagent)", "Silakan login"));
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: f });
		expect(r).toMatchObject({ ok: false, stage: "cek" });
		expect(r.detail).toMatch(/tidak dianggap sedang login/);
		expect(m.st.posts).toHaveLength(0);
	});
	it("login terdeteksi walau teks nama website (HUGOTOGEL.COM) tidak ada -- cookie hanya PHPSESSID", async () => {
		const r = await runAutoInput({ session: sess, plan: plan(), dryRun: true, fetchFn: mockSite().fetchFn });
		expect(r.ok).toBe(true);
		expect(r.detail).toMatch(/login sebagai \(fakeagent\)/);
	});
});

describe("autoInputAfterSend (DB)", () => {
	let env: Env;
	const profile = { username: "Op", role: "OPERATOR", websites: ["HUGOTOGEL", "FOLATOTO"], menus: null } as unknown as UserProfile;
	beforeEach(() => {
		turso.current = fakeD1([]);
		resetAutoInputTablesFlag();
		env = fakeEnv().env;
	});
	/** Seperti browser: afterSend membuat job, lalu tiap ANTRI dijalankan lewat panggilan TERPISAH. */
	const go = async (m: ReturnType<typeof mockSite>, text = RAW, sites = ["HUGOTOGEL"]): Promise<AutoInputNotice | undefined> => {
		const n = await autoInputAfterSend(env, profile, text, processText(text), sites);
		if (!n) return n;
		const results: AutoInputNotice["results"] = [];
		for (const r of n.results) {
			if (r.status === "ANTRI") {
				const o = await runQueuedJob(env, "Op", r.jobId!, m.fetchFn);
				results.push({ ...o });
			} else results.push(r);
		}
		return { ...n, results };
	};
	const withSession = () => saveSession(env, "Op", "HUGOTOGEL", "https://ag.suksesbogil.com", "PHPSESSID=" + SID1);

	it("saklar OFF (default) -> tidak melakukan apa pun", async () => {
		const m = mockSite();
		await withSession();
		expect(await go(m)).toBeUndefined();
		expect(m.st.posts).toHaveLength(0);
	});
	it("ON + sesi ada -> jalan sekali; klik ulang tidak dobel", async () => {
		const m = mockSite();
		await setEnabled(env, "Op", true);
		await withSession();
		expect((await go(m))?.results[0]).toMatchObject({ website: "HUGOTOGEL", status: "BERHASIL" });
		expect((await go(m))?.results[0].status).toBe("SUDAH");
		expect(m.st.calcPosts).toBe(1);
		expect((await listJobs(env, "Op"))[0]).toMatchObject({ status: "DONE", stage: "selesai", period: "1630" });
	});
	it("website tanpa PHPSESSID dilewati (manual), website lain tetap jalan", async () => {
		const m = mockSite();
		await setEnabled(env, "Op", true);
		await withSession();
		const r = await go(m, RAW, ["HUGOTOGEL", "FOLATOTO"]);
		expect(r?.results.map((x) => x.status)).toEqual(["BERHASIL", "DILEWATI"]);
	});
	it("shio salah -> dilewati dengan alasan, tidak menyentuh situs", async () => {
		const m = mockSite();
		await setEnabled(env, "Op", true);
		const r = await go(m, RAW.replace("BABI", "NAGA"));
		expect(r?.skippedReason).toMatch(/Shio/);
		expect(m.st.posts).toHaveLength(0);
	});
	it("gagal di tahap kirim tercatat FAILED & tidak bisa diulang otomatis", async () => {
		const m = mockSite({ ignoreKirimPost: true });
		await setEnabled(env, "Op", true);
		await withSession();
		expect((await go(m))?.results[0]).toMatchObject({ status: "GAGAL", manual: true });
		const j = (await listJobs(env, "Op"))[0];
		expect(j).toMatchObject({ status: "FAILED", stage: "kirim" });
		await expect(clearRetryable(env, "Op", j.id)).rejects.toThrow(/manual/);
	});
	it("gagal di tahap cek boleh dicoba lagi (job dihapus)", async () => {
		const m = mockSite({ expired: true });
		await setEnabled(env, "Op", true);
		await withSession();
		await go(m);
		const j = (await listJobs(env, "Op"))[0];
		expect(j).toMatchObject({ status: "FAILED", stage: "cek" });
		await clearRetryable(env, "Op", j.id);
		expect(await listJobs(env, "Op")).toHaveLength(0);
	});
	it("VIEWER tidak pernah memicu", async () => {
		await setEnabled(env, "Op", true);
		const m = mockSite();
		expect(await autoInputAfterSend(env, { ...profile, role: "VIEWER" } as UserProfile, RAW, processText(RAW), ["HUGOTOGEL"])).toBeUndefined();
		expect(m.st.posts).toHaveLength(0);
	});
	it("afterSend hanya MEMBUAT job (tanpa request ke admin) -- eksekusi di panggilan terpisah", async () => {
		const m = mockSite();
		await setEnabled(env, "Op", true);
		await withSession();
		let hits = 0;
		const counting = { ...m, fetchFn: async (u: string, i?: RequestInit) => (hits++, m.fetchFn(u, i)) };
		const n = await autoInputAfterSend(env, profile, RAW, processText(RAW), ["HUGOTOGEL"]);
		expect(n?.results[0]).toMatchObject({ status: "ANTRI", jobId: expect.any(Number) });
		expect(hits).toBe(0);
		expect((await listJobs(env, "Op"))[0].status).toBe("QUEUED");
		void counting;
	});
	it("job antre hanya bisa dijalankan SEKALI (klik dobel / retry jaringan tidak menggandakan input)", async () => {
		const m = mockSite();
		await setEnabled(env, "Op", true);
		await withSession();
		const n = await autoInputAfterSend(env, profile, RAW, processText(RAW), ["HUGOTOGEL"]);
		const id = n!.results[0].jobId!;
		const [a, b] = await Promise.all([runQueuedJob(env, "Op", id, m.fetchFn), runQueuedJob(env, "Op", id, m.fetchFn)]);
		expect([a.status, b.status].sort()).toEqual(["BERHASIL", "SUDAH"]);
		expect(m.st.calcPosts).toBe(1);
		expect(await claimJob(env, "Op", id)).toBeNull();
	});
	describe("percobaan ulang otomatis (jeda 2 menit, maks 2x)", () => {
		const age = (min: number) =>
			turso.current!.raw
				.prepare(`UPDATE auto_input_job SET updated_at = ? WHERE status = 'FAILED'`)
				.run(new Date(Date.now() + 7 * 3600_000 - min * 60_000).toISOString().slice(0, 19).replace("T", " "));
		it("gagal di tahap cek -> belum dicoba sebelum 2 menit, lalu dicoba otomatis & berhasil tanpa klik user", async () => {
			const o: SiteOpts = { expired: true };
			const m = mockSite(o);
			await setEnabled(env, "Op", true);
			await withSession();
			await go(m);
			expect((await listJobs(env, "Op"))[0]).toMatchObject({ status: "FAILED", stage: "cek", attempts: 0 });
			expect(await autoInputRetryTick(env, m.fetchFn)).toBe(false); // baru gagal: belum waktunya
			o.expired = false;
			age(3);
			expect(await autoInputRetryTick(env, m.fetchFn)).toBe(true);
			expect((await listJobs(env, "Op"))[0]).toMatchObject({ status: "DONE", attempts: 1 });
			expect(m.st.calcPosts).toBe(1);
		});
		it("angka sudah masuk tapi Hitung gagal -> percobaan ulang TIDAK mengirim angka lagi, hanya Hitung", async () => {
			const o: SiteOpts = { hitungShows: "0000" };
			const m = mockSite(o);
			await setEnabled(env, "Op", true);
			await withSession();
			await go(m);
			expect((await listJobs(env, "Op"))[0]).toMatchObject({ status: "FAILED", stage: "hitung" });
			const kirimBefore = m.st.posts.filter((p) => p.path === "admin_angka13.php").length;
			expect(kirimBefore).toBe(1);
			o.hitungShows = undefined;
			age(3);
			expect(await autoInputRetryTick(env, m.fetchFn)).toBe(true);
			expect((await listJobs(env, "Op"))[0]).toMatchObject({ status: "DONE", attempts: 1 });
			expect(m.st.posts.filter((p) => p.path === "admin_angka13.php")).toHaveLength(kirimBefore);
			expect(m.st.calcPosts).toBe(1);
		});
		it("gagal terus -> berhenti setelah 2 percobaan ulang (total 3 kali)", async () => {
			const m = mockSite({ expired: true });
			await setEnabled(env, "Op", true);
			await withSession();
			await go(m);
			for (let i = 0; i < 2; i++) {
				age(3);
				expect(await autoInputRetryTick(env, m.fetchFn)).toBe(true);
			}
			age(3);
			expect(await autoInputRetryTick(env, m.fetchFn)).toBe(false);
			const j = (await listJobs(env, "Op"))[0];
			expect(j).toMatchObject({ status: "FAILED", attempts: 2 });
			expect(j.detail).toMatch(/percobaan otomatis habis/);
		});
		it("fitur dimatikan user -> job gagal tidak dicoba ulang", async () => {
			const m = mockSite({ expired: true });
			await setEnabled(env, "Op", true);
			await withSession();
			await go(m);
			await setEnabled(env, "Op", false);
			age(3);
			expect(await autoInputRetryTick(env, m.fetchFn)).toBe(false);
		});
	});
	it("riwayat: semua job 7 hari terakhir tampil (bukan 30 baris), lebih lama dari itu tidak", async () => {
		await listJobs(env, "Op"); // pastikan tabel ada
		const wib = (msAgo: number) => new Date(Date.now() + 7 * 3600_000 - msAgo).toISOString().slice(0, 19).replace("T", " ");
		const ins = turso.current!.raw.prepare(
			`INSERT INTO auto_input_job (username, website, market, result_key, status, stage, created_at, updated_at) VALUES ('Op', 'HUGOTOGEL', 'HK', ?, 'DONE', 'selesai', ?, ?)`,
		);
		for (let i = 0; i < 50; i++) ins.run("k" + i, wib(6 * 86400_000), wib(6 * 86400_000)); // 6 hari lalu, 50 job
		ins.run("lama", wib(9 * 86400_000), wib(9 * 86400_000)); // 9 hari lalu
		const jobs = await listJobs(env, "Op");
		expect(jobs).toHaveLength(50);
		expect(await listJobs(env, "Op", 30)).toHaveLength(51);
	});
	it("user lain tidak bisa menjalankan job milik orang lain", async () => {
		const m = mockSite();
		await setEnabled(env, "Op", true);
		await withSession();
		const n = await autoInputAfterSend(env, profile, RAW, processText(RAW), ["HUGOTOGEL"]);
		const o = await runQueuedJob(env, "Orang-Lain", n!.results[0].jobId!, m.fetchFn);
		expect(o.status).toBe("SUDAH");
		expect(m.st.posts).toHaveLength(0);
	});
	it("saveSession: banyak website, input kosong = pertahankan yang lama, URL http ditolak", async () => {
		await saveSession(env, "Op", "HUGOTOGEL", "https://ag.suksesbogil.com", "PHPSESSID=" + SID1);
		await saveSession(env, "Op", "FOLATOTO", "agwl12.suksesbogil.com", SID2);
		await saveSession(env, "Op", "HUGOTOGEL", "https://ag.suksesbogil.com/index.php", "");
		const s = await getSessions(env, "Op");
		expect(s.map((x) => [x.website, x.baseUrl, x.phpsessid])).toEqual([
			["FOLATOTO", "https://agwl12.suksesbogil.com/", "PHPSESSID=" + SID2],
			["HUGOTOGEL", "https://ag.suksesbogil.com/", "PHPSESSID=" + SID1],
		]);
		await expect(saveSession(env, "Op", "X", "http://ag.suksesbogil.com", SID2)).rejects.toThrow(/https/);
		await expect(saveSession(env, "Op", "SOHOTOGEL", "https://agwl5.suksesbogil.com", "bad")).rejects.toThrow(/PHPSESSID/);
	});
});
