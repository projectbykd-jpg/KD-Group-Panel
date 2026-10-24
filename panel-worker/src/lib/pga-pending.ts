// Menu "PGA PENDING" -- daftar withdraw berstatus "PGA Pending" di
// motionv2.com/withdraw-request, disinkron LIVE dari skrip Console yang jalan
// di tab Motion (pola sama seperti Lap Motion: server-side fetch langsung ke
// motionv2.com sering diblokir WAF / ditolak kalau tidak dipanggil dari
// halamannya sendiri, jadi datanya didorong DARI browser asli, bukan ditarik
// server -- lihat pgaPendingConsoleScript di Scripts.html).
//
// PERNAH disimpan di KV -- SALAH, jangan diulang: sync tiap 2 detik = ribuan
// tulisan/jam. Sekarang Turso dipakai sebagai snapshot per user, tetapi write
// tetap di-throttle supaya 17+ operator tidak menghasilkan write storm.
//
// "Hilang dalam hitungan detik" tetap terpenuhi lewat STALE_MS: kalau tab Motion
// berhenti mengirim snapshot, snapshot dianggap basi dan UI kembali kosong.
import { getTurso, tursoGeneration } from "./turso";

export interface PgaPendingRow {
	website: string;
	idTrans: string;
	tanggal: string;
	idUser: string;
	jumlah: number;
	statusText: string; // teks badge apa adanya (mis. "Grabbed PGA PGA Pending 000")
	pgaRefNo: string;
	vendorName: string;
}

export interface PgaPendingSnapshot {
	rows: PgaPendingRow[];
	updatedAt: number;
}

const MAX_ROWS = 200;
// Client masih boleh mengirim tiap 2 detik, tetapi DB tidak perlu ditulis
// tiap 2 detik. Lima detik cukup realtime untuk daftar pending dan jauh lebih
// aman ketika 17+ operator membuka panel bersamaan.
const MIN_WRITE_MS = 5000;
const HEARTBEAT_MS = 10000;
const STALE_MS = 20000;

function cleanRow(r: Record<string, unknown>): PgaPendingRow {
	return {
		website: String(r.website ?? "").slice(0, 60),
		idTrans: String(r.idTrans ?? "").slice(0, 60),
		tanggal: String(r.tanggal ?? "").slice(0, 40),
		idUser: String(r.idUser ?? "").slice(0, 60),
		jumlah: Number(r.jumlah) || 0,
		statusText: String(r.statusText ?? "").slice(0, 160),
		pgaRefNo: String(r.pgaRefNo ?? "").slice(0, 80),
		vendorName: String(r.vendorName ?? "").slice(0, 60),
	};
}

/** Generasi database Turso (tursoGeneration) tempat skema ini sudah disiapkan; -1 = belum. */
let ensuredGen = -1;
async function ensureTable(env: Env): Promise<void> {
	if (ensuredGen === tursoGeneration()) return;
	const gen = tursoGeneration();
	await getTurso(env)
		.prepare(
			`CREATE TABLE IF NOT EXISTS pga_pending_state (
				username TEXT PRIMARY KEY,
				rows_json TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)`,
		)
		.run();
	ensuredGen = gen;
}

// Per-isolate debounce. Cloudflare Workers may have multiple isolates, so this
// is intentionally only an extra protection; browser-side change detection
// removes most no-op writes before they reach the Worker.
const lastWriteAt = new Map<string, number>();
const lastPayloadByUser = new Map<string, string>();

export async function pgaPendingSave(env: Env, user: string, rows: Record<string, unknown>[]): Promise<PgaPendingSnapshot> {
	await ensureTable(env);
	const clean = rows.slice(0, MAX_ROWS).map(cleanRow);
	const now = Date.now();
	const payload = JSON.stringify(clean);
	const previousWrite = lastWriteAt.get(user) || 0;
	const previousPayload = lastPayloadByUser.get(user);

	// Tidak ada perubahan data dan heartbeat belum jatuh tempo -> tidak perlu
	// menulis Turso sama sekali.
	if (previousPayload === payload && now - previousWrite < HEARTBEAT_MS) {
		return { rows: clean, updatedAt: previousWrite || now };
	}

	// Perubahan boleh ditulis maksimal sekali per 5 detik per isolate.
	// Burst dari browser tetap terasa live tanpa write storm.
	if (now - previousWrite < MIN_WRITE_MS) {
		return { rows: clean, updatedAt: previousWrite || now };
	}

	const snap: PgaPendingSnapshot = { rows: clean, updatedAt: now };
	await getTurso(env)
		.prepare(
			`INSERT INTO pga_pending_state (username, rows_json, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(username) DO UPDATE SET rows_json = excluded.rows_json, updated_at = excluded.updated_at`,
		)
		.bind(user, payload, snap.updatedAt)
		.run();
	lastWriteAt.set(user, now);
	lastPayloadByUser.set(user, payload);
	return snap;
}

export async function pgaPendingLoad(env: Env, user: string): Promise<PgaPendingSnapshot> {
	await ensureTable(env);
	const row = await getTurso(env)
		.prepare(`SELECT rows_json, updated_at FROM pga_pending_state WHERE username = ?`)
		.bind(user)
		.first<{ rows_json: string; updated_at: number }>();
	if (!row) return { rows: [], updatedAt: 0 };
	const updatedAt = Number(row.updated_at) || 0;
	if (Date.now() - updatedAt > STALE_MS) return { rows: [], updatedAt: 0 };
	try {
		const rows = JSON.parse(row.rows_json);
		return { rows: Array.isArray(rows) ? rows : [], updatedAt };
	} catch {
		return { rows: [], updatedAt: 0 };
	}
}
