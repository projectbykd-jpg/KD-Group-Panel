// Bagian MURNI (tanpa database) dari Auto Check Toto Macau: definisi game, parser tabel angka admin, dan pembaca halaman
// admin "Daftar Nomor ... Yang Keluar". Dipisah dari toto-macau.ts supaya BISA dipakai ulang oleh runner GitHub Actions
// (Jalur Kedua) — runner tidak boleh mengimpor toto-macau.ts yang penuh dependensi Worker (getTurso, dll). File ini hanya
// bergantung pada auto-input-run (juga murni) dan tipe AdminSession.
//
// Worker (toto-macau.ts) DAN runner sama-sama memakai parseTotoRows + adminPagePath + collectTotoAdminRows, jadi cara baca
// halaman admin TIDAK terduplikasi/menyimpang. Perbedaannya hanya SIAPA yang fetch: Worker fetch langsung (website biasa),
// runner fetch lewat curl-proxy (website Jalur Kedua yang tak terjangkau Worker).
import { adminReq, htmlText, type Fetcher } from "./auto-input-run";
import type { AdminSession } from "./auto-input";

export interface TotoGame {
	game: "m17" | "m51";
	/** nama game di tautan pagination admin (&game=...) */
	name: string;
	path: string;
	title: RegExp;
	digits: number;
	/** jam (WIB) baris di tabel -> nama pasaran Panel-Z (lihat MARKET_TO_PANEL di parser.ts) */
	slots: Record<number, string>;
}
export const TOTO_GAMES: TotoGame[] = [
	{
		game: "m17",
		name: "Toto Macau",
		path: "admin_angka.php?sar=m17&game=Toto%20Macau",
		title: /Daftar\s+Nomor\s+Toto\s+Macau\b/i,
		digits: 4,
		slots: { 0: "TOTOMACAU-00", 13: "TOTOMACAU-13", 16: "TOTOMACAU-16", 19: "TOTOMACAU-19", 22: "TOTOMACAU-22", 23: "TOTOMACAU-23" },
	},
	{
		game: "m51",
		name: "Toto Macao 5D",
		path: "admin_angka.php?sar=m51&game=Toto%20Macao%205D",
		title: /Daftar\s+Nomor\s+Toto\s+Macao\s+5D\b/i,
		digits: 5,
		slots: { 15: "TOTOMACAU-15-5D", 21: "TOTOMACAU-21-5D" },
	},
];

export const ADMIN_PAGE_SIZE = 20; // admin_angka.php menampilkan 20 baris per halaman (tombol [ >> ] = start=20&end=40 ...)
export const ADMIN_MAX_PAGES = 5;

export interface TotoRow {
	no: number;
	date: string; // yyyy-MM-dd
	time: string; // HH:mm:ss
	hour: number;
	period: number;
	number: string;
	hitung: string;
}

/** Baca baris tabel. HTML admin TIDAK rapi (baris tanpa </tr>, <form> di dalam <tr>) -> dibaca per rangkaian <td>, bukan per <tr>. */
export function parseTotoRows(html: string): TotoRow[] {
	const out: TotoRow[] = [];
	const re =
		/<td[^>]*>\s*(\d{1,4})\s*<\/td>\s*<td[^>]*>\s*(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*<\/td>\s*<td[^>]*>\s*(\d+)\s*<\/td>\s*<td[^>]*>\s*(\d+)\s*<\/td>\s*<td[^>]*>\s*([A-Za-z]+)\s*<\/td>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		out.push({
			no: Number(m[1]),
			date: `${m[4]}-${m[3]}-${m[2]}`,
			time: `${m[5]}:${m[6]}:${m[7]}`,
			hour: Number(m[5]),
			period: Number(m[8]),
			number: m[9],
			hitung: m[10].toLowerCase(),
		});
	}
	return out;
}

/** Tautan halaman pagination admin untuk satu game (halaman ke-`pg`, 0-indeks; pg=0 = game.path). HARUS sama persis dengan
 * yang dibangun di toto-macau.ts supaya runner & Worker membaca halaman yang sama. */
export function adminPagePath(game: TotoGame, pg: number): string {
	return `admin_angka.php?start=${pg * ADMIN_PAGE_SIZE}&end=${(pg + 1) * ADMIN_PAGE_SIZE}&sar=${game.game}&game=${encodeURIComponent(game.name)}`;
}

/** Hasil baca admin per game: baris mentah (sudah digabung lintas halaman) ATAU pesan error (sesi habis / halaman salah / tabel kosong). */
export type TotoAdminResult = Record<string, { rows?: TotoRow[]; error?: string }>;

/**
 * Baca halaman admin "Daftar Nomor ..." untuk SEMUA game (m17 & m51) memakai fetcher `f` (Worker = fetch langsung;
 * runner Jalur Kedua = curl-proxy), lalu kembalikan baris mentah per game. Logika pagination SAMA PERSIS dengan yang
 * dipakai Worker di reconcileWebsite (halaman berikutnya selama baris terlama masih dalam rentang & halaman penuh), jadi
 * baris yang dihasilkan runner identik dengan yang akan dibaca Worker sendiri untuk website biasa.
 *
 * `since`/`today` = yyyy-MM-dd (WIB) batas rentang periksa; dipakai hanya untuk memutuskan kapan berhenti menambah halaman.
 */
export async function collectTotoAdminRows(f: Fetcher, sess: AdminSession, since: string): Promise<TotoAdminResult> {
	const out: TotoAdminResult = {};
	for (const game of TOTO_GAMES) {
		try {
			const html = await adminReq(f, sess, game.path);
			if (!game.title.test(htmlText(html))) {
				out[game.game] = { error: "Halaman yang terbuka bukan daftar nomor game ini (bentuk halaman berubah / redirect)." };
				continue;
			}
			const rows = parseTotoRows(html);
			if (!rows.length) {
				out[game.game] = { error: "Tabel angka tidak terbaca (bentuk halaman berubah?)." };
				continue;
			}
			const all = new Map(rows.map((r) => [r.period, r]));
			let pageRows = rows;
			for (let pg = 1; pg < ADMIN_MAX_PAGES; pg++) {
				const oldest = pageRows.reduce((m, r) => (m && m < r.date ? m : r.date), "");
				if (!oldest || oldest < since || pageRows.length < ADMIN_PAGE_SIZE) break;
				try {
					pageRows = parseTotoRows(await adminReq(f, sess, adminPagePath(game, pg)));
				} catch {
					break; // halaman tambahan gagal: pakai yang sudah terbaca
				}
				if (!pageRows.length) break;
				for (const r of pageRows) if (!all.has(r.period)) all.set(r.period, r);
			}
			out[game.game] = { rows: [...all.values()] };
		} catch (e) {
			out[game.game] = { error: "Sesi admin habis atau halaman tidak bisa dibuka (" + (e instanceof Error ? e.message : String(e)).slice(0, 160) + ")" };
		}
	}
	return out;
}
