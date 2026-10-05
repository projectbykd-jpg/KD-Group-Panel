// Daftar provider AI untuk BOT NEWS -- apa pun yang berformat OpenAI
// (POST {base_url}/chat/completions + Authorization: Bearer <key>):
// Groq, Gemini (endpoint /v1beta/openai), DeepSeek, DattioAI, OpenRouter, dst.
//
// Disimpan di Turso bot_kv["ai_providers"] sebagai array JSON. URUTAN ARRAY =
// PRIORITAS: bot mencoba provider pertama yang aktif, kalau gagal / kuota
// habis / masa aktif lewat / hasilnya jelek -> provider berikutnya. Pemilik
// mengatur urutan & menghapus provider dari BOT -> Setting -> AI Provider.
// Worker DAN GitHub Actions (scripts/gh-turbo-run.ts) membaca daftar yang sama.
//
// API key TIDAK PERNAH dikirim utuh ke browser (lihat aiPublicProviders).
//
// Counter token: SETIAP panggilan mencatat `usage` yang dilaporkan server
// provider ke tabel ai_usage (Turso), dikelompokkan per key (key_id = hash
// key). Ganti key = counter mulai dari 0; riwayat key lama tetap tersimpan.
// Kalau provider tidak mengirim `usage`, token DIPERKIRAKAN (karakter/4) dan
// ditandai estimated=1 supaya kelihatan di panel.
import { getTurso } from "./turso";
import { tsNow } from "./time";

export const AI_PROVIDERS_KEY = "ai_providers";
export const AI_DEFAULT_VALID_DAYS = 28;
const WIB_MS = 7 * 3600 * 1000;
const MAX_PROVIDERS = 20;

export interface AiProvider {
	id: string;
	name: string;
	base_url: string;
	key: string;
	model: string;
	enabled: boolean;
	/** Kuota token yang dibeli; 0 = tidak dipantau (mis. free tier). */
	quota: number;
	/** Tanggal aktif / top-up terakhir (YYYY-MM-DD, WIB); kosong = tanpa masa aktif. */
	activated: string;
	valid_days: number;
	/** Token terpakai di luar panel (koreksi manual). */
	used_adjust: number;
	created_at: string;
}

export class AiUnavailableError extends Error {}

// ---------------------------------------------------------------------------
// Helper murni (mudah dites)
// ---------------------------------------------------------------------------
const toInt = (v: unknown) => {
	const n = Math.floor(Number(String(v ?? "").replace(/[^\d-]/g, "")));
	return Number.isFinite(n) ? n : 0;
};

export function wibToday(now = Date.now()): string {
	return new Date(now + WIB_MS).toISOString().slice(0, 10);
}

export function maskKey(key: string): string {
	const k = String(key || "");
	if (!k) return "";
	if (k.length <= 12) return k.slice(0, 3) + "…";
	return k.slice(0, 7) + "…" + k.slice(-4);
}

export function normalizeBaseUrl(raw: string): string {
	let u = String(raw || "").trim().replace(/\/+$/, "");
	if (!u) throw new Error("Base URL wajib diisi.");
	if (!/^https:\/\/[^\s/]+/i.test(u)) throw new Error("Base URL harus diawali https://");
	u = u.replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
	return u;
}

export async function aiKeyId(key: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(key || "")));
	return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const splitKeys = (s: unknown) => String(s || "").split(/[,\n]+/).map((x) => x.trim()).filter(Boolean);

function cleanProvider(p: Partial<AiProvider> & { id: string }): AiProvider {
	return {
		id: String(p.id),
		name: String(p.name || "Provider").trim().slice(0, 60) || "Provider",
		base_url: String(p.base_url || "").trim(),
		key: String(p.key || "").trim(),
		model: String(p.model || "").trim().slice(0, 120),
		enabled: p.enabled !== false,
		quota: Math.max(0, toInt(p.quota)),
		activated: /^\d{4}-\d{2}-\d{2}$/.test(String(p.activated || "")) ? String(p.activated) : "",
		valid_days: Math.max(0, toInt(p.valid_days)),
		used_adjust: Math.max(0, toInt(p.used_adjust)),
		created_at: String(p.created_at || ""),
	};
}

