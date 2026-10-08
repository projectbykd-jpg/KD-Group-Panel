// Port loginPanelZInternal_ / getPanelRowAutoInternal_ / sendToPanelZInternal_ / sendCustomPanelZInternal_.
import type { PanelZCfg } from "../lib/site";
import { convertMarketToPanel } from "../lib/parser";

interface PanelSession {
	basicAuth: string;
	cookie: string;
}

async function loginPanelZ(cfg: PanelZCfg): Promise<PanelSession | string> {
	const basicAuth = "Basic " + btoa(`${cfg.user}:${cfg.pass}`);
	const res = await fetch(cfg.url + "/assets/sys-tmbet/authentication.php", {
		method: "POST",
		redirect: "manual",
		headers: { Authorization: basicAuth, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ username: cfg.user2, password: cfg.pass2 }),
	});
	const many = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
	const raw = many[0] || res.headers.get("set-cookie") || "";
	if (!raw) return "Error: PHPSESSID tidak ditemukan";
	const m = raw.match(/PHPSESSID=[^;]+/);
	if (!m) return "Error: Session gagal";
	return { basicAuth, cookie: m[0] };
}

async function getPanelRow(
	session: PanelSession,
	cfg: PanelZCfg,
	market: string,
): Promise<string | null> {
	const res = await fetch(cfg.url + "/dashboard.php?hal=result", {
		headers: { Authorization: session.basicAuth, Cookie: session.cookie },
	});
	const html = await res.text();
	const key = convertMarketToPanel(market);
	if (!key) return null;
	const re = new RegExp(key + "[\\s\\S]{0,500}?update-resultlotto\\.php\\?row=(\\d+)", "i");
	const m = html.match(re);
	return m ? m[1] : null;
}

async function pushAngka(
	session: PanelSession,
	cfg: PanelZCfg,
	rowId: string,
	angka: string,
): Promise<string> {
	const res = await fetch(cfg.url + "/config/update-resultlotto.php?row=" + rowId, {
		method: "POST",
		redirect: "manual",
		headers: {
			Authorization: session.basicAuth,
			Cookie: session.cookie,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ updangka: angka }),
	});
	if (res.status === 200 || res.status === 302) return "Terkirim";
	return "Gagal (" + res.status + ")";
}

/** Kirim hasil result (parse Pasaran + Prize 1 dari rawText). */
export async function sendPanelZ(rawText: string, cfg: PanelZCfg): Promise<string> {
	try {
		if (!cfg.url || !cfg.user) return "Error: Konfigurasi Panel-Z kosong";
		const marketMatch = rawText.match(/Pasaran\s+(.+)/i) || rawText.match(/Hasil Pengeluaran Pasaran\s+(.+)/i);
		const prize1Match = rawText.match(/Prize\s*1[^\d]*(\d{4})/i) || rawText.match(/Prize\s*1\s*[:\-]?\s*(\d+)/i);
		if (!marketMatch) return "Pasaran tidak ditemukan";
		if (!prize1Match) return "Prize 1 tidak ditemukan dalam format teks";
		const market = marketMatch[1].trim().toUpperCase();
		const prize1 = prize1Match[1];

		const session = await loginPanelZ(cfg);
		if (typeof session === "string") return session;
		const rowId = await getPanelRow(session, cfg, market);
		if (!rowId) return "Row tidak ditemukan : " + market;
		return pushAngka(session, cfg, rowId, prize1);
	} catch (e) {
		return "Error: " + (e instanceof Error ? e.message : String(e));
	}
}

/** Kirim angka custom (dipakai fitur Send Panel-Z / TOTOMACAU manual). */
export async function sendCustomPanelZ(market: string, angka: string, cfg: PanelZCfg): Promise<string> {
	try {
		if (!cfg.url || !cfg.user) return "Error: Konfigurasi Panel-Z kosong";
		const session = await loginPanelZ(cfg);
		if (typeof session === "string") return session;
		const rowId = await getPanelRow(session, cfg, String(market).toUpperCase());
		if (!rowId) return "Row tidak ditemukan";
		const r = await pushAngka(session, cfg, rowId, angka);
		return r === "Terkirim" ? "Berhasil dikirim" : r;
	} catch (e) {
		return "Error : " + (e instanceof Error ? e.message : String(e));
	}
}

// ---------------------------------------------------------------------------
// Pembacaan DAFTAR RESULT Panel-Z per (pasaran, TANGGAL) -- dipakai Auto Check Toto Macau.
// Tombol manual lama memilih baris PERTAMA yang cocok nama pasarannya tanpa melihat tanggal; Panel-Z menyimpan satu baris
// per pasaran per tanggal, jadi untuk auto baris dipilih dari pasaran + tanggal dan hanya diisi bila masih kosong ("xxxx").
// ---------------------------------------------------------------------------
export interface PanelZRow {
	id: string;
	market: string; // TOTOMACAU-13 / TOTOMACAU-15-5D ...
	date: string; // yyyy-MM-dd
	value: string;
	filled: boolean;
}

const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7, aug: 8, agu: 8, agt: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, des: 12 };

