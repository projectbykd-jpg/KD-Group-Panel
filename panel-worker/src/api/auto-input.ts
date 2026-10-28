// Endpoint menu "Auto Prediksi" + kaitan ke alur KIRIM SEMUA SISTEM (send.ts).
// Logika inti: lib/auto-input.ts (rencana, sesi, antrean) & lib/auto-input-run.ts (eksekutor).
import { getSys, getSysCached } from "../lib/settings";
import { autoInputProxyRepo, ghToken, investTurboRepo, loadIntegrations } from "../lib/integrations";
import { ackTotoAlerts, dismissTotoRows, listTotoEvents, totoDispatchAt, totoWindowInfo, pruneTotoMacau, listTotoLog, logTotoEvent, pendingTotoAlerts, TOTO_MAX_ATTEMPTS, totoMacauRun } from "../lib/toto-macau";
import { requireSession } from "./auth";
import { saveMaster, loadMasterData } from "../lib/master-data";
import { logActivity } from "../lib/activity";
import { dateKeyNow } from "../lib/time";
import { hasMenu } from "../lib/menus";
import type { Processed } from "../lib/parser";
import type { UserProfile } from "../lib/db";
import type { AutoInputPlan } from "../lib/auto-input";
import {
	adminBaseProblem,
	getTotalsRow,
	listTotals,
	saveTotals,
	setJobTotalsText,
	recordManualTotalsJob,
	manualJobStatus,
	getManualJob,
	withTotalsText,
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
	getConfig,
	getDisabledMarkets,
	getSession,
	normMarket,
	clearLegacyDisabled,
	catalogMarkets,
	getSessions,
	listJobs,
	planAutoInput,
	saveSession,
	sessionHint,
	setEnabled,
	setStage,
	startJob,
} from "../lib/auto-input";
import { adminFetcherFor, claimNextProxyJob, deleteProxy, getJobById, getLatestJobFor, getProxy, proxyUsesSite, saveProxy } from "../lib/auto-input";
import { cleanProxyInput, probeTunnel, proxyFetcher, tlsClientHello } from "../lib/proxy-fetch";
import { findMarketCode, readPrediksiLastTotals, readPrediksiTotals, runAutoInput, type Fetcher } from "../lib/auto-input-run";

