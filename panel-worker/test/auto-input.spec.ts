import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { autoInputAfterSend, autoInputRetryTick, autoInputTotals, autoInputTotalsCheck, autoInputTotalsRefresh, autoInputTotalsTick, runQueuedJob, type AutoInputNotice } from "../src/api/auto-input";
import { autoInputGetState, autoInputSetMarkets } from "../src/api/auto-input";
import { checkLogin } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { getDisabledMarkets, setGlobalOffMarkets, cleanMarketList, hideJobs, pruneAutoInputJobs, pendingFailureAlerts, ackFailureAlerts, claimJob, parseCookieInput, adminBaseProblem, defaultAdminBase, clearRetryable, resetAutoInputTablesFlag, getSessions, listJobs, parsePhpSessId, parseResultDate, planAutoInput, saveSession, setEnabled } from "../src/lib/auto-input";
import { frameSources, parseAngkaPage, readTopRow, parseHitungPage, runAutoInput, buildPayload, parseForms, parseLastResult, parsePrediksiTotals, prediksiEchoProblem } from "../src/lib/auto-input-run";
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
	/** Menu Prediksi admin (admin_prediksifullbb.php). Tanpa ini halaman itu 404 seperti situs yang belum punya menunya. */
	prediksi?: {
		totals?: [string, string, string]; // Total Omset / Referal / Menang di baris Result setelah Submit
		lastPeriod?: number; // periode di "Last Result" (default: periode yang baru dihitung)
		ignorePost?: boolean; // server mengabaikan Submit dan menampilkan tampilan bawaan
		market?: string; // pasaran yang terpilih di dropdown halaman Prediksi
		noResultRow?: boolean;
	};
}

