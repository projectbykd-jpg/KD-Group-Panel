// Port setMaintenanceInternal_ dari PanelCore.gs.
import { requireSession } from "./auth";
import { getMaintenance } from "../lib/db";
import { logActivity } from "../lib/activity";
import { tsNow } from "../lib/time";

export async function setMaintenance(env: Env, token: string, enabled: boolean, message: string) {
	const session = await requireSession(env, token, { admin: true, ignoreMaintenance: true });
	const msg = String(message || "Panel sedang dalam pemeliharaan.");
	// UPSERT (bukan UPDATE): bila barisnya belum ada (DB baru / baris terhapus), UPDATE tidak berefek dan mode maintenance
	// diam-diam tidak pernah aktif padahal respons "sukses".
	const up = (k: string, v: string) =>
		env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(k, v);
	await env.DB.batch([
		up("maintenance", enabled ? "TRUE" : "FALSE"),
		up("maintenance_message", msg),
		up("updated_by", session.username),
		up("updated_at", tsNow()),
	]);
	await logActivity(
		env,
		session.username,
		"MODE MAINTENANCE",
		enabled ? "Diaktifkan" : "Dinonaktifkan",
		"BERHASIL",
		msg,
	);
	return getMaintenance(env);
}