/** Jam awal setelah tengah malam WIB (sys_auto_input_midnight_grace_h): tanggal form admin boleh = tanggal result + 1. */
async function allowNextDay(env: Env, nowMs = Date.now()): Promise<boolean> {
	const h = await getSys(env, "sys_auto_input_midnight_grace_h");
	const wibHour = new Date(nowMs + 7 * 3600_000).getUTCHours();
	return h > 0 && wibHour < h;
}

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
	// 3 query Turso saja (dulu 5+ ditambah ensure 12 perintah): config (saklar + pasaran mati), sesi, riwayat job.
	const [cfg, sessions, jobs] = await Promise.all([getConfig(env, s.username), getSessions(env, s.username), listJobs(env, s.username)]);
	const proxy = cfg.proxy;
	const { enabled } = cfg;
	const isAdmin = s.profile.role === "ADMIN";
	await loadMasterData(env);
	let disabledMarkets = await getDisabledMarkets(env);
	// Pemindahan sekali jalan: daftar lama per-akun milik ADMIN naik jadi daftar global (lalu dikosongkan agar tidak terulang).
	if (isAdmin && cfg.disabledMarkets.length) {
		const merged = [...new Set([...disabledMarkets, ...cfg.disabledMarkets])];
		const r = await saveMaster(env, "md_ai_off_markets", merged);
		if (r.ok) {
			await clearLegacyDisabled(env, s.username).catch(() => {});
			disabledMarkets = await getDisabledMarkets(env);
		}
	}
	// Daftar saklar = katalog pasaran panel (Invest + Panel-Z) + riwayat job + yang sudah dimatikan; tanpa query tambahan.
	const seen = jobs.map((j) => normMarket(j.market)).filter(Boolean);
	return {
		success: true,
		enabled,
		isAdmin,
		markets: [...new Set([...catalogMarkets(), ...seen, ...disabledMarkets])].sort().map((m) => ({ market: m, auto: !disabledMarkets.includes(m) })),
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
		// Jalur kedua (proxy): kata sandi TIDAK pernah dikirim balik -- hanya penanda "terisi".
		proxy: { enabled: !!proxy?.enabled, scheme: proxy?.scheme ?? "http", host: proxy?.host ?? "", port: proxy?.port || "", user: proxy?.user ?? "", hasPass: !!proxy?.pass, sites: proxy?.sites ?? [] },
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

/** Simpan pasaran yang TIDAK di-auto. HANYA ADMIN; berlaku untuk semua user. markets = daftar lengkap yang dimatikan (menggantikan yang lama). */
export async function autoInputSetMarkets(env: Env, token: string, markets: unknown) {
	const s = await gate(env, token);
	if (s.profile.role !== "ADMIN") throw new Error("Hanya ADMIN yang boleh mengatur pasaran Auto Prediksi (berlaku untuk semua user).");
	await loadMasterData(env);
	const before = await getDisabledMarkets(env);
	const r = await saveMaster(env, "md_ai_off_markets", Array.isArray(markets) ? markets : []);
	if (!r.ok) return { success: false, message: r.error };
	const list = await getDisabledMarkets(env);
	const off = list.filter((m) => !before.includes(m)), on = before.filter((m) => !list.includes(m));
	if (off.length || on.length) {
		await logActivity(env, s.username, "AUTO PREDIKSI", [off.length ? "Pasaran dimatikan (semua user): " + off.join(", ") : "", on.length ? "Pasaran di-auto lagi (semua user): " + on.join(", ") : ""].filter(Boolean).join(" · "), "BERHASIL", "");
	}
	return { success: true, disabledMarkets: list };
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

/** Jalur kedua (proxy) per user: simpan pengaturan. pass kosong = pertahankan yang lama. */
export async function autoInputSaveProxy(env: Env, token: string, data: Record<string, unknown>) {
	const s = await gate(env, token);
	const old = await getProxy(env, s.username);
	const c = cleanProxyInput({ scheme: data.scheme, host: data.host, port: data.port, user: data.user, pass: data.pass });
	const sites = Array.isArray(data.sites) ? (data.sites as unknown[]).map((x) => String(x).trim().toUpperCase()).filter((x) => s.profile.websites.includes(x)) : undefined;
	if (!c.ok) return { success: false, message: c.error };
	const enabled = !!data.enabled;
	const pass = c.cfg.pass !== "" ? c.cfg.pass : old?.pass ?? "";
	if (enabled && (!c.cfg.host || !c.cfg.port)) return { success: false, message: "Isi host dan port proxy dulu sebelum menyalakan Jalur Kedua." };
	if (enabled && c.cfg.user && !pass) return { success: false, message: "User proxy terisi tetapi kata sandi kosong (atau sebaliknya)." };
	await saveProxy(env, s.username, { enabled, scheme: c.cfg.scheme, host: c.cfg.host, port: c.cfg.port, user: c.cfg.user, pass: c.cfg.pass, sites });
	await logActivity(env, s.username, "AUTO PREDIKSI JALUR KEDUA", `${enabled ? "AKTIF" : "Nonaktif"} — proxy ${c.cfg.scheme}://${c.cfg.host}:${c.cfg.port}`, "BERHASIL", "");
	return { success: true, enabled };
}

export async function autoInputDeleteProxy(env: Env, token: string) {
	const s = await gate(env, token);
	await deleteProxy(env, s.username);
	await logActivity(env, s.username, "AUTO PREDIKSI JALUR KEDUA", "Proxy dihapus", "BERHASIL", "");
	return { success: true };
}

/** Uji proxy tersimpan (walau belum diaktifkan): minta alamat IP yang terlihat dari luar LEWAT proxy -- harus sama dengan IP yang didaftarkan di admin website. */
export async function autoInputTestProxy(env: Env, token: string, fetchFn?: Fetcher) {
	const s = await gate(env, token);
	const p = await getProxy(env, s.username);
	if (!p?.host || !p.port) return { success: false, message: "Proxy belum disimpan." };
	const f = fetchFn ?? proxyFetcher(p, { timeoutMs: getSysCached("sys_fetch_timeout_sec") * 1000 });
	// Uji bertahap supaya jelas di mana macetnya: (a) HTTP biasa lewat terowongan, (b) HTTPS cek-IP, (c) HTTPS website admin milik user.
	const sess = (await getSessions(env, s.username)).find((x) => x.baseUrl && !adminBaseProblem(x.website, x.baseUrl));
	const steps: { label: string; url: string; json?: boolean }[] = [
		{ label: "HTTP polos via terowongan", url: "http://api.ipify.org/?format=json", json: true },
		{ label: "HTTPS cek-IP", url: "https://api.ipify.org/?format=json", json: true },
		// pembanding HTTPS ke layanan di luar Cloudflare: bedakan "semua HTTPS gagal" dari "hanya tujuan di Cloudflare yang gagal"
		{ label: "HTTPS pembanding Google", url: "https://www.google.com/generate_204" },
		{ label: "HTTPS pembanding AWS", url: "https://httpbin.org/ip" },
	];
	if (sess) steps.push({ label: `HTTPS admin ${sess.website}`, url: sess.baseUrl });
	const lines: string[] = [];
	let ip = "";
	let adminOk = false;
	let anyOk = false;
	for (const st of steps) {
		try {
			const res = await f(st.url, { headers: { Accept: "application/json", "User-Agent": sess?.ua || "Mozilla/5.0" }, redirect: "manual" });
			const text = (await res.text()).slice(0, 400);
			anyOk = true;
			if (st.json) {
				const m = text.match(/"ip"\s*:\s*"([0-9a-f:.]{3,45})"/i);
				if (m && !ip) ip = m[1];
				lines.push(`${st.label}: OK (HTTP ${res.status}${m ? ", IP " + m[1] : ""})`);
			} else {
				if (st.label.startsWith("HTTPS admin")) adminOk = true;
				lines.push(`${st.label}: OK (HTTP ${res.status})`);
			}
		} catch (e) {
			lines.push(`${st.label}: GAGAL — ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
		}
	}
	// Bila HTTPS gagal padahal HTTP polos jalan: kirim ClientHello TLS MENTAH lewat terowongan. Ada balasan (0x16 ServerHello / 0x15 alert) =
	// proxy meneruskan lalu lintas TLS (masalah ada di sisi TLS Worker); ditutup tanpa balasan = proxy/jalur menolak lalu lintas TLS dari Cloudflare.
	if (!fetchFn && lines.some((l) => l.startsWith("HTTPS") && l.includes("GAGAL"))) {
		for (const [label, host] of [["TLS mentah ke Google", "www.google.com"], ["TLS mentah ke AWS", "httpbin.org"]] as const) {
			try {
				lines.push(`${label}: ${await probeTunnel(p, host, 443, tlsClientHello(host), { timeoutMs: 12_000 })}`);
			} catch (e) {
				lines.push(`${label}: GAGAL — ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
			}
		}
	}
	if (!fetchFn && lines.some((l) => l.startsWith("HTTPS cek-IP") && l.includes("GAGAL"))) {
		try {
			const r2 = await proxyFetcher(p, { tlsNoOptions: true, timeoutMs: 12_000 })("https://api.ipify.org/?format=json");
			lines.push(`HTTPS varian startTls tanpa opsi: OK (HTTP ${r2.status})`);
		} catch (e) {
			lines.push(`HTTPS varian startTls tanpa opsi: GAGAL — ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
		}
	}
	// Catatan WAJIB: baris "HTTPS … dari Worker" memang selalu GAGAL (Cloudflare Worker tak mendukung TLS lewat proxy) — itu NORMAL,
	// bukan masalah proxy Anda. Yang penting: IP benar + "TLS mentah" dibalas (= proxy meneruskan HTTPS). Auto Prediksi jalan lewat GitHub.
	const tlsForwards = lines.some((l) => l.startsWith("TLS mentah") && /balasan \d+ byte/.test(l));
	const head = ip
		? `Proxy OK. IP yang terlihat dari luar: ${ip} — pastikan sama dengan yang didaftarkan di admin.`
		: adminOk
			? "Proxy bisa menjangkau website admin."
			: tlsForwards
				? "Proxy meneruskan HTTPS dengan benar (lihat 'TLS mentah')."
				: anyOk
					? "Proxy tersambung tetapi belum bisa memakai HTTPS ke tujuan."
					: "Proxy gagal.";
	const note = tlsForwards
		? " CATATAN: baris 'HTTPS … GAGAL' di bawah berjalan dari Cloudflare Worker yang memang TIDAK mendukung TLS lewat proxy — itu WAJAR, bukan masalah proxy Anda. Auto Prediksi TIDAK memakai jalur ini; ia jalan lewat GitHub. Untuk menguji jalur sebenarnya, pakai tombol 'Uji (tanpa kirim)' di kartu website."
		: "";
	return { success: !!ip || adminOk || tlsForwards, ip: ip || undefined, message: `${head}${note} | ${lines.join(" | ")}` };
}

// ---------------------------------------------------------------------------
// Jalur Kedua (proxy) — jembatan ke runner GitHub Actions (autoinput-proxy.yml)
//
// Worker TIDAK bisa menjalankan HTTPS ke admin lewat proxy (Cloudflare Workers tidak mendukung TLS di atas terowongan
// CONNECT/SOCKS5 — terbukti lewat diagnosa: TLS mentah dibalas server, tapi startTls selalu ditutup). Maka untuk user yang
// menyalakan Jalur Kedua, eksekusi Auto Prediksi dipindah ke runner Node di GitHub Actions yang jalan dari IP proxy user dan
// punya TLS stack normal. Runner memanggil dua endpoint di bawah (via /__cron, auth CRON_KEY) dan MEMAKAI ULANG runAutoInput.
// ---------------------------------------------------------------------------
const GH_PROXY_HEADERS = (t: string) => ({ Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json", "User-Agent": "daygroup-panel", "X-GitHub-Api-Version": "2022-11-28" });

/** Picu workflow autoinput-proxy.yml untuk 1 user. Dikunci KV ±90 dtk supaya pemanggilan per-website tidak memicu puluhan run. Gagal = non-fatal. */
export async function dispatchAutoInputProxy(env: Env, user: string): Promise<void> {
	const t = ghToken(env);
	if (!t) return; // belum dikonfigurasi
	const u = String(user).trim();
	if (!u) return;
	try {
		const lockKey = `aiproxy:disp:${u.toLowerCase()}`;
		if (await env.SESS.get(lockKey)) return; // sudah dipicu baru-baru ini
		await env.SESS.put(lockKey, "1", { expirationTtl: 90 });
		const resp = await fetch(`https://api.github.com/repos/${autoInputProxyRepo(env)}/actions/workflows/autoinput-proxy.yml/dispatches`, {
			method: "POST",
			headers: GH_PROXY_HEADERS(t),
			body: JSON.stringify({ ref: "main", inputs: { user: u } }),
		});
		if (resp.status !== 204) console.error("dispatchAutoInputProxy gagal:", resp.status, (await resp.text()).slice(0, 200));
	} catch (e) {
		console.error("dispatchAutoInputProxy error:", e instanceof Error ? e.message : e);
	}
}

/**
 * Runner meminta SATU job berikutnya untuk dijalankan (QUEUED lalu due-retry). Mengembalikan sesi (PHPSESSID) + rencana +
 * konfigurasi proxy user. CATATAN KEAMANAN: PHPSESSID & sandi proxy MEMANG dikirim ke runner (lewat endpoint ber-CRON_KEY) —
 * itulah izin yang diberikan pemilik saat memilih Jalur Kedua; runner tidak pernah menuliskannya ke log.
 */
export async function autoInputProxyNext(env: Env, user: string) {
	const u = String(user).trim();
	if (!u) return { ok: false, message: "Query 'user' wajib diisi." };
	const px = await getProxy(env, u);
	if (!px?.enabled || !px.host || !px.port) return { ok: true, done: true, job: null, message: "Jalur Kedua tidak aktif untuk user ini." };
	const [maxRetries, gapMin] = await Promise.all([getSys(env, "sys_auto_input_retry_max"), getSys(env, "sys_auto_input_retry_gap_min")]);
	const claimed = await claimNextProxyJob(env, u, maxRetries, gapMin, px.sites);
	if (!claimed) return { ok: true, done: true, job: null };
	const sess = await getSession(env, u, claimed.job.website);
	if (!sess?.phpsessid) {
		await finishJob(env, claimed.job.id, "FAILED", "cek", "PHPSESSID belum disimpan — input manual.");
		return { ok: true, done: false, job: null, note: `PHPSESSID ${claimed.job.website} kosong, job dilewati.` };
	}
	return {
		ok: true,
		done: false,
		maxRetries,
		gapMin,
		allowNextDay: await allowNextDay(env),
		proxy: { scheme: px.scheme, host: px.host, port: px.port, user: px.user, pass: px.pass },
		job: {
			id: claimed.job.id,
			retry: claimed.retry,
			dryRun: claimed.job.resultKey.startsWith("UJI:"), // job uji: runAutoInput dryRun (tanpa Kirim/Hitung)
			totalsOnly: claimed.job.resultKey.startsWith("TOTALS:"), // job baca-Total pasaran off-input: hanya readPrediksiLastTotals
			attempts: claimed.job.attempts,
			website: claimed.job.website,
			baseUrl: sess.baseUrl,
			phpsessid: sess.phpsessid,
			ua: sess.ua ?? "",
			market: claimed.job.market,
			prizes: claimed.job.prizes,
			date: claimed.job.resultDate,
			period: claimed.job.period,
		},
	};
}

/** Runner melaporkan hasil SATU job. Worker yang menulis status final + simpan Total + log (logika tetap di Worker). Idempoten. */
export async function autoInputProxyDone(env: Env, data: Record<string, unknown>) {
	const u = String(data.user ?? "").trim();
	const jobId = Number(data.jobId);
	if (!u || !Number.isInteger(jobId) || jobId <= 0) return { ok: false, message: "user/jobId tidak valid." };
	const job = await getJobById(env, u, jobId);
	if (!job) return { ok: false, message: "Job tidak ditemukan." };
	if (job.status !== "RUNNING") return { ok: true, message: "Job sudah final — laporan diabaikan (idempoten)." };
	const okRun = String(data.ok) === "1" || data.ok === true;
	const detailBaseRaw = String(data.detail ?? "").slice(0, 440);
	// Job TOTALS (baca Total pasaran off-input lewat Jalur Kedua): runner melaporkan omset/referal/menang + Last Result; Worker mencatat
	// seperti manualTotalsCheck (baris manual DONE/SKIPPED + simpan Total). Job carrier ditutup SKIPPED.
	if (job.resultKey.startsWith("TOTALS:")) {
		const period = String(data.period ?? "");
		const totals = okRun && data.omset != null ? { omset: String(data.omset), referal: String(data.referal ?? "0"), menang: String(data.menang ?? "0") } : null;
		const numbers = String(data.numbers ?? "").split("/").map((x) => x.trim()).filter(Boolean);
		const why = okRun ? "" : detailBaseRaw || "Total gagal dibaca.";
		const cmp = Math.min(job.prizes.length, numbers.length);
		const differs = !!totals && (!cmp || job.prizes.slice(0, cmp).some((n, i) => numbers[i] !== n));
		const lastTxt = totals ? ` Last Result periode ${period} angka ${numbers.join("/")}.` : "";
		const warn = differs ? ` ⚠ Berbeda dari result yang dikirim (${job.prizes.join("/")}) — angka baru belum diinput/dihitung di admin? Tekan Ambil ulang.` : "";
		const detail = withTotalsText(`Total dibaca lewat Jalur Kedua (Last Result → Submit): ${job.market} ${job.prizes.join("/")}.${lastTxt}${warn}`, totals, why);
		const key = `manual:${normMarket(job.market)}:${job.resultDate}:${job.prizes.join("/")}`;
		const manualId = await recordManualTotalsJob(env, { username: u, website: job.website, market: job.market, prizes: job.prizes, resultDate: job.resultDate, key, ok: !!totals, detail, period });
		await saveTotals(env, { id: manualId, username: u, website: job.website, market: job.market, prizes: job.prizes, resultDate: job.resultDate }, period, totals, why, differs ? `Last Result admin ${numbers.join("/")} ≠ result dikirim ${job.prizes.join("/")} — cek sebelum menyalin` : "").catch(() => {});
		await finishJob(env, jobId, "SKIPPED", "prediksi", detail, period); // tutup carrier
		await logActivity(env, u, "AUTO PREDIKSI", `[${job.website}] ${detail}`, totals ? "BERHASIL" : "GAGAL", "").catch(() => {});
		return { ok: true };
	}
	// Job UJI Jalur Kedua (dry-run): catat sebagai SKIPPED (tidak memicu retry/peringatan), prefiks jelas supaya mudah dibaca & dipoll.
	if (job.resultKey.startsWith("UJI:")) {
		const msg = `UJI Jalur Kedua ${okRun ? "BERHASIL" : "GAGAL"} — ${job.website}: ${detailBaseRaw}`;
		await finishJob(env, jobId, "SKIPPED", "uji", msg, "");
		await logActivity(env, u, "AUTO PREDIKSI JALUR KEDUA", msg, okRun ? "BERHASIL" : "GAGAL", "").catch(() => {});
		return { ok: true };
	}
	const [maxRetries, gapMin] = await Promise.all([getSys(env, "sys_auto_input_retry_max"), getSys(env, "sys_auto_input_retry_gap_min")]);
	const stage = String(data.stage ?? (okRun ? "selesai" : "cek")).slice(0, 20);
	const period = String(data.period ?? "");
	const detailBase = String(data.detail ?? "").slice(0, 480);
	const note = String(data.note ?? "");
	const totals = okRun && data.omset != null ? { omset: String(data.omset), referal: String(data.referal ?? "0"), menang: String(data.menang ?? "0") } : null;
	const retry = String(data.retry) === "1" || data.retry === true;
	const tag = retry ? `[Percobaan ulang ${job.attempts}/${maxRetries}] ` : "";
	const left = maxRetries - job.attempts;
	const retryNote = okRun ? "" : retry ? (left > 0 ? ` (dicoba lagi otomatis ±${gapMin} menit)` : " (percobaan otomatis habis — CEK MANUAL)") : "";
	const shown = okRun ? withTotalsText(tag + detailBase, totals, note) : tag + detailBase + retryNote;
	await finishJob(env, jobId, okRun ? "DONE" : "FAILED", okRun ? "selesai" : stage, shown, period);
	if (okRun) await saveTotals(env, { id: jobId, username: u, website: job.website, market: job.market, prizes: job.prizes, resultDate: job.resultDate }, period, totals, note).catch(() => {});
	await logActivity(env, u, "AUTO PREDIKSI", `[${job.website}] ${job.market} ${job.prizes.join("/")} — ${shown}`, okRun ? "BERHASIL" : "GAGAL", "").catch(() => {});
	return { ok: true };
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
	// Jalur Kedua AKTIF: Worker tidak bisa menjangkau admin. Buat JOB UJI (dry-run) & picu runner GitHub — hasilnya dipoll browser.
	if (!fetchFn && (await proxyForSite(env, s.username, w))) {
		const started = await startJob(env, s.username, w, { ok: true, market: mk, prizes: ["0000", "0000", "0000"], date: dateKeyNow(), key: `UJI:${Date.now()}` });
		if ("existing" in started) return { success: false, message: "Uji sebelumnya masih berjalan — tunggu sebentar lalu coba lagi." };
		await dispatchAutoInputProxy(env, s.username);
		return { success: true, pending: true, jobId: started.id, message: `Uji ${w} ${mk} dikirim ke GitHub (lewat proxy). Menunggu hasil… (dry-run: cek login + baca form, TIDAK mengubah apa pun di admin)` };
	}
	const r = await runAutoInput({
		session: sess,
		plan: { ok: true, market: mk, prizes: ["0000", "0000", "0000"], date: dateKeyNow(), key: "TEST" },
		dryRun: true,
		fetchFn: await adminFetcherFor(env, s.username, fetchFn),
		allowNextDay: await allowNextDay(env),
	});
	return { success: r.ok, message: r.detail, preview: r.preview };
}

/** Monitor KIRIM SEMUA (website Jalur Kedua): status job TERBARU website+pasaran hari ini, supaya browser bisa menampilkan hasil async dari runner GitHub. */
export async function autoInputJobStatus(env: Env, token: string, website: string, market: string) {
	const s = await gate(env, token);
	const w = mustOwnWebsite(s.profile, website);
	const job = await getLatestJobFor(env, s.username, w, String(market ?? ""));
	if (!job) return { success: true, found: false };
	const final = job.status === "DONE" || job.status === "FAILED" || job.status === "SKIPPED";
	return { success: true, found: true, status: job.status, final, done: job.status === "DONE", detail: job.detail };
}

/** Polling hasil job UJI Jalur Kedua (dibuat autoInputTest saat proxy aktif). pending=true selama runner belum lapor. */
export async function autoInputProxyTestStatus(env: Env, token: string, jobId: number) {
	const s = await gate(env, token);
	const job = await getJobById(env, s.username, Number(jobId));
	if (!job) return { success: false, pending: false, message: "Uji tidak ditemukan." };
	if (job.status === "QUEUED" || job.status === "RUNNING") return { success: false, pending: true, message: "Menunggu runner GitHub…" };
	const okUji = /UJI Jalur Kedua BERHASIL/.test(job.detail);
	return { success: okUji, pending: false, message: job.detail };
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
	/** Pasaran yang dihitung MANUAL (dimatikan per pasaran, Auto Prediksi ON): browser memanggil autoInputTotalsCheck per website -- hanya membaca menu Prediksi. Saklar OFF = tidak ada daftar ini sama sekali. */
	totalsCheck?: ManualCheck[];
	/** Result yang dikirim: browser memakainya untuk membaca Total dari menu Prediksi bila job Auto Prediksi website itu TIDAK berhasil. */
	plan?: Omit<ManualCheck, "website">;
}
export interface ManualCheck {
	website: string;
	market: string;
	prizes: string[];
	date: string;
}

/** Pesan bila Total diminta saat saklar Auto Prediksi OFF: tidak ada permintaan apa pun ke admin website. */
const AUTO_PROXY_TOTALS_MSG = "Jalur Kedua AKTIF: pembacaan Total lewat panel tidak tersedia (admin hanya bisa dijangkau dari GitHub lewat proxy). Total pasaran yang di-auto tetap terbaca otomatis dari Riwayat Job saat KIRIM SEMUA.";
const AUTO_OFF_TOTALS_MSG = "Auto Prediksi sedang OFF, jadi Total Omset/Referal/Menang tidak dibaca. Nyalakan 'Aktifkan' di menu Auto Prediksi bila ingin dibaca lagi.";

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
	const enabled = await getEnabled(env, profile.username);
	const plan = planAutoInput(rawText, processed);
	// Auto Prediksi OFF = SEMUA yang menyentuh admin website ikut OFF, termasuk pembacaan Total Omset/Referal/Menang
	// (perintah pemilik 28 Okt 2026). Dulu Total tetap dibaca dari menu Prediksi walau saklar OFF.
	if (!enabled) return undefined;
	if (!plan.ok) return { skippedReason: plan.reason, results: [] };
	if ((await getDisabledMarkets(env, profile.username)).includes(normMarket(plan.market))) {
		return {
			skippedReason: `Pasaran ${plan.market} tidak di-auto (diatur di menu Auto Prediksi) — input manual`,
			results: [],
			totalsCheck: await manualChecks(env, profile, plan, websites),
		};
	}

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
			// Pasaran DI-AUTO yang job-nya belum selesai: Total TIDAK dibaca (Last Result admin masih periode lama -> menyesatkan;
			// pemilik 25 Okt). Job GAGAL dicoba ulang otomatis oleh cron; alasannya ada di Riwayat Job.
			results.push({ website, status: "SUDAH", detail: `Result ini sudah pernah diproses (${started.existing.status}).`, manual: started.existing.status === "FAILED" });
		} else {
			results.push({ website, status: "ANTRI", detail: "Menunggu dijalankan", manual: false, jobId: started.id });
		}
	}
	// Jalur Kedua: picu runner GitHub begitu job dibuat (tidak menunggu browser memanggil autoInputRun per website) supaya
	// job tidak yatim bila tab ditutup. Dikunci KV, jadi aman walau autoInputRun juga memicu. ghToken kosong -> diam (no-op).
	if (await proxyAny(env, profile.username)) await dispatchAutoInputProxy(env, profile.username);
	return { results, plan: { market: plan.market, prizes: plan.prizes, date: plan.date } };
}

