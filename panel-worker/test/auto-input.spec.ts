import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { autoInputAfterSend } from "../src/api/auto-input";
import { adminBaseProblem, defaultAdminBase, clearRetryable, resetAutoInputTablesFlag, getSessions, listJobs, parsePhpSessId, parseResultDate, planAutoInput, saveSession, setEnabled } from "../src/lib/auto-input";
import { parseAngkaPage, parseHitungPage, runAutoInput, buildPayload, parseForms } from "../src/lib/auto-input-run";
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
}
function mockSite(o: SiteOpts = {}) {
	const market = o.market ?? "FLORIDAEVE";
	const code = "p21545";
	const cols = o.prizeCols ?? 1;
	const rows = [{ period: o.lastPeriod ?? 1629, date: o.lastDate ?? "05-10-2026 08:52:09", nums: ["7283", "1111", "2222"].slice(0, cols) }];
	const st = { calc: false, posts: [] as { path: string; body: URLSearchParams }[], calcPosts: 0 };
	const nextPeriod = () => rows[0].period + 1;
	const opt = (n: number, sel: number) => Array.from({ length: n }, (_, i) => `<option value="${i + 1}"${i + 1 === sel ? " selected" : ""}>${i + 1}</option>`).join("");
	const angka = () => `<html><body><div>HUGOTOGEL.COM</div>
<select style="width:100%" onchange="gantipasar(this.value)"><option>Pilih Pasar</option>
<option value="ARIZONA,p33190">ARIZONA</option><option value="${market},${code}">${market}</option>
<option style="display:none;" id="paramp21545" value="pool-14-0-1-"></option></select>
<h2>Silahkan isi Angka baru ${market}</h2>
<form method="post" action="admin_angka13.php?psr=${code}">Tanggal
<select name="tgl">${opt(31, o.formDay ?? 6)}</select><select name="bln">${opt(12, 10)}</select>
<select name="thn"><option value="2025">2025</option><option value="2026" selected>2026</option></select>
Periode <input type="text" name="periode" value="${o.formPeriod ?? nextPeriod()}">
Nomor Keluar ${Array.from({ length: cols }, (_, i) => `<input type="text" name="${cols === 1 ? "angka" : "prize" + (i + 1)}" maxlength="4" value="${o.prefilled ? "1234" : ""}">`).join("")}
<input type="hidden" name="tok" value="abc123">
<input name="cmdsend" type="button" onclick="return myFunction('${market}');" value="&nbsp;Kirim&nbsp;">
<input type="submit" name="cmdhapus" value="Hapus"></form>
<h3>Daftar  Nomor ${market}</h3><table><tr><th>No</th><th>Tanggal</th><th>Hari</th><th>Periode</th>${Array.from({ length: cols }, (_, i) => `<th>Nomor Keluar ${i + 1}</th>`).join("")}<th>Hitung</th></tr>
${rows.map((r, i) => `<tr><td>${i + 1}</td><td><input value="${r.date}"><input type="button" value="E"></td><td>Senin</td><td>${r.period}</td>${r.nums.map((n) => `<td><input value="${n}"></td>`).join("")}<td>Yes</td></tr>`).join("")}
</table></body></html>`;
	const hitung = () =>
		`<html><body><select onchange="gantipasar(this.value)"><option value="${market},${code}">${market}</option></select>
(vldaa) TOTO Periode : ${rows[0].period} - ${market} - (${code}) Terdapat Invoice Pemenang : 0 Nomor Keluar : ${o.hitungShows ?? rows[0].nums.join(" ")}
${st.calc ? "" : `<form method="post" action="admin_hitungtimte.php?psr=${code}"><input type="hidden" name="per" value="${rows[0].period}"><input type="submit" name="cmdhitung" id="xxx" onclick="hilang()" value="Hitung Periode : ${rows[0].period} - ${market}"></form>`}</body></html>`;
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
				st.posts.push({ path, body });
				if (!o.ignoreKirimPost && body.get("periode") === String(nextPeriod())) {
					const nums = Array.from({ length: cols }, (_, i) => body.get(cols === 1 ? "angka" : "prize" + (i + 1)) ?? "");
					rows.unshift({ period: nextPeriod(), date: "06-10-2026 21:00:00", nums });
				}
			}
			return html(angka());
		}
		if (path === "admin_hitungtimte.php") {
			if (isPost) {
				st.posts.push({ path, body });
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
		expect(parseAngkaPage(await html({ prizeCols: 3 }), p).prizeFields).toEqual(["prize1", "prize2", "prize3"]);
	});
});

