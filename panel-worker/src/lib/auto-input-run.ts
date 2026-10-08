// Eksekutor "Auto Prediksi": menjalankan alur admin website langsung dari Worker
// memakai PHPSESSID tersimpan --
//   1. cari kode pasaran (pNNNN) di dropdown pasaran website itu,
//   2. buka halaman NOMOR KELUAR (admin_angka13.php), VALIDASI, lalu kirim form,
//   3. buka halaman HITUNG (admin_hitungtimte.php), VALIDASI, lalu kirim form.
//
// Form TIDAK ditebak: field & nilai (tanggal, periode, field tersembunyi) dibaca
// dari HTML halamannya sendiri lalu dikirim ulang persis, hanya kolom angka yang
// diisi. Menghitung membayar pemenang dan tidak bisa ditarik, jadi SETIAP langkah
// yang mengubah data didahului validasi dan diikuti pembacaan ulang:
//   * pasaran di halaman = pasaran result; tanggal form = tanggal result;
//   * periode form = periode terakhir di tabel + 1; tanggal baris terakhir < tanggal result;
//   * kolom angka kosong & jumlahnya <= jumlah prize di teks;
//   * sesudah Kirim: baris teratas tabel HARUS periode baru dgn angka yang sama;
//   * sebelum Hitung: halaman Hitung HARUS menunjukkan periode, pasaran, kode pasaran
//     & angka yang sama (juga field tersembunyi per / nomor / sar); sesudahnya tombol
//     Hitung HARUS sudah hilang.
// Bentuk request mengikuti request ASLI browser (DevTools): Kirim = POST admin_angka13.php
// (tgl,bln,thn,periode,angka[,angka2,angka3],psr); Hitung = POST admin_hitungtimte.php
// (per,nomor,sar,cmdhitung). Keduanya tanpa query string.
// Ada yang meleset -> berhenti dan lapor, TIDAK mencoba "kira-kira".
import { parsePasaranOptionsHtml, investIsLoginPage } from "./invest";
import { adminBaseProblem, cookieHeader, normMarket, siteBrand, type AdminSession, type AutoInputPlan } from "./auto-input";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type Plan = Extract<AutoInputPlan, { ok: true }>;

export interface RunOutcome {
	ok: boolean;
	/** tahap terakhir yang DICAPAI: cek | kirim | hitung | selesai. Selain 'cek' = admin sudah disentuh. */
	stage: "cek" | "kirim" | "hitung" | "selesai";
	detail: string;
	period: string;
	/** hanya dryRun: yang AKAN dikirim. */
	preview?: Record<string, unknown>;
}

class Stop extends Error {
	constructor(
		msg: string,
		readonly stage: RunOutcome["stage"],
	) {
		super(msg);
	}
}