/** true bila user menyalakan Jalur Kedua & mengisinya lengkap (semua admin-call-nya harus lewat runner GitHub, bukan Worker). */
async function proxyAny(env: Env, username: string): Promise<boolean> {
	const px = await getProxy(env, username).catch(() => null);
	return !!(px?.enabled && px.host && px.port);
}
async function proxyForSite(env: Env, username: string, website: string): Promise<boolean> {
	return proxyUsesSite(await getProxy(env, username).catch(() => null), website);
}

/** Website (yang punya PHPSESSID) untuk pembacaan Total pasaran manual. Galat apa pun -> daftar kosong: tidak boleh mengganggu KIRIM SEMUA. */
async function manualChecks(env: Env, profile: UserProfile, plan: Extract<AutoInputPlan, { ok: true }>, websites: string[]): Promise<ManualCheck[]> {
	try {
		const have = new Set((await getSessions(env, profile.username)).filter((x) => x.phpsessid).map((x) => x.website));
		return websites
			.map((w) => String(w).trim().toUpperCase())
			.filter((w) => have.has(w))
			.map((website) => ({ website, market: plan.market, prizes: plan.prizes, date: plan.date }));
	} catch {
		return [];
	}
}

/**
 * Dipanggil browser TEPAT sesudah KIRIM SEMUA untuk pasaran yang dihitung MANUAL: buka menu Prediksi pasaran itu, klik Last Result,
 * tekan Submit, baca baris Result -- seketika, tanpa cron. HANYA membaca (tidak pernah Kirim/Hitung). Hasil masuk tabel Result &
 * Riwayat Job (Keterangan). Last Result yang berbeda dari result yang dikirim tetap dibaca, tapi ditandai jelas.
 */
