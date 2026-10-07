// DATA MASTER yang bisa diatur ADMIN dari Admin > Data Master: jadwal prediksi, kata penutup, peta shio,
// pool "tebak shio", peta pasaran -> Panel-Z dan daftar pasaran Invest.
//
// Cara kerja (sengaja tanpa mengubah pemakai daftar-daftar ini): nilai disimpan di D1 `settings` (key "md_*", JSON),
// dibaca berkala (cache 15 dtk, sama seperti pengaturan sistem) lalu DITERAPKAN ke daftar yang sudah dipakai kode
// (array/objek diganti isinya di tempat). Bila baris tidak ada / JSON rusak / tidak lolos validasi -> otomatis
// kembali ke nilai bawaan di kode, jadi data master yang salah tidak pernah bisa melumpuhkan sistem.
import {
	JADWAL_PREDIKSI_CONFIG,
	CLOSING_PREDICTION_SLOTS,
	CLOSING_PREDICTION_VARIANTS,
	DAFTAR_SHIO,
} from "./prediction";
import { SHIO_ORDER, SHIO_CONFIG, MARKET_TO_PANEL } from "./parser";
import { INVEST_PASARAN } from "./invest";
import { getSys } from "./settings";
import { setFetchTimeoutMs } from "./fetch-guard";

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export type MasterDef<T = unknown> = {
	key: string;
	group: string;
	title: string;
	hint: string;
	/** Nilai bawaan (salinan dalam, diambil sekali saat modul dimuat -- sebelum ada yang diterapkan). */
	def: T;
	parse: (raw: unknown) => Parsed<T>;
	apply: (v: T) => void;
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const str = (v: unknown) => String(v ?? "").trim();
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function replaceArray<T>(target: T[], next: T[]): void {
	target.splice(0, target.length, ...next);
}

// ---- 1. Jadwal prediksi ---------------------------------------------------------------------------------------
type Slot = { jam: string; nama: string; pasaran: string[] };
function parseJadwal(raw: unknown): Parsed<Slot[]> {
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > 12) return fail("Jadwal harus berisi 1-12 sesi.");
	const out: Slot[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < raw.length; i++) {
		const r = (raw[i] ?? {}) as Record<string, unknown>;
		const jam = str(r.jam);
		if (!HHMM.test(jam)) return fail(`Sesi ${i + 1}: jam harus berformat HH:MM (00:00-23:59).`);
		if (seen.has(jam)) return fail(`Sesi ${i + 1}: jam ${jam} dipakai dua kali.`);
		seen.add(jam);
		const nama = str(r.nama);
		if (nama.length < 3 || nama.length > 120) return fail(`Sesi ${i + 1}: nama 3-120 karakter.`);
		const list = Array.isArray(r.pasaran) ? r.pasaran : [];
		const pas: string[] = [];
		for (const p of list) {
			const v = str(p).toUpperCase();
			if (!v) continue;
			if (v.length > 40) return fail(`Sesi ${i + 1}: nama pasaran "${v.slice(0, 20)}…" terlalu panjang (maks 40).`);
			if (!pas.includes(v)) pas.push(v);
		}
		if (pas.length < 1 || pas.length > 30) return fail(`Sesi ${i + 1}: isi 1-30 pasaran.`);
		out.push({ jam, nama, pasaran: pas });
	}
	return { ok: true, value: out };
}

// ---- 2. Kata penutup ------------------------------------------------------------------------------------------
type Closing = { slots: string[]; variants: string[] };
function parseClosing(raw: unknown): Parsed<Closing> {
	const r = (raw ?? {}) as Record<string, unknown>;
	const slots = (Array.isArray(r.slots) ? r.slots : []).map(str).filter(Boolean);
	if (slots.length < 1 || slots.length > 4) return fail("Slot penutup: 1-4 jam.");
	for (const s of slots) if (!HHMM.test(s)) return fail(`Jam penutup "${s}" harus berformat HH:MM.`);
	if (new Set(slots).size !== slots.length) return fail("Jam penutup tidak boleh kembar.");
	const sorted = [...slots].sort();
	const variants = (Array.isArray(r.variants) ? r.variants : []).map(str).filter(Boolean);
	if (variants.length < 1 || variants.length > 20) return fail("Kalimat penutup: 1-20 variasi.");
	for (const v of variants) if (v.length < 10 || v.length > 300) return fail("Tiap kalimat penutup 10-300 karakter.");
	return { ok: true, value: { slots: sorted, variants } };
}