/**
 * Konfigurasi lama (groq_key / gemini_key, dipisah koma) -> daftar provider.
 * Urutan sama dengan perilaku lama: Groq dulu, Gemini sebagai cadangan.
 * ID deterministik supaya migrasi dari dua tempat sekaligus (Worker & Actions)
 * menghasilkan daftar yang sama.
 */
export function legacyProviders(cfg: Record<string, string>): AiProvider[] {
	const out: AiProvider[] = [];
	splitKeys(cfg.groq_key).forEach((key, i) =>
		out.push(cleanProvider({
			id: "groq-" + (i + 1),
			name: "Groq" + (i ? " #" + (i + 1) : ""),
			base_url: "https://api.groq.com/openai/v1",
			key,
			model: cfg.groq_model || "llama-3.3-70b-versatile",
		})),
	);
	splitKeys(cfg.gemini_key).forEach((key, i) =>
		out.push(cleanProvider({
			id: "gemini-" + (i + 1),
			name: "Gemini" + (i ? " #" + (i + 1) : ""),
			base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
			key,
			model: cfg.gemini_model || "gemini-flash-latest",
		})),
	);
	return out;
}

export function parseProviders(cfg: Record<string, string>): AiProvider[] | null {
	const raw = cfg[AI_PROVIDERS_KEY];
	if (raw == null || raw === "") return null;
	try {
		const arr = JSON.parse(raw);
		if (!Array.isArray(arr)) return [];
		return arr.filter((p) => p && p.id).map((p) => cleanProvider(p)).slice(0, MAX_PROVIDERS);
	} catch {
		return [];
	}
}

export interface AiUsageTotals {
	used: number;
	calls: number;
	estimated: number;
	failed: number;
	todayTokens: number;
	todayCalls: number;
	lastAt: string;
	lastErr: string;
	lastErrAt: string;
}
const EMPTY_USAGE: AiUsageTotals = { used: 0, calls: 0, estimated: 0, failed: 0, todayTokens: 0, todayCalls: 0, lastAt: "", lastErr: "", lastErrAt: "" };

export interface AiProviderStatus {
	quota: number;
	used: number;
	remaining: number;
	pctUsed: number;
	expiresAt: string;
	daysLeft: number | null;
	expired: boolean;
	exhausted: boolean;
	usable: boolean;
	state: "active" | "disabled" | "expired" | "exhausted" | "incomplete";
	warn: string;
}

/** Status satu provider dari konfigurasi + total pemakaiannya (tanpa I/O). */
export function providerStatus(p: AiProvider, usage: AiUsageTotals, now = Date.now()): AiProviderStatus {
	const used = usage.used + p.used_adjust;
	let expiresAt = "";
	let daysLeft: number | null = null;
	let expired = false;
	if (p.activated && p.valid_days > 0) {
		// Aktif sampai akhir hari ke-valid_days (WIB): aktif 01-10, 28 hari -> habis 29-10 00:00 WIB.
		const startUtc = Date.parse(p.activated + "T00:00:00Z") - WIB_MS;
		const endUtc = startUtc + p.valid_days * 86400000;
		expiresAt = new Date(endUtc + WIB_MS).toISOString().slice(0, 10);
		daysLeft = Math.max(0, Math.ceil((endUtc - now) / 86400000));
		expired = now >= endUtc;
	}
	const remaining = p.quota > 0 ? Math.max(0, p.quota - used) : 0;
	const exhausted = p.quota > 0 && used >= p.quota;
	const complete = !!(p.key && p.base_url && p.model);
	let state: AiProviderStatus["state"] = "active";
	if (!complete) state = "incomplete";
	else if (!p.enabled) state = "disabled";
	else if (expired) state = "expired";
	else if (exhausted) state = "exhausted";
	let warn = "";
	if (state === "incomplete") warn = "Base URL, API key, dan model wajib diisi.";
	else if (state === "expired") warn = "Masa aktif habis — top-up atau ganti key.";
	else if (state === "exhausted") warn = "Kuota token habis — top-up atau ganti key.";
	else if (p.quota > 0 && remaining < p.quota * 0.1) warn = "Sisa kuota di bawah 10%.";
	else if (daysLeft !== null && daysLeft <= 3) warn = `Masa aktif tinggal ${daysLeft} hari.`;
	return {
		quota: p.quota,
		used,
		remaining,
		pctUsed: p.quota > 0 ? Math.min(100, Math.round((used / p.quota) * 1000) / 10) : 0,
		expiresAt,
		daysLeft,
		expired,
		exhausted,
		usable: state === "active",
		state,
		warn,
	};
}