describe("runAutoInput", () => {
	it("uji kering: validasi lolos, TIDAK ada POST", async () => {
		const m = mockSite();
		const r = await runAutoInput({ session: sess, plan: plan(), dryRun: true, fetchFn: m.fetchFn });
		expect(r.ok).toBe(true);
		expect(m.st.posts).toHaveLength(0);
		expect(r.preview).toMatchObject({ code: "p21545", fields: { angka: "9808", periode: "1630", tok: "abc123" } });
	});
	it("alur penuh: Kirim -> verifikasi -> Hitung; payload membawa field tersembunyi & TIDAK membawa Hapus", async () => {
		const m = mockSite();
		const stages: string[] = [];
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: m.fetchFn, onStage: async (s) => void stages.push(s) });
		expect(r).toMatchObject({ ok: true, stage: "selesai", period: "1630" });
		expect(stages).toEqual(["kirim", "hitung"]);
		expect(Object.fromEntries(m.st.posts[0].body)).toEqual({ tgl: "6", bln: "10", thn: "2026", periode: "1630", angka: "9808", tok: "abc123" });
		expect(m.st.calcPosts).toBe(1);
		expect(m.st.posts[1].body.get("cmdhitung")).toContain("Hitung Periode");
	});
	it("Kirim tak berefek -> coba sekali lagi dgn tombol, lalu berhenti di tahap kirim, Hitung TIDAK dijalankan", async () => {
		const m = mockSite({ ignoreKirimPost: true });
		const r = await runAutoInput({ session: sess, plan: plan(), fetchFn: m.fetchFn });
		expect(r).toMatchObject({ ok: false, stage: "kirim" });
		expect(m.st.posts).toHaveLength(2);
		expect(m.st.posts[1].body.get("cmdsend")).toBeTruthy();
		expect(m.st.calcPosts).toBe(0);
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
	it("cocokkan website dengan host-nya", () => {
		const ok = (w: string, u: string) => adminBaseProblem(w, u);
		expect(ok("HUGOTOGEL", "https://ag.suksesbogil.com/")).toBeNull();
		expect(ok("FOLATOTO", "https://agwl12.suksesbogil.com/")).toBeNull();
		expect(ok("WEBKETIGA", "https://agwl5.suksesbogil.com/")).toBeNull();
		expect(ok("HUGOTOGEL", "https://agwl12.suksesbogil.com/")).toMatch(/harus memakai/);
		expect(ok("FOLATOTO", "https://agwl5.suksesbogil.com/")).toMatch(/harus memakai/);
		expect(ok("WEBKETIGA", "https://ag.suksesbogil.com/")).toMatch(/milik website lain/);
		expect(ok("HUGOTOGEL", "https://evil.example.com/")).toMatch(/bukan salah satu/);
		expect(ok("HUGOTOGEL", "https://ag.suksesbogil.com.evil.com/")).toMatch(/bukan salah satu/);
		expect(ok("HUGOTOGEL", "http://ag.suksesbogil.com/")).toMatch(/https/);
		expect(defaultAdminBase("FOLATOTO")).toBe("https://agwl12.suksesbogil.com/");
	});
	it("saveSession menolak host salah & mengisi default kalau URL kosong", async () => {
		turso.current = fakeD1([]);
		resetAutoInputTablesFlag();
		const env = fakeEnv().env;
		await expect(saveSession(env, "Op", "HUGOTOGEL", "https://agwl12.suksesbogil.com", SID1)).rejects.toThrow(/harus memakai/);
		await expect(saveSession(env, "Op", "HUGOTOGEL", "https://evil.example.com", SID1)).rejects.toThrow(/bukan salah satu/);
		await saveSession(env, "Op", "FOLATOTO", "", SID2);
		expect((await getSessions(env, "Op"))[0].baseUrl).toBe("https://agwl12.suksesbogil.com/");
	});
	it("URL tersimpan yang melenceng ditolak saat dijalankan (tidak ada request sama sekali)", async () => {
		let hits = 0;
		const r = await runAutoInput({ session: { ...sess, baseUrl: "https://agwl12.suksesbogil.com/" }, plan: plan(), fetchFn: async () => (hits++, new Response("")) });
		expect(r).toMatchObject({ ok: false, stage: "cek" });
		expect(hits).toBe(0);
	});
	it("PHPSESSID milik website lain (halaman bukan HUGOTOGEL.COM) ditolak", async () => {
		const m = mockSite();
		const f = async (u: string, i?: RequestInit) => new Response((await (await m.fetchFn(u, i)).text()).replace("HUGOTOGEL.COM", "FOLATOTO.COM"));
		expect(await runAutoInput({ session: sess, plan: plan(), fetchFn: f })).toMatchObject({ ok: false, stage: "cek" });
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
	const go = (m: ReturnType<typeof mockSite>, text = RAW, sites = ["HUGOTOGEL"]) => autoInputAfterSend(env, profile, text, processText(text), sites, m.fetchFn);
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
		expect(await autoInputAfterSend(env, { ...profile, role: "VIEWER" } as UserProfile, RAW, processText(RAW), ["HUGOTOGEL"], m.fetchFn)).toBeUndefined();
	});
	it("saveSession: banyak website, input kosong = pertahankan yang lama, URL http ditolak", async () => {
		await saveSession(env, "Op", "HUGOTOGEL", "https://ag.suksesbogil.com", "PHPSESSID=" + SID1);
		await saveSession(env, "Op", "FOLATOTO", "agwl12.suksesbogil.com", SID2);
		await saveSession(env, "Op", "HUGOTOGEL", "https://ag.suksesbogil.com/index.php", "");
		const s = await getSessions(env, "Op");
		expect(s.map((x) => [x.website, x.baseUrl, x.phpsessid])).toEqual([
			["FOLATOTO", "https://agwl12.suksesbogil.com/", SID2],
			["HUGOTOGEL", "https://ag.suksesbogil.com/", SID1],
		]);
		await expect(saveSession(env, "Op", "X", "http://ag.suksesbogil.com", SID2)).rejects.toThrow(/https/);
		await expect(saveSession(env, "Op", "X", "https://agwl5.suksesbogil.com", "bad")).rejects.toThrow(/PHPSESSID/);
	});
});
