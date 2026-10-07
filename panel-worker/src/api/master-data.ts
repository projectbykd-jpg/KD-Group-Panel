// Admin > Data Master: ambil / simpan / kembalikan-ke-bawaan data master (lihat lib/master-data.ts).
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import { listMaster, saveMaster, getMasterDef, loadMasterData } from "../lib/master-data";
import { SHIO_ORDER, SHIO_CONFIG } from "../lib/parser";

export async function adminGetMasterData(env: Env, token: string) {
	await requireSession(env, token, { admin: true });
	return { success: true, items: await listMaster(env) };
}

/** value === null -> kembalikan ke bawaan. Validasi ketat di server; nilai tak valid ditolak dengan pesan jelas. */
export async function adminSaveMasterData(env: Env, token: string, key: string, value: unknown) {
	const s = await requireSession(env, token, { admin: true });
	const def = getMasterDef(String(key));
	if (!def) return { success: false, message: "Data master tidak dikenal." };
	const r = await saveMaster(env, def.key, value === undefined ? null : value);
	if (!r.ok) return { success: false, message: r.error };
	await logActivity(env, s.username, "DATA MASTER", def.title + (r.reset ? " dikembalikan ke bawaan" : " disimpan"), "BERHASIL", "");
	return { success: true, message: r.reset ? "Dikembalikan ke bawaan." : "Tersimpan.", items: await listMaster(env) };
}

/** Peta shio yang berlaku (untuk pratinjau di browser agar sama dengan server). Semua role boleh membaca. */
export async function shioMapGet(env: Env, token: string) {
	await requireSession(env, token, { allowBot: true, ignoreMaintenance: true });
	await loadMasterData(env);
	return { success: true, names: SHIO_ORDER.slice(1), zero: SHIO_CONFIG.zero };
}