/** Ambil angka token dari `usage` respons OpenAI-compatible; null kalau tidak ada. */
export function parseUsage(body: any): { prompt: number; completion: number; total: number } | null {
	const u = body?.usage;
	if (!u || typeof u !== "object") return null;
	const prompt = toInt(u.prompt_tokens ?? u.input_tokens);
	const completion = toInt(u.completion_tokens ?? u.output_tokens);
	let total = toInt(u.total_tokens);
	if (!total) total = prompt + completion;
	if (!total) return null;
	return { prompt, completion, total };
}

/** Pilih model penulis dari daftar /models (buang model audio/embedding/agent). */
export function pickWriterModel(ids: string[], exclude: Set<string>): string {
	const bad = (id: string) => /whisper|tts|audio|guard|moderation|embed|compound|safety|image|vision|dall-e|transcri|rerank/i.test(id);
	const good = (id: string) => /llama|qwen|gpt|kimi|deepseek|glm|gemini|mistral|mixtral|gemma|claude|mimo/i.test(id);
	const usable = ids.filter((id) => id && !exclude.has(id) && !bad(id));
	return usable.find(good) || usable[0] || "";
}

// ---------------------------------------------------------------------------
// Penyimpanan
// ---------------------------------------------------------------------------
async function kvSet(env: Env, patch: Record<string, string>): Promise<void> {
	const now = tsNow();
	const t = getTurso(env);
	const stmts = Object.entries(patch).map(([k, v]) =>
		t.prepare(
			`INSERT INTO bot_kv (k, v, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
		).bind(k, v, now),
	);
	if (stmts.length) await t.batch(stmts);
}

/**
 * Daftar provider (urutan = prioritas). Pertama kali dipanggil sesudah update
 * ini, key Groq/Gemini lama dipindah ke daftar (sekali saja) lalu field lama
 * dikosongkan -- satu sumber kebenaran, jadi provider yang dihapus pemilik
 * benar-benar tidak dipakai lagi. `cfg` ikut diperbarui di tempat.
 */
export async function aiLoadProviders(env: Env, cfg: Record<string, string>): Promise<AiProvider[]> {
	const list = parseProviders(cfg);
	if (list) return list;
	const migrated = legacyProviders(cfg);
	const json = JSON.stringify(migrated);
	await kvSet(env, { [AI_PROVIDERS_KEY]: json, groq_key: "", gemini_key: "" });
	cfg[AI_PROVIDERS_KEY] = json;
	cfg.groq_key = "";
	cfg.gemini_key = "";
	return migrated;
}

export async function aiSaveProviders(env: Env, cfg: Record<string, string>, list: AiProvider[]): Promise<void> {
	const json = JSON.stringify(list.slice(0, MAX_PROVIDERS).map((p) => cleanProvider(p)));
	await kvSet(env, { [AI_PROVIDERS_KEY]: json });
	cfg[AI_PROVIDERS_KEY] = json;
}

let usageTableEnsured = false;
export async function ensureAiUsageTable(env: Env): Promise<void> {
	if (usageTableEnsured) return;
	const t = getTurso(env);
	await t
		.prepare(
			`CREATE TABLE IF NOT EXISTS ai_usage (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts TEXT NOT NULL,
				key_id TEXT NOT NULL,
				provider TEXT NOT NULL DEFAULT '',
				model TEXT NOT NULL DEFAULT '',
				purpose TEXT NOT NULL DEFAULT '',
				prompt_tokens INTEGER NOT NULL DEFAULT 0,
				completion_tokens INTEGER NOT NULL DEFAULT 0,
				total_tokens INTEGER NOT NULL DEFAULT 0,
				estimated INTEGER NOT NULL DEFAULT 0,
				ok INTEGER NOT NULL DEFAULT 1,
				err TEXT NOT NULL DEFAULT '',
				ms INTEGER NOT NULL DEFAULT 0
			)`,
		)
		.run();
	await t.prepare(`CREATE INDEX IF NOT EXISTS ix_ai_usage_key ON ai_usage(key_id, id)`).run();
	usageTableEnsured = true;
}

/** Jalankan query ai_usage; kalau tabelnya ternyata belum/tidak ada, buat lalu ulangi sekali. */
async function withUsageTable<T>(env: Env, fn: () => Promise<T>): Promise<T> {
	await ensureAiUsageTable(env);
	try {
		return await fn();
	} catch (e) {
		if (!/no such table: ai_usage/i.test(String(e instanceof Error ? e.message : e))) throw e;
		usageTableEnsured = false;
		await ensureAiUsageTable(env);
		return fn();
	}
}

/** Total pemakaian per key_id (satu query untuk semua provider). */
export async function aiUsageByKey(env: Env, keyIds: string[], now = Date.now()): Promise<Map<string, AiUsageTotals>> {
	const out = new Map<string, AiUsageTotals>();
	const ids = [...new Set(keyIds.filter(Boolean))];
	if (!ids.length) return out;
	const today = wibToday(now);
	const ph = ids.map(() => "?").join(",");
	const r = await withUsageTable(env, () => getTurso(env)
		.prepare(
			`SELECT key_id,
			        COALESCE(SUM(total_tokens),0) AS used, COUNT(*) AS calls,
			        COALESCE(SUM(estimated),0) AS est,
			        COALESCE(SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END),0) AS failed,
			        COALESCE(SUM(CASE WHEN ts >= ? THEN total_tokens ELSE 0 END),0) AS today_tokens,
			        COALESCE(SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END),0) AS today_calls,
			        COALESCE(MAX(CASE WHEN ok=1 THEN ts END),'') AS last_at,
			        COALESCE(MAX(CASE WHEN ok=0 THEN ts END),'') AS last_err_at
			 FROM ai_usage WHERE key_id IN (${ph}) GROUP BY key_id`,
		)
		.bind(today, today, ...ids)
		.all<Record<string, unknown>>());
	for (const row of r.results ?? []) {
		out.set(String(row.key_id), {
			used: Number(row.used ?? 0),
			calls: Number(row.calls ?? 0),
			estimated: Number(row.est ?? 0),
			failed: Number(row.failed ?? 0),
			todayTokens: Number(row.today_tokens ?? 0),
			todayCalls: Number(row.today_calls ?? 0),
			lastAt: String(row.last_at ?? ""),
			lastErr: "",
			lastErrAt: String(row.last_err_at ?? ""),
		});
	}
	return out;
}

export async function aiLastErrors(env: Env, keyIds: string[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const ids = [...new Set(keyIds.filter(Boolean))];
	if (!ids.length) return out;
	const ph = ids.map(() => "?").join(",");
	const r = await withUsageTable(env, () => getTurso(env)
		.prepare(
			`SELECT key_id, err FROM ai_usage WHERE id IN (
				SELECT MAX(id) FROM ai_usage WHERE ok = 0 AND key_id IN (${ph}) GROUP BY key_id
			)`,
		)
		.bind(...ids)
		.all<Record<string, unknown>>());
	for (const row of r.results ?? []) out.set(String(row.key_id), String(row.err ?? ""));
	return out;
}

export async function aiRecentUsage(env: Env, limit = 20) {
	const r = await withUsageTable(env, () => getTurso(env)
		.prepare(
			`SELECT ts, provider, model, purpose, prompt_tokens, completion_tokens, total_tokens, estimated, ok, err, ms
			 FROM ai_usage ORDER BY id DESC LIMIT ?`,
		)
		.bind(limit)
		.all<Record<string, unknown>>());
	return (r.results ?? []).map((x) => ({
		ts: String(x.ts ?? ""),
		provider: String(x.provider ?? ""),
		model: String(x.model ?? ""),
		purpose: String(x.purpose ?? ""),
		prompt: Number(x.prompt_tokens ?? 0),
		completion: Number(x.completion_tokens ?? 0),
		total: Number(x.total_tokens ?? 0),
		estimated: !!Number(x.estimated ?? 0),
		ok: !!Number(x.ok ?? 0),
		err: String(x.err ?? ""),
		ms: Number(x.ms ?? 0),
	}));
}

async function recordUsage(
	env: Env,
	row: { keyId: string; provider: string; model: string; purpose: string; prompt: number; completion: number; total: number; estimated: boolean; ok: boolean; err: string; ms: number },
): Promise<void> {
	try {
		await withUsageTable(env, () => getTurso(env)
			.prepare(
				`INSERT INTO ai_usage (ts, key_id, provider, model, purpose, prompt_tokens, completion_tokens, total_tokens, estimated, ok, err, ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(tsNow(), row.keyId, row.provider.slice(0, 60), row.model, row.purpose, row.prompt, row.completion, row.total, row.estimated ? 1 : 0, row.ok ? 1 : 0, row.err.slice(0, 300), row.ms)
			.run());
		const hit = usageCache?.map.get(row.keyId);
		if (hit) usageCache!.map.set(row.keyId, { ...hit, used: hit.used + row.total, calls: hit.calls + 1 });
	} catch {
		/* pencatatan gagal tidak boleh menggagalkan pekerjaan utamanya */
	}
}

