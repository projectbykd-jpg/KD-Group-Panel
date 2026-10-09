// Endpoint Role BOT — modul NEWS. Boleh diakses akun role BOT (allowBot) DAN Admin.
import { ghToken, newsTurboRepo } from "../lib/integrations";
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import { getTurso } from "../lib/turso";
import {
	AI_DEFAULT_VALID_DAYS,
	assertKeyNotReused,
	aiChatProvider,
	aiClearCooldown,
	aiCooldown,
	aiListModels,
	modelChain,
	aiKeyId,
	aiLastErrors,
	aiLoadProviders,
	aiRecentUsage,
	aiSaveProviders,
	aiUsageByKey,
	maskKey,
	normalizeBaseUrl,
	pickWriterModel,
	providerStatus,
	wibToday,
	type AiProvider,
} from "../lib/ai-provider";
import { tsNow } from "../lib/time";
import { fbDiagnose } from "../lib/fb-check";
import {
	BloggerAuthError,
	bloggerAuthUrl,
	bloggerExchangeCode,
	bloggerSetAuthState,
	bloggerVerify,
	botCfg,
	botCfgSet,
	botNewsRun,
	botNewsSnapshot,
	ensureNewsCategoryColumns,
	fbDirectProcessOne,
	fbTemplateGenerate,
	NEWS_CATEGORIES,
	requeueBloggerAuthFailures,
	resetBloggerTokenCache,
} from "../lib/bot-news";
import { TG_CHAT_RE, tgChannelRun, tgChannelTest } from "../lib/tg-channel";

async function gate(env: Env, token: string) {
	// BOT & ADMIN sama-sama boleh; OPERATOR/VIEWER ditolak.
	const s = await requireSession(env, token, { ignoreMaintenance: true, allowBot: true });
	if (s.profile.role !== "BOT" && s.profile.role !== "ADMIN") {
		throw new Error("Menu BOT hanya untuk akun BOT atau ADMIN.");
	}
	return s;
}

export async function botNewsStatus(env: Env, token: string) {
	await gate(env, token);
	return botNewsSnapshot(env);
}

export async function botNewsSaveConfig(env: Env, token: string, data: Record<string, unknown>) {
	const s = await gate(env, token);
	const patch: Record<string, string> = {};
	const allow = [
		// API key AI TIDAK lewat sini lagi -- dikelola per provider (botAiSave).
		"enabled", "per_run", "daily_cap", "site_per_run", "attribution", "rewrite_style", "images_per_article",
		"blogger_blog_id", "para_min", "para_max", "promo_url", "promo_text", "post_labels",
		"fb_enabled", "fb_page_id", "fb_page_token", "fb_direct_enabled", "fb_direct_daily_cap", "fb_page_url", "wa_channel_url", "blogger_site_url", "tg_channel_enabled", "tg_channel_id", "tg_channel_url",
		"news_banner_enabled", "news_banner_image", "news_banner_url", "news_banner_text", "auto_interval_minutes",
		"blogger_client_id", "blogger_client_secret", "blogger_redirect_uri",
	];
	for (const k of allow) {
		if (Object.prototype.hasOwnProperty.call(data, k)) {
			let v = String((data as any)[k] ?? "").trim();
			if (k === "enabled" || k === "attribution" || k === "fb_enabled" || k === "fb_direct_enabled" || k === "news_banner_enabled") v = v === "1" || v === "true" ? "1" : "0";
			if (k === "tg_channel_enabled") v = v === "1" || v === "true" ? "1" : "0";
			if (k === "tg_channel_id" && v && !TG_CHAT_RE.test(v)) throw new Error("Chat ID channel tidak valid. Contoh: -1001234567890 atau @namakanal.");
			if (k === "tg_channel_url" && v && !/^https:\/\/(t\.me|telegram\.me)\/[^\s]{3,200}$/i.test(v)) throw new Error("Link channel Telegram harus berupa https://t.me/… (salin dari info channel).");
			if (k === "para_min" || k === "para_max") v = v ? String(Math.min(40, Math.max(1, Math.floor(Number(v) || 0)))) : "";
			if (k === "images_per_article") v = v ? String(Math.min(8, Math.max(1, Math.floor(Number(v) || 1)))) : "";
			// kosongkan input token/secret TIDAK menghapus yg tersimpan
			if ((k === "fb_page_token" || k === "blogger_client_secret" || k === "blogger_client_id") && !v) continue;
			patch[k] = v;
		}
	}
	if (Object.keys(patch).length) await botCfgSet(env, patch);
	await logActivity(env, s.username, "BOT NEWS SETTING", "Ubah konfigurasi: " + Object.keys(patch).join(", "), "BERHASIL", "");
	return botNewsSnapshot(env);
}