export async function autoInputTotalsCheck(env: Env, token: string, data: Record<string, unknown>, fetchFn?: Fetcher) {
	const s = await gate(env, token);
	// Penjaga sisi server: browser lama (halaman belum di-refresh) bisa saja masih memanggil ini sesudah saklar dimatikan.
	if (!(await getEnabled(env, s.username))) return { success: false, website: String(data?.website ?? ""), message: AUTO_OFF_TOTALS_MSG };
	const w = mustOwnWebsite(s.profile, String(data?.website ?? ""));
	const market = String(data?.market ?? "").trim().slice(0, 60);
	const prizes = (Array.isArray(data?.prizes) ? data.prizes : []).map((x) => String(x).trim()).filter((x) => /^\d{1,8}$/.test(x)).slice(0, 3);
	const date = String(data?.date ?? "").trim().slice(0, 20);
	if (!market || !prizes.length) throw new Error("Pasaran/angka result tidak lengkap.");
	// Jalur Kedua: Worker tak bisa menjangkau admin (agwl). Baca Total lewat runner GitHub juga -> buat job TOTALS, browser poll hasilnya.
	if (!fetchFn && (await proxyForSite(env, s.username, w))) {
		const started = await startJob(env, s.username, w, { ok: true, market, prizes, date, key: `TOTALS:${normMarket(market)}:${date}:${Date.now()}` });
		if ("existing" in started) return { success: false, website: w, message: "Pembacaan Total sebelumnya masih berjalan — tunggu sebentar." };
		await dispatchAutoInputProxy(env, s.username);
		return { success: true, pending: true, jobId: started.id, website: w, message: `Baca Total ${w} ${market} lewat Jalur Kedua (GitHub)…` };
	}
	return manualTotalsCheck(env, s.username, w, market, prizes, date, fetchFn);
}

