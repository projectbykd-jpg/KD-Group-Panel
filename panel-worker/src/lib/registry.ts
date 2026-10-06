// Anti-duplikat kirim result — tabel sent_registry (port getRegistryEntry_ / saveOrUpdateSentRegistry_).
// Di Turso (bukan D1): setiap kirim result (operator manual/auto) baca+tulis
// tabel ini -> paling sering dipanggil di seluruh app, growth tak terbatas
// tanpa pruning. Dipindah spy tidak makan kuota rows-read/write harian D1.
import { tsNow } from "./time";
import { getTurso } from "./turso";

// Tabel ini tidak ada di migration/turso_*.sql lama (dulu hanya di D1 lewat
// 001_init.sql, lalu kodenya pindah ke Turso tanpa skemanya). Dibuat otomatis
// supaya instalasi/Turso baru tidak gagal "no such table: sent_registry" di
// fitur inti kirim result. No-op kalau sudah ada; dicek sekali per isolate.
let tableReady = false;
async function ensureTable(env: Env): Promise<void> {
	if (tableReady) return;
	const db = getTurso(env);
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS sent_registry (
				hash     TEXT NOT NULL,
				website  TEXT NOT NULL,
				sent_at  TEXT NOT NULL DEFAULT '',
				username TEXT NOT NULL DEFAULT '',
				market   TEXT NOT NULL DEFAULT '',
				telegram INTEGER NOT NULL DEFAULT 0,
				linktree INTEGER NOT NULL DEFAULT 0,
				panelz   INTEGER NOT NULL DEFAULT 0,
				content  TEXT NOT NULL DEFAULT '',
				PRIMARY KEY (hash, website)
			)`,
		)
		.run();
	await db.prepare(`CREATE INDEX IF NOT EXISTS ix_sent_registry_sent_at ON sent_registry(sent_at)`).run();
	tableReady = true;
}

export interface RegEntry {
	hash: string;
	website: string;
	username: string;
	market: string;
	telegram: boolean;
	linktree: boolean;
	panelz: boolean;
	sentAt: string;
}

export async function getRegistryEntry(
	env: Env,
	website: string,
	hash: string,
): Promise<RegEntry | null> {
	const w = String(website ?? "").trim().toUpperCase();
	await ensureTable(env);
	const r = await getTurso(env).prepare(`SELECT * FROM sent_registry WHERE hash = ? AND website = ?`)
		.bind(hash, w)
		.first<Record<string, unknown>>();
	if (!r) return null;
	return {
		hash: String(r.hash ?? ""),
		website: w,
		username: String(r.username ?? ""),
		market: String(r.market ?? ""),
		telegram: !!r.telegram,
		linktree: !!r.linktree,
		panelz: !!r.panelz,
		sentAt: String(r.sent_at ?? ""),
	};
}

export async function upsertRegistry(
	env: Env,
	hash: string,
	website: string,
	username: string,
	market: string,
	merged: { telegram: boolean; linktree: boolean; panelz: boolean },
	content: string,
): Promise<void> {
	const w = String(website ?? "").trim().toUpperCase();
	await ensureTable(env);
	await getTurso(env).prepare(
		`INSERT INTO sent_registry
		   (hash, website, sent_at, username, market, telegram, linktree, panelz, content)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(hash, website) DO UPDATE SET
		   sent_at = excluded.sent_at,
		   username = excluded.username,
		   market = excluded.market,
		   telegram = excluded.telegram,
		   linktree = excluded.linktree,
		   panelz = excluded.panelz,
		   content = excluded.content`,
	)
		.bind(
			hash,
			w,
			tsNow(),
			username || "",
			market || "-",
			merged.telegram ? 1 : 0,
			merged.linktree ? 1 : 0,
			merged.panelz ? 1 : 0,
			content || "",
		)
		.run();
}
