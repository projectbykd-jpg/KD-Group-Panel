// Endpoint menu "Auto Prediksi" + kaitan ke alur KIRIM SEMUA SISTEM (send.ts).
// Logika inti: lib/auto-input.ts (rencana, sesi, antrean) & lib/auto-input-run.ts (eksekutor).
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import { dateKeyNow } from "../lib/time";
import { hasMenu } from "../lib/menus";
import type { Processed } from "../lib/parser";
import type { UserProfile } from "../lib/db";
import {
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
export interface AutoInputNotice {
	/** off = saklar mati (tidak ada notice); selain itu ada ringkasan per website. */
	skippedReason?: string;
	results: { website: string; status: "BERHASIL" | "GAGAL" | "DILEWATI" | "SUDAH"; detail: string; manual: boolean }[];
}

export async function autoInputAfterSend(
	env: Env,
	profile: UserProfile,
	rawText: string,
	processed: Processed,
	websites: string[],
	fetchFn?: Fetcher,
): Promise<AutoInputNotice | undefined> {
	if (profile.role !== "ADMIN" && profile.role !== "OPERATOR") return undefined;
	if (!hasMenu(profile, "auto-input")) return undefined;
	if (!(await getEnabled(env, profile.username))) return undefined;

	const plan = planAutoInput(rawText, processed);
	if (!plan.ok) return { skippedReason: plan.reason, results: [] };

	const results: AutoInputNotice["results"] = await Promise.all(
		websites.map(async (website): Promise<AutoInputNotice["results"][number]> => {
			const sess = await getSession(env, profile.username, website);
			if (!sess?.phpsessid) return { website, status: "DILEWATI", detail: "PHPSESSID belum disimpan — input manual.", manual: true };
			const started = await startJob(env, profile.username, website, plan);
			if ("existing" in started) {
				return { website, status: "SUDAH", detail: `Result ini sudah pernah diproses (${started.existing.status}).`, manual: false };
			}
			const r = await runAutoInput({
				session: sess,
				plan,
				fetchFn,
				onStage: (st, period) => setStage(env, started.id, st, period),
			});
			await finishJob(env, started.id, r.ok ? "DONE" : "FAILED", r.ok ? "selesai" : r.stage, r.detail, r.period);
			await logActivity(
				env,
				profile.username,
				"AUTO PREDIKSI",
				`[${website}] ${plan.market} ${plan.prizes.join("/")} — ${r.detail}`,
				r.ok ? "BERHASIL" : "GAGAL",
				"",
			).catch(() => {});
			return { website, status: r.ok ? "BERHASIL" : "GAGAL", detail: r.detail, manual: !r.ok };
		}),
	);
	return { results };
}