async function manualTotalsCheck(env: Env, username: string, w: string, market: string, prizes: string[], date: string, fetchFn?: Fetcher) {
	const sess = await getSession(env, username, w);
	if (!sess?.phpsessid) return { success: false, website: w, message: `PHPSESSID ${w} belum disimpan — Total tidak bisa dibaca.` };
	const badBase = adminBaseProblem(sess.website, sess.baseUrl);
	if (badBase) return { success: false, website: w, message: `URL admin ${w} ditolak: ${badBase}.` };
	const f: Fetcher = (await adminFetcherFor(env, username, fetchFn)) ?? ((u, i) => fetch(u, i));
	const key = `manual:${normMarket(market)}:${date}:${prizes.join("/")}`;
	let period = "";
	let numbers = prizes;
	let totals: Awaited<ReturnType<typeof readPrediksiLastTotals>>["totals"] | null = null;
	let why = "";
	try {
		const code = await findMarketCode(f, sess, market);
		const r = await readPrediksiLastTotals({ f, sess, code, market });
		totals = r.totals;
		period = String(r.last.period);
		numbers = r.last.numbers;
	} catch (e) {
		why = (e instanceof Error ? e.message : String(e)).slice(0, 240);
	}
	// Pembacaan ulang yang gagal tidak pernah menimpa angka yang sudah terbaca untuk result yang sama.
	if (!totals && (await manualJobStatus(env, username, w, key)) === "DONE") return { success: false, website: w, message: why + " (angka sebelumnya tetap)." };
	const cmp = Math.min(prizes.length, numbers.length);
	const differs = !!totals && (!cmp || prizes.slice(0, cmp).some((n, i) => numbers[i] !== n));
	const lastTxt = totals ? ` Last Result periode ${period} angka ${numbers.join("/")}.` : "";
	const warn = differs ? ` ⚠ Berbeda dari result yang dikirim (${prizes.join("/")}) — angka baru belum diinput/dihitung di admin? Tekan Ambil ulang di menu Result setelah menghitung.` : "";
	const detail = withTotalsText(`Total dibaca dari menu Prediksi (Last Result → Submit): ${market} ${prizes.join("/")}.${lastTxt}${warn}`, totals, why);
	const jobId = await recordManualTotalsJob(env, { username, website: w, market, prizes, resultDate: date, key, ok: !!totals, detail, period });
	await saveTotals(env, { id: jobId, username, website: w, market, prizes, resultDate: date }, period, totals, why, differs ? `Last Result admin ${numbers.join("/")} ≠ result dikirim ${prizes.join("/")} — cek sebelum menyalin` : "");
	await logActivity(env, username, "AUTO PREDIKSI", `[${w}] ${detail}`, totals ? "BERHASIL" : "GAGAL", "").catch(() => {});
	if (!totals) return { success: false, website: w, message: why };
	return { success: true, website: w, differs, message: `Terbaca: omset ${totals.omset}, referal ${totals.referal}, menang ${totals.menang} (periode ${period})${differs ? " — Last Result berbeda dari result yang dikirim" : ""}.` };
}