// Cek kuota sebelum tiap panggilan memakai total yang baru dihitung (<= 20
// dtk) + token yang dicatat isolate ini sejak itu -- hemat subrequest
// (Worker Free: maks 50/invocation). Panel selalu membaca angka segar.
let usageCache: { at: number; map: Map<string, AiUsageTotals> } | null = null;
async function cachedUsage(env: Env, keyIds: string[]): Promise<Map<string, AiUsageTotals>> {
	if (usageCache && Date.now() - usageCache.at < 20000 && keyIds.every((k) => usageCache!.map.has(k) || !k)) return usageCache.map;
	const map = await aiUsageByKey(env, keyIds);
	for (const k of keyIds) if (k && !map.has(k)) map.set(k, { ...EMPTY_USAGE });
	usageCache = { at: Date.now(), map };
	return map;
}

// ---------------------------------------------------------------------------
// Panggilan
// ---------------------------------------------------------------------------
export interface AiCallResult {
	text: string;
	providerId: string;
	providerName: string;
	model: string;
	totalTokens: number;
	estimated: boolean;
	ms: number;
}

const estimateTokens = (s: string) => Math.ceil(String(s || "").length / 4);
const isModelError = (status: number, msg: string) =>
	status === 404 || /model[^.]{0,80}(not[ _]found|does not exist|decommission|not supported|not available|blocked|invalid|unknown)/i.test(msg);

