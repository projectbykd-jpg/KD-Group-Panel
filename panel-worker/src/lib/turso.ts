// Turso (libSQL) — menampung tabel "berat" (Laporan Harian + Invest) yang
// dipindah dari Cloudflare D1 supaya D1 tidak kena limit "rows read" 5 juta/hari.
//
// Shim ini meniru antarmuka D1Database yang dipakai kode lap/invest:
//   getTurso(env).prepare(sql).bind(...args).run() | .all<T>() | .first<T>()
//   getTurso(env).batch([stmt, ...])
// jadi migrasi cukup ganti `env.DB` -> `getTurso(env)` di modul terkait.
import { createClient, type Client, type InArgs } from "@libsql/client/web";

// ---------------------------------------------------------------------------
// DATABASE CADANGAN (SPARE) -- 17 Okt 2026 Turso utama memblokir semua baca (kuota bulanan paket gratis habis) dan semua
// fitur yang memakai Turso ikut mati. Rancangan "spare model aman" (dipilih pemilik):
//  - Normal: SEMUA baca/tulis ke UTAMA. Spare TIDAK ditulis langsung (dulu diusulkan "catat ganda", ditolak: satu tulis
//    yang gagal membuat nomor baris spare bergeser dan UPDATE ... WHERE id=? diam-diam mengenai baris yang salah).
//  - Workflow GitHub "Turso sinkron cadangan" (scripts/turso-sync.ts) menyalin utama -> spare berkala (hanya baris yang
//    berubah; rowid identik dengan utama) dan mencatat kd_failover.synced_at di spare.
//  - Utama menjawab BLOCKED / kuota habis -> panel PINDAH ke spare (baca + tulis), ditandai kd_failover.active='spare' di
//    spare (sumber kebenaran bersama: Worker + skrip GitHub membaca penanda yang sama, jadi tidak ada yang menulis ke dua
//    tempat). Pindah HANYA bila spare sudah pernah disalin (synced_at ada) -- pindah ke spare kosong lalu "kembalikan ke
//    utama" akan menimpa data asli dengan isi kosong.
//  - Kembali ke utama TIDAK otomatis (data selama gangguan ada di spare): workflow yang sama mode "failback" menyalin
//    spare -> utama lalu mengembalikan penanda ke 'primary'.
// ---------------------------------------------------------------------------
export type TursoTarget = "primary" | "spare";
const clients: Partial<Record<TursoTarget, Client>> = {};

// Secret bisa terbawa BOM / spasi kalau di-set lewat pipe PowerShell.
const scrub = (v: string | undefined): string => String(v ?? "").replace(/^\uFEFF/, "").trim();

function creds(env: Env, t: TursoTarget): { url: string; authToken: string } | null {
	const url = scrub(t === "primary" ? env.TURSO_URL : env.TURSO_SPARE_URL);
	const authToken = scrub(t === "primary" ? env.TURSO_TOKEN : env.TURSO_SPARE_TOKEN);
	return url && authToken ? { url, authToken } : null;
}
export function spareConfigured(env: Env): boolean {
	return !!creds(env, "spare");
}
function client(env: Env, t: TursoTarget = "primary"): Client {
	let c = clients[t];
	if (!c) {
		const cr = creds(env, t);
		if (!cr) {
			throw new Error(
				t === "primary"
					? "Turso belum dikonfigurasi (TURSO_URL / TURSO_TOKEN). Hubungi admin."
					: "Turso cadangan belum dikonfigurasi (TURSO_SPARE_URL / TURSO_SPARE_TOKEN).",
			);
		}
		c = createClient(cr);
		clients[t] = c;
	}
	return c;
}

/** Galat Turso yang berarti kuota/paket habis (bukan galat query biasa). Huruf besar "BLOCKED" = kode galat Turso. */
export const TURSO_QUOTA_RE = /\bBLOCKED\b|reads are blocked|writes are blocked|upgrade your plan/;
const STATE_TTL_MS = 60_000;
interface FailoverState {
	active: TursoTarget;
	syncedAt: string;
	since: string;
	at: number;
}
let state: FailoverState | null = null;
let failoverHook: ((env: Env, reason: string) => void | Promise<void>) | null = null;