/** Menjalankan SATU job antre (tanpa autentikasi -- dipanggil setelah gate). */
export async function runQueuedJob(env: Env, username: string, jobId: number, fetchFn?: Fetcher): Promise<AutoInputOutcome> {
	// Jalur Kedua AKTIF: Worker TIDAK bisa menjangkau admin (IP Cloudflare berpindah; TLS lewat proxy tidak didukung Worker).
	// Eksekusi dialihkan ke runner GitHub Actions (autoinput-proxy.yml) yang jalan dari IP proxy user. Job dibiarkan QUEUED
	// supaya diklaim runner. fetchFn (test) menang: biarkan jalur normal saat diuji.
	if (!fetchFn) {
		const j0 = await getJobById(env, username, jobId);
		if (j0 && (await proxyForSite(env, username, j0.website))) {
			await dispatchAutoInputProxy(env, username);
			return { website: j0.website, status: "DILEWATI", detail: "Diproses lewat Jalur Kedua (GitHub Actions) — hasilnya muncul di Riwayat Job.", manual: false };
		}
	}
	const job = await claimJob(env, username, jobId);
	if (!job) return { website: "-", status: "SUDAH", detail: "Job tidak ditemukan atau sudah berjalan.", manual: false };
	const website = job.website;
	if ((await getDisabledMarkets(env, username)).includes(normMarket(job.market))) {
		await finishJob(env, job.id, "SKIPPED", "cek", `Pasaran ${job.market} tidak di-auto — input manual.`);
		return { website, status: "DILEWATI", detail: `Pasaran ${job.market} tidak di-auto — input manual.`, manual: true };
	}
	const sess = await getSession(env, username, website);
	if (!sess?.phpsessid) {
		await finishJob(env, job.id, "FAILED", "cek", "PHPSESSID belum disimpan.");
		return { website, status: "DILEWATI", detail: "PHPSESSID belum disimpan — input manual.", manual: true };
	}
	const plan = { ok: true as const, market: job.market, prizes: job.prizes, date: job.resultDate, key: "" };
	const r = await runAutoInput({
		session: sess,
		plan,
		fetchFn: await adminFetcherFor(env, username, fetchFn),
		allowNextDay: await allowNextDay(env),
		onStage: (st, period) => setStage(env, job.id, st, period),
	});
	// Keterangan job SELESAI memuat Total Omset/Referal/Menang (atau alasan belum terbaca) supaya terlihat di Riwayat Job.
	const shown = r.ok ? withTotalsText(r.detail, r.totals, r.totalsNote ?? "") : r.detail;
	await finishJob(env, job.id, r.ok ? "DONE" : "FAILED", r.ok ? "selesai" : r.stage, shown, r.period);
	if (r.ok) await saveTotals(env, job, r.period, r.totals, r.totalsNote ?? "").catch(() => {}); // job sudah beres; gagal simpan angka tidak boleh mengubahnya
	await logActivity(env, username, "AUTO PREDIKSI", `[${website}] ${job.market} ${job.prizes.join("/")} — ${shown}`, r.ok ? "BERHASIL" : "GAGAL", "").catch(() => {});
	return { website, status: r.ok ? "BERHASIL" : "GAGAL", detail: r.detail, manual: !r.ok };
}

