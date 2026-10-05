// Env tiruan untuk unit test: D1 di atas node:sqlite (memakai file migrasi
// ASLI di ../migration, jadi skemanya identik dengan produksi) + KV di memori.
// Cukup untuk menguji logika login/sesi tanpa menyentuh Cloudflare.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const MIGRATION_DIR = fileURLToPath(new URL("../../../migration/", import.meta.url).href);
const MIGRATIONS = ["001_init.sql", "004_sessions_fallback.sql", "007_login_throttle.sql"];

class FakeStatement {
	private params: SQLInputValue[] = [];
	constructor(
		private db: DatabaseSync,
		private sql: string,
	) {}
	bind(...values: unknown[]) {
		this.params = values.map((v) => {
			if (v === undefined) throw new Error("D1_TYPE_ERROR: undefined bind value");
			return typeof v === "boolean" ? (v ? 1 : 0) : (v as SQLInputValue);
		});
		return this;
	}
	async first<T>(col?: string): Promise<T | null> {
		const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
		if (!row) return null;
		return (col ? row[col] : { ...row }) as T;
	}
	async all<T>() {
		const rows = this.db.prepare(this.sql).all(...this.params) as T[];
		return { results: rows.map((r) => ({ ...r })) as T[], success: true, meta: {} };
	}
	async run() {
		const r = this.db.prepare(this.sql).run(...this.params);
		return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
	}
}

export function fakeD1(migrations: string[] = MIGRATIONS) {
	const db = new DatabaseSync(":memory:");
	for (const f of migrations) db.exec(readFileSync(MIGRATION_DIR + f, "utf8"));
	const d1 = {
		prepare: (sql: string) => new FakeStatement(db, sql),
		batch: async (stmts: FakeStatement[]) => Promise.all(stmts.map((s) => s.run())),
		exec: async (sql: string) => db.exec(sql),
	};
	return { d1, raw: db };
}

export function fakeKV() {
	const store = new Map<string, string>();
	return {
		store,
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v),
		delete: async (k: string) => void store.delete(k),
		list: async ({ prefix = "" } = {}) => ({
			keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
			list_complete: true,
		}),
	};
}

export function fakeEnv() {
	const { d1, raw } = fakeD1();
	const kv = fakeKV();
	const env = { DB: d1, SESS: kv, TZ_OFFSET_HOURS: "7" } as unknown as Env;
	return { env, db: raw, kv };
}

/** Turso tiruan (antarmuka sama dgn getTurso(env)) dari migrasi Turso asli. */
export function fakeTurso() {
	return fakeD1(["turso_004_bot_news.sql", "turso_005_news_category.sql", "turso_007_news_extra_columns.sql"]);
}