/** Dipanggil index.ts: catat ke Error & Bug (+ Telegram admin) saat panel pindah ke spare. */
export function onTursoFailover(cb: (env: Env, reason: string) => void | Promise<void>): void {
	failoverHook = cb;
}
/** Hanya untuk test. */
export function resetTursoForTest(): void {
	for (const k of Object.keys(clients) as TursoTarget[]) delete clients[k];
	state = null;
	failoverHook = null;
}

async function readState(env: Env, fresh = false): Promise<FailoverState> {
	if (!spareConfigured(env)) return { active: "primary", syncedAt: "", since: "", at: Date.now() };
	if (!fresh && state && Date.now() - state.at < STATE_TTL_MS) return state;
	try {
		const rs = await client(env, "spare").execute(`SELECT k, v, at FROM kd_failover WHERE k IN ('active', 'synced_at')`);
		const m = new Map(rs.rows.map((r) => [String(r.k), { v: String(r.v ?? ""), at: String(r.at ?? "") }]));
		state = {
			active: m.get("active")?.v === "spare" ? "spare" : "primary",
			syncedAt: m.get("synced_at")?.v ?? "",
			since: m.get("active")?.v === "spare" ? (m.get("active")?.at ?? "") : "",
			at: Date.now(),
		};
	} catch {
		// tabel penanda belum ada (spare belum pernah disalin) / spare tidak terjangkau -> tetap utama, belum siap
		state = { active: state?.active ?? "primary", syncedAt: state?.syncedAt ?? "", since: state?.since ?? "", at: Date.now() };
	}
	return state;
}

async function declareFailover(env: Env, reason: string): Promise<void> {
	const now = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
	await client(env, "spare").batch(
		[
			`CREATE TABLE IF NOT EXISTS kd_failover (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '', at TEXT NOT NULL DEFAULT '')`,
			{ sql: `INSERT OR REPLACE INTO kd_failover (k, v, at) VALUES ('active', 'spare', ?)`, args: [now] },
			{ sql: `INSERT OR REPLACE INTO kd_failover (k, v, at) VALUES ('failover_reason', ?, ?)`, args: [reason.slice(0, 300), now] },
		],
		"write",
	);
	state = { active: "spare", syncedAt: state?.syncedAt ?? "", since: now, at: Date.now() };
	try {
		await failoverHook?.(env, reason);
	} catch {
		/* pencatatan gagal tidak boleh menggagalkan query */
	}
}

/** Status untuk /health & menu admin: database yang sedang dipakai + kapan spare terakhir disalin. */
export async function tursoStatus(env: Env): Promise<{ active: TursoTarget; spareConfigured: boolean; spareSyncedAt: string; spareSince: string }> {
	const st = await readState(env);
	return { active: st.active, spareConfigured: spareConfigured(env), spareSyncedAt: st.syncedAt, spareSince: st.since };
}

/** Tabel BOT News: SELALU di Turso utama, tidak pernah dipindah ke cadangan (perintah pemilik 17 Okt 2026: "spare tidak pernah
 *  dipakai untuk news"). Saat utama diblokir, jalur news gagal apa adanya sedangkan fitur lain berjalan di cadangan. */
const NEWS_TABLES_RE = /\b(news_article|news_source|bot_kv|ai_usage)\b/i;
export const touchesNews = (sqls: string[]): boolean => sqls.some((q) => NEWS_TABLES_RE.test(q));