/** Halaman Prediksi (BB/FULL) -- struktur disalin dari halaman asli (tag tidak rapi ikut disalin: </font></a></th> di sel link). */
function prediksiPage(p: { market: string; code: string; last: number; nums: string[]; showPeriod: number; showNomor: string; totals: [string, string, string]; noResultRow?: boolean }): string {
	const n = (i: number) => p.nums[i] ?? "0";
	const link = (tipe: string) => `<td><a target=_blank href="admin_menkalahbb.php?pasar=${p.code}&tipe=${tipe}&periode=${p.showPeriod}&nomor=${p.showNomor}&nomor2=0&nomor3=0&,180,70,950,540); ">0</font></a></th>`;
	return `<style type="text/css">th{color:#FFFF00;} table{border:1px solid #fff;font-size:13px;}</style>
<script type="text/javascript">
function sendRes(per,res,res2,res3,wild){
    document.getElementById('periode').value=per;
    document.getElementById('nomor').value=res;
    if(res2)document.getElementById('nomor2').value=res2;
    if(res3)document.getElementById('nomor3').value=res3;
    if(wild)document.getElementById('wild').value=wild;
}
</script>
<form method=post>
    <B>Prediksi (BB/FULL) ${p.market}&nbsp;&nbsp;
        P: <input type=text name="periode" id="periode" value='${p.showPeriod}' size=3>
        No: </font><input type=text name="nomor" id="nomor" maxlength="4" value='${p.showNomor}' size=3></B></font>
                    <input type=text name="nomor1" id="nomor2" maxlength="4" placeholder="prize2" value='0' size=3></B></font>
            <input type=text name="nomor2" id="nomor3" maxlength="4" placeholder="prize3" value='0' size=3></B></font>
        <font style="font-family:helvetica;font-size:13px;">
            <select name="pasaran" id="pasaran" style="padding: 2px;" onchange="location = this.value;">
                            <option value="admin_prediksifullbb.php?psr=p33210" >BALI</option>
                            <option value="admin_prediksifullbb.php?psr=${p.code}" SELECTED>${p.market}</option>
                    </select>
        <input type=submit name=submit value=Submit>
        <input type=hidden value='${p.code}' name="sar" id="pasarnya">
        <div style="display: inline-block;" onclick="sendRes(${p.last},'${n(0)}','${n(1)}','${n(2)}','0')">Last Result Periode : ${p.last} , Angka : ${p.nums.join(",")}</div></form>
<table>
    <tr bgcolor=#009B00 align=center>
       <th>Games</th>
       <th>Omset<br>BB</th><th>Referal<br>BB</th><th>Menang<br>BB</th>
       <th>Omset<br>FULL</th><th>Referal<br>FULL</th><th>Menang<br>FULL</th>
       <th>Omset<br>DISKON</th><th>Referal<br>DISKON</th><th>Menang<br>DISKON</th>
       <th>Omset<br>PRIZE123</th><th>Referal<br>PRIZE123</th><th>Menang<br>PRIZE123</th>
       <th>Total<br>Omset</th>
       <th>Total<br>Referal</th>
       <th>Total<br>Menang</th>
    </tr>
    <tr class="table-row" bgcolor="#BCFF9F"><td align="left">4D</td>${"<td>0</td>".repeat(14)}${link("A")}</tr>
    <tr class="table-row" bgcolor="#88F885"><td align="left">3D</td>${"<td>0</td>".repeat(14)}${link("B")}</tr>
    ${
			p.noResultRow
				? ""
				: `<tr class="table-row" bgcolor="#CCCCCC">
       <td align="left"><b>Result</b></td>
        ${"<td>0</td>".repeat(12)}
        <td>${p.totals[0]}</td>
        <td>${p.totals[1]}</td>
        <td>${p.totals[2]}</td>
    </tr>`
		}
    <tr bgcolor="#CCCCCC"><td align="center" colspan=15><b>SERI</b></td><td><font color=#000><b>0</b></td></tr>
 </table>`;
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
		if (path === "admin_prediksifullbb.php" && o.prediksi) {
			const pr = o.prediksi;
			const q = new URL(url).searchParams.get("psr");
			if (q !== code) return html("pasaran lain", 404);
			const last = pr.lastPeriod ?? rows[0].period;
			const base = { market: pr.market ?? market, code, last, nums: rows[0].nums, totals: ["0", "0", "0"] as [string, string, string], noResultRow: pr.noResultRow };
			if (!isPost) {
				st.posts.push({ path: "GET " + path, search: new URL(url).search, body, cookie: "" });
				return html(prediksiPage({ ...base, showPeriod: rows[0].period + 1, showNomor: "" }));
			}
			st.posts.push({ path, search: new URL(url).search, body, cookie: String((init!.headers as Record<string, string>).Cookie) });
			if (pr.ignorePost) return html(prediksiPage({ ...base, showPeriod: rows[0].period + 1, showNomor: "" }));
			return html(prediksiPage({ ...base, showPeriod: Number(body.get("periode")), showNomor: body.get("nomor") ?? "", totals: pr.totals ?? ["21,700", "0", "0"] }));
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
	it("halaman Nomor Keluar tanpa form (kasus ARIZONA/CANADA): pesan menyebut sesi OK + apa yang benar-benar diterima, tanpa POST", async () => {
		const m = mockSite();
		const f = async (u: string, i?: RequestInit) =>
			new URL(u).pathname === "/admin_angka13.php" && i?.method !== "POST"
				? new Response("<html><head><title>Info Pasaran</title></head><body>Pasaran ini diupdate otomatis oleh pusat</body></html>", { status: 200 })
				: m.fetchFn(u, i);
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: f });
		expect(r.ok).toBe(false);
		expect(r.stage).toBe("cek");
		expect(r.detail).toContain("sesi login OK");
		expect(r.detail).not.toContain("sesi mungkin habis");
		expect(r.detail).toContain("psr=p21545");
		expect(r.detail).toContain("pool=pool-14-0-1-");
		expect(r.detail).toContain('judul "Info Pasaran"');
		expect(r.detail).toContain("diupdate otomatis oleh pusat");
		expect(m.st.posts).toHaveLength(0);
		const { cleanReason } = await import("../src/lib/admin-notify");
		expect(cleanReason(r.detail)).not.toContain("Diterima:"); // Telegram tetap ringkas & bisa digabung antar website
	});
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
		setGlobalOffMarkets([]);
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

	it("saklar OFF (default) -> tidak ada input/Hitung otomatis (hanya memantau Omset: tanpa satu pun request ke admin saat kirim)", async () => {
		const m = mockSite();
		await withSession();
		const n = await autoInputAfterSend(env, profile, RAW, processText(RAW), ["HUGOTOGEL"]);
		expect(n?.skippedReason).toBeUndefined();
		expect(n?.results).toEqual([]);
		expect(n?.totalsCheck).toHaveLength(1);
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
	describe("saklar per pasaran (pemilik: atur mana yang auto & mana yang tidak)", () => {
		it("normalisasi daftar: huruf besar, tanpa duplikat/kosong, urut", () => {
			expect(cleanMarketList([" arizona ", "ARIZONA", "", null, "canada"])).toEqual(["ARIZONA", "CANADA"]);
			expect(cleanMarketList("bukan array")).toEqual([]);
		});
		it("pasaran dimatikan -> tidak dibuat job sama sekali (tidak menyentuh admin); pasaran lain tetap auto", async () => {
			const m = mockSite();
			await setEnabled(env, "Op", true);
			await withSession();
			setGlobalOffMarkets(["floridaeve"]);
			const n = await go(m);
			expect(n?.results).toEqual([]);
			expect(n?.skippedReason).toContain("FLORIDAEVE tidak di-auto");
			expect(m.st.posts).toHaveLength(0);
			expect(await listJobs(env, "Op")).toHaveLength(0);
			setGlobalOffMarkets(["ARIZONA"]); // pasaran lain dimatikan -> FLORIDAEVE jalan
			const n2 = await go(m);
			expect(n2?.results[0].status).toBe("BERHASIL");
		});
		it("dimatikan setelah job gagal -> percobaan ulang dihentikan jadi DILEWATI (bukan gagal, tanpa peringatan)", async () => {
			const m = mockSite({ expired: true });
			await setEnabled(env, "Op", true);
			await withSession();
			await go(m);
			expect((await listJobs(env, "Op"))[0]).toMatchObject({ status: "FAILED" });
			setGlobalOffMarkets(["FLORIDAEVE"]);
			turso.current!.raw.prepare(`UPDATE auto_input_job SET updated_at = ? WHERE status = 'FAILED'`).run(new Date(Date.now() + 7 * 3600_000 - 3 * 60_000).toISOString().slice(0, 19).replace("T", " "));
			await autoInputRetryTick(env, m.fetchFn);
			const j = (await listJobs(env, "Op"))[0];
			expect(j.status).toBe("SKIPPED");
			expect(j.detail).toContain("tidak di-auto");
			expect(m.st.calcPosts).toBe(0);
		});
		it("lewat API: HANYA admin yang boleh mengatur; berlaku global untuk semua user; daftar lengkap (katalog)", async () => {
			const ctx = fakeEnv();
			env = ctx.env;
			setGlobalOffMarkets([]);
			const hash = await hashPassword("pw");
			ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status, websites) VALUES ('Op', 'op', ?, 'OPERATOR', 'AKTIF', 'HUGOTOGEL')`).run(hash);
			ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status, websites) VALUES ('Adm', 'adm', ?, 'ADMIN', 'AKTIF', 'HUGOTOGEL')`).run(hash);
			const op = ((await checkLogin(env, "Op", "pw", "")) as { sessionToken: string }).sessionToken;
			const adm = ((await checkLogin(env, "Adm", "pw", "")) as { sessionToken: string }).sessionToken;
			await expect(autoInputSetMarkets(env, op, ["Canada"])).rejects.toThrow(/ADMIN/);
			expect(await getDisabledMarkets(env)).toEqual([]);
			expect(await autoInputSetMarkets(env, adm, ["Canada"])).toMatchObject({ success: true, disabledMarkets: ["CANADA"] });
			const stOp = (await autoInputGetState(env, op)) as unknown as { isAdmin: boolean; markets: { market: string; auto: boolean }[] };
			expect(stOp.isAdmin).toBe(false);
			expect(stOp.markets.find((x) => x.market === "CANADA")).toEqual({ market: "CANADA", auto: false });
			expect(stOp.markets.length).toBeGreaterThan(40); // katalog Invest + Panel-Z, bukan hanya riwayat
			expect(stOp.markets.find((x) => x.market === "HONGKONG")?.auto).toBe(true);
			const stAdm = (await autoInputGetState(env, adm)) as unknown as { isAdmin: boolean };
			expect(stAdm.isAdmin).toBe(true);
			await autoInputSetMarkets(env, adm, []);
			expect(await getDisabledMarkets(env)).toEqual([]);
		});
		it("pemindahan sekali jalan: daftar lama per-akun milik admin naik jadi global lalu dikosongkan", async () => {
			const ctx = fakeEnv();
			env = ctx.env;
			setGlobalOffMarkets([]);
			ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status, websites) VALUES ('Adm', 'adm', ?, 'ADMIN', 'AKTIF', 'HUGOTOGEL')`).run(await hashPassword("pw"));
			const adm = ((await checkLogin(env, "Adm", "pw", "")) as { sessionToken: string }).sessionToken;
			await getSessions(env, "Adm"); // pastikan tabel ada
			turso.current!.raw.prepare(`INSERT INTO auto_input_config (username, enabled, updated_at, disabled_markets) VALUES ('Adm', 1, 'x', '["ARIZONA","SYDNEY"]')`).run();
			const st = (await autoInputGetState(env, adm)) as unknown as { markets: { market: string; auto: boolean }[] };
			expect(st.markets.filter((x) => !x.auto).map((x) => x.market)).toEqual(["ARIZONA", "SYDNEY"]);
			expect(await getDisabledMarkets(env)).toEqual(["ARIZONA", "SYDNEY"]);
			const row = turso.current!.raw.prepare(`SELECT disabled_markets FROM auto_input_config WHERE username='Adm'`).get() as { disabled_markets: string };
			expect(row.disabled_markets).toBe("[]");
			await autoInputSetMarkets(env, adm, []); // admin mengosongkan -> tidak hidup lagi dari data lama
			await autoInputGetState(env, adm);
			expect(await getDisabledMarkets(env)).toEqual([]);
		});
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
		it("peringatan terakhir: baru muncul setelah SEMUA percobaan habis, sekali saja (ack)", async () => {
			const m = mockSite({ expired: true });
			await setEnabled(env, "Op", true);
			await withSession();
			await go(m);
			expect(await pendingFailureAlerts(env, "Op", 2)).toHaveLength(0); // masih akan dicoba ulang
			age(3);
			await autoInputRetryTick(env, m.fetchFn);
			expect(await pendingFailureAlerts(env, "Op", 2)).toHaveLength(0);
			age(3);
			await autoInputRetryTick(env, m.fetchFn); // percobaan ulang ke-2 (terakhir) gagal
			const al = await pendingFailureAlerts(env, "Op", 2);
			expect(al).toHaveLength(1);
			expect(al[0]).toMatchObject({ website: "HUGOTOGEL", market: "FLORIDAEVE", attempts: 2 });
			expect(await pendingFailureAlerts(env, "Other", 2)).toHaveLength(0); // milik user lain tidak bocor
			await ackFailureAlerts(env, "Op", [al[0].id]);
			expect(await pendingFailureAlerts(env, "Op", 2)).toHaveLength(0);
		});
		it("job lama (>1 jam) tidak dicoba ulang otomatis", async () => {
			const m = mockSite({ expired: true });
			await setEnabled(env, "Op", true);
			await withSession();
			await go(m);
			const old = new Date(Date.now() + 7 * 3600_000 - 3 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
			turso.current!.raw.prepare(`UPDATE auto_input_job SET created_at = ?, updated_at = ?`).run(old, old);
			expect(await autoInputRetryTick(env, m.fetchFn)).toBe(false);
		});
		it("riwayat gagal LAMA tidak pernah dicoba ulang maupun memicu peringatan (hanya yang terbaru)", async () => {
			const m = mockSite({ expired: true });
			await setEnabled(env, "Op", true);
			await withSession();
			await go(m);
			const old = new Date(Date.now() + 7 * 3600_000 - 2 * 86400_000).toISOString().slice(0, 19).replace("T", " ");
			turso.current!.raw.prepare(`UPDATE auto_input_job SET created_at = ?, updated_at = ?, attempts = 2`).run(old, old);
			expect(await autoInputRetryTick(env, m.fetchFn)).toBe(false);
			expect(await pendingFailureAlerts(env, "Op", 2)).toHaveLength(0);
			expect(await pendingFailureAlerts(env, "Op", 0)).toHaveLength(0);
			turso.current!.raw.prepare(`UPDATE auto_input_job SET attempts = 0`).run();
			expect(await autoInputRetryTick(env, m.fetchFn)).toBe(false);
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
	it("pemangkasan harian: job lebih lama dari 7 hari dihapus, yang masih RUNNING dan yang baru tetap", async () => {
		await listJobs(env, "Op");
		const wib = (msAgo: number) => new Date(Date.now() + 7 * 3600_000 - msAgo).toISOString().slice(0, 19).replace("T", " ");
		const ins = turso.current!.raw.prepare(
			`INSERT INTO auto_input_job (username, website, market, result_key, status, stage, created_at, updated_at) VALUES ('Op', 'HUGOTOGEL', 'HK', ?, ?, '', ?, ?)`,
		);
		ins.run("baru", "DONE", wib(86400_000), wib(86400_000));
		ins.run("enam-hari", "FAILED", wib(6 * 86400_000), wib(6 * 86400_000));
		ins.run("lama-selesai", "DONE", wib(9 * 86400_000), wib(9 * 86400_000));
		ins.run("lama-gagal", "FAILED", wib(10 * 86400_000), wib(10 * 86400_000));
		ins.run("lama-jalan", "RUNNING", wib(9 * 86400_000), wib(9 * 86400_000));
		expect(await pruneAutoInputJobs(env)).toBe(2);
		const left = (turso.current!.raw.prepare(`SELECT result_key FROM auto_input_job ORDER BY result_key`).all() as { result_key: string }[]).map((r) => r.result_key);
		expect(left).toEqual(["baru", "enam-hari", "lama-jalan"]);
	});
	it("hapus manual (checkbox): job disembunyikan, hanya milik sendiri, yang berjalan dilewati; tidak dicoba ulang/diperingatkan; pagar anti-input-ganda tetap", async () => {
		await listJobs(env, "Op");
		const wib = (msAgo: number) => new Date(Date.now() + 7 * 3600_000 - msAgo).toISOString().slice(0, 19).replace("T", " ");
		const ins = turso.current!.raw.prepare(
			`INSERT INTO auto_input_job (username, website, market, result_key, status, stage, attempts, created_at, updated_at) VALUES (?, 'HUGOTOGEL', 'HK', ?, ?, ?, ?, ?, ?)`,
		);
		const id = (k: string) => (turso.current!.raw.prepare(`SELECT id FROM auto_input_job WHERE result_key = ?`).get(k) as { id: number }).id;
		ins.run("Op", "done", "DONE", "selesai", 0, wib(60_000), wib(60_000));
		ins.run("Op", "gagal", "FAILED", "cek", 2, wib(60_000), wib(60_000));
		ins.run("Op", "jalan", "RUNNING", "", 0, wib(60_000), wib(60_000));
		ins.run("Lain", "milik-lain", "DONE", "selesai", 0, wib(60_000), wib(60_000));
		expect((await listJobs(env, "Op")).map((j) => j.id).length).toBe(3);
		const r = await hideJobs(env, "Op", [id("done"), id("gagal"), id("jalan"), id("milik-lain"), -5, 999999]);
		expect(r).toEqual({ hidden: 2, skipped: 3 }); // id negatif disaring sebelum dihitung
		expect((await listJobs(env, "Op")).map((j) => j.status)).toEqual(["RUNNING"]); // yang berjalan tetap tampil
		expect((await listJobs(env, "Lain")).length).toBe(1); // milik orang lain tidak tersentuh
		// job gagal yang disembunyikan tidak memunculkan peringatan
		expect(await pendingFailureAlerts(env, "Op", 2)).toHaveLength(0);
		// barisnya tetap ada: UNIQUE (website, result_key) masih menjadi pagar anti-input-ganda
		expect((turso.current!.raw.prepare(`SELECT COUNT(*) AS n FROM auto_input_job WHERE username = 'Op'`).get() as { n: number }).n).toBe(3);
		expect(() => ins.run("Op", "done", "DONE", "selesai", 0, wib(1), wib(1))).toThrow(/UNIQUE/i);
		// pemangkasan harian tetap membuangnya setelah 7 hari
		turso.current!.raw.prepare(`UPDATE auto_input_job SET created_at = ? WHERE result_key = 'done'`).run(wib(9 * 86400_000));
		expect(await pruneAutoInputJobs(env)).toBe(1);
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

describe("percobaan ulang tidak boleh menekan Hitung dua kali (audit: risiko bayar ganda)", () => {
	let env: Env;
	const ago = (min: number) => new Date(Date.now() + 7 * 3600_000 - min * 60_000).toISOString().slice(0, 19).replace("T", " ");
	beforeEach(async () => {
		turso.current = fakeD1([]);
		resetAutoInputTablesFlag();
		env = fakeEnv().env;
		await setEnabled(env, "Op", true);
	});
	const job = (key: string, stage: string, detail: string, attempts = 0, createdMin = 10) =>
		turso.current!.raw
			.prepare(`INSERT INTO auto_input_job (username, website, market, result_key, status, stage, detail, created_at, updated_at, attempts) VALUES ('Op','HUGOTOGEL','HK',?, 'FAILED', ?, ?, ?, ?, ?)`)
			.run(key, stage, detail, ago(createdMin), ago(5), attempts);

	it("Hitung mungkin sudah ditekan -> TIDAK dicoba ulang; Hitung yang pasti belum ditekan -> tetap dicoba ulang", async () => {
		const { dueRetryJobs } = await import("../src/lib/auto-input");
		job("k1", "hitung", "Hitung dikirim tapi tombol Hitung periode ini masih ada — cek manual apakah sudah terhitung.");
		job("k2", "hitung", "Proses terputus di tengah jalan — CEK MANUAL di admin website (angka mungkin sudah masuk).");
		job("k3", "hitung", "Angka sudah MASUK, tapi halaman Hitung tidak cocok (periode 1 ≠ 2) — Hitung TIDAK dijalankan, cek manual.");
		job("k4", "hitung", "Angka sudah MASUK, tapi halaman Hitung tidak dikenali — tekan Hitung manual.");
		job("k5", "cek", "Halaman Nomor Keluar tidak dikenali");
		const due = await dueRetryJobs(env, 2, 2, 10);
		const keys = due.map((j) => JSON.stringify(j));
		expect(keys.some((k) => k.includes("Hitung dikirim"))).toBe(false);
		expect(keys.some((k) => k.includes("terputus di tengah"))).toBe(false);
		expect(keys.some((k) => k.includes("Hitung TIDAK dijalankan"))).toBe(true);
		expect(keys.some((k) => k.includes("halaman Hitung tidak dikenali"))).toBe(true);
		expect(keys.some((k) => k.includes("Nomor Keluar"))).toBe(true);
		expect(due.length).toBe(3);
	});

	it("yang tidak akan dicoba ulang langsung jadi peringatan (dulu: tidak pernah diperingatkan)", async () => {
		job("k1", "hitung", "Hitung dikirim tapi tombol Hitung periode ini masih ada — cek manual apakah sudah terhitung.");
		job("k2", "cek", "Halaman Nomor Keluar tidak dikenali", 0, 90); // di luar jendela percobaan ulang 60 menit
		job("k3", "cek", "masih akan dicoba ulang", 0, 10);
		const al = await pendingFailureAlerts(env, "Op", 2);
		expect(al.map((a) => a.detail).sort()).toEqual(["Halaman Nomor Keluar tidak dikenali", "Hitung dikirim tapi tombol Hitung periode ini masih ada — cek manual apakah sudah terhitung."]);
	});
});


// ---------------------------------------------------------------------------
// Menu Result: Total Omset / Referal / Menang dari menu Prediksi admin
// ---------------------------------------------------------------------------
describe("halaman Prediksi admin (HTML asli dari pemilik)", () => {
	// Potongan PERSIS seperti yang ditempel pemilik dari situs admin.
	const LAST = `<div style="display: inline-block;" onclick="sendRes(737,'1956','7895','1236','0')">Last Result Periode : 737 , Angka : 1956,7895,1236</div>`;
	it("Last Result: periode & angka dibaca dari onclick sendRes dan dicocokkan dengan teksnya", () => {
		expect(parseLastResult(`<form>${LAST}</form>`)).toEqual({ period: 737, numbers: ["1956", "7895", "1236"], args: ["737", "1956", "7895", "1236", "0"] });
	});
	it("Last Result ditolak bila teks ≠ argumen, tidak ada, atau ganda", () => {
		expect(parseLastResult(LAST.replace("Periode : 737", "Periode : 736"))).toBeNull();
		expect(parseLastResult(LAST.replace("1956,7895", "1956,7000"))).toBeNull();
		expect(parseLastResult("<div>tidak ada</div>")).toBeNull();
		expect(parseLastResult(LAST + LAST)).toBeNull();
	});
	const page = (totals: [string, string, string], extra = "") =>
		prediksiHtml(totals) + extra;
	function prediksiHtml(t: [string, string, string]): string {
		return `<table><tr bgcolor=#009B00 align=center><th>Games</th><th>Omset<br>BB</th><th>Total<br>Omset</th><th>Total<br>Referal</th><th>Total<br>Menang</th></tr>
<tr class="table-row"><td align="left">4D</td><td>9</td><td>9</td><td>9</td><td><a href="x">9</font></a></th></tr>
<tr class="table-row" bgcolor="#CCCCCC"><td align="left"><b>Result</b></td><td>0</td><td>${t[0]}</td><td>${t[1]}</td><td>${t[2]}</td></tr>
<tr bgcolor="#CCCCCC"><td align="center" colspan=15><b>SERI</b></td><td><font color=#000><b>0</b></td></tr></table>`;
	}
	it("baris Result: Total Omset/Referal/Menang dicari dari NAMA header, nilai disalin apa adanya", () => {
		expect(parsePrediksiTotals(page(["21,700", "0", "0"]))).toEqual({ omset: "21,700", referal: "0", menang: "0" });
		expect(parsePrediksiTotals(page(["1.250.000", "12.500", "-300.000"]))).toEqual({ omset: "1.250.000", referal: "12.500", menang: "-300.000" });
	});
	it("tabel yang tidak persis dikenali -> null (tidak menebak)", () => {
		expect(parsePrediksiTotals(page(["x", "0", "0"]))).toBeNull(); // bukan angka
		expect(parsePrediksiTotals(page(["1", "2", "3"]).replace("<th>Total<br>Referal</th>", ""))).toBeNull(); // header kurang
		expect(parsePrediksiTotals(page(["1", "2", "3"]).replace("<td>3</td></tr>", "</tr>"))).toBeNull(); // jumlah sel ≠ header
		expect(parsePrediksiTotals(page(["1", "2", "3"], '<tr><td><b>Result</b></td><td>1</td></tr>'))).toBeNull(); // dua baris Result
		expect(parsePrediksiTotals("<html>tidak ada tabel</html>")).toBeNull();
	});
	it("tampilan bawaan (periode berikutnya, nomor kosong) DITOLAK; tabel hasil Submit lolos", () => {
		const view = (per: number, nomor: string) => `<form><input type=text name="periode" id="periode" value='${per}'><input type=text name="nomor" id="nomor" value='${nomor}'></form><a href="admin_menkalahbb.php?pasar=p1&tipe=A&amp;periode=${per}&nomor=${nomor}&nomor2=0&nomor3=0&,180,70); ">0</a>`;
		expect(prediksiEchoProblem(view(738, ""), 737, ["1956"])).toMatch(/periode 738 angka kosong/);
		expect(prediksiEchoProblem(view(737, "1956"), 737, ["1956"])).toBe("");
		expect(prediksiEchoProblem(view(737, "1111"), 737, ["1956"])).toMatch(/angka 1111/);
		// tanpa tautan: kolom form yang menentukan
		const inputsOnly = (per: number, nomor: string) => view(per, nomor).replace(/<a .*<\/a>/, "");
		expect(prediksiEchoProblem(inputsOnly(737, "1956"), 737, ["1956"])).toBe("");
		expect(prediksiEchoProblem(inputsOnly(738, ""), 737, ["1956"])).toMatch(/tidak menampilkan/);
	});
});

