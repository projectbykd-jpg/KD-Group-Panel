// Port wrapper prediksi V6Core.gs (getPredictionStatusData / generatePredictionCopyBundle /
// generateClosingPredictionCopy / sendPredictionAuto / sendClosingPredictionAuto) + router auto-post.
import { requireSession } from "./auth";
import { getUserProfiles } from "../lib/db";
import { getSiteAccounts } from "../lib/site";
import { logActivity } from "../lib/activity";
import {
	JADWAL_PREDIKSI_CONFIG,
	CLOSING_PREDICTION_SLOTS,
	CLOSING_PREDICTION_NAME,
	predictionScheduleId,
	closingScheduleId,
	normalizeClosingSlot,
	getActiveClosingSlot,
	predictionTodayKey,
	getOrCreateDailyPredictionContents,
	getPredictionStatusDataInternal,
	generatePredictionCopyBundleInternal,
	generateClosingPredictionCopyInternal,
	buildClosingPredictionMessage,
	validatePredictionContext,
	sendPredictionJob,
	readPredictionRegistryForDate,
} from "../lib/prediction";
import { listActiveSessions } from "../lib/session";
import { getSys } from "../lib/settings";

const now7 = () => new Date(Date.now() + 7 * 60 * 60 * 1000);

export async function getPredictionStatusData(env: Env, token: string) {
	const s = await requireSession(env, token, { ignoreMaintenance: true, menu: "prediction" });
	return getPredictionStatusDataInternal(env, s.profile);
}

export async function generatePredictionCopyBundle(env: Env, index: number, token: string) {
	const s = await requireSession(env, token, { menu: "prediction" });
	return generatePredictionCopyBundleInternal(env, Number(index), s.profile);
}

export async function generateClosingPredictionCopy(env: Env, token: string, slot: string) {
	const s = await requireSession(env, token, { menu: "prediction" });
	return generateClosingPredictionCopyInternal(s.profile, String(slot || ""));
}

export async function sendPredictionAuto(env: Env, index: number, token: string, onlyWebsites?: string[]) {
	const s = await requireSession(env, token, { menu: "prediction" });
	const scheduleIndex = Number(index);
	const config = JADWAL_PREDIKSI_CONFIG[scheduleIndex];
	if (!config) {
		return { success: false, blocked: true, message: "Jadwal prediksi tidak ditemukan.", websiteResults: [], kind: "schedule" };
	}
	const ctx = validatePredictionContext(s.profile, onlyWebsites ?? null);
	if (ctx.error) return { success: false, blocked: true, message: ctx.error, websiteResults: [], kind: "schedule" };

	const contents = await getOrCreateDailyPredictionContents(env, scheduleIndex, ctx.websites!);
	return sendPredictionJob({
		env,
		username: s.username,
		websites: ctx.websites!,
		scheduleId: predictionScheduleId(scheduleIndex),
		predictionName: config.nama,
		predictionIndex: scheduleIndex,
		kind: "schedule",
		logAction: "KIRIM PREDIKSI AUTO",
		messageForWebsite: (w) => String(contents[w.toUpperCase()] || ""),
	});
}

export async function sendClosingPredictionAuto(env: Env, token: string, onlyWebsites: string[] | undefined, slot: string) {
	const s = await requireSession(env, token, { menu: "prediction" });
	const activeSlot = normalizeClosingSlot(String(slot || ""));
	const ctx = validatePredictionContext(s.profile, onlyWebsites ?? null);
	if (ctx.error) return { success: false, blocked: true, message: ctx.error, websiteResults: [], kind: "closing" };
	return sendPredictionJob({
		env,
		username: s.username,
		websites: ctx.websites!,
		scheduleId: closingScheduleId(activeSlot),
		predictionName: CLOSING_PREDICTION_NAME + " · " + activeSlot,
		predictionIndex: -1,
		kind: "closing",
		activeSlot,
		logAction: "KIRIM PENUTUP PREDIKSI AUTO",
		messageForWebsite: (w) => buildClosingPredictionMessage(w, now7(), activeSlot),
	});
}

// ---------------------------------------------------------------------------
// Auto-post router (dipakai Cron Trigger + tombol admin "JALANKAN SEKARANG")
// ---------------------------------------------------------------------------