async function postChat(
	p: AiProvider,
	model: string,
	messages: { role: string; content: string }[],
	opts: { temperature?: number; maxTokens?: number; json?: boolean },
): Promise<{ status: number; body: any }> {
	const send = async (withJson: boolean) => {
		const payload: Record<string, unknown> = { model, messages, temperature: opts.temperature ?? 0.8 };
		if (opts.maxTokens) payload.max_tokens = opts.maxTokens;
		if (withJson) payload.response_format = { type: "json_object" };
		const r = await fetch(normalizeBaseUrl(p.base_url) + "/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
			body: JSON.stringify(payload),
		});
		const raw = await r.text();
		let body: any;
		try {
			body = JSON.parse(raw);
		} catch {
			body = { error: raw.slice(0, 300) };
		}
		return { status: r.status, body };
	};
	const first = await send(!!opts.json);
	// Tidak semua provider mendukung response_format -> ulang tanpa (prompt sudah minta JSON).
	if (opts.json && (first.status === 400 || first.status === 422) && /response_format|json/i.test(JSON.stringify(first.body?.error ?? first.body))) {
		return send(false);
	}
	return first;
}

const errText = (status: number, body: any) => {
	const e = body?.error;
	const msg = typeof e === "string" ? e : e?.message || JSON.stringify(e ?? body ?? "");
	return `HTTP ${status} ${String(msg).slice(0, 220)}`.trim();
};

/**
 * Satu panggilan ke SATU provider. Melempar error kalau gagal. Kalau model
 * yang diatur sudah tidak ada (404 / decommissioned), daftar /models provider
 * itu ditanya sekali, model pengganti dipakai & disimpan otomatis.
 */
