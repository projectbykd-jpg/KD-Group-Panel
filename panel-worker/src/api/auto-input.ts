// Endpoint menu "Auto Prediksi" + kaitan ke alur KIRIM SEMUA SISTEM (send.ts).
// Logika inti: lib/auto-input.ts (rencana, sesi, antrean) & lib/auto-input-run.ts (eksekutor).
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import { dateKeyNow } from "../lib/time";
import { hasMenu } from "../lib/menus";
import type { Processed } from "../lib/parser";
import type { UserProfile } from "../lib/db";
import {
	claimJob,
	clearRetryable,
	defaultAdminBase,
	deleteSession,
	finishJob,
	getEnabled,
	getSession,
	getSessions,
	listJobs,
	planAutoInput,
	saveSession,
	sessionHint,
	setEnabled,
	setStage,
	startJob,
} from "../lib/auto-input";
import { runAutoInput, type Fetcher } from "../lib/auto-input-run";

async function gate(env: Env, token: string) {
	const s = await requireSession(env, token, { menu: "auto-input" });
	// Menghitung result = membayar pemenang: VIEWER (read-only) tidak boleh menyentuhnya.
	if (s.profile.role !== "ADMIN" && s.profile.role !== "OPERATOR") {
		throw new Error("Menu Auto Prediksi hanya untuk ADMIN atau OPERATOR.");
	}
	return s;
}

function mustOwnWebsite(profile: UserProfile, website: string): string {
	const w = String(website ?? "").trim().toUpperCase();
	if (!profile.websites.includes(w)) throw new Error(`Website ${w || "?"} tidak ada di akses akun ini.`);
	return w;
}

export async function autoInputGetState(env: Env, token: string) {
	const s = await gate(env, token);
	const [enabled, sessions, jobs] = await Promise.all([getEnabled(env, s.username), getSessions(env, s.username), listJobs(env, s.username)]);
	return {
		success: true,
		enabled,
		// PHPSESSID TIDAK pernah dikirim balik ke browser -- hanya penanda "terisi" + 4 karakter akhir.
		websites: s.profile.websites.map((w) => {
			const x = sessions.find((e) => e.website === w);
			return {
				website: w,
				baseUrl: x?.baseUrl || defaultAdminBase(w),
				hasSession: !!x?.phpsessid,
				hint: x?.phpsessid ? sessionHint(x.phpsessid) : "",
			};
		}),
		jobs,
	};
}

export async function autoInputSetEnabled(env: Env, token: string, enabled: boolean) {
	const s = await gate(env, token);
	await setEnabled(env, s.username, !!enabled);
	await logActivity(env, s.username, "AUTO PREDIKSI", enabled ? "Diaktifkan" : "Dimatikan", "BERHASIL", "");
	return { success: true, enabled: !!enabled };
}

export async function autoInputSaveSession(env: Env, token: string, data: Record<string, unknown>) {
	const s = await gate(env, token);
	const w = mustOwnWebsite(s.profile, String(data.website ?? ""));
	await saveSession(env, s.username, w, String(data.baseUrl ?? ""), String(data.phpsessid ?? ""));
	await logActivity(env, s.username, "AUTO PREDIKSI SESI", `Simpan PHPSESSID ${w}`, "BERHASIL", "");
	return { success: true };
}

export async function autoInputDeleteSession(env: Env, token: string, website: string) {
	const s = await gate(env, token);
	const w = mustOwnWebsite(s.profile, website);
	await deleteSession(env, s.username, w);
	await logActivity(env, s.username, "AUTO PREDIKSI SESI", `Hapus PHPSESSID ${w}`, "BERHASIL", "");
	return { success: true };
}

export async function autoInputClearJob(env: Env, token: string, jobId: number) {
	const s = await gate(env, token);
	await clearRetryable(env, s.username, Number(jobId));
	return { success: true };
}

/** Uji kering: cek sesi + validasi halaman Nomor Keluar sebuah pasaran, TANPA mengirim apa pun. */
export async function autoInputTest(env: Env, token: string, website: string, market: string, fetchFn?: Fetcher) {
	const s = await gate(env, token);
	const w = mustOwnWebsite(s.profile, website);
	const sess = await getSession(env, s.username, w);
	if (!sess?.phpsessid) return { success: false, message: `PHPSESSID ${w} belum disimpan.` };
	const mk = String(market ?? "").trim().toUpperCase();
	if (!mk) return { success: false, message: "Isi nama pasaran untuk diuji (mis. OREGON06)." };
	const r = await runAutoInput({
		session: sess,
		plan: { ok: true, market: mk, prizes: ["0000", "0000", "0000"], date: dateKeyNow(), key: "TEST" },
		dryRun: true,
		fetchFn,
	});
	return { success: r.ok, message: r.detail, preview: r.preview };
}