/** Percobaan ulang otomatis untuk job GAGAL (dipanggil cron tiap menit). Maks 1 job per tick (batas 50 subrequest). Return true bila ada yang dijalankan. */
export async function autoInputRetryTick(env: Env, fetchFn?: Fetcher): Promise<boolean> {
	const [maxRetries, gapMin] = await Promise.all([getSys(env, "sys_auto_input_retry_max"), getSys(env, "sys_auto_input_retry_gap_min")]);
	if (maxRetries <= 0) return false;
	const due = await dueRetryJobs(env, maxRetries, gapMin, 3);
	for (const cand of due) {
		if (!fetchFn && (await proxyForSite(env, cand.username, cand.website))) {
			// retry website Jalur Kedua ditangani runner GitHub (claimNextProxyJob ambil job due-retry), bukan Worker.
			await dispatchAutoInputProxy(env, cand.username);
			continue;
		}
		const job = await claimRetry(env, cand.id, maxRetries, gapMin);
		if (!job) continue; // sudah diambil tick lain
		const n = job.attempts;
		const tag = `[Percobaan ulang ${n}/${maxRetries}] `;
		// pasaran dimatikan setelah job gagal -> berhenti mencoba (bukan gagal; tidak memicu peringatan)
		if ((await getDisabledMarkets(env, job.username)).includes(normMarket(job.market))) {
			await finishJob(env, job.id, "SKIPPED", job.stage || "cek", `Pasaran ${job.market} tidak di-auto — percobaan ulang dihentikan, input manual.`, job.period);
			continue;
		}
		const sess = await getSession(env, job.username, job.website);
		if (!sess?.phpsessid) {
			await finishJob(env, job.id, "FAILED", job.stage || "cek", tag + "PHPSESSID belum disimpan — input manual.", job.period);
			continue;
		}
		const plan = { ok: true as const, market: job.market, prizes: job.prizes, date: job.resultDate, key: "" };
		const r = await runAutoInput({ session: sess, plan, fetchFn: await adminFetcherFor(env, job.username, fetchFn), resumePeriod: job.period || undefined, allowNextDay: await allowNextDay(env), onStage: (st, period) => setStage(env, job.id, st, period) });
		const left = maxRetries - n;
		const note = r.ok ? "" : left > 0 ? ` (dicoba lagi otomatis ±${gapMin} menit)` : " (percobaan otomatis habis — CEK MANUAL)";
		await finishJob(env, job.id, r.ok ? "DONE" : "FAILED", r.ok ? "selesai" : r.stage, r.ok ? withTotalsText(tag + r.detail, r.totals, r.totalsNote ?? "") : tag + r.detail + note, r.period || job.period);
		if (r.ok) await saveTotals(env, job, r.period || job.period, r.totals, r.totalsNote ?? "").catch(() => {});
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

/** Menu Result: Total Omset/Referal/Menang periode yang baru dihitung (dibaca dari menu Prediksi admin) per website. */
export async function autoInputTotals(env: Env, token: string) {
	const s = await gate(env, token);
	const mine = new Set(s.profile.websites);
	return { success: true, websites: s.profile.websites, rows: (await listTotals(env, s.username)).filter((r) => mine.has(r.website)) };
}

/** Tombol "Ambil ulang" di tabel Result: baca lagi menu Prediksi untuk satu baris yang gagal terbaca. Tidak menyentuh Kirim/Hitung. */
export async function autoInputTotalsRefresh(env: Env, token: string, id: number, fetchFn?: Fetcher) {
	const s = await gate(env, token);
	if (!(await getEnabled(env, s.username))) return { success: false, message: AUTO_OFF_TOTALS_MSG };
	const row = await getTotalsRow(env, s.username, Number(id));
	if (!row) throw new Error("Baris tidak ditemukan.");
	const w = mustOwnWebsite(s.profile, row.website);
	if (await proxyForSite(env, s.username, w)) return { success: false, message: AUTO_PROXY_TOTALS_MSG };
	// Baris pasaran MANUAL: baca lagi Last Result TERKINI (admin mungkin baru menghitung), bukan periode lama.
	const manual = await getManualJob(env, s.username, row.jobId);
	if (manual) return manualTotalsCheck(env, s.username, w, manual.market, manual.prizes, manual.resultDate, fetchFn);
	const sess = await getSession(env, s.username, w);
	if (!sess?.phpsessid) return { success: false, message: `PHPSESSID ${w} belum disimpan.` };
	const badBase = adminBaseProblem(sess.website, sess.baseUrl);
	if (badBase) return { success: false, message: `URL admin ${w} ditolak: ${badBase}.` };
	const f: Fetcher = (await adminFetcherFor(env, s.username, fetchFn)) ?? ((u, i) => fetch(u, i));
	const keep = { id: row.jobId, username: s.username, website: w, market: row.market, prizes: row.prizes, resultDate: "" };
	try {
		const code = await findMarketCode(f, sess, row.market);
		const totals = await readPrediksiTotals({ f, sess, code, market: row.market, period: row.period, numbers: row.prizes });
		await saveTotals(env, keep, row.period, totals, "");
		await setJobTotalsText(env, row.jobId, totals).catch(() => {});
		return { success: true, message: `Terbaca: omset ${totals.omset}, referal ${totals.referal}, menang ${totals.menang}.` };
	} catch (e) {
		const why = (e instanceof Error ? e.message : String(e)).slice(0, 300);
		// angka yang sudah terbaca tidak pernah ditimpa kosong oleh pengambilan ulang yang gagal
		if (!row.omset && !row.referal && !row.menang) await saveTotals(env, keep, row.period, null, why).catch(() => {});
		return { success: false, message: why };
	}
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
	await ackTotoAlerts(env, all.filter((n) => n < 0).map((n) => -n), s.profile.websites);
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