/** Baca baris-baris tabel "Semua Result". Baris yang tidak punya tautan update-resultlotto / pasaran / tanggal dilewati (fail-closed). */
export function parsePanelZRows(html: string): PanelZRow[] {
	const out: PanelZRow[] = [];
	for (const chunk of html.split(/<tr\b/i).slice(1)) {
		const link = chunk.match(/update-resultlotto\.php\?row=(\d+)/i);
		if (!link) continue;
		const mk = chunk.match(/TOTOMACAU-(\d{2})(-5D)?/i);
		if (!mk) continue;
		const text = chunk.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
		const dm = text.match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/);
		const month = dm ? MON[dm[2].toLowerCase()] : undefined;
		if (!dm || !month) continue;
		// kolom Angka = <input> pertama yang bukan hidden; nilai kosong / "xxxx" = belum terisi
		let value = "";
		for (const im of chunk.matchAll(/<input\b([^>]*)>/gi)) {
			if (/type\s*=\s*["']?hidden/i.test(im[1])) continue;
			value = (im[1].match(/\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i) ?? []).slice(1).find((x) => x !== undefined) ?? "";
			break;
		}
		value = value.trim();
		out.push({
			id: link[1],
			market: `TOTOMACAU-${mk[1]}${mk[2] ? "-5D" : ""}`.toUpperCase(),
			date: `${dm[3]}-${String(month).padStart(2, "0")}-${dm[1].padStart(2, "0")}`,
			value,
			filled: /\d/.test(value),
		});
	}
	return out;
}

export interface PanelZHandle {
	/** HTML semua halaman daftar result yang dimuat (digabung) */
	html: string;
	/** jumlah panggilan jaringan yang dipakai membuka daftar (untuk hitungan subrequest) */
	fetches?: number;
	push(rowId: string, angka: string): Promise<string>;
	/** baca ulang; rowIds = baris yang baru dikirim -> hanya halaman yang memuat baris itu */
	reload(rowIds?: string[]): Promise<string>;
}

export const PANELZ_MAX_PAGES = 6;

/** Jumlah halaman dari tautan pagination "?hal=result&no=N". */
export function panelZPageCount(html: string): number {
	let max = 1;
	for (const m of html.matchAll(/[?&]no=(\d+)/g)) max = Math.max(max, Number(m[1]));
	return max;
}

/** Tanggal (yyyy-MM-dd) paling lama di satu halaman daftar result; "" bila tidak ada baris. */
function oldestDate(html: string): string {
	let min = "";
	for (const chunk of html.split(/<tr\b/i).slice(1)) {
		if (!/update-resultlotto\.php\?row=\d+/i.test(chunk)) continue;
		const text = chunk.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
		const dm = text.match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/);
		const month = dm ? MON[dm[2].toLowerCase()] : undefined;
		if (!dm || !month) continue;
		const d = `${dm[3]}-${String(month).padStart(2, "0")}-${dm[1].padStart(2, "0")}`;
		if (!min || d < min) min = d;
	}
	return min;
}

/**
 * Masuk Panel-Z satu kali, baca daftar result, kembalikan pegangan untuk mengisi baris & membaca ulang. String = pesan galat.
 * Daftar result Panel-Z DIPECAH PER HALAMAN (100 baris/halaman, "?hal=result&no=N", terbaru dulu): halaman berikutnya dimuat
 * selama baris paling lama di halaman terakhir masih >= sinceDate (batas maks PANELZ_MAX_PAGES).
 */
export async function openPanelZ(cfg: PanelZCfg, opts: { sinceDate?: string; maxPages?: number } = {}): Promise<PanelZHandle | string> {
	try {
		if (!cfg.url || !cfg.user) return "Konfigurasi Panel-Z kosong";
		const session = await loginPanelZ(cfg);
		if (typeof session === "string") return session;
		const load = async (page: number): Promise<string> => {
			const res = await fetch(cfg.url + "/dashboard.php?hal=result" + (page > 1 ? "&no=" + page : ""), { headers: { Authorization: session.basicAuth, Cookie: session.cookie } });
			if (!res.ok) throw new Error("HTTP " + res.status + " dari Panel-Z (halaman " + page + ")");
			return res.text();
		};
		const pages = new Map<number, string>();
		const pageOf = new Map<string, number>();
		const remember = (n: number, h: string): void => {
			pages.set(n, h);
			for (const r of parsePanelZRows(h)) pageOf.set(r.id, n);
		};
		let fetches = 1; // login
		const first = await load(1);
		fetches++;
		remember(1, first);
		const total = Math.min(panelZPageCount(first), opts.maxPages ?? PANELZ_MAX_PAGES);
		let last = first;
		for (let p = 2; p <= total; p++) {
			if (opts.sinceDate) {
				const old = oldestDate(last);
				if (old && old < opts.sinceDate) break; // halaman terakhir yang dimuat sudah melewati batas tanggal
			}
			last = await load(p);
			fetches++;
			remember(p, last);
		}
		const joined = (): string => [...pages.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]).join("\n");
		return {
			html: joined(),
			fetches,
			push: async (rowId, angka) => {
				const r = await pushAngka(session, cfg, rowId, angka);
				return r === "Terkirim" ? "Berhasil dikirim" : r;
			},
			reload: async (rowIds) => {
				const want = rowIds?.length ? [...new Set(rowIds.map((id) => pageOf.get(id) ?? 1))] : [...pages.keys()];
				const out: string[] = [];
				for (const n of want.sort((a, b) => a - b)) out.push(await load(n));
				return out.join("\n");
			},
		};
	} catch (e) {
		return "Error: " + (e instanceof Error ? e.message : String(e));
	}
}