/** Tombol TES CHANNEL TELEGRAM: satu pesan uji ke channel + penjelasan bila gagal. Chat ID dari form (atau yang tersimpan). */
export async function botTgChannelTest(env: Env, token: string, data: Record<string, unknown>) {
	const s = await gate(env, token);
	const r = await tgChannelTest(env, String(data.chat_id ?? ""));
	await logActivity(env, s.username, "BOT CHANNEL TELEGRAM TES", r.message.slice(0, 250), r.ok ? "BERHASIL" : "GAGAL", "");
	return { success: true, ...r };
}

/** Tombol KIRIM 1 ARTIKEL SEKARANG: melewati saklar aktif & jeda antar posting (batas harian tetap berlaku). */
export async function botTgChannelSendNow(env: Env, token: string) {
	const s = await gate(env, token);
	const r = await tgChannelRun(env, { force: true });
	await logActivity(env, s.username, "BOT CHANNEL TELEGRAM", r.message.slice(0, 250), r.posted ? "BERHASIL" : "INFO", "");
	return { success: true, ...r, snapshot: await botNewsSnapshot(env) };
}

export async function botNewsAddSource(env: Env, token: string, data: Record<string, unknown>) {
	const s = await gate(env, token);
	const name = String(data.name ?? "").trim();
	const url = String(data.url ?? "").trim();
	const kind = String(data.kind ?? "rss").trim().toLowerCase();
	const category = String(data.category ?? "umum").trim().toLowerCase();
	if (!name || !/^https?:\/\//i.test(url)) throw new Error("Nama & URL feed wajib (URL harus http/https).");
	if (!["rss", "gnews", "scrape"].includes(kind)) throw new Error("Jenis sumber tidak valid.");
	if (!(NEWS_CATEGORIES as readonly string[]).includes(category)) throw new Error("Kategori tidak valid.");
	await ensureNewsCategoryColumns(env);
	await getTurso(env)
		.prepare(`INSERT INTO news_source (name, kind, url, active, added_at, category) VALUES (?, ?, ?, 1, ?, ?)`)
		.bind(name, kind, url, tsNow(), category)
		.run();
	await logActivity(env, s.username, "BOT NEWS SUMBER", "Tambah sumber: " + name, "BERHASIL", url);
	return botNewsSnapshot(env);
}

export async function botNewsToggleSource(env: Env, token: string, data: Record<string, unknown>) {
	await gate(env, token);
	const id = Number(data.id);
	const active = String(data.active ?? "") === "1" ? 1 : 0;
	if (!id) throw new Error("id sumber wajib.");
	await getTurso(env).prepare(`UPDATE news_source SET active = ? WHERE id = ?`).bind(active, id).run();
	return botNewsSnapshot(env);
}

export async function botNewsDeleteSource(env: Env, token: string, data: Record<string, unknown>) {
	await gate(env, token);
	const id = Number(data.id);
	if (!id) throw new Error("id sumber wajib.");
	await getTurso(env).prepare(`DELETE FROM news_source WHERE id = ?`).bind(id).run();
	return botNewsSnapshot(env);
}

/** Tombol "PROSES KE BLOGGER" -- HANYA loop Blogger, tidak menyentuh situs sendiri sama sekali. */
export async function botNewsRunNow(env: Env, token: string, count?: number) {
	const s = await gate(env, token);
	// Abaikan flag enabled untuk run manual, tapi tetap hormati batas harian.
	// count dibatasi di botNewsRun (maks 5x sekali klik) -> jaga anggaran
	// subrequest Cloudflare (Gemini+Blogger+Turso per artikel).
	const r = await botNewsRun(env, { force: true, count: count ? Number(count) : 1, mode: "blogger" });
	await logActivity(
		env,
		s.username,
		"BOT NEWS RUN",
		`Manual (Blogger): feed +${r.pulled}, diposting ${r.posted}${r.capped ? " (batas harian tercapai)" : ""}`,
		"BERHASIL",
		"",
	);
	return { success: true, ...r, snapshot: await botNewsSnapshot(env) };
}

/** Tombol "PROSES KE SITUS SENDIRI" -- HANYA loop situs sendiri, tidak pernah menyentuh/posting ke Blogger. */
export async function botNewsRunSiteNow(env: Env, token: string, count?: number) {
	const s = await gate(env, token);
	const r = await botNewsRun(env, { force: true, count: count ? Number(count) : 1, mode: "site" });
	await logActivity(env, s.username, "BOT NEWS RUN SITUS", `Manual (Situs Sendiri): feed +${r.pulled}, +${r.siteOnly} artikel`, "BERHASIL", "");
	return { success: true, ...r, snapshot: await botNewsSnapshot(env) };
}

// Repo TEMPAT workflow news-turbo.yml hidup -- SENGAJA di-hardcode terpisah
// dari env.GH_REPO (itu punya repo scraper LAIN, daygroup-scraper, dipakai
// fitur LAP ADMIN di lap.ts, bukan repo panel ini).
// Nama repo SEKARANG (dulu "Day-Group-Panel"; GitHub masih mengalihkan nama
// lama, tapi pengalihan itu putus kalau nama lama dipakai repo lain).

/**
 * Tombol "PROSES BANYAK VIA GITHUB" -- alternatif dari botNewsRunNow/
 * botNewsRunSiteNow di atas yang DIBATASI KETAT (maks 5 artikel/klik) karena
 * jalan sebagai 1 invocation Cloudflare sinkron (limit 50 subrequest/invocation,
 * tombol biasa gampang kena "Too many subrequests" kalau pilih banyak artikel
 * sekaligus). Di sini TIDAK memproses artikel sama sekali dari Worker --
 * cuma memicu workflow GitHub Actions "news-turbo.yml" (lihat
 * .github/workflows/news-turbo.yml) yang jalan di server GitHub sendiri,
 * TANPA limit subrequest itu sama sekali (mekanisme SAMA PERSIS dgn yang
 * sudah otomatis jalan tiap 10 menit) -- hasilnya (posting Blogger + Situs
 * Sendiri) masuk sendiri ke database dalam 1-2 menit, tidak instan spt tombol
 * lain, tapi bisa memproses SELURUH antrean 'new' dalam sekali klik.
 */
const GH_HEADERS = (token: string) => ({
	Authorization: `Bearer ${token}`,
	Accept: "application/vnd.github+json",
	"User-Agent": "daygroup-panel",
	"X-GitHub-Api-Version": "2022-11-28",
});

/**
 * Inti pemicu GitHub Actions -- TIDAK melakukan auth sendiri (dipisah dari
 * botNewsRunViaGithub di bawah supaya bisa dipakai jalur lain yang otentikasinya
 * beda, lihat dispatchNewsTurboFromCron di index.ts yang dipakai cron eksternal
 * lewat CRON_KEY, bukan sesi login).
 */
export async function dispatchNewsTurbo(env: Env, count?: number, target?: string, full?: boolean): Promise<{ targetLabel: string; n: number }> {
	if (!ghToken(env)) {
		throw new Error("GitHub Actions belum dikonfigurasi (token GitHub). Isi di Admin > Integrasi.");
	}
	// count kosong/0 = kosongkan input di panel = ikuti Artikel/Proses di
	// Setting -- kalau full=true (klik tombol panel dgn kolom Jumlah kosong)
	// jalan sampai antrean habis; kalau TIDAK (tick otomatis cron-job.org/
	// jadwal), cuma 1 putaran (lihat gh-turbo-run.ts, PENTING: cegah "habiskan
	// ulang SELURUH antrean tiap tick" yang sebelumnya kejadian).
	const n = count && count > 0 ? Math.floor(count) : 0;
	const tgt = target === "blogger" || target === "site" ? target : "both";
	const inputs: Record<string, string> = {};
	if (n) inputs.count = String(n);
	if (tgt !== "both") inputs.target = tgt;
	if (!n && full) inputs.full = "1";
	const resp = await fetch(`https://api.github.com/repos/${newsTurboRepo(env)}/actions/workflows/news-turbo.yml/dispatches`, {
		method: "POST",
		headers: GH_HEADERS(ghToken(env)),
		body: JSON.stringify({ ref: "main", inputs }),
	});
	if (resp.status !== 204) {
		const body = await resp.text();
		let hint = "";
		if (resp.status === 404) hint = " -- workflow news-turbo.yml belum ke-push ke repo Day-Group-Panel, atau GH_TOKEN tidak punya akses ke repo ini.";
		else if (resp.status === 403) hint = " -- GH_TOKEN kurang izin (butuh scope 'Actions: Read and write' utk repo Day-Group-Panel).";
		let detail = "";
		try {
			detail = " [" + (JSON.parse(body).message || "") + "]";
		} catch {
			/* body bukan JSON, abaikan */
		}
		throw new Error(`Gagal memicu GitHub Actions (HTTP ${resp.status})${hint}${detail}`);
	}
	const targetLabel = tgt === "blogger" ? "Blogger" : tgt === "site" ? "Website Sendiri" : "Blogger + Website Sendiri";
	return { targetLabel, n };
}

export async function botNewsRunViaGithub(env: Env, token: string, count?: number, target?: string) {
	const s = await gate(env, token);
	// Kolom "Jumlah artikel" dikosongkan di panel = SENGAJA minta "proses
	// semua" (full drain) -- beda dari tick otomatis yg tidak pernah minta ini.
	const { targetLabel, n } = await dispatchNewsTurbo(env, count, target, !count);
	await logActivity(env, s.username, "BOT NEWS RUN (GitHub)", `Memicu workflow news-turbo.yml secara manual -> ${targetLabel}${n ? ` (${n} artikel)` : ""}`, "BERHASIL", "");
	return {
		success: true,
		message: n
			? `Dipicu! Target ${n} artikel ke ${targetLabel}. Hasilnya masuk 1-2 menit lagi, klik REFRESH nanti.`
			: `Dipicu! Proses ke ${targetLabel} sesuai pengaturan Setting. Hasilnya masuk 1-2 menit lagi, klik REFRESH nanti.`,
	};
}

/**
 * Dipoll dari dashboard (tiap beberapa detik) setelah tombol GitHub diklik --
 * biar kelihatan progress-nya (queued/in_progress/completed) tanpa perlu
 * bolak-balik buka tab GitHub. Ambil run TERBARU dari workflow news-turbo.yml
 * (baik yang dipicu tombol ini MAUPUN jadwal otomatis tiap 10 menit -- sengaja
 * sama-sama ditampilkan, biar dashboard selalu mencerminkan status run yang
 * paling baru apa pun pemicunya).
 */
export async function botNewsGithubRunStatus(env: Env, token: string) {
	await gate(env, token);
	if (!ghToken(env)) {
		throw new Error("GitHub Actions belum dikonfigurasi (token GitHub). Isi di Admin > Integrasi.");
	}
	const resp = await fetch(`https://api.github.com/repos/${newsTurboRepo(env)}/actions/workflows/news-turbo.yml/runs?per_page=1`, {
		headers: GH_HEADERS(ghToken(env)),
	});
	if (!resp.ok) {
		throw new Error(`Gagal ambil status GitHub Actions (HTTP ${resp.status}).`);
	}
	const body = (await resp.json()) as any;
	const run = Array.isArray(body?.workflow_runs) ? body.workflow_runs[0] : null;
	if (!run) return { success: true, run: null };
	return {
		success: true,
		run: {
			id: run.id,
			status: String(run.status || ""), // queued | in_progress | completed
			conclusion: String(run.conclusion || ""), // success | failure | cancelled | ... (cuma valid kalau status=completed)
			htmlUrl: String(run.html_url || ""),
			createdAt: String(run.created_at || ""),
			updatedAt: String(run.updated_at || ""),
			runNumber: Number(run.run_number || 0),
		},
	};
}

export async function botFbRunNow(env: Env, token: string) {
	const s = await gate(env, token);
	const r = await fbDirectProcessOne(env);
	await logActivity(
		env,
		s.username,
		"BOT FB LANGSUNG RUN",
		r.title ? `Terposting: ${r.title}` : r.error || "Tidak ada artikel baru.",
		r.error && !/akan dicoba lagi/i.test(r.error) ? "SEBAGIAN" : "BERHASIL",
		"",
	);
	return { success: true, ...r, snapshot: await botNewsSnapshot(env) };
}

export async function botFbTemplateGenerate(env: Env, token: string) {
	const s = await gate(env, token);
	const r = await fbTemplateGenerate(env);
	await logActivity(
		env,
		s.username,
		"BOT TEMPLATE FB",
		r.title ? `Template dibuat: ${r.title}` : r.error || "Tidak ada artikel baru.",
		r.done ? "BERHASIL" : "SEBAGIAN",
		"",
	);
	return { success: r.done, ...r };
}

export async function botNewsSkip(env: Env, token: string, data: Record<string, unknown>) {
	await gate(env, token);
	const id = Number(data.id);
	if (!id) throw new Error("id artikel wajib.");
	await getTurso(env).prepare(`UPDATE news_article SET status='skipped' WHERE id = ? AND status IN ('new','error')`).bind(id).run();
	return botNewsSnapshot(env);
}

// ---------------------------------------------------------------------------
// Koneksi Blogger (OAuth) -- supaya pemilik bisa memperbarui izin Google
// sendiri dari panel saat token kedaluwarsa, tanpa mengutak-atik database.
// ---------------------------------------------------------------------------
export async function botBloggerAuthUrl(env: Env, token: string) {
	await gate(env, token);
	const cfg = await botCfg(env);
	return { success: true, url: bloggerAuthUrl(cfg) };
}

export async function botBloggerConnect(env: Env, token: string, data: Record<string, unknown>) {
	const s = await gate(env, token);
	const cfg = await botCfg(env);
	const { refreshToken, refreshExpiresAt } = await bloggerExchangeCode(cfg, String(data.code ?? ""));
	await botCfgSet(env, {
		blogger_refresh_token: refreshToken,
		blogger_refresh_expires_at: refreshExpiresAt,
		blogger_connected_at: tsNow(),
		blogger_auth_error: "",
		blogger_auth_error_at: "",
	});
	resetBloggerTokenCache();
	const fresh = await botCfg(env);
	let blog = { name: "", url: "" };
	let verifyError = "";
	try {
		blog = await bloggerVerify(env, fresh);
	} catch (e) {
		verifyError = e instanceof Error ? e.message : String(e);
		if (e instanceof BloggerAuthError) await bloggerSetAuthState(env, fresh, verifyError);
	}
	const requeued = verifyError ? 0 : await requeueBloggerAuthFailures(env);
	await logActivity(
		env,
		s.username,
		"BOT BLOGGER CONNECT",
		verifyError ? "Token tersimpan, verifikasi gagal: " + verifyError : `Terhubung ke ${blog.name || "blog"}; ${requeued} artikel dikembalikan ke antrean`,
		verifyError ? "SEBAGIAN" : "BERHASIL",
		"",
	);
	return { success: !verifyError, message: verifyError, blog, requeued, refreshExpiresAt, snapshot: await botNewsSnapshot(env) };
}

export async function botBloggerTest(env: Env, token: string) {
	await gate(env, token);
	const cfg = await botCfg(env);
	try {
		const blog = await bloggerVerify(env, cfg);
		await bloggerSetAuthState(env, cfg, "");
		return { success: true, ok: true, blog, snapshot: await botNewsSnapshot(env) };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (e instanceof BloggerAuthError) await bloggerSetAuthState(env, cfg, msg);
		return { success: true, ok: false, message: msg, snapshot: await botNewsSnapshot(env) };
	}
}

// dipakai cron
export { botNewsRun };

// ===========================================================================
// AI PROVIDER -- BOT -> Setting -> AI Provider. Daftar bebas (base URL + API
// key + model), urutan = prioritas pemakaian. API key tidak pernah dikirim
// utuh ke browser; mengosongkan field key saat edit = key lama dipertahankan.
// ===========================================================================
const toNum = (v: unknown) => {
	const n = Math.floor(Number(String(v ?? "").replace(/[^\d]/g, "")));
	return Number.isFinite(n) ? n : 0;
};

async function aiListPayload(env: Env, cfg: Record<string, string>) {
	const list = await aiLoadProviders(env, cfg);
	const keyIds = await Promise.all(list.map((p) => (p.key ? aiKeyId(p.key) : Promise.resolve(""))));
	const [usage, lastErr, recent] = await Promise.all([aiUsageByKey(env, keyIds), aiLastErrors(env, keyIds), aiRecentUsage(env, 25)]);
	const empty = { used: 0, calls: 0, estimated: 0, failed: 0, todayTokens: 0, todayCalls: 0, lastAt: "", lastErr: "", lastErrAt: "" };
	let firstUsable = "";
	const providers = list.map((p, i) => {
		const u = usage.get(keyIds[i]) ?? empty;
		const st = providerStatus(p, u);
		const models = modelChain(p);
		const cds = st.usable ? models.map((m) => ({ model: m, cd: aiCooldown(cfg, { ...p, model: m }) })).filter((x) => x.cd) : [];
		const allCooling = models.length > 0 && cds.length === models.length;
		if (st.usable && !allCooling && !firstUsable) firstUsable = p.id;
		const err = lastErr.get(keyIds[i]) || "";
		return {
			id: p.id,
			name: p.name,
			base_url: p.base_url,
			model: p.model,
			models,
			enabled: p.enabled,
			key_mask: maskKey(p.key),
			has_key: !!p.key,
			activated: p.activated,
			valid_days: p.valid_days,
			used_adjust: p.used_adjust,
			...st,
			today_tokens: u.todayTokens,
			today_calls: u.todayCalls,
			calls: u.calls,
			failed: u.failed,
			estimated_calls: u.estimated,
			last_ok_at: u.lastAt,
			// Error terakhir hanya relevan kalau sesudahnya belum ada panggilan sukses.
			last_error: err && u.lastErrAt >= u.lastAt ? err : "",
			last_error_at: err && u.lastErrAt >= u.lastAt ? u.lastErrAt : "",
			// Sedang dilewati bot sesudah timeout / rate limit (lihat ai-provider.ts).
			// cooldown_until > 0 hanya kalau SEMUA model provider ini sedang dijeda.
			cooldown_until: allCooling ? Math.min(...cds.map((x) => Number(x.cd!.until))) : 0,
			cooldown_reason: allCooling ? cds[0].cd!.reason : "",
			cooling_models: cds.map((x) => ({ model: x.model, until: Number(x.cd!.until), reason: x.cd!.reason })),
		};
	});
	const totals = providers.reduce(
		(a, p) => ({ used: a.used + p.used, today: a.today + p.today_tokens, calls: a.calls + p.calls }),
		{ used: 0, today: 0, calls: 0 },
	);
	return { success: true, providers, active_id: firstUsable, totals, recent };
}

export async function botAiList(env: Env, token: string) {
	await gate(env, token);
	return aiListPayload(env, await botCfg(env));
}

/** Tambah (tanpa id) atau ubah (dengan id) satu provider. */
export async function botAiSave(env: Env, token: string, data: Record<string, unknown>) {
	const s = await gate(env, token);
	const cfg = await botCfg(env);
	const list = await aiLoadProviders(env, cfg);
	const id = String(data.id ?? "").trim();
	const idx = id ? list.findIndex((p) => p.id === id) : -1;
	if (id && idx < 0) throw new Error("Provider tidak ditemukan (mungkin sudah dihapus).");
	const prev = idx >= 0 ? list[idx] : null;
	const key = String(data.key ?? "").trim();
	if (!prev && !key) throw new Error("API key wajib diisi untuk provider baru.");
	if (/\s/.test(key)) throw new Error("API key tidak boleh mengandung spasi.");
	assertKeyNotReused(prev?.base_url, String(data.base_url ?? prev?.base_url ?? ""), key);
	const model = modelChain(String(data.model ?? prev?.model ?? "")).join(", ");
	if (!model) throw new Error("Model wajib diisi (mis. deepseek-v4-flash, llama-3.3-70b-versatile). Boleh beberapa, pisahkan koma.");
	const next: AiProvider = {
		id: prev?.id || "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
		name: String(data.name ?? prev?.name ?? "").trim() || "Provider",
		base_url: normalizeBaseUrl(String(data.base_url ?? prev?.base_url ?? "")),
		key: key || prev?.key || "",
		model,
		enabled: data.enabled === undefined ? (prev?.enabled ?? true) : String(data.enabled) === "1" || data.enabled === true,
		quota: data.quota === undefined ? (prev?.quota ?? 0) : toNum(data.quota),
		activated: data.activated === undefined ? (prev?.activated ?? "") : /^\d{4}-\d{2}-\d{2}$/.test(String(data.activated)) ? String(data.activated) : "",
		valid_days: data.valid_days === undefined ? (prev?.valid_days ?? 0) : toNum(data.valid_days),
		used_adjust: data.used_adjust === undefined ? (prev?.used_adjust ?? 0) : toNum(data.used_adjust),
		created_at: prev?.created_at || tsNow(),
	};
	if (next.valid_days > 0 && !next.activated) next.activated = wibToday();
	if (prev) list[idx] = next;
	else list.push(next);
	await aiSaveProviders(env, cfg, list);
	// Pemilik baru saja membetulkan provider ini -> langsung boleh dicoba lagi.
	await aiClearCooldown(env, cfg, next.id);
	await logActivity(env, s.username, "BOT AI PROVIDER", (prev ? "Ubah" : "Tambah") + " provider: " + next.name + " (" + next.model + ")", "BERHASIL", next.base_url);
	return aiListPayload(env, cfg);
}

export async function botAiDelete(env: Env, token: string, data: Record<string, unknown>) {
	const s = await gate(env, token);
	const cfg = await botCfg(env);
	const list = await aiLoadProviders(env, cfg);
	const id = String(data.id ?? "");
	const target = list.find((p) => p.id === id);
	if (!target) throw new Error("Provider tidak ditemukan.");
	await aiSaveProviders(env, cfg, list.filter((p) => p.id !== id));
	await logActivity(env, s.username, "BOT AI PROVIDER", "Hapus provider: " + target.name, "BERHASIL", "");
	return aiListPayload(env, cfg);
}

/** Urutan baru (array id). Id yang tidak disebut tetap di belakang sesuai urutan lama. */
export async function botAiReorder(env: Env, token: string, data: Record<string, unknown>) {
	await gate(env, token);
	const cfg = await botCfg(env);
	const list = await aiLoadProviders(env, cfg);
	const ids = Array.isArray(data.ids) ? data.ids.map(String) : [];
	const byId = new Map(list.map((p) => [p.id, p]));
	const ordered: AiProvider[] = [];
	for (const id of ids) {
		const p = byId.get(id);
		if (p) {
			ordered.push(p);
			byId.delete(id);
		}
	}
	for (const p of list) if (byId.has(p.id)) ordered.push(p);
	await aiSaveProviders(env, cfg, ordered);
	return aiListPayload(env, cfg);
}

/** Top-up: tambah kuota token & mulai ulang masa aktif dari hari ini. */
export async function botAiTopUp(env: Env, token: string, data: Record<string, unknown>) {
	const s = await gate(env, token);
	const cfg = await botCfg(env);
	const list = await aiLoadProviders(env, cfg);
	const idx = list.findIndex((p) => p.id === String(data.id ?? ""));
	if (idx < 0) throw new Error("Provider tidak ditemukan.");
	const add = toNum(data.add_tokens);
	const p = list[idx];
	list[idx] = { ...p, quota: p.quota + add, activated: wibToday(), valid_days: p.valid_days || AI_DEFAULT_VALID_DAYS };
	await aiSaveProviders(env, cfg, list);
	await logActivity(env, s.username, "BOT AI PROVIDER", `Top-up ${p.name}: +${add} token, masa aktif mulai ulang`, "BERHASIL", "");
	return aiListPayload(env, cfg);
}

/** Tes Facebook: periksa Page ID + token (yang diketik di form, atau yang tersimpan bila dikosongkan) dan jelaskan penyebab bila gagal. */
export async function botFbTest(env: Env, token: string, data: Record<string, unknown>) {
	const s = await gate(env, token);
	const cfg = await botCfg(env);
	const pageId = String(data.page_id ?? "").trim() || String(cfg.fb_page_id ?? "").trim();
	const pageToken = String(data.page_token ?? "").trim() || String(cfg.fb_page_token ?? "").trim();
	if (!/^\d{5,25}$/.test(pageId)) return { success: false, message: "Page ID harus berupa angka (5-25 digit). Isi Page ID lalu coba lagi." };
	if (!pageToken) return { success: false, message: "Page Access Token belum diisi. Tempel token di kolom token lalu klik TES FACEBOOK." };
	if (pageToken.length < 20 || pageToken.length > 700 || /\s/.test(pageToken)) return { success: false, message: "Format token tidak wajar (20-700 karakter tanpa spasi). Salin ulang token dengan utuh." };
	const r = await fbDiagnose(pageId, pageToken);
	await logActivity(env, s.username, "BOT FACEBOOK TES", r.ok ? `Tes Facebook OK (${r.page?.name ?? pageId})` : `Tes Facebook gagal: ${r.verdict}`.slice(0, 300), r.ok ? "BERHASIL" : "GAGAL", "");
	return { success: true, ...r };
}

/** Tes koneksi: 1 panggilan kecil + daftar model yang tersedia (kalau provider mendukung /models). */
export async function botAiTest(env: Env, token: string, data: Record<string, unknown>) {
	await gate(env, token);
	const cfg = await botCfg(env);
	const list = await aiLoadProviders(env, cfg);
	const p = list.find((x) => x.id === String(data.id ?? ""));
	if (!p) throw new Error("Provider tidak ditemukan.");
	const chain = modelChain(p);
	let models: string[] = [];
	try {
		models = await aiListModels(p);
	} catch {
		/* tidak semua provider punya /models */
	}
	// Semua model di daftar dites BERSAMAAN (bukan satu-satu) -- pemilik
	// langsung tahu model mana yang hidup, lambat, atau selalu kosong.
	const results = await Promise.all(
		chain.map(async (model) => {
			try {
				const res = await aiChatProvider(env, cfg, { ...p, model }, {
					purpose: "test",
					messages: [{ role: "user", content: "Balas persis satu kata: OK" }],
					temperature: 0,
					maxTokens: 1024,
					firstByteMs: 60_000,
					totalMs: 120_000,
				});
				return { model, ok: true, reply: res.text.trim().slice(0, 80), tokens: res.totalTokens, estimated: res.estimated, ms: res.ms, message: "", listed: !models.length || models.includes(model) };
			} catch (e) {
				return { model, ok: false, reply: "", tokens: 0, estimated: false, ms: 0, message: e instanceof Error ? e.message : String(e), listed: !models.length || models.includes(model) };
			}
		}),
	);
	const first = results.find((r) => r.ok);
	const missing = results.filter((r) => !r.listed).map((r) => r.model);
	return {
		success: true,
		ok: !!first,
		results,
		reply: first?.reply ?? "",
		model: first?.model ?? "",
		tokens: first?.tokens ?? 0,
		estimated: first?.estimated ?? false,
		ms: first?.ms ?? 0,
		message: first ? "" : results.map((r) => `${r.model}: ${r.message}`).join(" | "),
		models,
		suggested: missing.length ? pickWriterModel(models, new Set(chain)) : "",
		list: await aiListPayload(env, cfg),
	};
}

/**
 * Daftar model dari provider (GET /models) untuk dipilih di form. Provider
 * yang sudah tersimpan cukup kirim id (key tidak pernah dikirim balik ke
 * browser); provider baru kirim base_url + key dari form.
 */
export async function botAiModels(env: Env, token: string, data: Record<string, unknown>) {
	await gate(env, token);
	const cfg = await botCfg(env);
	const saved = (await aiLoadProviders(env, cfg)).find((x) => x.id === String(data.id ?? ""));
	const base_url = normalizeBaseUrl(String(data.base_url ?? "") || saved?.base_url || "");
	assertKeyNotReused(saved?.base_url, base_url, String(data.key ?? ""));
	const key = String(data.key ?? "").trim() || saved?.key || "";
	if (!/^https:\/\//i.test(base_url)) throw new Error("Isi Base URL (https://...) dulu.");
	if (!key) throw new Error("Isi API key dulu.");
	let models: string[];
	try {
		models = await aiListModels({ base_url, key });
	} catch (e) {
		throw new Error("Gagal mengambil daftar model: " + (e instanceof Error ? e.message : String(e)));
	}
	if (!models.length) throw new Error("Provider ini tidak memberi daftar model (/models kosong). Ketik nama model manual.");
	const bad = /whisper|tts|audio|guard|moderation|embed|rerank|transcri|dall-e|image-gen/i;
	return { success: true, models: models.filter((m) => !bad.test(m)), hidden: models.filter((m) => bad.test(m)).length };
}
