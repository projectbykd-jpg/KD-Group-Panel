// Turso (libSQL) — menampung tabel "berat" (Laporan Harian + Invest) yang
// dipindah dari Cloudflare D1 supaya D1 tidak kena limit "rows read" 5 juta/hari.
//
// Shim ini meniru antarmuka D1Database yang dipakai kode lap/invest:
//   getTurso(env).prepare(sql).bind(...args).run() | .all<T>() | .first<T>()
//   getTurso(env).batch([stmt, ...])
// jadi migrasi cukup ganti `env.DB` -> `getTurso(env)` di modul terkait.
import { createClient, type Client, type InArgs } from "@libsql/client/web";

// ---------------------------------------------------------------------------
// PEMBAGIAN DATABASE (perintah pemilik 25 Okt 2026) -- dua database Turso dengan tugas TETAP, tidak ada lagi pindah otomatis:
//  - DB 1 = Turso UTAMA (TURSO_URL / TURSO_TOKEN): HANYA BOT News (news_article, news_source, bot_kv, ai_usage).
//  - DB 2 = Turso CADANGAN (TURSO_SPARE_URL / TURSO_SPARE_TOKEN): SEMUA data panel lain -- Result/Auto Prediksi, Laporan,
//    Live Chat, Invest, Toto Macau, WD, notifikasi, dst.
// Dulu (17-24 Okt) cadangan hanya dipakai saat utama kena kuota, lalu "failback" menyalin balik. Kenyataannya utama habis
// kuota karena BOT News, panel ikut mati, dan sejak 18 Okt panel sudah berjalan di cadangan. Sekarang dibuat tetap: kuota
// BOT News tidak bisa lagi mematikan panel, dan tidak ada salin antar database yang bisa menimpa data.
// Tanpa DB 2 (secret cadangan belum diisi, mis. dev/test) semuanya tetap di UTAMA seperti sebelum ada cadangan.
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
/** Generasi database untuk penanda skema "sekali per isolate" (shared-once.ts, xGen). Pembagian database tetap, jadi
 *  nilainya tidak berubah selama isolate hidup; penanda tetap dipakai supaya bila pembagian diubah lagi, skema disiapkan
 *  ulang di database tujuan yang baru (test/turso-schema-parity.spec.ts). */
const generation = 0;
export function tursoGeneration(): number {
	return generation;
}
/** Hanya untuk test. */
export function resetTursoForTest(): void {
	primaryQuotaError = null;
	for (const k of Object.keys(clients) as TursoTarget[]) delete clients[k];
}

/** Tabel BOT News: SELALU di DB 1 (utama). */
const NEWS_TABLES_RE = /\b(news_article|news_source|bot_kv|ai_usage)\b/i;
export const touchesNews = (sqls: string[]): boolean => sqls.some((q) => NEWS_TABLES_RE.test(q));

/** Database tujuan satu perintah SQL: tabel BOT News -> DB 1 (utama); lainnya -> DB 2 (cadangan) bila diatur. */
export function tursoTargetFor(env: Env, sql: string): TursoTarget {
	return touchesNews([sql]) || !spareConfigured(env) ? "primary" : "spare";
}

/** Peta untuk /health & menu admin. */
export function tursoLayout(env: Env): { news: TursoTarget; panel: TursoTarget; spareConfigured: boolean } {
	const spare = spareConfigured(env);
	return { news: "primary", panel: spare ? "spare" : "primary", spareConfigured: spare };
}

/** Jalankan operasi di database tujuan. Satu batch harus seluruhnya milik SATU database (batch Turso = satu transaksi di
 *  satu database): campuran tabel News + panel ditolak, bukan diam-diam menulis tabel panel ke DB 1. */
async function onTarget<T>(env: Env, sqls: string[], fn: (c: Client) => Promise<T>): Promise<T> {
	const targets = new Set(sqls.map((q) => tursoTargetFor(env, q)));
	if (targets.size > 1) {
		throw new Error("Satu batch Turso mencampur tabel BOT News (DB 1) dan tabel panel (DB 2) — pisahkan menjadi dua batch.");
	}
	const t: TursoTarget = targets.values().next().value ?? "primary";
	return withTransientRetry(() => fn(client(env, t))).catch((e: unknown) => {
		const msg = e instanceof Error ? e.message : String(e);
		if (t === "primary" && TURSO_QUOTA_RE.test(msg)) primaryQuotaError = msg;
		throw e;
	});
}

// Galat kuota terakhir yang BENAR-BENAR datang dari DB 1 (bukan DB 2), dicatat di sini karena pemanggil sering membungkus
// ulang galatnya. db1-gate.ts mengambilnya (db1Settle) untuk menjeda BOT News -- lihat komentar di sana.
let primaryQuotaError: string | null = null;
export function takePrimaryQuotaError(): string | null {
	const e = primaryQuotaError;
	primaryQuotaError = null;
	return e;
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
		const rs = await onTarget(this.env, [this.sql], (c) => c.execute({ sql: this.sql, args: clean(this.args) }));
		return { success: true, meta: { changes: rs.rowsAffected ?? 0, last_row_id: Number(rs.lastInsertRowid ?? 0), duration: 0 } };
	}
	async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
		const rs = await onTarget(this.env, [this.sql], (c) => c.execute({ sql: this.sql, args: clean(this.args) }));
		return { results: rs.rows as unknown as T[], success: true, meta: {} };
	}
	async first<T = Record<string, unknown>>(): Promise<T | null> {
		const rs = await onTarget(this.env, [this.sql], (c) => c.execute({ sql: this.sql, args: clean(this.args) }));
		return (rs.rows[0] as unknown as T) ?? null;
	}
}

class TDB {
	constructor(readonly env: Env) {}
	prepare(sql: string): TStmt {
		return new TStmt(this.env, sql);
	}
	async batch(stmts: TStmt[]): Promise<{ success: true; meta: { changes: number; last_row_id: number } }[]> {
		const rs = await onTarget(this.env, stmts.map((x) => x.sql), (c) =>
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