describe("Auto Prediksi membaca Total Omset/Referal/Menang sesudah Hitung", () => {
	it("alur penuh: Last Result -> Submit seperti browser -> baris Result terbaca; Kirim & Hitung tidak berubah", async () => {
		const m = mockSite({ prediksi: { totals: ["21,700", "0", "0"] } });
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: m.fetchFn });
		expect(r).toMatchObject({ ok: true, stage: "selesai", period: "1630", totals: { omset: "21,700", referal: "0", menang: "0" }, totalsNote: "" });
		const post = m.st.posts.find((x) => x.path === "admin_prediksifullbb.php")!;
		expect(post.search).toBe("?psr=p21545"); // form tanpa action = kirim ke alamat halaman itu sendiri
		expect(Object.fromEntries(post.body)).toEqual({ periode: "1630", nomor: "9808", nomor1: "0", nomor2: "0", sar: "p21545", pasaran: "admin_prediksifullbb.php?psr=p21545", submit: "Submit" });
		expect(m.st.calcPosts).toBe(1);
	});
	it("anggaran request tetap <= 16 fetch per website (batas Worker gratis 50)", async () => {
		const m = mockSite({ prediksi: {} });
		let n = 0;
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: async (u, i) => (n++, m.fetchFn(u, i)) });
		expect(r.ok).toBe(true);
		expect(n).toBeLessThanOrEqual(16);
	});
	it("menu Prediksi tak bisa dibuka -> job TETAP berhasil (Hitung sudah membayar pemenang), alasannya dicatat", async () => {
		const m = mockSite(); // tanpa halaman Prediksi = 404
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: m.fetchFn });
		expect(r).toMatchObject({ ok: true, stage: "selesai", totals: null });
		expect(r.totalsNote).toMatch(/HTTP 404/);
	});
	it("Last Result masih periode lama -> TIDAK ada Submit, angka tidak ditampilkan", async () => {
		const m = mockSite({ prediksi: { lastPeriod: 1629 } });
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: m.fetchFn });
		expect(r.ok).toBe(true);
		expect(r.totals).toBeNull();
		expect(r.totalsNote).toMatch(/Last Result di admin periode 1629, bukan periode 1630/);
		expect(m.st.posts.some((x) => x.path === "admin_prediksifullbb.php")).toBe(false);
	});
	it("dropdown Prediksi menunjukkan pasaran lain -> TIDAK ada Submit", async () => {
		const m = mockSite({ prediksi: { market: "HONGKONG" } });
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: m.fetchFn });
		expect(r.totals).toBeNull();
		expect(r.totalsNote).toMatch(/menampilkan pasaran "HONGKONG"/);
		expect(m.st.posts.some((x) => x.path === "admin_prediksifullbb.php")).toBe(false);
	});
	it("server mengabaikan Submit (tampilan bawaan, semua 0) -> ditolak, BUKAN ditampilkan sebagai Rp 0", async () => {
		const m = mockSite({ prediksi: { ignorePost: true } });
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: m.fetchFn });
		expect(r.ok).toBe(true);
		expect(r.totals).toBeNull();
		expect(r.totalsNote).toMatch(/Hasil Prediksi ditolak/);
	});
	it("baris Result tidak ada -> tidak terbaca (bukan ditebak)", async () => {
		const m = mockSite({ prediksi: { noResultRow: true } });
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: m.fetchFn });
		expect(r.totals).toBeNull();
		expect(r.totalsNote).toMatch(/Baris Result/);
	});
	it("uji kering tidak menyentuh halaman Prediksi", async () => {
		const m = mockSite({ prediksi: {} });
		await runAutoInput({ session: sess, plan: plan(), dryRun: true, fetchFn: m.fetchFn });
		expect(m.st.posts.some((x) => x.path.includes("prediksi"))).toBe(false);
	});
});