// ---------------------------------------------------------------------------
// Dipanggil send.ts sesudah KIRIM SEMUA SISTEM
// ---------------------------------------------------------------------------
export interface AutoInputOutcome {
	website: string;
	status: "BERHASIL" | "GAGAL" | "DILEWATI" | "SUDAH";
	detail: string;
	manual: boolean;
}
export interface AutoInputNotice {
	/** Alasan dilewati (tidak ada job sama sekali). */
	skippedReason?: string;
	/** ANTRI = job sudah dibuat, browser harus memanggil autoInputRun(jobId) -- satu panggilan per website. */
	results: (Omit<AutoInputOutcome, "status"> & { status: AutoInputOutcome["status"] | "ANTRI"; jobId?: number })[];
}

/**
 * Hanya MEMBUAT job (murah). Eksekusi sebenarnya (belasan request ke admin) dijalankan browser lewat
 * autoInputRun, satu website per panggilan: Worker paket gratis hanya boleh 50 subrequest per
 * invocation, dan KIRIM SEMUA SISTEM sendiri sudah memakai banyak (Telegram, LinkTree, Panel-Z).
 */
export async function autoInputAfterSend(
	env: Env,
	profile: UserProfile,
	rawText: string,
	processed: Processed,
	websites: string[],
): Promise<AutoInputNotice | undefined> {
	if (profile.role !== "ADMIN" && profile.role !== "OPERATOR") return undefined;
	if (!hasMenu(profile, "auto-input")) return undefined;
	if (!(await getEnabled(env, profile.username))) return undefined;

	const plan = planAutoInput(rawText, processed);
	if (!plan.ok) return { skippedReason: plan.reason, results: [] };

	const sessions = await getSessions(env, profile.username);
	const results: AutoInputNotice["results"] = [];
	for (const website of websites) {
		const sess = sessions.find((x) => x.website === String(website).trim().toUpperCase());
		if (!sess?.phpsessid) {
			results.push({ website, status: "DILEWATI", detail: "PHPSESSID belum disimpan — input manual.", manual: true });
			continue;
		}
		const started = await startJob(env, profile.username, website, plan);
		if ("existing" in started) {
			results.push({ website, status: "SUDAH", detail: `Result ini sudah pernah diproses (${started.existing.status}).`, manual: false });
		} else {
			results.push({ website, status: "ANTRI", detail: "Menunggu dijalankan", manual: false, jobId: started.id });
		}
	}
	return { results };
}

/** Menjalankan SATU job antre (tanpa autentikasi -- dipanggil setelah gate). */
export async function runQueuedJob(env: Env, username: string, jobId: number, fetchFn?: Fetcher): Promise<AutoInputOutcome> {
	const job = await claimJob(env, username, jobId);
	if (!job) return { website: "-", status: "SUDAH", detail: "Job tidak ditemukan atau sudah berjalan.", manual: false };
	const website = job.website;
	const sess = await getSession(env, username, website);
	if (!sess?.phpsessid) {
		await finishJob(env, job.id, "FAILED", "cek", "PHPSESSID belum disimpan.");
		return { website, status: "DILEWATI", detail: "PHPSESSID belum disimpan — input manual.", manual: true };
	}
	const plan = { ok: true as const, market: job.market, prizes: job.prizes, date: job.resultDate, key: "" };
	const r = await runAutoInput({
		session: sess,
		plan,
		fetchFn,
		onStage: (st, period) => setStage(env, job.id, st, period),
	});
	await finishJob(env, job.id, r.ok ? "DONE" : "FAILED", r.ok ? "selesai" : r.stage, r.detail, r.period);
	await logActivity(env, username, "AUTO PREDIKSI", `[${website}] ${job.market} ${job.prizes.join("/")} — ${r.detail}`, r.ok ? "BERHASIL" : "GAGAL", "").catch(() => {});
	return { website, status: r.ok ? "BERHASIL" : "GAGAL", detail: r.detail, manual: !r.ok };
}

export async function autoInputRun(env: Env, token: string, jobId: number, fetchFn?: Fetcher) {
	const s = await gate(env, token);
	const o = await runQueuedJob(env, s.username, Number(jobId), fetchFn);
	return { success: o.status === "BERHASIL", ...o };
}
