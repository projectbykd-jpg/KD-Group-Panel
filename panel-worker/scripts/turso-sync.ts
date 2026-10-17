// Salin database Turso UTAMA -> CADANGAN (spare), atau sebaliknya saat failback. Dijalankan workflow GitHub
// "Turso sinkron cadangan" (.github/workflows/turso-sync.yml). Lihat rancangan lengkap di src/lib/turso.ts.
//
//   MODE=sync      (bawaan) utama -> spare. DILEWATI bila panel sedang memakai spare (kd_failover.active='spare'):
//                  menimpa spare dengan utama yang basi akan menghapus data selama gangguan.
//   MODE=failback  spare -> utama, lalu penanda kembali ke 'primary'. HANYA bila panel sedang memakai spare.
//
// Cara menyalin: per tabel, baris dibandingkan menurut rowid; hanya baris baru/berubah yang ditulis dan baris yang hilang di
// sumber dihapus di tujuan. rowid ikut disalin persis, jadi nomor id di kedua database SELALU sama (UPDATE ... WHERE id=?
// setelah pindah database mengenai baris yang benar). Tabel/kolom yang belum ada di tujuan dibuat; tidak pernah DROP tabel.
//
// Env: TURSO_URL, TURSO_TOKEN (utama), TURSO_SPARE_URL, TURSO_SPARE_TOKEN (cadangan), MODE, TURSO_SYNC_EXCLUDE
// (tabel dipisah koma yang tidak disalin; bawaan invest_raw = data mentah sementara scan Invest).
import { createClient, type Client, type InValue } from "@libsql/client";

const MARKER = "kd_failover";
const scrub = (v: string | undefined) => String(v ?? "").replace(/^﻿/, "").trim();
const wibNow = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface SyncReport {
	tables: { name: string; written: number; deleted: number; total: number }[];
	skipped?: string;
}

async function marker(db: Client): Promise<Record<string, string>> {
	try {
		const rs = await db.execute(`SELECT k, v FROM ${MARKER}`);
		return Object.fromEntries(rs.rows.map((r) => [String(r.k), String(r.v ?? "")]));
	} catch {
		return {};
	}
}
async function setMarker(db: Client, entries: Record<string, string>): Promise<void> {
	const now = wibNow();
	await db.batch(
		[
			`CREATE TABLE IF NOT EXISTS ${MARKER} (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '', at TEXT NOT NULL DEFAULT '')`,
			...Object.entries(entries).map(([k, v]) => ({ sql: `INSERT OR REPLACE INTO ${MARKER} (k, v, at) VALUES (?, ?, ?)`, args: [k, v, now] })),
		],
		"write",
	);
}

interface ColInfo {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
}
async function columns(db: Client, table: string): Promise<ColInfo[]> {
	const rs = await db.execute(`SELECT name, type, "notnull", dflt_value FROM pragma_table_info(${`'${table.replace(/'/g, "''")}'`})`);
	return rs.rows.map((r) => ({ name: String(r.name), type: String(r.type ?? ""), notnull: Number(r.notnull ?? 0), dflt_value: r.dflt_value == null ? null : String(r.dflt_value) }));
}

