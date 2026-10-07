// Admin > Data Master: ambil / simpan / kembalikan-ke-bawaan data master (lihat lib/master-data.ts).
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import { listMaster, saveMaster, getMasterDef, loadMasterData } from "../lib/master-data";
import { SHIO_ORDER, SHIO_CONFIG } from "../lib/parser";
import { listIntegrations, saveIntegrations, ghToken, ghRepo, newsTurboRepo, investTurboRepo, loadIntegrations } from "../lib/integrations";

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

// ---------------------------------------------------------------------------
// Admin > Integrasi (token/repo GitHub, LinkTree, URL) -- lihat lib/integrations.ts
// ---------------------------------------------------------------------------

export async function adminGetIntegrations(env: Env, token: string) {
	await requireSession(env, token, { admin: true });
	await loadIntegrations(env);
	return { success: true, items: await listIntegrations(env) };
}

/** values[key]: teks baru = simpan; null = bawaan; kolom rahasia kosong = tidak diubah. Rahasia tidak pernah dikembalikan. */
export async function adminSaveIntegrations(env: Env, token: string, values: unknown) {
	const s = await requireSession(env, token, { admin: true });
	const v = (values && typeof values === "object" ? values : {}) as Record<string, unknown>;
	const r = await saveIntegrations(env, v);
	if (!r.ok) return { success: false, message: r.error };
	// Catat NAMA yang diubah saja -- tidak pernah nilainya (bisa rahasia).
	await logActivity(env, s.username, "INTEGRASI", r.changed.length ? r.changed.join(", ") : "Tidak ada perubahan", "BERHASIL", "");
	return { success: true, message: r.changed.length ? "Tersimpan." : "Tidak ada perubahan.", items: await listIntegrations(env) };
}

type GhCheck = { label: string; repo: string; workflow: string; ok: boolean; status: number; message: string };
async function ghWorkflowCheck(tok: string, label: string, repo: string, workflow: string): Promise<GhCheck> {
	try {
		const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}`, {
			headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "User-Agent": "daygroup-panel", "X-GitHub-Api-Version": "2022-11-28" },
		});
		if (r.ok) return { label, repo, workflow, ok: true, status: r.status, message: "Tersambung — workflow ditemukan." };
		const hint =
			r.status === 401 ? "Token salah atau kedaluwarsa. Buat token baru lalu isi lagi di sini."
			: r.status === 403 ? "Token tidak punya izin: centang repo ini di token dan atur Actions = Read and write."
			: r.status === 404 ? "Repo atau file workflow tidak ditemukan (cek nama repo), atau token tidak mencakup repo ini."
			: "Gangguan di sisi GitHub, coba lagi sebentar.";
		return { label, repo, workflow, ok: false, status: r.status, message: hint };
	} catch (e) {
		return { label, repo, workflow, ok: false, status: 0, message: "Gagal menghubungi GitHub: " + (e instanceof Error ? e.message : String(e)).slice(0, 80) };
	}
}

/** Tes semua jalur GitHub Actions dengan token yang SEDANG berlaku (tanpa mengubah apa pun, hanya membaca). */
export async function adminTestIntegrations(env: Env, token: string) {
	await requireSession(env, token, { admin: true });
	await loadIntegrations(env);
	const tok = ghToken(env);
	if (!tok) return { success: false, message: "Token GitHub belum diisi." };
	const checks = await Promise.all([
		ghWorkflowCheck(tok, "Laporan Harian (Tarik Data)", ghRepo(env), "scrape.yml"),
		ghWorkflowCheck(tok, "Bot News turbo", newsTurboRepo(env), "news-turbo.yml"),
		ghWorkflowCheck(tok, "Invest turbo", investTurboRepo(env), "invest-turbo.yml"),
	]);
	return { success: true, allOk: checks.every((c) => c.ok), checks };
}