// ---- 3. Peta shio ---------------------------------------------------------------------------------------------
type Shio = { names: string[]; zero: string };
const SHIO_NAME = /^[A-Z]{2,20}$/;
function parseShio(raw: unknown): Parsed<Shio> {
	const r = (raw ?? {}) as Record<string, unknown>;
	const names = (Array.isArray(r.names) ? r.names : []).map((x) => str(x).toUpperCase());
	if (names.length !== 12) return fail("Peta shio harus berisi tepat 12 nama.");
	for (const n of names) if (!SHIO_NAME.test(n)) return fail(`Nama shio "${n}" harus huruf saja (2-20 huruf, tanpa spasi).`);
	if (new Set(names).size !== 12) return fail("12 nama shio tidak boleh ada yang kembar.");
	const zero = str(r.zero).toUpperCase();
	if (!SHIO_NAME.test(zero)) return fail("Shio untuk angka 00 harus huruf saja.");
	return { ok: true, value: { names, zero } };
}

// ---- 4. Pool tebak shio ---------------------------------------------------------------------------------------
function parseShioPool(raw: unknown): Parsed<string[]> {
	const list = (Array.isArray(raw) ? raw : []).map((x) => str(x).toUpperCase().replace(/\s+/g, " ")).filter(Boolean);
	const uniq = [...new Set(list)];
	if (uniq.length < 1 || uniq.length > 60) return fail("Pool tebak shio: 1-60 baris.");
	for (const v of uniq) if (v.length < 3 || v.length > 60) return fail(`Baris "${v.slice(0, 20)}…" harus 3-60 karakter.`);
	return { ok: true, value: uniq };
}

// ---- 5. Peta pasaran -> Panel-Z ---------------------------------------------------------------------------------
const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,40}$/;
function parseMarketPanel(raw: unknown): Parsed<Record<string, string>> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("Format peta pasaran tidak valid.");
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		const key = str(k).toUpperCase();
		const slug = str(v);
		if (!key) continue;
		if (key.length > 60) return fail(`Nama pasaran "${key.slice(0, 20)}…" terlalu panjang (maks 60).`);
		if (!SLUG.test(slug)) return fail(`Slug "${slug.slice(0, 20)}" untuk ${key} hanya boleh huruf, angka, tanda minus (maks 41).`);
		out[key] = slug;
	}
	const n = Object.keys(out).length;
	if (n < 1 || n > 300) return fail("Peta pasaran: 1-300 baris.");
	return { ok: true, value: out };
}

// ---- 6. Pasaran Invest ----------------------------------------------------------------------------------------
function parseInvestPasaran(raw: unknown): Parsed<[string, string][]> {
	const list = Array.isArray(raw) ? raw : [];
	const out: [string, string][] = [];
	const seen = new Set<string>();
	for (const it of list) {
		const a = Array.isArray(it) ? it : [];
		const code = str(a[0]).toLowerCase();
		const name = str(a[1]).toUpperCase();
		if (!code && !name) continue;
		if (!/^p\d{1,8}$/.test(code)) return fail(`Kode "${code.slice(0, 12)}" harus berformat p diikuti angka (mis. p6680).`);
		if (name.length < 1 || name.length > 40) return fail(`Nama untuk ${code} harus 1-40 karakter.`);
		if (seen.has(code)) return fail(`Kode ${code} dipakai dua kali.`);
		seen.add(code);
		out.push([code, name]);
	}
	if (out.length < 1 || out.length > 300) return fail("Daftar pasaran Invest: 1-300 baris.");
	return { ok: true, value: out };
}

export const MASTER_DEFS: MasterDef<any>[] = [
	{
		key: "md_jadwal", group: "Auto Posting", title: "Jadwal Prediksi",
		hint: "Sesi auto-posting prediksi: jam (WIB), nama sesi, dan daftar pasaran. Urutan = nomor sesi (PRED-1, PRED-2, …) yang dipakai penjaga anti-kirim-ganda; hindari menukar urutan di tengah hari. Sesi baru sebaiknya ditambah di bagian bawah.",
		def: clone(JADWAL_PREDIKSI_CONFIG), parse: parseJadwal,
		apply: (v: Slot[]) => replaceArray(JADWAL_PREDIKSI_CONFIG, v),
	},
	{
		key: "md_closing", group: "Auto Posting", title: "Kata-kata Penutup Prediksi",
		hint: "Jam kiriman penutup (1-4) dan variasi kalimatnya. Variasi dipilih acak-tetap per hari/website.",
		def: { slots: clone(CLOSING_PREDICTION_SLOTS), variants: clone(CLOSING_PREDICTION_VARIANTS) }, parse: parseClosing,
		apply: (v: Closing) => { replaceArray(CLOSING_PREDICTION_SLOTS, v.slots); replaceArray(CLOSING_PREDICTION_VARIANTS, v.variants); },
	},
	{
		key: "md_shio_pool", group: "Auto Posting", title: "Pool Tebak Shio",
		hint: "Pilihan teks 'TEBAK SHIO' di prediksi (satu per baris, mis. ANJING - KUDA).",
		def: clone(DAFTAR_SHIO), parse: parseShioPool,
		apply: (v: string[]) => replaceArray(DAFTAR_SHIO, v),
	},
	{
		key: "md_shio", group: "Shio", title: "Peta Shio (angka -> shio)",
		hint: "Dipakai untuk memeriksa/mengoreksi baris 'Shio :' pada hasil. Dua angka terakhir Prize 1 dibagi 12: sisa 1 = nama pertama, … sisa 0 (12) = nama ke-12. Angka 00 punya shio tersendiri.",
		def: { names: SHIO_ORDER.slice(1), zero: SHIO_CONFIG.zero }, parse: parseShio,
		apply: (v: Shio) => { v.names.forEach((n, i) => { SHIO_ORDER[i + 1] = n; }); SHIO_CONFIG.zero = v.zero; },
	},
	{
		key: "md_market_panel", group: "Pasaran", title: "Peta Pasaran -> Panel-Z",
		hint: "Nama pasaran di teks hasil (huruf besar) -> slug di Panel-Z. Salah slug = pengiriman Panel-Z gagal untuk pasaran itu.",
		def: clone(MARKET_TO_PANEL), parse: parseMarketPanel,
		apply: (v: Record<string, string>) => {
			for (const k of Object.keys(MARKET_TO_PANEL)) delete MARKET_TO_PANEL[k];
			Object.assign(MARKET_TO_PANEL, v);
		},
	},
	{
		key: "md_invest_pasaran", group: "Pasaran", title: "Daftar Pasaran AutoCheck Invest",
		hint: "Daftar bawaan (kode panel agen + nama) untuk scan Invest. Tiap user tetap bisa menimpa daftarnya sendiri di menu AutoCheck Invest.",
		def: clone(INVEST_PASARAN), parse: parseInvestPasaran,
		apply: (v: [string, string][]) => replaceArray(INVEST_PASARAN, v),
	},
];