/** Pastikan tabel + kolom + index sumber ada di tujuan (tanpa pernah menghapus apa pun di tujuan). */
async function ensureSchema(src: Client, dst: Client, table: string, createSql: string, indexSql: string[]): Promise<void> {
	const exists = (await dst.execute({ sql: `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, args: [table] })).rows.length > 0;
	if (!exists) await dst.execute(createSql.replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?/i, "CREATE TABLE IF NOT EXISTS "));
	else {
		const have = new Set((await columns(dst, table)).map((c) => c.name));
		for (const c of await columns(src, table)) {
			if (have.has(c.name)) continue;
			// ADD COLUMN tidak boleh NOT NULL tanpa DEFAULT -> NOT NULL hanya bila ada default
			const def = `${q(c.name)} ${c.type}${c.dflt_value != null ? ` ${c.notnull ? "NOT NULL " : ""}DEFAULT ${c.dflt_value}` : ""}`;
			await dst.execute(`ALTER TABLE ${q(table)} ADD COLUMN ${def}`);
		}
	}
	for (const ix of indexSql) await dst.execute(ix.replace(/^CREATE (UNIQUE )?INDEX\s+(IF NOT EXISTS\s+)?/i, (_m, u) => `CREATE ${u || ""}INDEX IF NOT EXISTS `)).catch(() => {});
}

const rowKey = (vals: unknown[]) => JSON.stringify(vals, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)) : v));

/** Samakan isi `table` di tujuan dengan sumber (menurut rowid). */
async function syncTable(src: Client, dst: Client, table: string): Promise<{ written: number; deleted: number; total: number }> {
	const cols = (await columns(src, table)).map((c) => c.name);
	const sel = `SELECT rowid AS "__rid", ${cols.map(q).join(", ")} FROM ${q(table)}`;
	const [a, b] = await Promise.all([src.execute(sel), dst.execute(sel)]);
	const there = new Map<string, string>();
	for (const r of b.rows) there.set(String(r.__rid), rowKey(cols.map((c) => r[c])));
	const ins = `INSERT OR REPLACE INTO ${q(table)} (rowid, ${cols.map(q).join(", ")}) VALUES (${["?", ...cols.map(() => "?")].join(", ")})`;
	const writes: { sql: string; args: InValue[] }[] = [];
	const seen = new Set<string>();
	for (const r of a.rows) {
		const rid = String(r.__rid);
		seen.add(rid);
		const vals = cols.map((c) => r[c] as InValue);
		if (there.get(rid) !== rowKey(vals)) writes.push({ sql: ins, args: [r.__rid as InValue, ...vals] });
	}
	const gone = [...there.keys()].filter((rid) => !seen.has(rid));
	for (let i = 0; i < writes.length; i += 100) await dst.batch(writes.slice(i, i + 100), "write");
	for (let i = 0; i < gone.length; i += 200) {
		const part = gone.slice(i, i + 200);
		await dst.execute({ sql: `DELETE FROM ${q(table)} WHERE rowid IN (${part.map(() => "?").join(",")})`, args: part.map(Number) });
	}
	return { written: writes.length, deleted: gone.length, total: a.rows.length };
}

export async function copyDatabase(src: Client, dst: Client, exclude: string[], guard?: () => Promise<boolean>): Promise<SyncReport["tables"]> {
	const master = await src.execute(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`);
	const tables = master.rows.filter((r) => r.type === "table" && r.name !== MARKER && !exclude.includes(String(r.name)));
	const out: SyncReport["tables"] = [];
	for (const t of tables) {
		// panel bisa pindah ke cadangan DI TENGAH sinkron (utama kena kuota): berhenti, jangan timpa tulisan baru di cadangan
		if (guard && (await guard())) throw new Error("Panel pindah ke database cadangan di tengah sinkron — dihentikan supaya tulisan baru di cadangan tidak tertimpa.");
		const name = String(t.name);
		const idx = master.rows.filter((r) => r.type === "index" && r.tbl_name === name).map((r) => String(r.sql));
		await ensureSchema(src, dst, name, String(t.sql), idx);
		out.push({ name, ...(await syncTable(src, dst, name)) });
	}
	return out;
}

export async function runSync(opts: { primary: Client; spare: Client; mode: "sync" | "failback"; exclude: string[] }): Promise<SyncReport> {
	const m = await marker(opts.spare);
	if (opts.mode === "sync") {
		if (m.active === "spare") return { tables: [], skipped: "Panel sedang memakai database CADANGAN — sinkron utama->cadangan dilewati (akan menghapus data selama gangguan). Jalankan mode failback setelah utama pulih." };
		const tables = await copyDatabase(opts.primary, opts.spare, opts.exclude, async () => (await marker(opts.spare)).active === "spare");
		await setMarker(opts.spare, { synced_at: wibNow() }); // penanda 'active' TIDAK disentuh: hanya panel/failback yang mengubahnya
		return { tables };
	}
	if (m.active !== "spare") return { tables: [], skipped: "Panel TIDAK sedang memakai database cadangan — failback tidak diperlukan (dan akan menimpa utama dengan salinan lama)." };
	const tables = await copyDatabase(opts.spare, opts.primary, opts.exclude);
	await setMarker(opts.spare, { active: "primary", synced_at: wibNow(), failback_at: wibNow() });
	return { tables };
}

async function main(): Promise<void> {
	const p = { url: scrub(process.env.TURSO_URL), authToken: scrub(process.env.TURSO_TOKEN) };
	const s = { url: scrub(process.env.TURSO_SPARE_URL), authToken: scrub(process.env.TURSO_SPARE_TOKEN) };
	if (!s.url || !s.authToken) {
		console.log("::notice::TURSO_SPARE_URL / TURSO_SPARE_TOKEN belum diisi (Settings > Secrets and variables > Actions) — tidak ada yang disalin.");
		return;
	}
	if (!p.url || !p.authToken) throw new Error("TURSO_URL / TURSO_TOKEN (utama) belum diisi sebagai GitHub secret.");
	const mode = String(process.env.MODE || "sync").trim().toLowerCase() === "failback" ? "failback" : "sync";
	const exclude = String(process.env.TURSO_SYNC_EXCLUDE ?? "invest_raw").split(",").map((x) => x.trim()).filter(Boolean);
	const t0 = Date.now();
	const r = await runSync({ primary: createClient(p), spare: createClient(s), mode, exclude });
	if (r.skipped) {
		console.log("::notice::" + r.skipped);
		return;
	}
	for (const t of r.tables) console.log(`${t.name.padEnd(28)} ${String(t.total).padStart(7)} baris  ditulis ${t.written}  dihapus ${t.deleted}`);
	console.log(`=== ${mode === "sync" ? "utama -> cadangan" : "FAILBACK cadangan -> utama"} selesai dalam ${Math.round((Date.now() - t0) / 1000)} dtk ===`);
}

if (process.argv[1] && /turso-sync\.ts$/.test(process.argv[1])) {
	main().catch((e) => {
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`::error::${/BLOCKED|reads are blocked|upgrade your plan/.test(msg) ? "Turso UTAMA sedang diblokir (kuota habis) — belum bisa disalin. " : ""}${msg}`);
		process.exit(1);
	});
}
