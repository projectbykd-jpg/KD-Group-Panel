// Tenggat keras untuk permintaan panel yang mengirim ke banyak website (Kirim Semua, Send Panel-Z, Kirim Prediksi).
// Dulu satu server luar yang lambat x batas 25 dtk per panggilan x beberapa website melewati batas tunggu panel
// ("Permintaan menggantung lebih dari 100 dtk", smartAutoSendFast 14 Okt 02:04): operator tidak melihat hasil apa pun.
// Semua panggilan keluar diikat ke satu signal yang putus SEBELUM batas itu, menyisakan waktu untuk mencatat hasil.
import { getSysCached } from "./settings";

/** Detik yang disisakan sebelum batas tunggu panel untuk mencatat registry anti-duplikat + log. */
export const SEND_RESERVE_SEC = 12;
export const TIME_UP_REASON = "Batas waktu kirim habis";
export const TIME_UP_NOT_SENT = "Belum dikirim: waktu proses habis karena server lain lambat. Tekan kirim lagi — yang sudah terkirim tidak akan dobel.";
/** Hasil pengirim yang berarti server TIDAK menjawab / jaringan putus (bukan ditolak dengan jawaban). */
export const NET_FAIL_RE = /timeout|timed out|aborted|fetch failed|network connection|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|Batas waktu kirim habis/i;

export interface SendDeadline {
	signal: AbortSignal;
	stop: () => void;
}

/** Mulai tenggat (batas tunggu panel - cadangan). WAJIB `stop()` di finally. */
export function startSendDeadline(): SendDeadline {
	const ctrl = new AbortController();
	const t = setTimeout(
		() => ctrl.abort(new DOMException(TIME_UP_REASON, "TimeoutError")),
		Math.max(15, getSysCached("sys_api_timeout_sec") - SEND_RESERVE_SEC) * 1000,
	);
	return { signal: ctrl.signal, stop: () => clearTimeout(t) };
}

/** Teks "tidak menjawab dalam N dtk" / "koneksi gagal" untuk hasil jaringan yang gagal. */
export function netFailWhy(r: string): string {
	return /timeout|timed out|aborted/i.test(r) ? `tidak menjawab dalam ${getSysCached("sys_fetch_timeout_sec")} dtk` : "koneksi gagal";
}