describe("Total Omset/Referal/Menang tersimpan & tampil di menu Result (DB + API)", () => {
	let env: Env;
	let op: string;
	beforeEach(async () => {
		setGlobalOffMarkets([]);
		turso.current = fakeD1([]);
		resetAutoInputTablesFlag();
		const ctx = fakeEnv();
		env = ctx.env;
		const hash = await hashPassword("pw");
		ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status, websites) VALUES ('Op', 'op', ?, 'OPERATOR', 'AKTIF', ?)`).run(hash, JSON.stringify(["HUGOTOGEL", "FOLATOTO"]));
		op = ((await checkLogin(env, "Op", "pw", "")) as { sessionToken: string }).sessionToken;
		await setEnabled(env, "Op", true);
		await saveSession(env, "Op", "HUGOTOGEL", "https://ag.suksesbogil.com", "PHPSESSID=" + SID1);
	});
	const run = async (m: ReturnType<typeof mockSite>) => {
		const profile = { username: "Op", role: "OPERATOR", websites: ["HUGOTOGEL", "FOLATOTO"], menus: null } as unknown as UserProfile;
		const n = await autoInputAfterSend(env, profile, RAW, processText(RAW), ["HUGOTOGEL"]);
		return runQueuedJob(env, "Op", n!.results[0].jobId!, m.fetchFn);
	};
	it("job selesai -> baris tersimpan dan dikembalikan autoInputTotals bersama urutan website akun", async () => {
		await run(mockSite({ prediksi: { totals: ["21,700", "0", "0"] } }));
		const r = (await autoInputTotals(env, op)) as unknown as { rows: Record<string, unknown>[]; websites: string[] };
		expect(r.websites).toEqual(["HUGOTOGEL", "FOLATOTO"]);
		expect(r.rows).toHaveLength(1);
		expect(r.rows[0]).toMatchObject({ website: "HUGOTOGEL", market: "FLORIDAEVE", period: "1630", omset: "21,700", referal: "0", menang: "0", note: "" });
	});
	it("gagal baca -> baris tersimpan dengan alasan; Ambil ulang membacanya lagi; ambil ulang gagal TIDAK menghapus angka yang sudah ada", async () => {
		const m = mockSite({ prediksi: { lastPeriod: 1629 } });
		await run(m);
		let row = ((await autoInputTotals(env, op)) as unknown as { rows: { id: number; omset: string; note: string }[] }).rows[0];
		expect(row.omset).toBe("");
		expect(row.note).toMatch(/periode 1629/);
		// admin sudah memperbarui Last Result -> ambil ulang berhasil
		const fixed = mockSite({ prediksi: { totals: ["5,000", "50", "0"] } });
		fixed.rows[0].period = 1630;
		fixed.rows[0].nums = ["9808"];
		expect(await autoInputTotalsRefresh(env, op, row.id, fixed.fetchFn)).toMatchObject({ success: true });
		row = ((await autoInputTotals(env, op)) as unknown as { rows: { id: number; omset: string; referal: string; note: string }[] }).rows[0];
		expect(row).toMatchObject({ omset: "5,000", referal: "50", note: "" });
		// admin pindah ke periode berikutnya -> ambil ulang gagal, angka lama aman
		const moved = mockSite({ prediksi: {} });
		moved.rows[0].period = 1631;
		moved.rows[0].nums = ["1111"];
		const bad = await autoInputTotalsRefresh(env, op, row.id, moved.fetchFn);
		expect(bad.success).toBe(false);
		expect(((await autoInputTotals(env, op)) as unknown as { rows: { omset: string }[] }).rows[0].omset).toBe("5,000");
	});
	it("Keterangan Riwayat Job memuat Total Omset/Referal/Menang; gagal baca memuat alasannya; Ambil ulang MENGGANTI (tidak menumpuk)", async () => {
		const jobDetail = async () => (await listJobs(env, "Op"))[0].detail;
		await run(mockSite({ prediksi: { totals: ["21,700", "0", "0"] } }));
		expect(await jobDetail()).toBe("Periode 1630 FLORIDAEVE: angka 9808 masuk & dihitung (agen fakeagent). [Omset 21,700 · Referal 0 · Menang 0]");
		// kasus gagal baca (menu Prediksi 404): job tetap SELESAI, Keterangan menyebut alasannya
		turso.current!.raw.exec(`DELETE FROM auto_input_job; DELETE FROM auto_input_totals;`);
		await run(mockSite());
		expect((await listJobs(env, "Op"))[0]).toMatchObject({ status: "DONE" });
		expect(await jobDetail()).toMatch(/masuk & dihitung \(agen fakeagent\)\. \[Omset belum terbaca: .*HTTP 404.*\]$/);
		// admin sudah memperbarui Last Result -> Ambil ulang berhasil: tanda lama DIGANTI
		const id = ((await autoInputTotals(env, op)) as unknown as { rows: { id: number }[] }).rows[0].id;
		const fixed = mockSite({ prediksi: { totals: ["5,000", "50", "0"] } });
		fixed.rows[0].period = 1630;
		fixed.rows[0].nums = ["9808"];
		expect(await autoInputTotalsRefresh(env, op, id, fixed.fetchFn)).toMatchObject({ success: true });
		expect(await jobDetail()).toBe("Periode 1630 FLORIDAEVE: angka 9808 masuk & dihitung (agen fakeagent). [Omset 5,000 · Referal 50 · Menang 0]");
	});
	it("job GAGAL tidak mendapat catatan omset (Keterangan galat apa adanya)", async () => {
		await run(mockSite({ ignoreKirimPost: true, prediksi: {} }));
		const j = (await listJobs(env, "Op"))[0];
		expect(j.status).toBe("FAILED");
		expect(j.detail).not.toContain("Omset");
		expect(((await autoInputTotals(env, op)) as unknown as { rows: unknown[] }).rows).toHaveLength(0);
	});
	it("user lain tidak bisa melihat / mengambil ulang baris ini", async () => {
		await run(mockSite({ prediksi: {} }));
		const id = ((await autoInputTotals(env, op)) as unknown as { rows: { id: number }[] }).rows[0].id;
		await expect(autoInputTotalsRefresh(env, op, 99999)).rejects.toThrow(/tidak ditemukan/);
		expect(id).toBeGreaterThan(0);
	});
	it("pemangkasan harian ikut membuang baris lama", async () => {
		await run(mockSite({ prediksi: {} }));
		const old = new Date(Date.now() + 7 * 3600_000 - 9 * 86400_000).toISOString().slice(0, 19).replace("T", " ");
		turso.current!.raw.prepare(`UPDATE auto_input_totals SET at = ?`).run(old);
		await pruneAutoInputJobs(env);
		expect(((await autoInputTotals(env, op)) as unknown as { rows: unknown[] }).rows).toHaveLength(0);
	});
});


describe("pasaran yang TIDAK di-auto: Omset tetap dipantau lewat menu Prediksi (hanya membaca)", () => {
	let env: Env;
	let op: string;
	const profile = { username: "Op", role: "OPERATOR", websites: ["HUGOTOGEL", "FOLATOTO"], menus: null } as unknown as UserProfile;
	beforeEach(async () => {
		setGlobalOffMarkets(["FLORIDAEVE"]); // saklar pasaran OFF = dihitung manual
		turso.current = fakeD1([]);
		resetAutoInputTablesFlag();
		const ctx = fakeEnv();
		env = ctx.env;
		ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status, websites) VALUES ('Op', 'op', ?, 'OPERATOR', 'AKTIF', ?)`).run(await hashPassword("pw"), JSON.stringify(["HUGOTOGEL", "FOLATOTO"]));
		op = ((await checkLogin(env, "Op", "pw", "")) as { sessionToken: string }).sessionToken;
		await setEnabled(env, "Op", true);
		await saveSession(env, "Op", "HUGOTOGEL", "https://ag.suksesbogil.com", "PHPSESSID=" + SID1);
	});
	const send = (sites = ["HUGOTOGEL"]) => autoInputAfterSend(env, profile, RAW, processText(RAW), sites);
	const rows = async () => ((await autoInputTotals(env, op)) as unknown as { rows: { id: number; website: string; pending: boolean; manual: boolean; period: string; omset: string; referal: string; menang: string; note: string }[] }).rows;
	const due = () => turso.current!.raw.exec(`UPDATE auto_input_totals SET next_at = '2000-01-01 00:00:00' WHERE pending = 1`);
	const adminPaths = (m: ReturnType<typeof mockSite>) => m.st.posts.map((x) => x.path);

	it("kirim: tidak menyentuh admin, hanya menjadwalkan; baris MENUNGGU tampil di Result; teks pemberitahuan menyebut pantauan", async () => {
		const m = mockSite({ prediksi: {} });
		const n = await send();
		expect(n?.skippedReason).toMatch(/tidak di-auto.*tetap dicek otomatis/);
		expect(m.st.posts).toHaveLength(0);
		expect(await rows()).toMatchObject([{ website: "HUGOTOGEL", pending: true, manual: true, period: "", omset: "" }]);
		await send(); // kirim ulang teks yang sama: tidak ada baris ganda
		expect(await rows()).toHaveLength(1);
	});
	it("Auto Prediksi dimatikan total: tetap dipantau (cek langsung dipicu), tanpa pemberitahuan 'dilewati'", async () => {
		await setEnabled(env, "Op", false);
		const n = await send();
		expect(n).toMatchObject({ results: [], totalsCheck: [{ website: "HUGOTOGEL" }] });
		expect(n?.skippedReason).toBeUndefined();
		expect(await rows()).toMatchObject([{ website: "HUGOTOGEL", pending: true, manual: true }]);
	});
	it("CEK LANGSUNG saat kirim: bila sudah dihitung di admin -> Total terbaca seketika (tanpa menunggu cron), cuma menu Prediksi yang disentuh", async () => {
		const m = mockSite({ prediksi: { totals: ["21,700", "0", "0"] } });
		m.rows.unshift({ period: 1630, date: "06-10-2026 21:00:00", nums: ["9808"] }); // operator sudah menginput & menghitung di admin
		const n = await send();
		const id = n!.totalsCheck![0].id;
		expect(await autoInputTotalsCheck(env, op, id, m.fetchFn)).toMatchObject({ success: true, done: true, message: "Terbaca: omset 21,700, referal 0, menang 0." });
		expect(await rows()).toMatchObject([{ pending: false, period: "1630", omset: "21,700", referal: "0", menang: "0", note: "" }]);
		expect(adminPaths(m).every((x) => x === "GET admin_prediksifullbb.php" || x === "admin_prediksifullbb.php")).toBe(true);
		expect(Object.fromEntries(m.st.posts.find((x) => x.path === "admin_prediksifullbb.php")!.body)).toMatchObject({ periode: "1630", nomor: "9808", submit: "Submit" });
		// klik ganda / cek lagi: tidak membaca ulang baris yang sudah selesai
		expect(await autoInputTotalsCheck(env, op, id, m.fetchFn)).toMatchObject({ done: false, message: "Sedang/sudah dicek." });
	});
	it("CEK LANGSUNG tetapi Last Result admin belum sama -> baris menampilkan FAKTA yang terbaca (bukan kalimat menunggu), pantau berlanjut diam-diam", async () => {
		const m = mockSite({ prediksi: {} });
		const n = await send();
		const r = await autoInputTotalsCheck(env, op, n!.totalsCheck![0].id, m.fetchFn);
		expect(r).toMatchObject({ done: false });
		const [row] = await rows();
		expect(row).toMatchObject({ pending: true, omset: "" });
		expect(row.note).toBe("Last Result di admin: periode 1629 angka 7283; menunggu 9808 dihitung");
		expect(m.st.posts.some((x) => x.path === "admin_prediksifullbb.php")).toBe(false); // belum cocok -> tidak ada Submit
	});
	it("cek langsung hanya untuk baris milik akun sendiri", async () => {
		const m = mockSite({ prediksi: {} });
		const n = await send();
		expect(await autoInputTotalsCheck(env, op, 987654, m.fetchFn)).toMatchObject({ done: false, message: "Sedang/sudah dicek." });
		expect(n!.totalsCheck).toHaveLength(1);
	});
	it("tick: Last Result belum angka ini -> TUNGGU (jadwal maju, tidak dibaca ulang sebelum waktunya); begitu dihitung -> Submit & baca Total; hanya menu Prediksi yang disentuh", async () => {
		const m = mockSite({ prediksi: { totals: ["21,700", "0", "0"] } });
		await send();
		expect(await autoInputTotalsTick(env, m.fetchFn)).toBe(true); // Last Result masih periode 1629 / 7283
		expect(await rows()).toMatchObject([{ pending: true, omset: "" }]);
		expect((await rows())[0].note).toMatch(/Last Result di admin: periode 1629 angka 7283; menunggu 9808/);
		expect(await autoInputTotalsTick(env, m.fetchFn)).toBe(false); // belum waktunya
		expect(m.st.posts.some((x) => x.path === "admin_prediksifullbb.php")).toBe(false); // belum cocok -> belum ada Submit
		// operator menginput & menghitung di admin
		m.rows.unshift({ period: 1630, date: "06-10-2026 21:00:00", nums: ["9808"] });
		due();
		expect(await autoInputTotalsTick(env, m.fetchFn)).toBe(true);
		expect(await rows()).toMatchObject([{ pending: false, manual: true, period: "1630", omset: "21,700", referal: "0", menang: "0", note: "" }]);
		const post = m.st.posts.find((x) => x.path === "admin_prediksifullbb.php")!;
		expect(Object.fromEntries(post.body)).toMatchObject({ periode: "1630", nomor: "9808", submit: "Submit" });
		// HANYA menu Prediksi: tidak ada Kirim / Hitung / halaman lain yang di-POST
		expect(adminPaths(m).every((x) => x === "GET admin_prediksifullbb.php" || x === "admin_prediksifullbb.php")).toBe(true);
		// tercatat di Riwayat Job (Keterangan) sebagai SELESAI; dipantau tidak berlanjut
		const j = (await listJobs(env, "Op"))[0];
		expect(j).toMatchObject({ status: "DONE", period: "1630" });
		expect(j.detail).toBe("Dihitung manual (pasaran tidak di-auto): FLORIDAEVE angka 9808 periode 1630. [Omset 21,700 · Referal 0 · Menang 0]");
		expect(await autoInputTotalsTick(env, m.fetchFn)).toBe(false);
	});
	it("pagar anti-input-ganda Auto Prediksi untuk hasil yang sama TIDAK terpakai oleh catatan manual", async () => {
		const m = mockSite({ prediksi: {} });
		await send();
		m.rows.unshift({ period: 1630, date: "06-10-2026 21:00:00", nums: ["9808"] });
		due();
		await autoInputTotalsTick(env, m.fetchFn);
		const keys = (turso.current!.raw.prepare(`SELECT result_key FROM auto_input_job`).all() as { result_key: string }[]).map((r) => r.result_key);
		expect(keys).toEqual(["FLORIDAEVE|2026-10-06|9808#manual"]);
		setGlobalOffMarkets([]); // pasaran di-auto lagi -> hasil yang sama masih boleh dijalankan Auto Prediksi
		const again = await send();
		expect(again?.results[0].status).toBe("ANTRI");
	});
	it("batas waktu habis -> berhenti dengan alasan, tercatat di Keterangan; 'Pantau lagi' mengaktifkan kembali", async () => {
		const m = mockSite({ prediksi: {} });
		await send();
		turso.current!.raw.exec(`UPDATE auto_input_totals SET until_at = '2000-01-01 00:00:00', next_at = '2000-01-01 00:00:00'`);
		await autoInputTotalsTick(env, m.fetchFn);
		const [r] = await rows();
		expect(r).toMatchObject({ pending: false, omset: "" });
		expect(r.note).toMatch(/^Sampai batas waktu tunggu: Last Result di admin/);
		expect((await listJobs(env, "Op"))[0].detail).toMatch(/\[Omset belum terbaca: Sampai batas waktu tunggu/);
		expect(await autoInputTotalsRefresh(env, op, r.id, m.fetchFn)).toMatchObject({ success: true });
		expect(await rows()).toMatchObject([{ pending: true, note: "" }]);
	});
	it("tanpa PHPSESSID: tidak bisa dibaca -> langsung selesai dengan alasan; website lain tetap dipantau", async () => {
		await send(["HUGOTOGEL", "FOLATOTO"]);
		const byWebsite = Object.fromEntries((await rows()).map((r) => [r.website, r]));
		expect(byWebsite.HUGOTOGEL.pending).toBe(true);
		expect(byWebsite.FOLATOTO).toMatchObject({ pending: false });
		expect(byWebsite.FOLATOTO.note).toMatch(/PHPSESSID FOLATOTO belum disimpan/);
	});
	it("pasaran yang DI-AUTO tidak dipantau manual (alur Auto Prediksi seperti biasa)", async () => {
		setGlobalOffMarkets([]);
		const m = mockSite({ prediksi: {} });
		const n = await send();
		expect(n?.results[0].status).toBe("ANTRI");
		expect(await rows()).toHaveLength(0);
		expect(m.st.posts).toHaveLength(0);
	});
	it("tanpa baris menunggu: tick tidak menyentuh admin sama sekali", async () => {
		let calls = 0;
		expect(await autoInputTotalsTick(env, async () => (calls++, new Response("x")))).toBe(false);
		expect(calls).toBe(0);
	});
});


