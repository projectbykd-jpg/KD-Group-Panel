// Endpoint menu "Auto Prediksi" + kaitan ke alur KIRIM SEMUA SISTEM (send.ts).
// Logika inti: lib/auto-input.ts (rencana, sesi, antrean) & lib/auto-input-run.ts (eksekutor).
import { getSys } from "../lib/settings";
import { ghToken, investTurboRepo, loadIntegrations } from "../lib/integrations";
import { ackTotoAlerts, dismissTotoRows, listTotoEvents, totoDispatchAt, totoWindowInfo, pruneTotoMacau, listTotoLog, logTotoEvent, pendingTotoAlerts, TOTO_MAX_ATTEMPTS, totoMacauRun } from "../lib/toto-macau";
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import { dateKeyNow } from "../lib/time";
import { hasMenu } from "../lib/menus";
import type { Processed } from "../lib/parser";
import type { UserProfile } from "../lib/db";
import {
	claimJob,
	hideJobs,
	pruneAutoInputJobs,
	ackFailureAlerts,
	claimRetry,
	pendingFailureAlerts,
	dueRetryJobs,
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
		historyDays: await getSys(env, "sys_auto_input_history_days"),
		retryMax: await getSys(env, "sys_auto_input_retry_max"),
		retryGapMin: await getSys(env, "sys_auto_input_retry_gap_min"),
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

const idList = (v: unknown): number[] => (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 300);

/** Checkbox + "Hapus terpilih" di Riwayat Job: sembunyikan job milik sendiri (sudah beres / ditangani manual). */
export async function autoInputHideJobs(env: Env, token: string, ids: unknown) {
	const s = await gate(env, token);
	const r = await hideJobs(env, s.username, idList(ids));
	if (r.hidden) await logActivity(env, s.username, "AUTO PREDIKSI HAPUS RIWAYAT", `${r.hidden} job disembunyikan manual dari Riwayat Job`, "INFO", "").catch(() => {});
	return { success: true, ...r, message: r.skipped ? `${r.hidden} dihapus; ${r.skipped} dilewati (masih berjalan/antre atau bukan milikmu).` : `${r.hidden} catatan dihapus dari daftar.` };
}

/** Checkbox + "Hapus terpilih" di Toto Macau: tandai ditangani manual (berlaku untuk semua user di website itu). */
export async function autoInputDismissToto(env: Env, token: string, ids: unknown) {
	const s = await gate(env, token);
	const r = await dismissTotoRows(env, s.profile.websites, idList(ids), s.username);
	if (r.dismissed) await logActivity(env, s.username, "TOTO MACAU HAPUS BARIS", `${r.dismissed} baris ditandai ditangani manual (tidak diperiksa otomatis lagi)`, "INFO", "").catch(() => {});
	const n = idList(ids).length;
	return { success: true, ...r, message: r.dismissed < n ? `${r.dismissed} baris dihapus; ${n - r.dismissed} dilewati (bukan website milikmu).` : `${r.dismissed} baris dihapus dan tidak diperiksa otomatis lagi.` };
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

/** Percobaan ulang otomatis untuk job GAGAL (dipanggil cron tiap menit). Maks 1 job per tick (batas 50 subrequest). Return true bila ada yang dijalankan. */
export async function autoInputRetryTick(env: Env, fetchFn?: Fetcher): Promise<boolean> {
	const [maxRetries, gapMin] = await Promise.all([getSys(env, "sys_auto_input_retry_max"), getSys(env, "sys_auto_input_retry_gap_min")]);
	if (maxRetries <= 0) return false;
	const due = await dueRetryJobs(env, maxRetries, gapMin, 3);
	for (const cand of due) {
		const job = await claimRetry(env, cand.id, maxRetries, gapMin);
		if (!job) continue; // sudah diambil tick lain
		const n = job.attempts;
		const tag = `[Percobaan ulang ${n}/${maxRetries}] `;
		const sess = await getSession(env, job.username, job.website);
		if (!sess?.phpsessid) {
			await finishJob(env, job.id, "FAILED", job.stage || "cek", tag + "PHPSESSID belum disimpan — input manual.", job.period);
			continue;
		}
		const plan = { ok: true as const, market: job.market, prizes: job.prizes, date: job.resultDate, key: "" };
		const r = await runAutoInput({ session: sess, plan, fetchFn, resumePeriod: job.period || undefined, onStage: (st, period) => setStage(env, job.id, st, period) });
		const left = maxRetries - n;
		const note = r.ok ? "" : left > 0 ? ` (dicoba lagi otomatis ±${gapMin} menit)` : " (percobaan otomatis habis — CEK MANUAL)";
		await finishJob(env, job.id, r.ok ? "DONE" : "FAILED", r.ok ? "selesai" : r.stage, tag + r.detail + note, r.period || job.period);
		await logActivity(env, job.username, "AUTO PREDIKSI", `[${job.website}] ${job.market} ${job.prizes.join("/")} — ${tag}${r.detail}`, r.ok ? "BERHASIL" : "GAGAL", "").catch(() => {});
		return true; // satu job per tick
	}
	return false;
}

export async function autoInputRun(env: Env, token: string, jobId: number, fetchFn?: Fetcher) {
	const s = await gate(env, token);
	const o = await runQueuedJob(env, s.username, Number(jobId), fetchFn);
	return { success: o.status === "BERHASIL", ...o };
}

/** Peringatan terakhir: job yang tetap GAGAL setelah semua percobaan + Toto Macau gagal dibaca/dikirim. Dipoll browser dari menu mana pun. */
export async function autoInputAlerts(env: Env, token: string) {
	const s = await gate(env, token);
	const maxRetries = await getSys(env, "sys_auto_input_retry_max");
	const jobs = await pendingFailureAlerts(env, s.username, maxRetries);
	const toto = (await pendingTotoAlerts(env, s.profile.websites)).map((t) => ({
		id: -t.id, // id negatif = catatan Toto Macau (dibedakan saat ack)
		website: t.website,
		market: t.market || (t.game === "m51" ? "TOTO MACAO 5D" : "TOTO MACAU"),
		prizes: t.number ? [t.number] : [],
		stage: "cek",
		detail: t.detail,
		attempts: t.attempts,
	}));
	return { success: true, alerts: [...jobs, ...toto] };
}

export async function autoInputAckAlerts(env: Env, token: string, ids: number[]) {
	const s = await gate(env, token);
	const all = (Array.isArray(ids) ? ids : []).map(Number);
	await ackFailureAlerts(env, s.username, all.filter((n) => n > 0));
	await ackTotoAlerts(env, all.filter((n) => n < 0).map((n) => -n));
	return { success: true };
}

/** Riwayat Auto Check Toto Macau/5D untuk website milik akun ini (3 hari terakhir). */
export async function autoInputTotoLog(env: Env, token: string) {
	const s = await gate(env, token);
	return {
		success: true,
		mode: await getSys(env, "sys_totomacau_mode"),
		maxAttempts: TOTO_MAX_ATTEMPTS,
		rows: await listTotoLog(env, s.profile.websites, await getSys(env, "sys_auto_input_history_days")),
		...(await listTotoEvents(env, s.profile.websites, 60)),
		dispatchAt: await totoDispatchAt(env),
		window: await totoWindowInfo(env),
	};
}

/** Pemangkasan harian: job Auto Prediksi + catatan/log Toto Macau yang lebih lama dari sys_auto_input_history_days (bawaan 7 hari) dihapus. */
export async function pruneAutoPrediksiHistory(env: Env): Promise<{ jobs: number; totoLog: number; totoEvents: number }> {
	const jobs = await pruneAutoInputJobs(env);
	const t = await pruneTotoMacau(env);
	return { jobs, totoLog: t.log, totoEvents: t.events };
}

/** Pemicu workflow GitHub Actions toto-macau.yml (prosesnya di Actions, bebas batas subrequest Cloudflare). */
export async function dispatchTotoMacau(env: Env, user?: string): Promise<void> {
	await loadIntegrations(env);
	if (!ghToken(env)) throw new Error("GitHub Actions belum dikonfigurasi (token GitHub). Isi di Admin > Integrasi.");
	const resp = await fetch(`https://api.github.com/repos/${investTurboRepo(env)}/actions/workflows/toto-macau.yml/dispatches`, {
		method: "POST",
		headers: { Authorization: `Bearer ${ghToken(env)}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "kd-panel-worker", "Content-Type": "application/json" },
		body: JSON.stringify({ ref: "main", inputs: user ? { user, force: "1" } : {} }),
	});
	if (resp.status !== 204) {
		const hint = resp.status === 404 ? " -- workflow toto-macau.yml belum ada di repo, atau token tidak punya akses ke repo itu." : resp.status === 403 ? " -- token kurang izin (butuh 'Actions: Read and write')." : "";
		throw new Error(`Gagal memicu GitHub Actions (HTTP ${resp.status})${hint}`);
	}
}

/** Tombol "Cek & Isi Sekarang": picu GitHub Actions (tanpa batas subrequest Cloudflare). Tanpa token GitHub: jalankan 1 website langsung di Worker. */
export async function autoInputTotoRun(env: Env, token: string) {
	const s = await gate(env, token);
	try {
		await dispatchTotoMacau(env, s.username);
		await logTotoEvent(env, "", "info", "INFO", `Tombol CEK & ISI SEKARANG ditekan oleh ${s.username} → GitHub Actions dipicu`);
		await logActivity(env, s.username, "TOTO MACAU AUTO", "Cek & Isi Sekarang — dipicu lewat GitHub Actions", "BERHASIL", "").catch(() => {});
		return { success: true, viaGithub: true, message: "Dipicu di GitHub Actions. Hasilnya masuk ±1–2 menit — daftar di kartu akan diperbarui otomatis." };
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		const sum = await totoMacauRun(env, { only: [s.username], force: true, maxSites: 1 });
		await logActivity(env, s.username, "TOTO MACAU AUTO", "Cek & Isi Sekarang (langsung di Worker, 1 website) — " + sum.message, sum.failed || sum.conflict ? "GAGAL" : "BERHASIL", "").catch(() => {});
		return { success: true, viaGithub: false, ...sum, message: `GitHub Actions tidak bisa dipicu (${why}). Dijalankan langsung untuk 1 website: ${sum.message}` };
	}
}