async function isAutoPostEnabled(env: Env): Promise<boolean> {
	const r = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'autopost_enabled'`).first<{ value: string }>();
	return String(r?.value ?? "TRUE").toUpperCase().trim() !== "FALSE";
}

async function activeSessionUsernames(env: Env): Promise<string[]> {
	// Dari D1, bukan SESS.list — dipanggil tiap tick cron auto-post; kuota KV
	// list Free cuma 1000/hari (dulu jebol tiap sore -> daftar sesi kosong).
	return (await listActiveSessions(env)).map((g) => g.username);
}

async function autoPostWebsites(env: Env, usernames: string[]): Promise<string[]> {
	// Dua query batch (profil user + akun website), bukan 1 query per user lalu
	// 1 query per website -- fungsi ini dipanggil TIAP MENIT oleh cron auto-post,
	// jadi hemat round-trip di sini berlaku terus sepanjang hari.
	const set: Record<string, boolean> = {};
	const profiles = await getUserProfiles(env, usernames);
	for (const p of profiles.values()) {
		if (!p.permissions.telegram) continue;
		for (const w of p.websites || []) {
			const site = String(w || "").trim().toUpperCase();
			if (site) set[site] = true;
		}
	}
	// PENTING: hanya sertakan website yang PUNYA Telegram Prediksi (tg_pred_*).
	// Website tanpa config (mis. HELEN) kalau ikut -> selalu GAGAL -> guard slot
	// tidak pernah terkunci -> router retry tiap menit sepanjang window (boros).
	const accounts = await getSiteAccounts(env, Object.keys(set));
	const eligible: string[] = [];
	for (const site of Object.keys(set)) {
		const acc = accounts.get(site);
		if (acc && acc.telegramPred.token && acc.telegramPred.chatId) eligible.push(site);
	}
	return eligible;
}

function slotDue(nowMinutes: number, slotMinutes: number, catchup: number, windowMinutes?: number): boolean {
	const diff = nowMinutes - slotMinutes;
	const maxAfter = windowMinutes != null && windowMinutes > 0 ? windowMinutes : catchup;
	return diff >= -1 && diff <= maxAfter && nowMinutes <= 1435;
}

export async function runAutoPostRouter(env: Env, opts: { force?: boolean; windowMinutes?: number } = {}) {
	const summary = { ran: false, slots: 0, sent: 0, already: 0, failed: 0, message: "" };
	if (!(await isAutoPostEnabled(env))) {
		summary.message = "Auto Posting dimatikan (Settings: autopost_enabled = FALSE).";
		return summary;
	}
	// Cek MURAH dulu (tanpa DB/KV): adakah slot yang jatuh tempo sekarang? Sebagian besar tick (cron tiap menit) tidak punya
	// slot -> langsung selesai tanpa query sesi/profil/website dan tanpa menulis kunci KV (dulu ±2.880 KV write/hari yang
	// melewati kuota Free 1.000/hari sehingga penulisan sesi login/guard ikut gagal diam-diam).
	const catchup = await getSys(env, "sys_catchup_minutes");
	{
		const d0 = now7();
		const nowMin0 = d0.getUTCHours() * 60 + d0.getUTCMinutes();
		const dueNow =
			JADWAL_PREDIKSI_CONFIG.some((c) => {
				const [hh, mm] = c.jam.split(":").map(Number);
				return slotDue(nowMin0, hh * 60 + mm, catchup, opts.windowMinutes);
			}) ||
			CLOSING_PREDICTION_SLOTS.some((slot) => {
				const [hh, mm] = slot.split(":").map(Number);
				return slotDue(nowMin0, hh * 60 + mm, catchup, opts.windowMinutes);
			});
		if (!opts.force && !dueNow) {
			summary.message = "Belum ada slot prediksi yang jatuh tempo.";
			return summary;
		}
	}
	const usernames = await activeSessionUsernames(env);
	if (!usernames.length) {
		summary.message = "Tidak ada user yang sedang login, jadi tidak ada yang diposting.";
		return summary;
	}
	const websites = await autoPostWebsites(env, usernames);
	if (!websites.length) {
		summary.message = "Tidak ada user login yang punya izin Telegram + website.";
		return summary;
	}

	const d = now7();
	const nowMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
	const dateKey = predictionTodayKey();

	// KUNCI ANTI-TUMPANG-TINDIH: cron eksternal memanggil endpoint ini tiap menit.
	// Kalau satu run belum selesai (Telegram lambat) dan run berikutnya sudah masuk,
	// dua-duanya bisa memproses slot yang sama SEBELUM guard slot terkunci -> pesan
	// penutup / prediksi terkirim DOBEL. Lock ini (KV, TTL 3 menit) mencegah itu.
	// Angka berikut diatur admin (Pengaturan Sistem > Auto Posting Prediksi).
	const GUARD_TTL = (await getSys(env, "sys_slot_guard_hours")) * 3600;
	const MAX_ATTEMPTS = await getSys(env, "sys_slot_max_attempts");
	const LOCK_SECONDS = await getSys(env, "sys_autopost_lock_seconds");
	const RUN_LOCK = "autopost:router:running";
	if (!opts.force) {
		try {
			if (await env.SESS.get(RUN_LOCK)) {
				summary.message = "Router auto-post lain masih berjalan — tick ini dilewati.";
				return summary;
			}
			await env.SESS.put(RUN_LOCK, String(Date.now()), { expirationTtl: LOCK_SECONDS });
		} catch {
			/* KV error -> lanjut tanpa lock (lebih baik jalan daripada macet) */
		}
	}

	// GUARD ANDALAN = prediction_registry (D1), bukan KV. KV cuma fast-path.
	// Alasan: kuota KV write Free 1000/hari; kalau jebol, SESS.put(guard) gagal
	// diam-diam -> slot tidak pernah terkunci -> router menjalankan slot yang sama
	// tiap menit sepanjang window (spam log "DUPLIKAT" / risiko dobel).
	// registry di-cache 1x per run.
	let _reg: Record<string, { status: string }> | null = null;
	const registryAllDone = async (scheduleId: string): Promise<boolean> => {
		if (!_reg) {
			try {
				_reg = (await readPredictionRegistryForDate(env, dateKey)) as Record<string, { status: string }>;
			} catch {
				_reg = {};
			}
		}
		const sid = scheduleId.toUpperCase();
		return websites.every((w) => {
			const e = _reg![sid + "||" + w.toUpperCase()];
			return e && String(e.status).toUpperCase() === "BERHASIL";
		});
	};
	const kvGet = async (k: string): Promise<string | null> => {
		try {
			return await env.SESS.get(k);
		} catch {
			return null;
		}
	};
	const kvPut = async (k: string, ttl: number) => {
		try {
			await env.SESS.put(k, "1", { expirationTtl: ttl });
		} catch {
			/* kuota KV -> abaikan, registry yang jadi andalan */
		}
	};

	const runSlot = async (
		guardKey: string,
		scheduleId: string,
		job: () => Promise<{ counters?: { success?: number; already?: number; failed?: number }; pendingWebsites?: string[] }>,
	) => {
		if (!opts.force) {
			if (await kvGet(guardKey)) return;
			// cek D1: semua website slot ini sudah BERHASIL hari ini? -> kunci & keluar.
			if (await registryAllDone(scheduleId)) {
				await kvPut(guardKey, GUARD_TTL);
				return;
			}
		}
		let res;
		try {
			res = await job();
		} catch {
			return;
		}
		summary.ran = true;
		summary.slots++;
		summary.sent += Number(res?.counters?.success || 0);
		summary.already += Number(res?.counters?.already || 0);
		summary.failed += Number(res?.counters?.failed || 0);
		const hadFailure = !res || !res.counters || (res.pendingWebsites || []).length > 0;
		if (!hadFailure) {
			await kvPut(guardKey, GUARD_TTL);
			return;
		}
		// Masih ada yang gagal: coba lagi tick berikutnya, TAPI batasi (bawaan 3x, diatur admin).
		const attKey = guardKey + ":att";
		const att = Number((await kvGet(attKey)) || 0) + 1;
		try {
			if (att >= MAX_ATTEMPTS) {
				await kvPut(guardKey, GUARD_TTL);
				await env.SESS.delete(attKey);
			} else {
				await env.SESS.put(attKey, String(att), { expirationTtl: GUARD_TTL });
			}
		} catch {
			/* kuota KV -> abaikan; registry tetap mencegah dobel di tick berikutnya */
		}
	};

	for (let index = 0; index < JADWAL_PREDIKSI_CONFIG.length; index++) {
		const [hh, mm] = JADWAL_PREDIKSI_CONFIG[index].jam.split(":").map(Number);
		if (!slotDue(nowMinutes, hh * 60 + mm, catchup, opts.windowMinutes)) continue;
		const scheduleId = predictionScheduleId(index);
		await runSlot(`autopost:${dateKey}:${scheduleId}`, scheduleId, async () => {
			const config = JADWAL_PREDIKSI_CONFIG[index];
			const contents = await getOrCreateDailyPredictionContents(env, index, websites);
			return sendPredictionJob({
				env,
				username: "AUTO",
				websites,
				dateKey,
				scheduleId,
				predictionName: config.nama,
				predictionIndex: index,
				kind: "schedule",
				logAction: "KIRIM PREDIKSI AUTO",
				messageForWebsite: (w) => String(contents[w.toUpperCase()] || ""),
			});
		});
	}

	for (const slot of CLOSING_PREDICTION_SLOTS) {
		const [hh, mm] = slot.split(":").map(Number);
		if (!slotDue(nowMinutes, hh * 60 + mm, catchup, opts.windowMinutes)) continue;
		await runSlot(`autopost:${dateKey}:${closingScheduleId(slot)}`, closingScheduleId(slot), () =>
			sendPredictionJob({
				env,
				username: "AUTO",
				websites,
				dateKey,
				scheduleId: closingScheduleId(slot),
				predictionName: CLOSING_PREDICTION_NAME + " · " + slot,
				predictionIndex: -1,
				kind: "closing",
				activeSlot: slot,
				logAction: "KIRIM PENUTUP PREDIKSI AUTO",
				messageForWebsite: (w) => buildClosingPredictionMessage(w, now7(), slot),
			}),
		);
	}

	if (!opts.force) {
		try {
			await env.SESS.delete(RUN_LOCK);
		} catch {
			/* biarkan TTL 3 menit yang membersihkan */
		}
	}

	summary.message = summary.ran
		? `${summary.slots} sesi diproses — terkirim ${summary.sent}, sudah ada ${summary.already}, gagal ${summary.failed}`
		: "Belum ada sesi jam yang jatuh tempo untuk disusulkan saat ini.";
	return summary;
}

// --- tombol admin ---------------------------------------------------------
export async function adminRunAutoPostNow(env: Env, token: string) {
	const s = await requireSession(env, token, { admin: true });
	const result = await runAutoPostRouter(env, { force: true });
	await logActivity(
		env,
		s.username,
		"AUTO POST MANUAL",
		result.message || "Router auto posting dijalankan manual.",
		result.failed ? "SEBAGIAN" : "BERHASIL",
		"",
	);
	return { success: true, message: result.message || "Router dijalankan. Cek menu Aktivitas / Telegram." };
}

export async function setupAutoPostTriggers(env: Env, token: string) {
	const s = await requireSession(env, token, { admin: true });
	await env.DB.prepare(
		`INSERT INTO settings (key, value) VALUES ('autopost_enabled','TRUE')
		 ON CONFLICT(key) DO UPDATE SET value = 'TRUE'`,
	).run();
	await logActivity(env, s.username, "AUTO POSTING", "Auto posting prediksi diaktifkan", "BERHASIL", "");
	return {
		success: true,
		installed: true,
		enabled: true,
		message:
			"Auto Posting Prediksi AKTIF. Penjadwalan dijalankan oleh cron eksternal yang memanggil " +
			"/__cron?job=autopost tiap menit (lihat tombol URL CRON). Butuh minimal 1 operator login saat jam sesi.",
	};
}

export async function adminGetAutoPostWebhook(env: Env, token: string, origin?: string) {
	await requireSession(env, token, { admin: true });
	const slots = Array.from(
		new Set(JADWAL_PREDIKSI_CONFIG.map((x) => x.jam).concat(CLOSING_PREDICTION_SLOTS)),
	).sort();
	const base = String(origin || "").replace(/\/+$/, "");
	const key = env.CRON_KEY || "";
	return {
		success: true,
		url: base && key ? `${base}/__cron?key=${key}&job=autopost` : "",
		urlInvest: base && key ? `${base}/__cron?key=${key}&job=invest` : "",
		slots,
		timezone: "GMT+7 (WIB)",
		everyMinute: true,
		message:
			"Pasang di cron-job.org / GitHub Actions: panggil URL di atas dengan method GET tiap 1 menit. " +
			"Router cek sendiri slot mana yang jatuh tempo (toleransi susulan 25 menit).",
	};
}

export const PREDICTION_SLOTS_INFO = { JADWAL_PREDIKSI_CONFIG, CLOSING_PREDICTION_SLOTS, getActiveClosingSlot };
