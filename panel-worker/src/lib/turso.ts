// Turso (libSQL) — menampung tabel "berat" (Laporan Harian + Invest) yang
// dipindah dari Cloudflare D1 supaya D1 tidak kena limit "rows read" 5 juta/hari.
//
// Shim ini meniru antarmuka D1Database yang dipakai kode lap/invest:
//   getTurso(env).prepare(sql).bind(...args).run() | .all<T>() | .first<T>()
//   getTurso(env).batch([stmt, ...])
// jadi migrasi cukup ganti `env.DB` -> `getTurso(env)` di modul terkait.
import { createClient, type Client, type InArgs } from "@libsql/client/web";

let _client: Client | null = null;

// Secret bisa terbawa BOM / spasi kalau di-set lewat pipe PowerShell.
const scrub = (v: string | undefined): string => String(v ?? "").replace(/^﻿/, "").trim();

function client(env: Env): Client {
	if (!_client) {
		const url = scrub(env.TURSO_URL);
		const authToken = scrub(env.TURSO_TOKEN);
		if (!url || !authToken) {
			throw new Error("Turso belum dikonfigurasi (TURSO_URL / TURSO_TOKEN). Hubungi admin.");
		}
		_client = createClient({ url, authToken });
	}
	return _client;
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
		readonly c: Client,
		readonly sql: string,
		readonly args: unknown[] = [],
	) {}
	bind(...args: unknown[]): TStmt {
		return new TStmt(this.c, this.sql, args);
	}
	async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number; duration: number } }> {
		const rs = await withTransientRetry(() => this.c.execute({ sql: this.sql, args: clean(this.args) }));
		return { success: true, meta: { changes: rs.rowsAffected ?? 0, last_row_id: Number(rs.lastInsertRowid ?? 0), duration: 0 } };
	}
	async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
		const rs = await withTransientRetry(() => this.c.execute({ sql: this.sql, args: clean(this.args) }));
		return { results: rs.rows as unknown as T[], success: true, meta: {} };
	}
	async first<T = Record<string, unknown>>(): Promise<T | null> {
		const rs = await withTransientRetry(() => this.c.execute({ sql: this.sql, args: clean(this.args) }));
		return (rs.rows[0] as unknown as T) ?? null;
	}
}

class TDB {
	constructor(readonly c: Client) {}
	prepare(sql: string): TStmt {
		return new TStmt(this.c, sql);
	}
	async batch(stmts: TStmt[]): Promise<{ success: true; meta: { changes: number; last_row_id: number } }[]> {
		const rs = await withTransientRetry(() =>
			this.c.batch(
				stmts.map((s) => ({ sql: s.sql, args: clean(s.args) })),
				"write",
			),
		);
		return rs.map((r) => ({ success: true as const, meta: { changes: r.rowsAffected ?? 0, last_row_id: Number(r.lastInsertRowid ?? 0) } }));
	}
}

export function getTurso(env: Env): TDB {
	return new TDB(client(env));
}
