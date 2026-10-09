// API menu Admin > Error & Bug + penerima laporan galat dari browser.
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import { alertTgCfg, loadIntegrations } from "../lib/integrations";
import { sendTelegram } from "../senders/telegram";
import { deleteErrors, listErrors, recordError, recordTestError, setErrorStatus } from "../lib/error-log";

export async function adminErrorList(env: Env, token: string, options: unknown) {
	await requireSession(env, token, { admin: true, ignoreMaintenance: true });
	const o = (options && typeof options === "object" ? options : {}) as Record<string, unknown>;
	const out = await listErrors(env, { status: String(o.status ?? ""), source: String(o.source ?? "") });
	return { success: true, ...out };
}

export async function adminErrorSet(env: Env, token: string, ids: unknown, status: unknown) {
	await requireSession(env, token, { admin: true, ignoreMaintenance: true });
	const n = await setErrorStatus(env, ids, String(status ?? ""));
	return { success: true, changed: n };
}

export async function adminErrorDelete(env: Env, token: string, ids: unknown, scope: unknown) {
	const s = await requireSession(env, token, { admin: true, ignoreMaintenance: true });
	const n = await deleteErrors(env, ids, String(scope ?? ""));
	if (n) await logActivity(env, s.username, "HAPUS LOG ERROR", `${n} catatan error dihapus.`, "BERHASIL", "");
	return { success: true, removed: n };
}

/** Tombol TES TELEGRAM: kirim pesan uji ke bot/chat yang diisi di Admin > Integrasi. */
export async function adminErrorAlertTest(env: Env, token: string) {
	await requireSession(env, token, { admin: true, ignoreMaintenance: true });
	await loadIntegrations(env);
	const c = alertTgCfg();
	if (!c.token || !c.chatId) return { success: false, message: "Isi Token bot & Chat ID di Admin › Integrasi › Notifikasi Galat (Telegram) dulu." };
	const r = await sendTelegram("✅ Tes notifikasi Error & Bug — KD-Group Panel. Bila pesan ini sampai, pemberitahuan galat baru akan dikirim ke sini.", c);
	return r === "Terkirim" ? { success: true, message: "Pesan uji terkirim ke Telegram." } : { success: false, message: "Gagal kirim: " + r.replace(c.token, "***") };
}

/** Tombol UJI GALAT PALSU: mencatat satu galat uji dan memicu notifikasi Telegram (menguji seluruh rantai). */
export async function adminErrorSelfTest(env: Env, token: string) {
	const s = await requireSession(env, token, { admin: true, ignoreMaintenance: true });
	const r = await recordTestError(env);
	await logActivity(env, s.username, "UJI GALAT PALSU", "Galat uji dicatat di Error & Bug.", "INFO", "");
	const msg: Record<string, string> = {
		terkirim: "Galat uji tercatat dan notifikasi Telegram TERKIRIM — cek grup Telegram Anda.",
		"belum-diatur": "Galat uji tercatat, tetapi notifikasi Telegram belum diatur (Admin › Integrasi › Notifikasi Galat).",
		gagal: "Galat uji tercatat, tetapi Telegram GAGAL: " + String(r.detail || "").replace(/\d{5,15}:[A-Za-z0-9_-]{20,60}/g, "***").slice(0, 200),
		jeda: "Galat uji tercatat (notifikasi ditahan jeda).",
		"": "Galat uji tercatat.",
	};
	return { success: true, alert: r.alert, message: msg[r.alert] ?? msg[""] };
}

// Pembatas per user (per isolate): satu tab yang rusak tidak boleh membanjiri tabel.
const bucket = new Map<string, { at: number; n: number }>();
export function resetClientReportLimit(): void {
	bucket.clear();
}

/** Laporan galat dari browser (window.onerror / unhandledrejection / galat render). Semua user yang login boleh melapor. */
export async function clientErrorReport(env: Env, token: string, report: unknown) {
	const s = await requireSession(env, token, { allowBot: true, ignoreMaintenance: true });
	const now = Date.now();
	const b = bucket.get(s.username);
	if (!b || now - b.at > 60_000) bucket.set(s.username, { at: now, n: 1 });
	else if (++b.n > 20) return { success: true, dropped: true };
	if (bucket.size > 200) bucket.clear();
	const r = (report && typeof report === "object" ? report : {}) as Record<string, unknown>;
	const str = (v: unknown, max: number) => String(v ?? "").slice(0, max);
	await recordError(env, {
		source: "browser",
		message: str(r.message, 500),
		detail: str(r.stack, 2500) + (r.ua ? "\nUA: " + str(r.ua, 160) : ""),
		loc: str(r.loc, 120),
		username: s.username,
	});
	return { success: true };
}