const BY_KEY = new Map(MASTER_DEFS.map((d) => [d.key, d]));
const TTL_MS = 15_000;
let loadedAt = 0;
let inflight: Promise<void> | null = null;

export function resetMasterCache(): void {
	loadedAt = 0;
}

async function doLoad(env: Env): Promise<void> {
	const rows = await env.DB.prepare(`SELECT key, value FROM settings WHERE key LIKE 'md\\_%' ESCAPE '\\'`).all<{ key: string; value: string }>();
	const stored = new Map((rows.results ?? []).map((r) => [r.key, r.value]));
	for (const d of MASTER_DEFS) {
		let applied = false;
		const raw = stored.get(d.key);
		if (raw) {
			try {
				const p = d.parse(JSON.parse(raw));
				if (p.ok) { d.apply(p.value); applied = true; }
			} catch {
				/* JSON rusak -> bawaan */
			}
		}
		if (!applied) d.apply(clone(d.def));
	}
}

/** Terapkan data master dari D1 ke daftar yang dipakai kode. Aman dipanggil di tiap request (cache 15 dtk). */
export async function loadMasterData(env: Env): Promise<void> {
	if (Date.now() - loadedAt < TTL_MS) return;
	if (inflight) return inflight;
	inflight = (async () => {
		try {
			await doLoad(env);
			setFetchTimeoutMs((await getSys(env, "sys_fetch_timeout_sec")) * 1000);
		} catch {
			/* tabel settings belum siap -> pakai yang sedang berlaku (bawaan) */
		} finally {
			loadedAt = Date.now();
			inflight = null;
		}
	})();
	return inflight;
}

export function getMasterDef(key: string): MasterDef | undefined {
	return BY_KEY.get(key);
}

export async function listMaster(env: Env): Promise<{ key: string; group: string; title: string; hint: string; value: unknown; def: unknown; custom: boolean }[]> {
	const rows = await env.DB.prepare(`SELECT key, value FROM settings WHERE key LIKE 'md\\_%' ESCAPE '\\'`).all<{ key: string; value: string }>();
	const stored = new Map((rows.results ?? []).map((r) => [r.key, r.value]));
	return MASTER_DEFS.map((d) => {
		let value: unknown = d.def;
		let custom = false;
		const raw = stored.get(d.key);
		if (raw) {
			try {
				const p = d.parse(JSON.parse(raw));
				if (p.ok) { value = p.value; custom = true; }
			} catch {
				/* bawaan */
			}
		}
		return { key: d.key, group: d.group, title: d.title, hint: d.hint, value, def: d.def, custom };
	});
}

/** Simpan satu data master (value === null -> kembalikan ke bawaan). Mengembalikan pesan galat validasi bila ditolak. */
export async function saveMaster(env: Env, key: string, value: unknown): Promise<{ ok: true; reset: boolean } | { ok: false; error: string }> {
	const d = BY_KEY.get(key);
	if (!d) return { ok: false, error: "Data master tidak dikenal." };
	if (value === null) {
		await env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind(key).run();
		resetMasterCache();
		await loadMasterData(env);
		return { ok: true, reset: true };
	}
	const p = d.parse(value);
	if (!p.ok) return { ok: false, error: p.error };
	await env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
		.bind(key, JSON.stringify(p.value))
		.run();
	resetMasterCache();
	await loadMasterData(env);
	return { ok: true, reset: false };
}
