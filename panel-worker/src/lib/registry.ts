// Anti-duplikat kirim result — tabel sent_registry (port getRegistryEntry_ / saveOrUpdateSentRegistry_).
// Di Turso (bukan D1): setiap kirim result (operator manual/auto) baca+tulis
// tabel ini -> paling sering dipanggil di seluruh app, growth tak terbatas
// tanpa pruning. Dipindah spy tidak makan kuota rows-read/write harian D1.
import { tsNow } from "./time";
import { getTurso, tursoGeneration } from "./turso";

// Tabel ini tidak ada di migration/turso_*.sql lama (dulu hanya di D1 lewat
// 001_init.sql, lalu kodenya pindah ke Turso tanpa skemanya). Dibuat otomatis
// supaya instalasi/Turso baru tidak gagal "no such table: sent_registry" di
// fitur inti kirim result. No-op kalau sudah ada; dicek sekali per isolate.
/** Generasi database Turso (tursoGeneration) tempat skema ini sudah disiapkan; -1 = belum. */
let tableReadyGen = -1;
async function ensureTable(env: Env): Promise<void> {
	if (tableReadyGen === tursoGeneration()) return;
	const gen = tursoGeneration();
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
	tableReadyGen = gen;
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

// CERMIN D1: tabel yang sama (skema identik, 001_init.sql) ikut ditulis di D1 pada SETIAP kiriman. Alasannya: 17 Okt 2026
// Turso memblokir semua baca ("reads are blocked, do you need to upgrade your plan?" -- kuota baca bulanan paket gratis
// habis) dan Kirim Semua ikut lumpuh karena anti-duplikat tidak terbaca. Sekarang:
//  - baca: Turso + D1 digabung (tanda "sudah terkirim" diambil yang tertinggi); salah satu mati -> pakai yang hidup;
//    keduanya mati -> lempar (pengirim menolak kirim buta, seperti sebelumnya);
//  - tulis: ke keduanya; cukup SATU yang berhasil.
// Kiriman selama Turso mati tercatat di D1, jadi setelah Turso pulih teks yang sama tetap terblokir sebagai duplikat.
let d1Ready = false;
async function ensureD1Table(env: Env): Promise<void> {
	if (d1Ready) return;
	await env.DB.prepare(
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
	).run();
	d1Ready = true;
}

type RegRow = Record<string, unknown>;
const SELECT_ONE = `SELECT * FROM sent_registry WHERE hash = ? AND website = ?`;

function toEntry(w: string, rows: RegRow[]): RegEntry | null {
	if (!rows.length) return null;
	// yang terbaru jadi sumber nama/waktu; tanda terkirim digabung (hanya boleh naik)
	const latest = [...rows].sort((a, b) => String(b.sent_at ?? "").localeCompare(String(a.sent_at ?? "")))[0];
	return {
		hash: String(latest.hash ?? ""),
		website: w,
		username: String(latest.username ?? ""),
		market: String(latest.market ?? ""),
		telegram: rows.some((r) => !!Number(r.telegram)),
		linktree: rows.some((r) => !!Number(r.linktree)),
		panelz: rows.some((r) => !!Number(r.panelz)),
		sentAt: String(latest.sent_at ?? ""),
	};
}

export async function getRegistryEntry(
	env: Env,
	website: string,
	hash: string,
): Promise<RegEntry | null> {
	const w = String(website ?? "").trim().toUpperCase();
	const [t, d] = await Promise.allSettled([
		ensureTable(env).then(() => getTurso(env).prepare(SELECT_ONE).bind(hash, w).first<RegRow>()),
		ensureD1Table(env).then(() => env.DB.prepare(SELECT_ONE).bind(hash, w).first<RegRow>()),
	]);
	if (t.status === "rejected" && d.status === "rejected") throw t.reason;
	const rows = [t, d].flatMap((x) => (x.status === "fulfilled" && x.value ? [x.value] : []));
	return toEntry(w, rows);
}

const UPSERT = `INSERT INTO sent_registry
	   (hash, website, sent_at, username, market, telegram, linktree, panelz, content)
	 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	 ON CONFLICT(hash, website) DO UPDATE SET
	   sent_at = excluded.sent_at,
	   username = excluded.username,
	   market = excluded.market,
	   -- tanda "sudah terkirim" hanya boleh NAIK: kiriman kedua yang gagal (klik ganda / dua operator) dulu menimpa
	   -- telegram=1 jadi 0 sehingga teks yang sama tidak lagi diblokir sebagai duplikat.
	   telegram = MAX(sent_registry.telegram, excluded.telegram),
	   linktree = MAX(sent_registry.linktree, excluded.linktree),
	   panelz = MAX(sent_registry.panelz, excluded.panelz),
	   content = excluded.content`;

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
	const args = [hash, w, tsNow(), username || "", market || "-", merged.telegram ? 1 : 0, merged.linktree ? 1 : 0, merged.panelz ? 1 : 0, content || ""];
	const [t, d] = await Promise.allSettled([
		ensureTable(env).then(() => getTurso(env).prepare(UPSERT).bind(...args).run()),
		ensureD1Table(env).then(() => env.DB.prepare(UPSERT).bind(...args).run()),
	]);
	if (t.status === "rejected" && d.status === "rejected") throw t.reason;
}

export function resetRegistryGuards(): void {
	tableReadyGen = -1;
	d1Ready = false;
}
