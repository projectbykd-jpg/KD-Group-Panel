// Port Invest.gs — Menu INVEST (AutoCheck batas line invest per operator).
// Config + state per-user (invest_config / invest_state), hasil di invest_result.
// Tabel invest_* ada di Turso (bukan D1) -> pakai getTurso(env).
import { tsNow } from "./time";
import { getTurso } from "./turso";

export const INVEST_DEFAULT_CONFIG = {
	BASE_URL: "https://ag.suksesbogil.com/",
	PHPSESSID: "",
	KODEREDIS: "",
	COOKIE_EXTRA: "",
	LIMIT_2D: 20,
	LIMIT_3D: 250,
	LIMIT_4D: 1296,
	// JSON [["p7023","ARIZONA"],...] — daftar pasaran KHUSUS panel ini. Diisi kalau
	// auto-discovery gagal (dropdown pasaran di-render JavaScript, mis. agwlXX).
	// Kosong = scanner pakai auto-discovery / list bawaan.
	PASARAN_JSON: "",
};
export type InvestConfig = typeof INVEST_DEFAULT_CONFIG;

/** Ambil pasangan [kode pNNNN, nama] dari HTML <select>/<option> pasaran. */
export function parsePasaranOptionsHtml(html: string): [string, string][] {
	const out: [string, string][] = [];
	const seen = new Set<string>();
	const re = /<option\b([^>]*)>([^<]*)/gi;
	let mm: RegExpExecArray | null;
	while ((mm = re.exec(html))) {
		const attrs = mm[1] || "";
		const label = (mm[2] || "").replace(/\s+/g, " ").trim();
		if (/display\s*:\s*none/i.test(attrs)) continue;
		const vm = attrs.match(/value=["']([^"']*)["']/i);
		const val = vm ? vm[1].trim() : "";
		if (!val || !label || /^pilih/i.test(label)) continue;
		if (/^pool-|^param|^\d+$/i.test(val)) continue;
		const cm = val.match(/(?:^|,)\s*(p\d+)\s*$/i);
		if (!cm || seen.has(cm[1])) continue;
		seen.add(cm[1]);
		out.push([cm[1], label]);
	}
	return out;
}

// Konstanta scan (tidak diutak-atik dari panel).
export const INVEST_TIMEZONE = "Asia/Jakarta";
export const INVEST_PERIODE_LOOKBACK = 8;
export const INVEST_PAGE_SIZE = 50;
export const INVEST_MAX_PAGES_PER_GAME = 80;
export const INVEST_GAMES = ["2D", "3D", "4D"] as const;

// 62 pasaran togel standar (index dari agent_bt.php) + IDN4D.
export const INVEST_PASARAN: [string, string][] = [
	["p33190", "ARIZONA"], ["p12698", "ATHENS"], ["p12703", "AUSTRIA"], ["p12701", "BAHRAIN"],
	["p33210", "BALI"], ["p31202", "BERLIN"], ["p33191", "BRAZIL"], ["p6680", "BULLSEYE"],
	["p31205", "BUSAN"], ["p12700", "CAIRO"], ["p21546", "CALIFORNIA"], ["p33192", "CANADA"],
	["p6682", "CAROLINADAY"], ["p21547", "CAROLINAEVE"], ["p31211", "COLORADO"], ["p31210", "DALLAS"],
	["p21545", "FLORIDAEVE"], ["p21544", "FLORIDAMID"], ["p31209", "HK SIANG"], ["p6683", "HONGKONG"],
	["p6684", "IDAHO"], ["p6685", "INDIA"], ["p28611", "INDIA MORNING"], ["p33193", "JAKARTA"],
	["p12704", "KANSAS"], ["p6686", "KENTUCKYEVE"], ["p21540", "KENTUCKYMID"], ["p31585", "KHMER LOTTO"],
	["p31199", "LAOS MALAM"], ["p31200", "LAOS SIANG"], ["p12699", "LISBON"], ["p28616", "LISBON NIGHT"],
	["p31206", "MALAYSIA"], ["p33211", "MANILA"], ["p12706", "MEXICO"], ["p31213", "MICHIGAN"],
	["p31214", "MONTANA"], ["p6687", "NEBRASKA"], ["p28614", "NEW MEXICO"], ["p21543", "NEWYORKEVE"],
	["p21542", "NEWYORKMID"], ["p31594", "NIPPON LOTTO"], ["p31212", "OHIO"], ["p21538", "OREGON03"],
	["p21535", "OREGON06"], ["p21537", "OREGON09"], ["p21539", "OREGON12"], ["p31203", "OSAKA"],
	["p6688", "PANAMA"], ["p31204", "PARIS"], ["p12705", "PARMA"], ["p31201", "ROMA"],
	["p31198", "RUSIA"], ["p12697", "SAPPORO"], ["p28613", "SAPPORO EVE"], ["p6689", "SINGAPORE"],
	["p6690", "SYDNEY"], ["p31588", "TAIPEI LOTTO"], ["p31207", "THAILAND"], ["p31587", "TIONGKOK 4D"],
	["p12702", "TURKEY"], ["p31208", "UEA SORE"],
	["p808", "IDN4D"],
];

