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

/**
 * Beberapa provider (mis. Groq di balik Cloudflare) menolak permintaan tanpa User-Agent dengan
 * 403 "Forbidden". fetch() di Worker tidak mengirimnya sendiri, jadi kita set eksplisit.
 */
/** Isi pesan: teks biasa, atau array bagian (teks + gambar data-URL) untuk model yang bisa membaca gambar. */
export type AiMsgContent = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];

/** Teks untuk perkiraan ukuran prompt; gambar dihitung tetap (isi base64-nya tidak ikut). */
function msgChars(c: AiMsgContent): string {
	return typeof c === "string" ? c : c.map((x) => (x.type === "text" ? x.text : "x".repeat(1200))).join("\n");
}

export const AI_USER_AGENT = "KD-Group-Panel/1.0";

export function normalizeBaseUrl(raw: string): string {
	let u = String(raw || "").trim().replace(/\/+$/, "");
	if (!u) throw new Error("Base URL wajib diisi.");
	if (!/^https:\/\/[^\s/]+/i.test(u)) throw new Error("Base URL harus diawali https://");
	u = u.replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
	return u;
}

/** Host dari Base URL (huruf kecil), atau '' bila tidak sah. */
export function hostOf(raw: string): string {
	try {
		return new URL(normalizeBaseUrl(raw)).host.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * Key tersimpan TIDAK boleh dikirim ke alamat yang berbeda dari yang tersimpan (akun berhak mengganti Base URL ke host
 * miliknya, lalu server memanggil host itu dengan key lama -> key bocor). Ganti host = wajib key baru.
 */
export function assertKeyNotReused(savedBase: string | undefined, newBase: string, newKey: string): void {
	if (!savedBase || newKey.trim()) return;
	if (hostOf(savedBase) !== hostOf(newBase)) throw new Error("Base URL diganti ke alamat lain: isi API key BARU (key lama tidak dipakai untuk alamat baru demi keamanan).");
}

export async function aiKeyId(key: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(key || "")));
	return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const splitKeys = (s: unknown) => String(s || "").split(/[,\n]+/).map((x) => x.trim()).filter(Boolean);

/**
 * Satu provider boleh punya BANYAK model, urut prioritas, dipisah koma
 * ("deepseek-v4-flash, glm-5.3, kimi-k3"). Model pertama dipakai dulu; kalau
 * gagal (jawaban kosong, lambat, error) model berikutnya di provider yang SAMA
 * dicoba sebelum pindah ke provider lain.
 */
export function modelChain(model: string | AiProvider): string[] {
	const raw = typeof model === "string" ? model : model.model;
	const out: string[] = [];
	for (const m of String(raw || "").split(/[,\n]/)) {
		const t = m.trim().slice(0, 120);
		if (t && !out.includes(t)) out.push(t);
	}
	return out.slice(0, 10);
}

/** Provider dgn satu model saja (untuk satu panggilan). */
const withModel = (p: AiProvider, model: string): AiProvider => ({ ...p, model });

function cleanProvider(p: Partial<AiProvider> & { id: string }): AiProvider {
	return {
		id: String(p.id),
		name: String(p.name || "Provider").trim().slice(0, 60) || "Provider",
		base_url: String(p.base_url || "").trim(),
		key: String(p.key || "").trim(),
		model: modelChain(String(p.model || "")).join(", ").slice(0, 600),
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

/**
 * Batas tunggu. Jawaban diminta sebagai STREAM (sepotong-sepotong), jadi yang
 * dibatasi adalah server yang DIAM, bukan lamanya menulis: DattioAI
 * deepseek-v4-flash butuh > 150 dtk untuk artikel panjang tapi terus
 * mengirim. Dulu panggilan itu diputus padahal hampir selesai -- artikel
 * gagal DAN token tetap ditagih provider (panel 35rb vs DattioAI 58rb).
 */
export const AI_FIRST_BYTE_MS = 180_000; // sampai server mulai membalas (provider tanpa stream: sampai jawaban lengkap)
export const AI_IDLE_MS = 60_000; // diam di tengah jawaban
export const AI_TOTAL_MS = 8 * 60_000; // batas keseluruhan (job GitHub maks 15 menit)

export interface AiCallOpts {
	messages: { role: string; content: AiMsgContent }[];
	purpose: string;
	temperature?: number;
	maxTokens?: number;
	json?: boolean;
	/** Parameter tambahan khusus provider (mis. reasoning_effort) -- digabung ke body permintaan. */
	extra?: Record<string, unknown>;
	/** Untuk tes; default AI_FIRST_BYTE_MS / AI_IDLE_MS / AI_TOTAL_MS. */
	firstByteMs?: number;
	idleMs?: number;
	totalMs?: number;
}

/** Panggilan diputus karena waktu habis; `partialChars` = jawaban yang sempat diterima. */
export class AiTimeoutError extends Error {
	constructor(message: string, readonly partialChars: number) {
		super(message);
	}
}

// ---------------------------------------------------------------------------
// Jeda provider yang bermasalah
// ---------------------------------------------------------------------------
// Dulu provider yang diam / kena rate limit dicoba ULANG di SETIAP artikel:
// DattioAI "auto" yang tidak pernah membalas membuang 150 dtk per artikel,
// jadi 2 artikel = 6 menit. Sekarang kegagalan sementara membuat provider itu
// dilewati selama beberapa saat. Disimpan di bot_kv["ai_cooldowns"] supaya
// run GitHub berikutnya (proses baru) juga ikut melewatinya. Jeda berlaku
// untuk kombinasi model + base URL saat itu -- ganti model = jeda hilang.
export const AI_COOLDOWNS_KEY = "ai_cooldowns";
type Cooldown = { sig: string; until: number; reason: string };
const memCooldowns = new Map<string, Cooldown>();
const sigOf = (p: AiProvider) => `${p.model}@${normalizeBaseUrl(p.base_url)}`;
/** Kunci jeda: per provider + model (model lain di provider yang sama tetap dicoba). */
const cdKey = (p: AiProvider) => `${p.id}|${p.model}`;

/** Untuk tes: lupakan semua jeda di memori. */
export function aiResetCooldowns(): void {
	memCooldowns.clear();
}

function storedCooldowns(cfg: Record<string, string>): Record<string, Cooldown> {
	try {
		const o = JSON.parse(cfg[AI_COOLDOWNS_KEY] || "{}");
		return o && typeof o === "object" && !Array.isArray(o) ? o : {};
	} catch {
		return {};
	}
}

/** Jeda yang masih berlaku untuk model ini (p.model = SATU model), atau null. */
export function aiCooldown(cfg: Record<string, string>, p: AiProvider, now = Date.now()): Cooldown | null {
	const sig = sigOf(p);
	for (const c of [memCooldowns.get(cdKey(p)), storedCooldowns(cfg)[cdKey(p)]]) {
		if (c && c.sig === sig && Number(c.until) > now) return c;
	}
	return null;
}

/** Berapa lama (ms) jeda dipasang untuk error ini; 0 = jangan dijeda. */
export function cooldownMsFor(err: string): number {
	const MIN = 60_000;
	if (/tidak membalas|belum mulai membalas|berhenti mengirim|belum selesai setelah/i.test(err)) return 10 * MIN; // server diam
	if (/Gagal menghubungi server/i.test(err)) return 5 * MIN;
	if (/^HTTP 40[13]\b/.test(err)) return 30 * MIN; // key salah / dicabut
	if (/^HTTP 429\b/.test(err)) {
		if (/too large|max_tokens|context length/i.test(err)) return 0; // soal ukuran, bukan kecepatan
		// Groq: "Please try again in 1h2m3.5s" / "in 7.5s" / "in 450ms"
		const m = /try again in\s+(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:([\d.]+)ms)?/i.exec(err);
		const waitMs = m ? ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000 + Number(m[4] || 0) : 0;
		return waitMs > 0 ? Math.min(60 * MIN, Math.max(5_000, Math.ceil(waitMs) + 2_000)) : 2 * MIN;
	}
	if (/^HTTP 5\d\d\b/.test(err)) return 2 * MIN;
	return 0;
}

async function persistCooldowns(env: Env, cfg: Record<string, string>, map: Record<string, Cooldown>): Promise<void> {
	const now = Date.now();
	for (const [k, c] of Object.entries(map)) if (!(Number(c?.until) > now)) delete map[k];
	const json = JSON.stringify(map);
	if (json === (cfg[AI_COOLDOWNS_KEY] || "{}")) return;
	cfg[AI_COOLDOWNS_KEY] = json;
	await kvSet(env, { [AI_COOLDOWNS_KEY]: json }).catch(() => {});
}

async function setCooldown(env: Env, cfg: Record<string, string>, p: AiProvider, err: string): Promise<void> {
	const ms = cooldownMsFor(err);
	if (!ms) return;
	const c: Cooldown = { sig: sigOf(p), until: Date.now() + ms, reason: err.slice(0, 160) };
	memCooldowns.set(cdKey(p), c);
	await persistCooldowns(env, cfg, { ...storedCooldowns(cfg), [cdKey(p)]: c });
}

/**
 * Hapus jeda: satu model (panggilan berhasil) atau semua model satu provider
 * (pemilik menyimpan provider itu lagi).
 */
export async function aiClearCooldown(env: Env, cfg: Record<string, string>, id: string, model?: string): Promise<void> {
	const hit = (k: string) => (model ? k === `${id}|${model}` : k === id || k.startsWith(id + "|"));
	for (const k of [...memCooldowns.keys()]) if (hit(k)) memCooldowns.delete(k);
	const stored = storedCooldowns(cfg);
	const keys = Object.keys(stored).filter(hit);
	if (!keys.length) return;
	for (const k of keys) delete stored[k];
	await persistCooldowns(env, cfg, stored);
}

/**
 * Lupakan semua jeda. Dipakai saat pemilik menekan PROSES manual: itu
 * permintaan eksplisit untuk mencoba sekarang, jadi jeda dari run
 * sebelumnya tidak boleh membuat tombol itu langsung berhenti dgn 0 artikel.
 * Jeda yang muncul DI DALAM run ini tetap berlaku.
 */
export async function aiClearAllCooldowns(env: Env, cfg: Record<string, string>): Promise<void> {
	memCooldowns.clear();
	if (Object.keys(storedCooldowns(cfg)).length) await persistCooldowns(env, cfg, {});
}

/** Jeda terdekat yang akan habis (ms dari sekarang) di antara provider aktif, atau null. */
export async function aiNextReadyInMs(env: Env, cfg: Record<string, string>): Promise<number | null> {
	const now = Date.now();
	let best: number | null = null;
	for (const p of await aiReadyOrCoolingProviders(env, cfg)) {
		for (const m of modelChain(p)) {
			const c = aiCooldown(cfg, withModel(p, m), now);
			const wait = c ? Number(c.until) - now : 0;
			if (best == null || wait < best) best = wait;
		}
	}
	return best;
}

/** Pesan jelas untuk error jaringan (Node cuma bilang "fetch failed"; detailnya di e.cause). */
export function networkErrorText(e: unknown): string {
	const cause = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
	const c = cause && typeof cause === "object" ? (cause as { code?: string; message?: string }) : {};
	const base = e instanceof Error ? e.message : String(e);
	return [base, c.code, c.message].filter(Boolean).join(" -- ");
}

const isTooLarge = (status: number, body: any) =>
	status === 413 || ((status === 429 || status === 400) && /too large|max_tokens|maximum context|context length|reduce the length/i.test(JSON.stringify(body?.error ?? body ?? "")));

const parseJson = (raw: string): any => {
	try {
		return JSON.parse(raw);
	} catch {
		return { error: raw.slice(0, 300) };
	}
};

/**
 * Baca jawaban Server-Sent Events OpenAI ("data: {...}" per baris) jadi
 * bentuk jawaban biasa { model, choices[0].message.content, usage }.
 * `onChunk` dipanggil tiap ada data masuk (untuk menyetel ulang batas diam).
 */
export async function readChatStream(body: ReadableStream<Uint8Array>, onChunk: (chars: number) => void): Promise<any> {
	const reader = body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	let content = "";
	let model = "";
	let usage: unknown = null;
	let error: unknown = null;
	let finish = "";
	const handle = (line: string) => {
		const t = line.trim();
		if (!t.startsWith("data:")) return;
		const data = t.slice(5).trim();
		if (!data || data === "[DONE]") return;
		let o: any;
		try {
			o = JSON.parse(data);
		} catch {
			return;
		}
		if (o?.error) error = o.error;
		if (o?.model) model = String(o.model);
		if (o?.usage) usage = o.usage;
		else if (o?.x_groq?.usage) usage = o.x_groq.usage; // Groq menaruhnya di sini
		const ch = o?.choices?.[0];
		if (ch?.finish_reason) finish = String(ch.finish_reason);
		const piece = ch?.delta?.content ?? ch?.message?.content ?? "";
		if (typeof piece === "string") content += piece;
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		onChunk(content.length);
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			handle(buf.slice(0, nl));
			buf = buf.slice(nl + 1);
		}
	}
	handle(buf + dec.decode());
	if (error && !content) return { error };
	return { model, choices: [{ message: { content }, finish_reason: finish || null }], usage };
}

async function postChat(
	p: AiProvider,
	model: string,
	messages: { role: string; content: AiMsgContent }[],
	opts: { temperature?: number; maxTokens?: number; json?: boolean; extra?: Record<string, unknown>; firstByteMs?: number; idleMs?: number; totalMs?: number },
): Promise<{ status: number; body: any }> {
	const firstByteMs = opts.firstByteMs ?? AI_FIRST_BYTE_MS;
	const idleMs = opts.idleMs ?? AI_IDLE_MS;
	const totalMs = opts.totalMs ?? AI_TOTAL_MS;
	let json = !!opts.json;
	let maxTokens = opts.maxTokens;
	// Semua provider OpenAI-compatible yang umum mendukung stream; stream_options
	// (minta jumlah token di potongan terakhir) kadang ditolak -> dilepas dulu.
	let stream = true;
	let streamUsage = true;
	const send = async () => {
		const payload: Record<string, unknown> = { model, messages, temperature: opts.temperature ?? 0.8 };
		if (maxTokens) payload.max_tokens = maxTokens;
		if (json) payload.response_format = { type: "json_object" };
		if (opts.extra) Object.assign(payload, opts.extra);
		if (stream) {
			payload.stream = true;
			if (streamUsage) payload.stream_options = { include_usage: true };
		}
		const ctl = new AbortController();
		const started = Date.now();
		let phase: "first" | "idle" | "total" = "first";
		let received = 0;
		let timer = setTimeout(() => ctl.abort(), firstByteMs);
		const total = setTimeout(() => {
			phase = "total";
			ctl.abort();
		}, totalMs);
		const bump = (chars: number) => {
			received = chars;
			if (phase === "total") return;
			phase = "idle";
			clearTimeout(timer);
			timer = setTimeout(() => ctl.abort(), idleMs);
		};
		try {
			const r = await fetch(normalizeBaseUrl(p.base_url) + "/chat/completions", {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}`, "User-Agent": AI_USER_AGENT },
				body: JSON.stringify(payload),
				signal: ctl.signal,
			});
			const isSse = /text\/event-stream/i.test(r.headers.get("content-type") || "");
			if (r.ok && isSse && r.body) return { status: r.status, body: await readChatStream(r.body, bump) };
			return { status: r.status, body: parseJson(await r.text()) };
		} catch (e) {
			if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
				const sec = (ms: number) => Math.round(ms / 1000);
				const msg =
					phase === "first"
						? `server belum mulai membalas setelah ${sec(firstByteMs)} detik`
						: phase === "idle"
							? `server berhenti mengirim jawaban selama ${sec(idleMs)} detik (jawaban terpotong sesudah ${sec(Date.now() - started - idleMs)} detik)`
							: `jawaban belum selesai setelah ${sec(totalMs)} detik`;
				throw new AiTimeoutError(msg, received);
			}
			throw new Error(networkErrorText(e));
		} finally {
			clearTimeout(timer);
			clearTimeout(total);
		}
	};
	const errStr = (res: { body: any }) => JSON.stringify(res.body?.error ?? res.body ?? "");
	let res = await send();
	// Ditolak karena parameter stream -> ulang tanpa stream_options, lalu tanpa stream.
	if ((res.status === 400 || res.status === 422) && /stream_options|include_usage/i.test(errStr(res))) {
		streamUsage = false;
		res = await send();
	}
	if ((res.status === 400 || res.status === 422) && /\bstream/i.test(errStr(res))) {
		stream = false;
		res = await send();
	}
	// Tidak semua provider mendukung response_format -> ulang tanpa (prompt sudah minta JSON).
	if (json && (res.status === 400 || res.status === 422) && /response_format|json/i.test(errStr(res))) {
		json = false;
		res = await send();
	}
	// Batas output terlalu besar untuk paket akun (mis. Groq gratis: "Request too
	// large ... on output tokens") -> ulang sekali dgn batas separuhnya.
	if (maxTokens && maxTokens > 2048 && isTooLarge(res.status, res.body)) {
		maxTokens = Math.max(2048, Math.floor(maxTokens / 2));
		res = await send();
	}
	return res;
}

const errText = (status: number, body: any) => {
	const e = body?.error;
	const msg = typeof e === "string" ? e : e?.message || JSON.stringify(e ?? body ?? "");
	return `HTTP ${status} ${String(msg).slice(0, 220)}`.trim();
};

/**
 * Satu panggilan ke SATU provider dgn SATU model (p.model; kalau berisi
 * daftar, model pertama). Melempar error kalau gagal.
 * - Model sudah tidak ada (404 / decommissioned): daftar /models ditanya
 *   sekali, pengganti dipakai & ditulis menggantikannya di daftar model.
 * - Jawaban kosong karena model "berpikir" sampai batas token habis
 *   (deepseek-v4-flash: content "" dgn completion_tokens = max_tokens):
 *   diulang sekali dgn batas token 2x lipat.
 */
export async function aiChatProvider(
	env: Env,
	cfg: Record<string, string>,
	p: AiProvider,
	opts: AiCallOpts,
): Promise<AiCallResult> {
	const keyId = await aiKeyId(p.key);
	const promptChars = opts.messages.map((m) => msgChars(m.content)).join("\n");
	const configured = modelChain(p)[0] || p.model;
	let model = configured;
	let callOpts = opts;
	const tried = new Set<string>();
	let discovered = false;
	let enlarged = false;
	for (;;) {
		tried.add(model);
		const started = Date.now();
		let res: { status: number; body: any };
		try {
			res = await postChat(p, model, opts.messages, callOpts);
		} catch (e) {
			const err = "Gagal menghubungi server: " + (e instanceof Error ? e.message : String(e));
			// Diputus karena waktu habis: server sudah menerima permintaan dan
			// biasanya tetap menagih -> catat perkiraannya, bukan 0.
			const billed = e instanceof AiTimeoutError;
			const prompt = billed ? estimateTokens(promptChars) : 0;
			const completion = billed ? Math.ceil(e.partialChars / 4) : 0;
			await recordUsage(env, { keyId, provider: p.name, model, purpose: opts.purpose, prompt, completion, total: prompt + completion, estimated: billed, ok: false, err, ms: Date.now() - started });
			await setCooldown(env, cfg, withModel(p, model), err);
			throw new Error(err);
		}
		const ms = Date.now() - started;
		const text = String(res.body?.choices?.[0]?.message?.content ?? "");
		const usage = parseUsage(res.body);
		if (res.status >= 200 && res.status < 300 && text.trim()) {
			const estimated = !usage;
			const total = usage?.total ?? estimateTokens(promptChars) + estimateTokens(text);
			const usedModel = String(res.body?.model || model);
			await recordUsage(env, {
				keyId, provider: p.name, model: usedModel, purpose: opts.purpose,
				prompt: usage?.prompt ?? estimateTokens(promptChars), completion: usage?.completion ?? estimateTokens(text),
				total, estimated, ok: true, err: "", ms,
			});
			await aiClearCooldown(env, cfg, p.id, model);
			if (model !== configured) {
				// Model pengganti berhasil -> tulis menggantikan model lama di daftar.
				const list = parseProviders(cfg) || [];
				const idx = list.findIndex((x) => x.id === p.id);
				if (idx >= 0) {
					const chain = modelChain(list[idx]).map((m) => (m === configured ? model : m));
					list[idx] = { ...list[idx], model: modelChain(chain.join(",")).join(", ") };
					await aiSaveProviders(env, cfg, list).catch(() => {});
				}
			}
			return { text, providerId: p.id, providerName: p.name, model: usedModel, totalTokens: total, estimated, ms };
		}
		const empty = res.status >= 200 && res.status < 300 && !res.body?.error;
		const finish = String(res.body?.choices?.[0]?.finish_reason ?? "");
		const limit = callOpts.maxTokens ?? 0;
		const hitLimit = finish === "length" || (!!limit && (usage?.completion ?? 0) >= limit * 0.95);
		const err = empty
			? hitLimit
				? `jawaban kosong: model ${model} memakai ${usage?.completion ?? limit} token untuk "berpikir" sampai batas habis, tanpa menulis jawaban`
				: `jawaban kosong dari model ${model}`
			: errText(res.status, res.body);
		// Server kadang tetap menagih token walau gagal -> catat yang dilaporkan.
		await recordUsage(env, {
			keyId, provider: p.name, model, purpose: opts.purpose,
			prompt: usage?.prompt ?? 0, completion: usage?.completion ?? 0, total: usage?.total ?? 0,
			estimated: false, ok: false, err, ms,
		});
		if (empty && hitLimit && !enlarged && limit) {
			enlarged = true;
			callOpts = { ...callOpts, maxTokens: Math.min(32768, Math.max(4096, limit * 2)) };
			continue;
		}
		if (!discovered && isModelError(res.status, err)) {
			discovered = true;
			try {
				const ids = await aiListModels(p);
				const next = pickWriterModel(ids, new Set([...tried, ...modelChain(p)]));
				if (next) {
					model = next;
					continue;
				}
			} catch {
				/* tidak bisa menanyakan daftar model -> anggap gagal */
			}
		}
		await setCooldown(env, cfg, withModel(p, model), err);
		throw new Error(err);
	}
}

/** Daftar id model dari GET {base}/models (kosong kalau provider tidak menyediakannya). */
export async function aiListModels(p: Pick<AiProvider, "base_url" | "key">): Promise<string[]> {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), 20_000);
	try {
		const r = await fetch(normalizeBaseUrl(p.base_url) + "/models", { headers: { Authorization: `Bearer ${p.key}`, "User-Agent": AI_USER_AGENT }, signal: ctl.signal });
		const b: any = await r.json().catch(() => null);
		if (!r.ok) throw new Error(errText(r.status, b));
		const ids: string[] = Array.isArray(b?.data) ? b.data.map((m: any) => String(m?.id || "")).filter(Boolean) : [];
		return [...new Set(ids)].sort((x, y) => x.localeCompare(y)).slice(0, 300);
	} finally {
		clearTimeout(timer);
	}
}

/** Provider aktif (kuota & masa aktif OK), urut prioritas -- termasuk yang sedang dijeda. */
async function aiReadyOrCoolingProviders(env: Env, cfg: Record<string, string>): Promise<AiProvider[]> {
	const list = await aiLoadProviders(env, cfg);
	const keyIds = await Promise.all(list.map((p) => (p.key ? aiKeyId(p.key) : Promise.resolve(""))));
	const usage = await cachedUsage(env, keyIds);
	return list.filter((p, i) => providerStatus(p, usage.get(keyIds[i]) ?? EMPTY_USAGE).usable);
}

/** Provider yang boleh dipakai sekarang (aktif & minimal satu modelnya tidak dijeda), urut prioritas. */
export async function aiUsableProviders(env: Env, cfg: Record<string, string>): Promise<AiProvider[]> {
	return (await aiReadyOrCoolingProviders(env, cfg)).filter((p) => modelChain(p).some((m) => !aiCooldown(cfg, withModel(p, m))));
}

/**
 * Coba provider satu per satu sesuai urutan prioritas. `accept` boleh
 * melempar (mis. artikel terlalu pendek) -> provider berikutnya dicoba.
 * Kalau semua gagal, error berisi alasan tiap provider.
 */
export async function aiGenerate<T>(
	env: Env,
	cfg: Record<string, string>,
	opts: AiCallOpts,
	accept: (text: string) => T,
): Promise<{ value: T; call: AiCallResult }> {
	const providers = await aiReadyOrCoolingProviders(env, cfg);
	if (!providers.length) {
		throw new AiUnavailableError("Tidak ada AI provider yang aktif. Tambahkan / aktifkan di BOT → Setting → AI Provider (cek juga kuota & masa aktif).");
	}
	const errs: string[] = [];
	let attempted = 0;
	for (const p of providers) {
		const chain = modelChain(p);
		for (const m of chain) {
			const pm = withModel(p, m);
			const label = chain.length > 1 ? `${p.name}/${m}` : p.name;
			const cd = aiCooldown(cfg, pm);
			if (cd) {
				errs.push(`${label}: dijeda ${Math.ceil((Number(cd.until) - Date.now()) / 1000)} dtk lagi (${cd.reason})`);
				continue;
			}
			attempted++;
			try {
				const call = await aiChatProvider(env, cfg, pm, opts);
				return { value: accept(call.text), call };
			} catch (e) {
				errs.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}
	// Semua provider sedang dijeda -> artikel tidak salah apa-apa, jangan dibakar.
	if (!attempted) throw new AiUnavailableError("Semua AI provider sedang dijeda: " + errs.join(" | "));
	throw new Error(errs.join(" | "));
}