// ---------------------------------------------------------------------------
// Parser HTML kecil (regex) -- cukup untuk halaman admin yang sederhana ini.
// ---------------------------------------------------------------------------
export function decodeEntities(s: string): string {
	return String(s ?? "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&quot;/gi, '"')
		.replace(/&#0?39;|&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&amp;/gi, "&");
}

function attr(tag: string, name: string): string | null {
	const m = tag.match(new RegExp(`(?:^|[\\s"'])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
	return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
}
const hasFlag = (tag: string, name: string) => new RegExp(`\\s${name}(?:\\s|=|>|/|$)`, "i").test(tag);

/** Judul tabel: "Daftar  Nomor X" -- spasinya sering berupa &nbsp; di HTML aslinya. */
const DAFTAR_RE = /Daftar(?:\s|&nbsp;|&#160;|\u00a0)+Nomor/i;

export interface FormInput {
	name: string;
	type: string;
	value: string;
	id: string;
	maxlength: number;
	readonly: boolean;
	checked: boolean;
}
export interface FormSelect {
	name: string;
	options: { value: string; label: string }[];
	selected: string;
}
export interface ParsedForm {
	action: string;
	method: string;
	inputs: FormInput[];
	selects: FormSelect[];
}

export function parseForms(html: string): ParsedForm[] {
	const out: ParsedForm[] = [];
	const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		const head = m[1];
		const body = m[2];
		const inputs: FormInput[] = [];
		for (const im of body.matchAll(/<input\b([^>]*)>/gi)) {
			const tag = im[1];
			inputs.push({
				name: attr(tag, "name") ?? "",
				type: (attr(tag, "type") ?? "text").toLowerCase(),
				value: attr(tag, "value") ?? "",
				id: attr(tag, "id") ?? "",
				maxlength: Number(attr(tag, "maxlength") ?? 0) || 0,
				readonly: hasFlag(tag, "readonly") || hasFlag(tag, "disabled"),
				checked: hasFlag(tag, "checked"),
			});
		}
		const selects: FormSelect[] = [];
		for (const sm of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
			const options: { value: string; label: string }[] = [];
			let selected = "";
			let firstVal: string | null = null;
			for (const om of sm[2].matchAll(/<option\b([^>]*)>([^<]*)/gi)) {
				const label = decodeEntities(om[2]).trim();
				const value = attr(om[1], "value") ?? label;
				options.push({ value, label });
				if (firstVal === null) firstVal = value;
				if (hasFlag(om[1], "selected")) selected = value;
			}
			selects.push({ name: attr(sm[1], "name") ?? "", options, selected: selected || firstVal || "" });
		}
		out.push({
			action: attr(head, "action") ?? "",
			method: (attr(head, "method") ?? "get").toLowerCase(),
			inputs,
			selects,
		});
	}
	return out;
}

export function htmlText(html: string): string {
	return decodeEntities(
		html
			.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
			.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]*>/g, " "),
	)
		.replace(/ /g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const squash = (s: string) => normMarket(s).replace(/\s+/g, "");

/** Cari kode pasaran di dropdown pasaran. Nama harus SAMA PERSIS (spasi diabaikan) -- tidak ada tebakan prefix. */
export function findPoolCode(html: string, market: string): string | null {
	const want = squash(market);
	const hit = parsePasaranOptionsHtml(html).filter(([, name]) => squash(name) === want);
	return hit.length === 1 ? hit[0][0] : null;
}

interface TableRow {
	cells: string[];
}
export interface ResultTable {
	headers: string[];
	rows: TableRow[];
}

/** Tabel "Daftar Nomor ..." (nilai <input> di dalam sel ikut dibaca). */
export function parseResultTable(html: string): ResultTable | null {
	const at = html.search(DAFTAR_RE);
	if (at < 0) return null;
	const rest = html.slice(at);
	const tm = rest.match(/<table\b[\s\S]*?<\/table>/i);
	if (!tm) return null;
	const rowsRaw = tm[0].match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];
	const parsed = rowsRaw.map((r) =>
		[...r.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => {
			const inp = c[1].match(/<input\b([^>]*)>/i);
			const v = inp ? (attr(inp[1], "value") ?? "") : htmlText(c[1]);
			return v.trim();
		}),
	);
	const hi = parsed.findIndex((cells) => cells.some((c) => /^periode$/i.test(c)));
	if (hi < 0) return null;
	return { headers: parsed[hi], rows: parsed.slice(hi + 1).filter((c) => /^\d+$/.test(c[0] ?? "")).map((cells) => ({ cells })) };
}

export function topRow(t: ResultTable): { period: number; date: string; numbers: string[] } | null {
	const pi = t.headers.findIndex((h) => /^periode$/i.test(h));
	const di = t.headers.findIndex((h) => /^tanggal$/i.test(h));
	const ni = t.headers.map((h, i) => (/^nomor\s*keluar/i.test(h) ? i : -1)).filter((i) => i >= 0);
	const r = t.rows[0];
	if (!r || pi < 0 || !ni.length) return null;
	const period = Number((r.cells[pi] ?? "").replace(/\D/g, ""));
	if (!Number.isFinite(period) || !period) return null;
	// "05-10-2026 08:52:09" -> 2026-10-05
	const dm = (r.cells[di] ?? "").match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
	const date = dm ? `${dm[3]}-${dm[2].padStart(2, "0")}-${dm[1].padStart(2, "0")}` : "";
	return { period, date, numbers: ni.map((i) => (r.cells[i] ?? "").trim()) };
}

/** Isi <input> ikut jadi teks (htmlText membuangnya), supaya nilai kolom tabel terbaca. */
function textWithInputs(html: string): string {
	return htmlText(html.replace(/<input\b([^>]*)>/gi, (_m, a) => " " + (attr(a, "value") ?? "") + " "));
}

/**
 * Cadangan kalau struktur <table> tidak terbaca (tag tidak ditutup, judul di dalam tabel, dsb):
 * baca baris teratas dari TEKS di bawah "Daftar Nomor ...". Kolom: No, Tanggal(jam), E, Hari, Periode, Nomor Keluar 1..N.
 */
export function topRowFromText(html: string): { period: number; date: string; numbers: string[] } | null {
	const at = html.search(DAFTAR_RE);
	if (at < 0) return null;
	const t = textWithInputs(html.slice(at));
	const hm = t.match(/Periode\s+((?:Nomor\s+Keluar\s*\d*\s*)+)Hitung/i);
	if (!hm) return null;
	const cols = (hm[1].match(/Nomor\s+Keluar/gi) ?? []).length;
	const after = t.slice((hm.index ?? 0) + hm[0].length);
	const rm = after.match(
		new RegExp(`\\b1\\s+(\\d{1,2})-(\\d{1,2})-(\\d{4})\\s+\\d{1,2}:\\d{2}(?::\\d{2})?\\s+(?:E\\s+)?[A-Za-z]+\\s+(\\d+)((?:\\s+\\d{3,6}){${cols}})`),
	);
	if (!rm) return null;
	return {
		period: Number(rm[4]),
		date: `${rm[3]}-${rm[2].padStart(2, "0")}-${rm[1].padStart(2, "0")}`,
		numbers: rm[5].trim().split(/\s+/),
	};
}

/** Baris teratas "Daftar Nomor": dari struktur tabel, kalau gagal dari teks. */
export function readTopRow(html: string): { period: number; date: string; numbers: string[] } | null {
	const t = parseResultTable(html);
	return (t && topRow(t)) || topRowFromText(html);
}

export interface AngkaPage {
	form: ParsedForm;
	period: number;
	prizeFields: string[]; // nama field kolom angka, berurutan
	prev: { period: number; date: string; numbers: string[] };
}

const isKirim = (i: FormInput) =>
	(i.type === "button" || i.type === "submit") && i.value.replace(/ /g, " ").trim().toLowerCase() === "kirim";

/** Validasi halaman NOMOR KELUAR. Lempar Stop('cek') kalau ada yang tidak persis sesuai. */
export function parseAngkaPage(html: string, plan: Plan): AngkaPage {
	const fail = (msg: string): never => {
		throw new Stop(msg, "cek");
	};
	const h = htmlText(html).match(/Silahkan isi Angka baru\s+(.+?)\s+(?:Tanggal|Periode|Nomor)/i);
	if (!h) fail("Halaman Nomor Keluar tidak dikenali (judul 'Silahkan isi Angka baru' tidak ada) — sesi mungkin habis atau tampilan situs berubah.");
	if (squash(h![1]) !== squash(plan.market)) fail(`Pasaran di halaman "${h![1]}" ≠ pasaran result "${plan.market}".`);

	const forms = parseForms(html).filter((f) => f.inputs.some(isKirim));
	if (forms.length !== 1) fail(`Form dengan tombol Kirim ditemukan ${forms.length}x (harus tepat 1).`);
	const form = forms[0];

	const pIn = form.inputs.filter((i) => /period/i.test(i.name) || /period/i.test(i.id));
	if (pIn.length !== 1) fail("Kolom Periode tidak ditemukan / ganda di form.");
	const period = Number(pIn[0].value.replace(/\D/g, ""));
	if (!period) fail("Nilai Periode di form kosong.");

	// Tanggal: tiga <select> (hari / bulan / tahun) dikenali dari isi opsinya, bukan dari namanya.
	let d = 0,
		mo = 0,
		y = 0;
	for (const s of form.selects) {
		const nums = s.options.map((o) => Number(o.value)).filter((n) => Number.isFinite(n));
		const sel = Number(s.selected);
		if (nums.some((n) => n >= 1000)) y = sel;
		else if (nums.length && Math.max(...nums) === 12) mo = sel;
		else if (nums.length && Math.max(...nums) >= 28 && Math.max(...nums) <= 31) d = sel;
	}
	if (!d || !mo || !y) fail("Pilihan tanggal (hari/bulan/tahun) di form tidak terbaca.");
	const formDate = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
	if (formDate !== plan.date) fail(`Tanggal form ${formDate} ≠ tanggal result ${plan.date}. Input manual.`);

	const prize = form.inputs.filter(
		(i) =>
			(i.type === "text" || i.type === "number" || i.type === "tel") &&
			!i.readonly &&
			i !== pIn[0] &&
			(/angka|prize|nomor/i.test(i.name + " " + i.id) || (i.maxlength >= 4 && i.maxlength <= 6)),
	);
	if (!prize.length) fail("Kolom angka tidak ditemukan di form.");
	if (prize.some((i) => !i.name)) fail("Ada kolom angka tanpa atribut name — tidak bisa dikirim dengan aman.");
	if (prize.some((i) => i.value.trim() !== "")) fail("Kolom angka sudah terisi — kemungkinan angka sudah pernah diinput. Cek manual.");
	if (prize.length > plan.prizes.length) {
		fail(`Pasaran ini butuh ${prize.length} angka, teks result hanya punya ${plan.prizes.length} prize.`);
	}
	for (const p of prize.slice(0, plan.prizes.length)) {
		if (p.maxlength && p.maxlength < plan.prizes[0].length) fail("Panjang kolom angka tidak cocok dengan prize.");
	}

	const prev = readTopRow(html);
	if (!prev) {
		const at = html.search(DAFTAR_RE);
		const seen = at < 0 ? "judul 'Daftar Nomor' tidak ditemukan" : textWithInputs(html.slice(at)).slice(0, 260);
		fail(`Tabel Daftar Nomor / baris periode sebelumnya tidak terbaca. Yang terbaca: "${seen}"`);
	}
	if (prev!.period + 1 !== period) fail(`Periode form ${period} ≠ periode terakhir ${prev!.period} + 1. Ada periode terlewat / sudah terinput.`);
	if (!prev!.date || prev!.date >= plan.date) fail(`Baris terakhir bertanggal ${prev!.date || "?"} (≥ ${plan.date}) — result hari ini kemungkinan sudah terinput.`);

	return { form, period, prizeFields: prize.map((p) => p.name), prev: prev! };
}

export interface HitungPage {
	form: ParsedForm;
	button: FormInput;
	period: number;
	market: string;
	code: string;
	numbers: string[];
}

export function parseHitungPage(html: string): HitungPage | null {
	const t = htmlText(html);
	const pm = t.match(/Periode\s*:?\s*(\d+)\s*-\s*(.+?)\s*-\s*\((p\d+)\)/i);
	const nm = t.match(/Nomor Keluar\s*:?\s*([\d][\d\s,\-]*)/i);
	const forms = parseForms(html).filter((f) => f.inputs.some((i) => /^cmdhitung$/i.test(i.name)));
	if (!pm || !nm || forms.length !== 1) return null;
	const button = forms[0].inputs.find((i) => /^cmdhitung$/i.test(i.name))!;
	return { form: forms[0], button, period: Number(pm[1]), market: pm[2].trim(), code: pm[3], numbers: nm[1].match(/\d+/g) ?? [] };
}

/** Isi form sebagaimana browser: semua field bernama, kecuali tombol (selain yang dipilih). */
export function buildPayload(form: ParsedForm, fill: Record<string, string>, button?: FormInput): URLSearchParams {
	const body = new URLSearchParams();
	for (const i of form.inputs) {
		if (!i.name) continue;
		if (i.type === "button" || i.type === "submit" || i.type === "reset" || i.type === "image" || i.type === "file") continue;
		if ((i.type === "checkbox" || i.type === "radio") && !i.checked) continue;
		body.append(i.name, Object.prototype.hasOwnProperty.call(fill, i.name) ? fill[i.name] : i.value);
	}
	for (const s of form.selects) if (s.name) body.append(s.name, s.selected);
	if (button?.name) body.append(button.name, button.value);
	return body;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export async function adminReq(
	f: Fetcher,
	sess: AdminSession,
	path: string,
	init: { method?: "GET" | "POST"; body?: URLSearchParams; referer?: string } = {},
	/** Diisi apa adanya (status akhir + rantai redirect) untuk diagnostik kalau halaman yang diterima aneh. */
	meta?: { status: number; trail: string[] },
): Promise<string> {
	let url = new URL(path, sess.baseUrl).toString();
	if (meta) meta.trail = [new URL(url).pathname + new URL(url).search];
	let method = init.method ?? "GET";
	let body = init.body;
	for (let hop = 0; hop < 4; hop++) {
		const headers: Record<string, string> = {
			Cookie: cookieHeader(sess.phpsessid),
			"User-Agent": UA,
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8",
			Referer: init.referer || sess.baseUrl,
		};
		if (method === "POST") {
			headers["Content-Type"] = "application/x-www-form-urlencoded";
			headers.Origin = new URL(sess.baseUrl).origin;
		}
		const res = await f(url, { method, headers, body: method === "POST" ? body!.toString() : undefined, redirect: "manual" });
		const loc = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && loc) {
			url = new URL(loc, url).toString();
			meta?.trail.push(res.status + " -> " + new URL(url).pathname + new URL(url).search);
			method = "GET"; // 301/302/303 sesudah POST -> GET (perilaku browser)
			body = undefined;
			continue;
		}
		const text = await res.text();
		if (meta) meta.status = res.status;
		if (res.status >= 400) throw new Error(`HTTP ${res.status} dari ${new URL(url).pathname}`);
		if (investIsLoginPage("", text)) throw new Stop("Sesi (PHPSESSID) sudah habis — ambil yang baru dari Chrome lalu simpan di menu Auto Prediksi.", "cek");
		return text;
	}
	throw new Error("Terlalu banyak redirect.");
}

/**
 * index.php admin berupa FRAMESET (halamannya hanya berjudul "Administration"); sidebar
 * dengan nama website & dropdown pasaran ada di frame. Ambil alamat frame same-origin.
 */
export function frameSources(html: string, pageUrl: string): string[] {
	const out: string[] = [];
	const base = new URL(pageUrl);
	for (const m of html.matchAll(/<i?frame\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
		const raw = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "").trim();
		if (!raw || /^(javascript|about|data|mailto):/i.test(raw)) continue;
		try {
			const u = new URL(raw, base);
			if (u.origin !== base.origin) continue;
			const rel = u.pathname.replace(/^\//, "") + u.search;
			if (!out.includes(rel)) out.push(rel);
		} catch {
			/* abaikan */
		}
	}
	return out.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Alur utama
// ---------------------------------------------------------------------------
export async function runAutoInput(opts: {
	session: AdminSession;
	plan: Plan;
	dryRun?: boolean;
	fetchFn?: Fetcher;
	/** Percobaan ULANG: bila angka PERSIS ini sudah ada di baris teratas tabel untuk periode ini, lewati Kirim (tidak pernah input dobel) dan lanjut Hitung. */
	resumePeriod?: string;
	/** dipanggil SEBELUM langkah yang mengubah data -- supaya tahap tersimpan walau Worker mati. */
	onStage?: (stage: "kirim" | "hitung", period: string) => Promise<void>;
}): Promise<RunOutcome> {
	const f: Fetcher = opts.fetchFn ?? ((u, i) => fetch(u, i));
	const { session: sess, plan } = opts;
	let stage: RunOutcome["stage"] = "cek";
	let period = "";
	try {
		// 0. URL tersimpan harus tetap salah satu dari tiga admin yang diizinkan & cocok dengan websitenya.
		const badBase = adminBaseProblem(sess.website, sess.baseUrl);
		if (badBase) throw new Stop(`URL admin ${sess.website} ditolak: ${badBase}.`, "cek");

		// 1. kode pasaran
		const homeMeta = { status: 0, trail: [] as string[] };
		const index = await adminReq(f, sess, "index.php", {}, homeMeta);
		// Frame (sidebar, dropdown pasaran) dibaca juga; gagal-baca satu frame tidak menghentikan (sesi habis tetap berhenti).
		const frames = frameSources(index, new URL("index.php", sess.baseUrl).toString());
		let home = index;
		for (const src of frames) {
			try {
				home += "\n" + (await adminReq(f, sess, src, { referer: new URL("index.php", sess.baseUrl).toString() }));
			} catch (e) {
				if (e instanceof Stop) throw e;
			}
		}
		// Sudah login? Sidebar admin menampilkan "Agent (<nama agen>)". Nama WEBSITE ("HUGOTOGEL.COM") sengaja
		// TIDAK dijadikan syarat: tulisan itu dirender dari cookie "<agen>=HUGOTOGEL.COM" yang tidak ikut
		// kalau yang disimpan cuma PHPSESSID. Salah-website tidak mungkin: host dikunci per website
		// (adminBaseProblem) dan PHPSESSID hanya sah di host penerbitnya.
		const who = htmlText(home).match(/Agent\s*\(([^)\s]{2,40})\)/i)?.[1];
		if (!who) {
			const title = (index.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
			const body = htmlText(home).slice(0, 220);
			throw new Stop(
				`Server tidak dianggap sedang login di ${sess.website} (sidebar "Agent (...)" tidak ada) — PHPSESSID salah/habis, atau kurang cookie lain. ` +
					`Yang diterima server: HTTP ${homeMeta.status} [${homeMeta.trail.join(" ")}] frame [${frames.join(", ") || "tidak ada"}] judul "${title}" isi "${body}"`,
				"cek",
			);
		}
		// Satu host bisa melayani beberapa website. Kalau sidebar menampilkan nama website ("SENJATOGEL.COM" --
		// muncul bila cookie lengkap) dan BEDA dari website baris ini, berhenti: cookie salah tempat.
		const shownBrand = htmlText(home).toUpperCase().match(/AGENT\s*\([^)]*\)\s*([A-Z0-9]{2,20}(?:TOGEL|TOTO))\.COM/)?.[1];
		const wantBrand = siteBrand(sess.website);
		if (shownBrand && wantBrand && shownBrand !== wantBrand) {
			throw new Stop(`Cookie ini milik ${shownBrand}.COM (agen ${who}), bukan ${wantBrand} — tempel cookie admin ${wantBrand} di baris ${sess.website}.`, "cek");
		}
		const code = findPoolCode(home, plan.market);
		if (!code) throw new Stop(`Pasaran "${plan.market}" tidak ditemukan (atau ganda) di dropdown website ini.`, "cek");

		// 2. halaman Nomor Keluar + validasi
		const angkaPath = `admin_angka13.php?psr=${code}`;
		const angkaHtml = await adminReq(f, sess, angkaPath);
		let page: AngkaPage | null = null;
		let used = plan.prizes;
		let skipKirim = false;
		if (opts.resumePeriod && !opts.dryRun) {
			// Percobaan ulang setelah gagal di tengah: kalau angka sudah masuk untuk periode itu, jangan Kirim lagi.
			const top = readTopRow(angkaHtml);
			const want = plan.prizes.slice(0, top?.numbers.length ?? 0);
			if (top && String(top.period) === opts.resumePeriod && want.length > 0 && want.every((n, i) => top.numbers[i] === n)) {
				skipKirim = true;
				used = want;
				period = String(top.period);
			}
		}
		if (!skipKirim) page = parseAngkaPage(angkaHtml, plan);
		const pagePeriod = skipKirim ? Number(period) : page!.period;
		if (page) {
			period = String(page.period);
			used = plan.prizes.slice(0, page.prizeFields.length);
		}
		const fill: Record<string, string> = {};
		page?.prizeFields.forEach((n, i) => (fill[n] = used[i]));

		// Persis seperti request asli browser: field form + psr (hidden), TANPA nilai tombol.
		const kirimBody = () => {
			const b = buildPayload(page!.form, fill);
			if (!b.has("psr")) b.set("psr", code);
			return b;
		};

		if (opts.dryRun) {
			const payload = kirimBody();
			return {
				ok: true,
				stage: "cek",
				period,
				detail: `Uji kering OK: login sebagai (${who})${shownBrand ? " di " + shownBrand + ".COM" : ""}, ${plan.market} (${code}) periode ${period}, angka ${used.join("/")} — validasi lolos, TIDAK ada yang dikirim.`,
				preview: { code, post: "admin_angka13.php", fields: Object.fromEntries(payload), prev: page!.prev },
			};
		}

		// 3. Kirim -- dari sini admin DISENTUH.
		if (!skipKirim) {
			await opts.onStage?.("kirim", period);
			stage = "kirim";
			const verifyEntered = async () => {
				const top = readTopRow(await adminReq(f, sess, angkaPath));
				return !!top && top.period === pagePeriod && used.every((n, i) => top.numbers[i] === n);
			};
			// Satu kali saja (tidak ada percobaan ulang): request asli browser POST ke admin_angka13.php tanpa query.
			await adminReq(f, sess, "admin_angka13.php", { method: "POST", body: kirimBody(), referer: new URL(angkaPath, sess.baseUrl).toString() });
			if (!(await verifyEntered())) throw new Stop("Form Nomor Keluar sudah dikirim tapi angka TIDAK muncul di tabel — cek manual.", "kirim");
		}

		// 4. Hitung -- validasi ulang dari halamannya sendiri.
		await opts.onStage?.("hitung", period);
		stage = "hitung";
		const hitungPath = `admin_hitungtimte.php?psr=${code}`;
		const hp = parseHitungPage(await adminReq(f, sess, hitungPath));
		if (!hp) throw new Stop("Angka sudah MASUK, tapi halaman Hitung tidak dikenali — tekan Hitung manual.", "hitung");
		// Field tersembunyi form Hitung (per / nomor / sar pada request asli) harus cocok juga.
		const hv = (n: string) => hp.form.inputs.find((i) => i.name === n)?.value;
		const bad =
			hp.period !== pagePeriod ? `periode ${hp.period} ≠ ${pagePeriod}`
			: squash(hp.market) !== squash(plan.market) ? `pasaran ${hp.market} ≠ ${plan.market}`
			: hp.code !== code ? `kode ${hp.code} ≠ ${code}`
			: !hp.numbers.length || hp.numbers.some((n, i) => i < used.length && n !== used[i]) ? `angka ${hp.numbers.join("/") || "-"} ≠ ${used.join("/")}`
			: hv("per") !== undefined && hv("per") !== period ? `field per ${hv("per")} ≠ ${period}`
			: hv("nomor") !== undefined && hv("nomor") !== used[0] ? `field nomor ${hv("nomor")} ≠ ${used[0]}`
			: hv("sar") !== undefined && hv("sar") !== code ? `field sar ${hv("sar")} ≠ ${code}`
			: "";
		if (bad) throw new Stop(`Angka sudah MASUK, tapi halaman Hitung tidak cocok (${bad}) — Hitung TIDAK dijalankan, cek manual.`, "hitung");
		await adminReq(f, sess, "admin_hitungtimte.php", {
			method: "POST",
			body: buildPayload(hp.form, {}, hp.button),
			referer: new URL(hitungPath, sess.baseUrl).toString(),
		});
		const after = parseHitungPage(await adminReq(f, sess, hitungPath));
		if (after && after.period === hp.period) {
			throw new Stop("Hitung dikirim tapi tombol Hitung periode ini masih ada — cek manual apakah sudah terhitung.", "hitung");
		}
		stage = "selesai";
		return { ok: true, stage, period, detail: `Periode ${period} ${plan.market}: angka ${used.join("/")} masuk & dihitung (agen ${who}).` };
	} catch (e) {
		if (e instanceof Stop) return { ok: false, stage: e.stage, period, detail: e.message };
		return {
			ok: false,
			stage,
			period,
			detail: (stage === "cek" ? "Gagal sebelum mengubah apa pun: " : `Gagal di tahap ${stage} (admin sudah disentuh, CEK MANUAL): `) + (e instanceof Error ? e.message : String(e)),
		};
	}
}
