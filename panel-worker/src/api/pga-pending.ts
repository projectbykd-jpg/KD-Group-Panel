// Endpoint publik menu "PGA PENDING" (lihat src/lib/pga-pending.ts untuk arsitektur
// penyimpanannya). Dua aksi saja: skrip Console di tab Motion nge-POST snapshot
// terbaru tiap 5 detik (pgaPendingSync), panel poll GET-nya di interval yang sama
// (pgaPendingStatus) buat menggambar ulang tabel.
import { requireSession } from "./auth";
import { pgaPendingLoad, pgaPendingSave } from "../lib/pga-pending";

export async function pgaPendingSync(env: Env, token: string, rows: unknown) {
	const s = await requireSession(env, token, { ignoreMaintenance: true, menu: "pga-pending" });
	const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
	const snap = await pgaPendingSave(env, s.username, list);
	return { success: true, count: snap.rows.length };
}

export async function pgaPendingStatus(env: Env, token: string) {
	const s = await requireSession(env, token, { ignoreMaintenance: true, menu: "pga-pending" });
	const snap = await pgaPendingLoad(env, s.username);
	return { success: true, rows: snap.rows, updatedAt: snap.updatedAt };
}