describe("MATRIKS: apa pun keadaan Auto Prediksi, KIRIM SEMUA selalu berujung Total Omset/Referal/Menang terbaca & tercatat", () => {
	const profile = { username: "Op", role: "OPERATOR", websites: ["HUGOTOGEL"], menus: null } as unknown as UserProfile;
	const cases: { name: string; enabled: boolean; marketOff: boolean; auto: boolean }[] = [
		{ name: "Auto Prediksi ON, pasaran di-auto", enabled: true, marketOff: false, auto: true },
		{ name: "Auto Prediksi ON, pasaran DIMATIKAN", enabled: true, marketOff: true, auto: false },
		{ name: "Auto Prediksi OFF, pasaran di-auto", enabled: false, marketOff: false, auto: false },
		{ name: "Auto Prediksi OFF, pasaran dimatikan", enabled: false, marketOff: true, auto: false },
	];
	for (const c of cases) {
		it(c.name, async () => {
			setGlobalOffMarkets(c.marketOff ? ["FLORIDAEVE"] : []);
			turso.current = fakeD1([]);
			resetAutoInputTablesFlag();
			const ctx = fakeEnv();
			const env = ctx.env;
			ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status, websites) VALUES ('Op', 'op', ?, 'OPERATOR', 'AKTIF', ?)`).run(await hashPassword("pw"), JSON.stringify(["HUGOTOGEL"]));
			const op = ((await checkLogin(env, "Op", "pw", "")) as { sessionToken: string }).sessionToken;
			await setEnabled(env, "Op", c.enabled);
			await saveSession(env, "Op", "HUGOTOGEL", "https://ag.suksesbogil.com", "PHPSESSID=" + SID1);
			const m = mockSite({ prediksi: { totals: ["21,700", "0", "0"] } });
			if (!c.auto) m.rows.unshift({ period: 1630, date: "06-10-2026 21:00:00", nums: ["9808"] }); // sudah dihitung manual di admin
			const n = await autoInputAfterSend(env, profile, RAW, processText(RAW), ["HUGOTOGEL"]);
			if (c.auto) {
				await runQueuedJob(env, "Op", n!.results[0].jobId!, m.fetchFn);
				expect(m.st.calcPosts).toBe(1); // Auto Prediksi benar-benar Input + Hitung
			} else {
				await autoInputTotalsCheck(env, op, n!.totalsCheck![0].id, m.fetchFn);
				expect(m.st.calcPosts).toBe(0); // manual: TIDAK PERNAH menekan Hitung
				expect(m.st.posts.every((x) => x.path.includes("prediksi"))).toBe(true); // hanya menu Prediksi
			}
			const post = m.st.posts.find((x) => x.path === "admin_prediksifullbb.php")!;
			expect(Object.fromEntries(post.body)).toMatchObject({ periode: "1630", nomor: "9808", submit: "Submit" });
			const [row] = ((await autoInputTotals(env, op)) as unknown as { rows: { pending: boolean; period: string; omset: string; referal: string; menang: string }[] }).rows;
			expect(row).toMatchObject({ pending: false, period: "1630", omset: "21,700", referal: "0", menang: "0" });
			expect((await listJobs(env, "Op"))[0].detail).toContain("[Omset 21,700 · Referal 0 · Menang 0]");
		});
	}
});