/** Jalankan satu operasi di database yang aktif; utama kena kuota -> pindah ke spare (bila sudah disalin) lalu ulangi. */
async function onActive<T>(env: Env, sqls: string[], fn: (c: Client) => Promise<T>): Promise<T> {
	const st = await readState(env);
	if (st.active === "spare" && !touchesNews(sqls)) return withTransientRetry(() => fn(client(env, "spare")));
	try {
		return await withTransientRetry(() => fn(client(env, "primary")));
	} catch (e) {
		const msg = String(e instanceof Error ? e.message : e);
		if (!spareConfigured(env) || !TURSO_QUOTA_RE.test(msg) || touchesNews(sqls)) throw e; // news tidak pernah ke cadangan
		const now = await readState(env, true);
		if (now.active !== "spare") {
			if (!now.syncedAt) {
				throw new Error(
					msg + " — database cadangan (spare) belum pernah disalin, jadi TIDAK dipakai (spare kosong akan merusak data). Jalankan workflow GitHub 'Turso sinkron cadangan' setelah utama bisa dibaca lagi.",
				);
			}
			await declareFailover(env, msg);
		}
		return withTransientRetry(() => fn(client(env, "spare")));
	}
}

const clean = (args: unknown[]): InArgs => args.map((a) => (a === undefined ? null : a)) as InArgs;

async function withTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
	let last: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await fn();
		} catch (e) {
			last = e;
			const msg = String(e instanceof Error ? e.message : e).toLowerCase();
			const retryable =
				msg.includes("capacity temporarily exceeded") ||
				msg.includes("sqlite_busy") ||
				msg.includes("sqlite_locked") ||
				msg.includes("too many requests") ||
				msg.includes("rate limit") ||
				msg.includes("http status 429") ||
				msg.includes("http status 503") ||
				// respons Turso terpotong di tengah jalan (jaringan putus): JSON tidak lengkap -> aman diulang (baca) / diulang (tulis idempoten)
				msg.includes("unterminated string in json") ||
				msg.includes("unexpected end of json") ||
				msg.includes("unexpected end of data");
			if (!retryable || attempt === 2) throw e;
			await new Promise((resolve) => setTimeout(resolve, [150, 400, 900][attempt]));
		}
	}
	throw last instanceof Error ? last : new Error(String(last));
}

class TStmt {
	constructor(
		readonly env: Env,
		readonly sql: string,
		readonly args: unknown[] = [],
	) {}
	bind(...args: unknown[]): TStmt {
		return new TStmt(this.env, this.sql, args);
	}
	async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number; duration: number } }> {
		const rs = await onActive(this.env, [this.sql], (c) => c.execute({ sql: this.sql, args: clean(this.args) }));
		return { success: true, meta: { changes: rs.rowsAffected ?? 0, last_row_id: Number(rs.lastInsertRowid ?? 0), duration: 0 } };
	}
	async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
		const rs = await onActive(this.env, [this.sql], (c) => c.execute({ sql: this.sql, args: clean(this.args) }));
		return { results: rs.rows as unknown as T[], success: true, meta: {} };
	}
	async first<T = Record<string, unknown>>(): Promise<T | null> {
		const rs = await onActive(this.env, [this.sql], (c) => c.execute({ sql: this.sql, args: clean(this.args) }));
		return (rs.rows[0] as unknown as T) ?? null;
	}
}

class TDB {
	constructor(readonly env: Env) {}
	prepare(sql: string): TStmt {
		return new TStmt(this.env, sql);
	}
	async batch(stmts: TStmt[]): Promise<{ success: true; meta: { changes: number; last_row_id: number } }[]> {
		const rs = await onActive(this.env, stmts.map((x) => x.sql), (c) =>
			c.batch(
				stmts.map((s) => ({ sql: s.sql, args: clean(s.args) })),
				"write",
			),
		);
		return rs.map((r) => ({ success: true as const, meta: { changes: r.rowsAffected ?? 0, last_row_id: Number(r.lastInsertRowid ?? 0) } }));
	}
}

export function getTurso(env: Env): TDB {
	client(env, "primary"); // konfigurasi utama tetap wajib (pesan galat sama seperti dulu)
	return new TDB(env);
}