const INVEST_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

/**
 * Bersihkan BASE_URL yang sering salah tempel:
 *  - buang query string / fragment (mis. "...?passkey=xxx")
 *  - buang segmen "index.php" / "login.php" di ujung
 *  - pastikan diakhiri "/"
 * Halaman scan dipanggil sebagai "<base>admin_invoice13.php?..." jadi base HARUS
 * cuma "scheme://host/[path/]".
 */
export function normalizeInvestBaseUrl(raw: string): string {
	let s = String(raw || "").trim();
	if (!s) return INVEST_DEFAULT_CONFIG.BASE_URL;
	s = s.split("#")[0].split("?")[0];
	s = s.replace(/\/(?:index|login|main|home)\.php\/?$/i, "/");
	if (!/^https?:\/\//i.test(s)) s = "https://" + s;
	if (!s.endsWith("/")) s += "/";
	return s;
}

// ---------------------------------------------------------------------------
// CONFIG (per-user) — invest_config
// ---------------------------------------------------------------------------
// Kolom pasaran_json ditambahkan belakangan dan tidak ada di migration/turso_001
// (hanya di database produksi yang sudah dipatch tangan). Tanpa ini Turso baru
// gagal "table invest_config has no column named pasaran_json". Dicek sekali
// per isolate; ALTER yang gagal (kolom sudah ada) diabaikan.
let pasaranColumnReady = false;
export async function ensureInvestPasaranColumn(env: Env): Promise<void> {
	if (pasaranColumnReady) return;
	try {
		await getTurso(env).prepare(`ALTER TABLE invest_config ADD COLUMN pasaran_json TEXT NOT NULL DEFAULT ''`).run();
	} catch {
		/* kolom sudah ada */
	}
	pasaranColumnReady = true;
}

export async function investLoadConfig(env: Env, user: string): Promise<InvestConfig> {
	await ensureInvestPasaranColumn(env);
	const row = await getTurso(env).prepare(`SELECT * FROM invest_config WHERE username = ?`)
		.bind(user)
		.first<Record<string, unknown>>();
	const cfg: InvestConfig = { ...INVEST_DEFAULT_CONFIG };
	if (row) {
		cfg.BASE_URL = String(row.base_url || INVEST_DEFAULT_CONFIG.BASE_URL);
		cfg.PHPSESSID = String(row.phpsessid || "");
		cfg.KODEREDIS = String(row.koderedis || "");
		cfg.COOKIE_EXTRA = String(row.cookie_extra || "");
		cfg.LIMIT_2D = Number(row.limit_2d ?? INVEST_DEFAULT_CONFIG.LIMIT_2D);
		cfg.LIMIT_3D = Number(row.limit_3d ?? INVEST_DEFAULT_CONFIG.LIMIT_3D);
		cfg.LIMIT_4D = Number(row.limit_4d ?? INVEST_DEFAULT_CONFIG.LIMIT_4D);
		cfg.PASARAN_JSON = String(row.pasaran_json || "");
	}
	cfg.BASE_URL = normalizeInvestBaseUrl(cfg.BASE_URL);
	return cfg;
}

export async function investSaveConfig(env: Env, user: string, data: Record<string, unknown>): Promise<InvestConfig> {
	const cur = await investLoadConfig(env, user);
	const pick = (k: keyof InvestConfig): string =>
		Object.prototype.hasOwnProperty.call(data, k) ? String(data[k] ?? "").trim() : String(cur[k]);
	const num = (k: keyof InvestConfig): number => {
		const raw = pick(k);
		const n = Number(raw);
		return raw === "" || isNaN(n) ? (INVEST_DEFAULT_CONFIG[k] as number) : n;
	};
	const baseUrl = normalizeInvestBaseUrl(pick("BASE_URL"));

	// PASARAN: bisa dikirim sbg HTML <select> mentah (PASARAN_RAW) atau JSON siap
	// (PASARAN_JSON). Parse & simpan sbg JSON bersih; string "-" / "reset" = kosongkan.
	let pasaranJson = cur.PASARAN_JSON;
	if (Object.prototype.hasOwnProperty.call(data, "PASARAN_RAW") || Object.prototype.hasOwnProperty.call(data, "PASARAN_JSON")) {
		const raw = String(data.PASARAN_RAW ?? data.PASARAN_JSON ?? "").trim();
		if (!raw || /^(-|reset|kosong|clear)$/i.test(raw)) {
			pasaranJson = "";
		} else if (raw.startsWith("[")) {
			try {
				const arr = JSON.parse(raw);
				if (Array.isArray(arr) && arr.length >= 5) pasaranJson = JSON.stringify(arr);
			} catch { /* abaikan JSON rusak */ }
		} else {
			const parsed = parsePasaranOptionsHtml(raw);
			if (parsed.length >= 5) pasaranJson = JSON.stringify(parsed);
		}
	}

	await getTurso(env).prepare(
		`INSERT INTO invest_config
		   (username, base_url, phpsessid, koderedis, cookie_extra, limit_2d, limit_3d, limit_4d, pasaran_json, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(username) DO UPDATE SET
		   base_url = excluded.base_url, phpsessid = excluded.phpsessid, koderedis = excluded.koderedis,
		   cookie_extra = excluded.cookie_extra, limit_2d = excluded.limit_2d, limit_3d = excluded.limit_3d,
		   limit_4d = excluded.limit_4d, pasaran_json = excluded.pasaran_json, updated_at = excluded.updated_at`,
	)
		.bind(
			user,
			baseUrl,
			pick("PHPSESSID"),
			pick("KODEREDIS"),
			pick("COOKIE_EXTRA"),
			num("LIMIT_2D"),
			num("LIMIT_3D"),
			num("LIMIT_4D"),
			pasaranJson,
			tsNow(),
		)
		.run();
	return investLoadConfig(env, user);
}

// ---------------------------------------------------------------------------
// STATE (per-user) — invest_state
// ---------------------------------------------------------------------------
export interface InvestState {
	state: string; // idle | running | paused | session_expired | done | error
	cursor: number;
	total: number;
	startedAt: string;
	finishedAt: string;
	message: string;
	updatedAt: string;
	warningCount?: number;
}
export async function investGetState(env: Env, user: string): Promise<InvestState> {
	const row = await getTurso(env).prepare(`SELECT * FROM invest_state WHERE username = ?`)
		.bind(user)
		.first<Record<string, unknown>>();
	return {
		state: String(row?.state ?? "idle"),
		cursor: Number(row?.cursor ?? 0),
		total: Number(row?.total ?? 0),
		startedAt: String(row?.started_at ?? ""),
		finishedAt: String(row?.finished_at ?? ""),
		message: String(row?.message ?? ""),
		updatedAt: String(row?.updated_at ?? ""),
	};
}
export async function investSetState(env: Env, user: string, patch: Partial<InvestState>): Promise<InvestState> {
	const cur = await investGetState(env, user);
	const next: InvestState = { ...cur, ...patch, updatedAt: tsNow() };
	await getTurso(env).prepare(
		`INSERT INTO invest_state (username, state, cursor, total, started_at, finished_at, message, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(username) DO UPDATE SET
		   state = excluded.state, cursor = excluded.cursor, total = excluded.total,
		   started_at = excluded.started_at, finished_at = excluded.finished_at,
		   message = excluded.message, updated_at = excluded.updated_at`,
	)
		.bind(user, next.state, next.cursor, next.total, next.startedAt || null, next.finishedAt || null, next.message, next.updatedAt)
		.run();
	return next;
}
export async function investRunningUsers(env: Env): Promise<string[]> {
	const res = await getTurso(env).prepare(`SELECT username FROM invest_state WHERE state = 'running'`).all<{ username: string }>();
	return (res.results ?? []).map((r) => r.username);
}

// ---------------------------------------------------------------------------
// HASIL — invest_result
// ---------------------------------------------------------------------------
export async function investWarningCount(env: Env, user: string): Promise<number> {
	const r = await getTurso(env).prepare(`SELECT COUNT(*) n FROM invest_result WHERE owner = ?`).bind(user).first<{ n: number }>();
	return Number(r?.n ?? 0);
}

export async function investGetWarningsList(env: Env, user: string) {
	const res = await getTurso(env).prepare(
		`SELECT bettor, dates, markets, excess, hits FROM invest_result WHERE owner = ? ORDER BY excess DESC`,
	)
		.bind(user)
		.all<Record<string, unknown>>();
	return (res.results ?? []).map((r) => {
		let hits: unknown[] = [];
		try {
			hits = JSON.parse(String(r.hits ?? "[]"));
		} catch {
			hits = [];
		}
		return {
			user: String(r.bettor ?? ""),
			dates: String(r.dates ?? "").split(", ").filter(Boolean),
			markets: String(r.markets ?? "").split(", ").filter(Boolean),
			excess: Number(r.excess ?? 0),
			hits,
		};
	});
}

// ---------------------------------------------------------------------------
// HTTP ke panel agen
// ---------------------------------------------------------------------------
// Deteksi: field ini berisi HEADER cookie lengkap (mis. user salah tempel
// "PHPSESSID=...; lastuser=...; ..." ke kolom KODEREDIS / COOKIE_EXTRA).
function looksLikeFullCookie(v: string): boolean {
	const s = String(v || "");
	return /\bPHPSESSID=/i.test(s) || (s.includes("=") && s.includes(";"));
}

export function investCookieHeader(cfg: InvestConfig): string {
	// Prioritas: cookie mentah lengkap kalau diisi.
	if (cfg.COOKIE_EXTRA && looksLikeFullCookie(cfg.COOKIE_EXTRA)) return cfg.COOKIE_EXTRA.trim();
	if (cfg.COOKIE_EXTRA) return cfg.COOKIE_EXTRA.trim();
	// Toleransi: kalau KODEREDIS ternyata berisi header cookie lengkap, pakai itu.
	if (cfg.KODEREDIS && looksLikeFullCookie(cfg.KODEREDIS)) return cfg.KODEREDIS.trim();
	let c = "PHPSESSID=" + cfg.PHPSESSID;
	if (cfg.KODEREDIS) c += "; koderedis=" + cfg.KODEREDIS;
	return c;
}

export function investIsLoginPage(location: string, body: string): boolean {
	const loc = String(location || "");
	if (/(?:^|\/)(?:login|index|logout)\.php/i.test(loc) || /[?&]expired/i.test(loc)) return true;
	if (
		/name=["']entered_login["']/i.test(body) ||
		/name=["']vb_login_md5password["']/i.test(body) ||
		/class="submit-button"\s+value="LOGIN"/i.test(body) ||
		/<form[^>]+action=["'][^"']*login/i.test(body)
	) {
		return true;
	}
	return false;
}

export class InvestSessionExpired extends Error {
	constructor() {
		super("SESSION_EXPIRED");
		this.name = "InvestSessionExpired";
	}
}

// Situs agen sedang maintenance / error server (bukan sesi kedaluwarsa).
// Halaman ini balas 200 dengan konten error, bukan redirect login.
export class InvestSiteDown extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "InvestSiteDown";
	}
}

export function investSiteDownReason(body: string): string | null {
	const b = String(body || "");
	if (b.length < 4000 && /images\/maintenance\.jpg|sedang (?:dalam )?(?:maintenance|perbaikan)|under maintenance/i.test(b)) {
		return "Situs agen sedang MAINTENANCE.";
	}
	if (b.length < 2000 && /Error Connected to server|Sorry for inconvinience|Press Ctrl\+F5 to retry/i.test(b)) {
		return "Situs agen error koneksi ke server (coba lagi beberapa menit).";
	}
	if (b.length < 3000 && /<b>Information<\/b>/i.test(b) && !/periode/i.test(b) && !/admin_invoice/i.test(b)) {
		return "Situs agen menampilkan halaman 'Information' — akun mungkin tidak punya akses / dibatasi.";
	}
	return null;
}

// Header ala browser sungguhan. Panel agwlXX ada di belakang Cloudflare dgn
// Bot Fight Mode — subrequest Worker yang cuma kirim UA + Cookie sering di-
// challenge (balas 200 halaman kosong tanpa "periode"). Melengkapi header
// fingerprint bikin lolos seperti fetch dari browser.
export function investBrowserHeaders(cfg: InvestConfig): Record<string, string> {
	return {
		Cookie: investCookieHeader(cfg),
		"User-Agent": INVEST_UA,
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
		"Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
		"Accept-Encoding": "gzip, deflate, br",
		Referer: cfg.BASE_URL,
		"Upgrade-Insecure-Requests": "1",
		"Sec-Fetch-Dest": "document",
		"Sec-Fetch-Mode": "navigate",
		"Sec-Fetch-Site": "same-origin",
		"sec-ch-ua": '"Chromium";v="128", "Not(A:Brand";v="24", "Google Chrome";v="128"',
		"sec-ch-ua-mobile": "?0",
		"sec-ch-ua-platform": '"Windows"',
	};
}

export async function investFetch(cfg: InvestConfig, path: string): Promise<string> {
	if (!cfg.PHPSESSID && !cfg.COOKIE_EXTRA) {
		throw new Error("PHPSESSID kosong — isi & simpan dulu di menu INVEST.");
	}
	const res = await fetch(cfg.BASE_URL + path, {
		method: "GET",
		headers: investBrowserHeaders(cfg),
		redirect: "manual",
	});
	const body = await res.text();
	if (investIsLoginPage(res.headers.get("location") || "", body)) throw new InvestSessionExpired();
	const down = investSiteDownReason(body);
	if (down) throw new InvestSiteDown(down);
	return body;
}

/** GET paralel (chunk 30) — meniru investBatchGet_. */
export async function investBatchGet(
	cfg: InvestConfig,
	paths: string[],
): Promise<{ body: string; expired: boolean; error: string }[]> {
	const out: { body: string; expired: boolean; error: string }[] = [];
	const CHUNK = 30;
	for (let i = 0; i < paths.length; i += CHUNK) {
		const chunk = paths.slice(i, i + CHUNK);
		const settled = await Promise.allSettled(
			chunk.map((p) =>
				fetch(cfg.BASE_URL + p, {
					method: "GET",
					headers: investBrowserHeaders(cfg),
					redirect: "manual",
				}),
			),
		);
		for (const s of settled) {
			if (s.status !== "fulfilled") {
				out.push({ body: "", expired: false, error: "fetch gagal" });
				continue;
			}
			try {
				const b = await s.value.text();
				out.push({ body: b, expired: investIsLoginPage(s.value.headers.get("location") || "", b), error: "" });
			} catch (e) {
				out.push({ body: "", expired: false, error: e instanceof Error ? e.message : String(e) });
			}
		}
	}
	return out;
}

/** config lengkap dengan key UPPERCASE untuk frontend lama. */
export function investConfigForClient(cfg: InvestConfig) {
	return {
		BASE_URL: cfg.BASE_URL,
		PHPSESSID: cfg.PHPSESSID,
		KODEREDIS: cfg.KODEREDIS,
		COOKIE_EXTRA: cfg.COOKIE_EXTRA,
		LIMIT_2D: cfg.LIMIT_2D,
		LIMIT_3D: cfg.LIMIT_3D,
		LIMIT_4D: cfg.LIMIT_4D,
		PASARAN_COUNT: (() => {
			try {
				const a = JSON.parse(cfg.PASARAN_JSON || "[]");
				return Array.isArray(a) ? a.length : 0;
			} catch {
				return 0;
			}
		})(),
	};
}
