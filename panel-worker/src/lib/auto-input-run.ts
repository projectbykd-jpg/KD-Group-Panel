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
	/** Sesudah Hitung selesai: Total Omset/Referal/Menang dari menu Prediksi (null = gagal dibaca, alasannya di totalsNote). Tidak pernah menggagalkan job. */
	totals?: PrediksiTotals | null;
	totalsNote?: string;
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
/** Tanggal ISO + n hari (UTC, tanpa zona). */
function addDays(iso: string, n: number): string {
	const t = new Date(iso + "T00:00:00Z");
	t.setUTCDate(t.getUTCDate() + n);
	return t.toISOString().slice(0, 10);
}

/**
 * allowNextDay: result pasaran yang diundi menjelang/lewat tengah malam WIB (MONTANA dkk.) bertanggal undian (mis. 24),
 * sedangkan form admin sudah tanggal WIB berikutnya (25) -- operator manual memakai tanggal form apa adanya. Bila true,
 * tanggal form = tanggal result + 1 hari juga diterima dan dipakai sebagai acuan cek baris terakhir. Pemanggil hanya
 * mengizinkannya pada jam awal setelah tengah malam WIB (sys_auto_input_midnight_grace_h), jadi teks result basi tetap ditolak.
 */
export function parseAngkaPage(html: string, plan: Plan, opts: { allowNextDay?: boolean } = {}): AngkaPage {
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
	const nextDay = !!opts.allowNextDay && formDate === addDays(plan.date, 1);
	if (formDate !== plan.date && !nextDay) fail(`Tanggal form ${formDate} ≠ tanggal result ${plan.date}. Input manual.`);
	const dateRef = nextDay ? formDate : plan.date; // lewat tengah malam: tanggal form admin yang jadi acuan

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
	if (!prev!.date || prev!.date >= dateRef) fail(`Baris terakhir bertanggal ${prev!.date || "?"} (≥ ${dateRef}) — result hari ini kemungkinan sudah terinput.`);

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
// Prediksi: Total Omset / Referal / Menang periode yang BARU dihitung (tampil di menu Result)
// ---------------------------------------------------------------------------
export interface PrediksiTotals {
	omset: string;
	referal: string;
	menang: string;
}
export interface LastResult {
	period: number;
	/** angka yang tertulis di "Last Result Periode : N , Angka : a,b,c" */
	numbers: string[];
	/** argumen asli sendRes(periode, nomor, nomor2, nomor3, wild) */
	args: string[];
}

/** Div "Last Result" di halaman Prediksi: onclick="sendRes(93,'1956','7895','1236','0')". Harus tepat satu & teksnya cocok dengan argumennya. */
export function parseLastResult(html: string): LastResult | null {
	const hits: LastResult[] = [];
	for (const m of html.matchAll(/<div\b([^>]*)>([\s\S]*?)<\/div>/gi)) {
		const call = (attr(m[1], "onclick") ?? "").match(/^\s*sendRes\s*\(([^)]*)\)/i);
		if (!call) continue;
		const txt = htmlText(m[2]);
		const head = txt.match(/Last\s*Result\s*Periode\s*:?\s*(\d+)/i);
		if (!head) continue;
		const args = call[1].split(",").map((a) => a.trim().replace(/^['"]|['"]$/g, ""));
		if (!/^\d+$/.test(args[0] ?? "") || Number(args[0]) !== Number(head[1])) return null;
		const fromArgs = args.slice(1, 4).filter((a) => /^\d+$/.test(a));
		const shown = txt.match(/Angka\s*:?\s*([\d][\d\s,]*)/i)?.[1].match(/\d+/g) ?? [];
		if (shown.some((n, i) => fromArgs[i] !== n)) return null;
		hits.push({ period: Number(args[0]), numbers: shown.length ? shown : fromArgs, args });
	}
	return hits.length === 1 ? hits[0] : null;
}

const MONEY_RE = /^-?\d[\d.,]*$/;

/**
 * Baris "Result" di tabel halaman Prediksi, kolom Total Omset / Total Referal / Total Menang.
 * Kolom dicari dari NAMA header (bukan urutan), dan jumlah sel baris Result harus sama dengan header.
 */
export function parsePrediksiTotals(html: string): PrediksiTotals | null {
	const rows = (html.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []).map((r) => [...r.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => htmlText(c[1])));
	const heads = rows.filter((c) => c.some((x) => /^total omset$/i.test(x)));
	const results = rows.filter((c) => /^result$/i.test(c[0] ?? ""));
	if (heads.length !== 1 || results.length !== 1) return null;
	const head = heads[0];
	const res = results[0];
	if (head.length !== res.length) return null;
	const col = (re: RegExp) => {
		const at = head.map((h, i) => (re.test(h) ? i : -1)).filter((i) => i >= 0);
		return at.length === 1 ? at[0] : -1;
	};
	const [o, r, m] = [col(/^total omset$/i), col(/^total referal$/i), col(/^total menang$/i)];
	if (o < 1 || r < 1 || m < 1) return null;
	const vals = [res[o], res[r], res[m]];
	if (!vals.every((v) => MONEY_RE.test(v))) return null;
	return { omset: vals[0], referal: vals[1], menang: vals[2] };
}

/** Tabel yang diterima HARUS untuk periode & angka yang kita kirim (bukan tampilan bawaan: periode berikutnya, nomor kosong). '' = cocok. */
export function prediksiEchoProblem(html: string, period: number, numbers: string[]): string {
	const want = `periode ${period} angka ${numbers.join("/")}`;
	const links = [...html.matchAll(/href\s*=\s*["']?([^"'>]*admin_menkalahbb\.php\?[^"'>]*)/gi)].map((m) => decodeEntities(m[1])).map((h) => ({
		p: h.match(/[?&]periode=(\d*)/i)?.[1] ?? "",
		n: h.match(/[?&]nomor=([^&]*)/i)?.[1] ?? "",
	}));
	if (links.length) {
		const bad = links.find((l) => l.p !== String(period) || l.n !== numbers[0]);
		return bad ? `tabel yang diterima untuk periode ${bad.p || "?"} angka ${bad.n || "kosong"}, bukan ${want}` : "";
	}
	const form = parseForms(html).find((f) => f.inputs.some((i) => i.name === "periode"));
	const p = form?.inputs.find((i) => i.id === "periode")?.value;
	const n = form?.inputs.find((i) => i.id === "nomor")?.value;
	return p === String(period) && n === numbers[0] ? "" : `server tidak menampilkan ${want}`;
}

/** Kode pasaran dari dropdown di sidebar (index.php + frame). Hanya untuk pengambilan ulang -- alur utama sudah punya kodenya. */
export async function findMarketCode(f: Fetcher, sess: AdminSession, market: string): Promise<string> {
	const indexUrl = new URL("index.php", sess.baseUrl).toString();
	const index = await adminReq(f, sess, "index.php");
	let home = index;
	for (const src of frameSources(index, indexUrl)) {
		try {
			home += "\n" + (await adminReq(f, sess, src, { referer: indexUrl }));
		} catch (e) {
			if (e instanceof Stop) throw e;
		}
	}
	const code = findPoolCode(home, market);
	if (!code) throw new Error(`Pasaran "${market}" tidak ditemukan (atau ganda) di dropdown website ini.`);
	return code;
}

/**
 * Buka menu Prediksi pasaran itu, "klik" Last Result (sendRes hanya mengisi kolom form -- tidak ada request),
 * lalu Submit seperti browser dan baca baris Result. Tidak mengubah apa pun di admin selain tampilan prediksi.
 * Lempar Error berisi alasan bila ada yang tidak persis sesuai (pasaran, periode, angka, tabel).
 */
export async function readPrediksiTotals(o: { f: Fetcher; sess: AdminSession; code: string; market: string; period: string; numbers: string[] }): Promise<PrediksiTotals> {
	if (!Number(o.period) || !o.numbers.length) throw new Error("Periode/angka yang dihitung tidak diketahui.");
	return (await submitPrediksi(o, { period: Number(o.period), numbers: o.numbers })).totals;
}

/**
 * Pasaran yang dihitung MANUAL di admin (tidak di-auto): Last Result APA ADANYA -> Submit -> baris Result. Tidak membandingkan dengan
 * result yang dikirim; periode & angka Last Result dikembalikan supaya pemanggil bisa mencatat (dan menandai bila berbeda). Hanya membaca.
 */
export async function readPrediksiLastTotals(o: { f: Fetcher; sess: AdminSession; code: string; market: string }): Promise<{ totals: PrediksiTotals; last: LastResult }> {
	return submitPrediksi(o, null);
}

async function submitPrediksi(
	o: { f: Fetcher; sess: AdminSession; code: string; market: string },
	expect: { period: number; numbers: string[] } | null,
): Promise<{ totals: PrediksiTotals; last: LastResult }> {
	const path = `admin_prediksifullbb.php?psr=${o.code}`;
	const referer = new URL(path, o.sess.baseUrl).toString();
	const html = await adminReq(o.f, o.sess, path);

	const forms = parseForms(html).filter((f) => f.inputs.some((i) => i.name === "periode") && f.inputs.some((i) => i.type === "submit"));
	if (forms.length !== 1) throw new Error("Halaman Prediksi tidak dikenali (form Periode + Submit tidak ditemukan).");
	const form = forms[0];
	const sel = form.selects.find((s) => s.name === "pasaran");
	const cur = sel?.options.find((op) => op.value === sel.selected);
	if (!cur || !cur.value.includes(`psr=${o.code}`) || squash(cur.label) !== squash(o.market)) {
		throw new Error(`Halaman Prediksi menampilkan pasaran "${cur?.label ?? "?"}", bukan ${o.market}.`);
	}
	const sar = form.inputs.find((i) => i.name === "sar")?.value;
	if (sar !== undefined && sar !== o.code) throw new Error(`Kode pasaran di form Prediksi ${sar} ≠ ${o.code}.`);

	const last = parseLastResult(html);
	if (!last) throw new Error("'Last Result' tidak ditemukan / tidak terbaca di halaman Prediksi.");
	if (expect) {
		if (last.period !== expect.period) throw new Error(`Last Result di admin periode ${last.period}, bukan periode ${expect.period} yang baru dihitung.`);
		// Banding sebanyak angka yang ada di KEDUA sisi (pasaran 1-prize bisa menampilkan filler '0' / job menyimpan 3 prize).
		const cmp = Math.min(expect.numbers.length, last.numbers.length);
		if (!cmp || expect.numbers.slice(0, cmp).some((n, i) => last.numbers[i] !== n)) throw new Error(`Last Result angka ${last.numbers.join("/") || "-"} ≠ angka yang dihitung ${expect.numbers.join("/")}.`);
	}
	const period = last.period;
	const numbers = expect ? expect.numbers : last.numbers;

	// sendRes(per, res, res2, res3, wild): isi kolom id periode / nomor / nomor2 / nomor3 / wild (yang ada), persis fungsi di halamannya.
	const nameOf = (id: string) => form.inputs.find((i) => i.id === id)?.name;
	const fill: Record<string, string> = {};
	const fPeriod = nameOf("periode");
	const fNomor = nameOf("nomor");
	if (!fPeriod || !fNomor || !/^\d+$/.test(last.args[1] ?? "")) throw new Error("Kolom Periode/Nomor di form Prediksi tidak terbaca.");
	fill[fPeriod] = String(last.period);
	fill[fNomor] = last.args[1];
	for (const [id, v] of [["nomor2", last.args[2]], ["nomor3", last.args[3]], ["wild", last.args[4]]] as const) {
		const n = nameOf(id);
		if (n && v) fill[n] = v;
	}
	const button = form.inputs.find((i) => i.type === "submit");
	const body = await adminReq(o.f, o.sess, path, { method: "POST", body: buildPayload(form, fill, button), referer });

	const echo = prediksiEchoProblem(body, period, numbers);
	if (echo) throw new Error(`Hasil Prediksi ditolak: ${echo}.`);
	const totals = parsePrediksiTotals(body);
	if (!totals) throw new Error("Baris Result / kolom Total Omset-Referal-Menang tidak terbaca di tabel Prediksi.");
	return { totals, last };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

/**
 * Ringkasan balasan admin UNTUK DIAGNOSTIK saja: nama + keadaan header/cookie, TIDAK PERNAH nilainya
 * (token sesi tidak boleh bocor ke pesan galat). Dipakai untuk membedakan "admin menghapus sesi"
 * (Set-Cookie PHPSESSID kosong/deleted/expires lampau) dari "diblokir Cloudflare" (cf-mitigated / 403)
 * dan "halaman kosong dari aplikasi".
 */
export function describeAdminResponse(res: Response, bodyChars?: number, bodyText?: string): string {
	const h = res.headers;
	const pick = (name: string): string => {
		const v = h.get(name);
		if (!v) return "";
		// alamat Location bisa membawa token di query -> buang query-nya
		return `${name}=${name === "location" ? v.split("?")[0].slice(0, 80) : v.slice(0, 60)}`;
	};
	const raw: string[] = typeof h.getSetCookie === "function" ? h.getSetCookie() : h.get("set-cookie") ? [h.get("set-cookie")!] : [];
	const cookies = raw.map((c) => {
		const [pair, ...attrs] = c.split(";").map((x) => x.trim());
		const eq = pair.indexOf("=");
		const name = (eq < 0 ? pair : pair.slice(0, eq)).slice(0, 40);
		const val = eq < 0 ? "" : pair.slice(eq + 1);
		const state = val === "" ? "kosong" : /^deleted$/i.test(val) ? "deleted" : `diisi(${val.length} huruf)`;
		const keep = attrs.filter((a) => /^(expires|max-age|samesite|domain|path|secure|httponly)\b/i.test(a)).map((a) => a.slice(0, 48));
		return `${name}:${state}${keep.length ? "{" + keep.join(",") + "}" : ""}`;
	});
	const parts = [
		`HTTP ${res.status}`,
		pick("server"),
		pick("content-type"),
		pick("content-encoding"),
		pick("content-length"),
		pick("location"),
		pick("cf-ray") ? "cf-ray=ada" : "",
		`cf-mitigated=${h.get("cf-mitigated") || "tidak ada"}`,
		bodyChars === undefined ? "" : `isi=${bodyChars} huruf`,
		bodyText !== undefined && bodyText.length > 0 && bodyText.length <= 200 ? `teks-isi="${maskBodySnippet(bodyText)}"` : "",
		`set-cookie=[${cookies.join("; ") || "tidak ada"}]`,
	];
	return parts.filter(Boolean).join(" ");
}

/** Isi balasan sangat pendek (<=200 huruf) untuk diagnosa: deretan huruf/angka >=16 (mirip token) disamarkan. */
export function maskBodySnippet(t: string): string {
	return t.replace(/\s+/g, " ").replace(/[A-Za-z0-9+/=_%-]{16,}/g, "***").replace(/"/g, "'").trim();
}

/** Nama cookie yang DIKIRIM panel ke admin (nama saja, tanpa nilai). */
export function cookieNamesSent(stored: string): string {
	return cookieHeader(stored).split(";").map((p) => p.trim().split("=")[0]).filter(Boolean).join(", ");
}

export async function adminReq(
	f: Fetcher,
	sess: AdminSession,
	path: string,
	init: { method?: "GET" | "POST"; body?: URLSearchParams; referer?: string } = {},
	/** Diisi apa adanya (status akhir + rantai redirect + ringkasan header balasan) untuk diagnostik kalau halaman yang diterima aneh. */
	meta?: { status: number; trail: string[]; diag?: string },
): Promise<string> {
	let url = new URL(path, sess.baseUrl).toString();
	if (meta) meta.trail = [new URL(url).pathname + new URL(url).search];
	let method = init.method ?? "GET";
	let body = init.body;
	for (let hop = 0; hop < 4; hop++) {
		const headers: Record<string, string> = {
			Cookie: cookieHeader(sess.phpsessid),
			"User-Agent": sess.ua || UA,
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
			if (meta) meta.diag = (meta.diag ? meta.diag + " ⇒ " : "") + describeAdminResponse(res);
			method = "GET"; // 301/302/303 sesudah POST -> GET (perilaku browser)
			body = undefined;
			continue;
		}
		const text = await res.text();
		if (meta) {
			meta.status = res.status;
			meta.diag = (meta.diag ? meta.diag + " ⇒ " : "") + describeAdminResponse(res, text.length, text);
		}
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
	/** lihat parseAngkaPage: terima tanggal form = tanggal result + 1 (jam awal setelah tengah malam WIB). */
	allowNextDay?: boolean;
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
		const homeMeta = { status: 0, trail: [] as string[], diag: "" };
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
					`Yang diterima server: HTTP ${homeMeta.status} [${homeMeta.trail.join(" ")}] frame [${frames.join(", ") || "tidak ada"}] judul "${title}" isi "${body}". ` +
					`Rincian balasan (nama saja, tanpa nilai): ${homeMeta.diag || "-"}. Cookie yang dikirim panel: ${cookieNamesSent(sess.phpsessid)}.`,
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
		const angkaMeta = { status: 0, trail: [] as string[] };
		const angkaHtml = await adminReq(f, sess, angkaPath, {}, angkaMeta);
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
		if (!skipKirim) {
			try {
				page = parseAngkaPage(angkaHtml, plan, { allowNextDay: opts.allowNextDay });
			} catch (e) {
				// Sesi SUDAH terbukti hidup (sidebar "Agent (...)" terbaca di atas), jadi "tidak dikenali" di sini BUKAN sesi habis.
				// Dulu isi halaman dibuang -> pesan selalu generik dan penyebab (mis. pasaran ini diinput di halaman lain) tidak
				// pernah terlihat. Sekarang simpan apa yang benar-benar diterima untuk diagnosa.
				if (e instanceof Stop && /tidak dikenali/i.test(e.message)) {
					const title = (angkaHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
					const pool = home.match(new RegExp(`id=["']param${code}["'][^>]*value=["']([^"']*)`, "i"))?.[1] ?? home.match(new RegExp(`value=["']([^"']*)["'][^>]*id=["']param${code}["']`, "i"))?.[1] ?? "-";
					// Halaman admin diawali daftar "Pools : [..] [..] ..." (menu tautan pasaran) yang menutupi pesan sebenarnya
					// (data produksi 25 Okt: FLORIDAMID/KENTUCKYMID). Lewati daftar itu; catat juga apakah pasaran ini ada di daftar.
					const txt = htmlText(angkaHtml);
					const pools = txt.match(/^\s*Pools\s*:\s*((?:\[[^\]]*\]\s*)+)/i);
					const inPools = pools ? new RegExp(`\\[${plan.market.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "i").test(pools[1]) : null;
					const rest = (pools ? txt.slice(pools[0].length) : txt).trim();
					const heads = [...angkaHtml.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)].map((m) => htmlText(m[1]).trim()).filter(Boolean).slice(0, 4).join(" | ");
					const nForms = (angkaHtml.match(/<form\b/gi) ?? []).length;
					throw new Stop(
						`Halaman Nomor Keluar ${plan.market} tidak berisi form input (sesi login OK) — kemungkinan pasaran ini diinput di halaman lain atau belum waktunya; matikan pasaran ini di Auto Prediksi bila selalu gagal. ` +
							`Diterima: HTTP ${angkaMeta.status} [${angkaMeta.trail.join(" ")}] psr=${code} pool=${pool} judul "${title}" form=${nForms} ${plan.market}${inPools === null ? "" : inPools ? " ADA" : " TIDAK ada"} di daftar Pools; heading "${heads.slice(0, 120)}" isi "${rest.slice(0, 240)}"`,
						"cek",
					);
				}
				throw e;
			}
		}
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
		// Angka sudah masuk & terhitung (membayar pemenang): apa pun yang terjadi di langkah baca-Prediksi TIDAK boleh mengubah hasil job.
		let totals: PrediksiTotals | null = null;
		let totalsNote = "";
		try {
			totals = await readPrediksiTotals({ f, sess, code, market: plan.market, period, numbers: used });
		} catch (e) {
			totalsNote = (e instanceof Error ? e.message : String(e)).slice(0, 300);
		}
		return { ok: true, stage, period, totals, totalsNote, detail: `Periode ${period} ${plan.market}: angka ${used.join("/")} masuk & dihitung (agen ${who}).` };
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