export async function aiChatProvider(
	env: Env,
	cfg: Record<string, string>,
	p: AiProvider,
	opts: { messages: { role: string; content: string }[]; purpose: string; temperature?: number; maxTokens?: number; json?: boolean },
): Promise<AiCallResult> {
	const keyId = await aiKeyId(p.key);
	const promptChars = opts.messages.map((m) => m.content).join("\n");
	let model = p.model;
	const tried = new Set<string>();
	for (let attempt = 0; attempt < 2; attempt++) {
		tried.add(model);
		const started = Date.now();
		let res: { status: number; body: any };
		try {
			res = await postChat(p, model, opts.messages, opts);
		} catch (e) {
			const err = "Gagal menghubungi server: " + (e instanceof Error ? e.message : String(e));
			await recordUsage(env, { keyId, provider: p.name, model, purpose: opts.purpose, prompt: 0, completion: 0, total: 0, estimated: false, ok: false, err, ms: Date.now() - started });
			throw new Error(err);
		}
		const ms = Date.now() - started;
		const text = String(res.body?.choices?.[0]?.message?.content ?? "");
		const usage = parseUsage(res.body);
		if (res.status >= 200 && res.status < 300 && text) {
			const estimated = !usage;
			const total = usage?.total ?? estimateTokens(promptChars) + estimateTokens(text);
			const usedModel = String(res.body?.model || model);
			await recordUsage(env, {
				keyId, provider: p.name, model: usedModel, purpose: opts.purpose,
				prompt: usage?.prompt ?? estimateTokens(promptChars), completion: usage?.completion ?? estimateTokens(text),
				total, estimated, ok: true, err: "", ms,
			});
			if (model !== p.model) {
				// Model pengganti berhasil -> simpan supaya panggilan berikutnya langsung pakai itu.
				const list = parseProviders(cfg) || [];
				const idx = list.findIndex((x) => x.id === p.id);
				if (idx >= 0) {
					list[idx] = { ...list[idx], model };
					await aiSaveProviders(env, cfg, list).catch(() => {});
				}
			}
			return { text, providerId: p.id, providerName: p.name, model: usedModel, totalTokens: total, estimated, ms };
		}
		const err = errText(res.status, res.body);
		// Server kadang tetap menagih token walau gagal -> catat yang dilaporkan.
		await recordUsage(env, {
			keyId, provider: p.name, model, purpose: opts.purpose,
			prompt: usage?.prompt ?? 0, completion: usage?.completion ?? 0, total: usage?.total ?? 0,
			estimated: false, ok: false, err, ms,
		});
		if (attempt === 0 && isModelError(res.status, err)) {
			try {
				const lr = await fetch(normalizeBaseUrl(p.base_url) + "/models", { headers: { Authorization: `Bearer ${p.key}` } });
				const lb: any = await lr.json();
				const ids: string[] = Array.isArray(lb?.data) ? lb.data.map((m: any) => String(m?.id || "")) : [];
				const next = pickWriterModel(ids, tried);
				if (next) {
					model = next;
					continue;
				}
			} catch {
				/* tidak bisa menanyakan daftar model -> anggap gagal */
			}
		}
		throw new Error(err);
	}
	throw new Error("Model tidak tersedia.");
}

/** Provider yang boleh dipakai sekarang, urut prioritas, beserta status masing-masing. */
export async function aiUsableProviders(env: Env, cfg: Record<string, string>): Promise<AiProvider[]> {
	const list = await aiLoadProviders(env, cfg);
	const keyIds = await Promise.all(list.map((p) => (p.key ? aiKeyId(p.key) : Promise.resolve(""))));
	const usage = await cachedUsage(env, keyIds);
	return list.filter((p, i) => providerStatus(p, usage.get(keyIds[i]) ?? EMPTY_USAGE).usable);
}

/**
 * Coba provider satu per satu sesuai urutan prioritas. `accept` boleh
 * melempar (mis. artikel terlalu pendek) -> provider berikutnya dicoba.
 * Kalau semua gagal, error berisi alasan tiap provider.
 */
export async function aiGenerate<T>(
	env: Env,
	cfg: Record<string, string>,
	opts: { messages: { role: string; content: string }[]; purpose: string; temperature?: number; maxTokens?: number; json?: boolean },
	accept: (text: string) => T,
): Promise<{ value: T; call: AiCallResult }> {
	const providers = await aiUsableProviders(env, cfg);
	if (!providers.length) {
		throw new AiUnavailableError("Tidak ada AI provider yang aktif. Tambahkan / aktifkan di BOT → Setting → AI Provider (cek juga kuota & masa aktif).");
	}
	const errs: string[] = [];
	for (const p of providers) {
		try {
			const call = await aiChatProvider(env, cfg, p, opts);
			return { value: accept(call.text), call };
		} catch (e) {
			errs.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	throw new Error(errs.join(" | "));
}
