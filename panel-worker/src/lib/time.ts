// Semua waktu panel = GMT+7 (Asia/Jakarta), disimpan apa adanya sebagai TEXT.
const OFFSET_MS = 7 * 60 * 60 * 1000;

/** "yyyy-MM-dd HH:mm:ss" di GMT+7 — sama persis dengan datetime('now','+7 hours') di D1. */
export function tsNow(): string {
	return new Date(Date.now() + OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

/** Batas awal penyimpanan riwayat: 00:00 WIB, N hari lalu ("yyyy-MM-dd 00:00:00"). Data lebih lama dari ini dianggap kedaluwarsa. */
export function retentionFrom(days: number): string {
	return new Date(Date.now() + OFFSET_MS - days * 86400_000).toISOString().slice(0, 10) + " 00:00:00";
}

/** "yyyy-MM-dd" di GMT+7. */
export function dateKeyNow(): string {
	return new Date(Date.now() + OFFSET_MS).toISOString().slice(0, 10);
}

/** "yyyy-MM-dd HH:mm:ss" di GMT+7, N menit dari sekarang. */
export function tsPlusMinutes(minutes: number): string {
	return new Date(Date.now() + OFFSET_MS + minutes * 60 * 1000)
		.toISOString()
		.slice(0, 19)
		.replace("T", " ");
}

const ID_DAY_NAMES = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const ID_MONTH_NAMES = [
	"Januari", "Februari", "Maret", "April", "Mei", "Juni",
	"Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

/** "Minggu,13 September 2026" (nama hari + tanggal berbahasa Indonesia, GMT+7) --
 *  dipakai buat byline tanggal di awal tiap artikel (Blogger & situs sendiri). */
export function tsNowIndonesianDate(): string {
	const d = new Date(Date.now() + OFFSET_MS);
	return `${ID_DAY_NAMES[d.getUTCDay()]},${d.getUTCDate()} ${ID_MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
