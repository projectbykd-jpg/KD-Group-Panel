// Endpoint publik menu "WD LISTED" (lihat src/lib/wd-listed.ts untuk arsitektur).
import { requireSession } from "./auth";
import { wdListedAdd, wdListedCheckStatus, wdListedDelete, wdListedList, WdListedInput } from "../lib/wd-listed";

function toInput(r: Record<string, unknown>): WdListedInput {
	return {
		website: String(r.website ?? ""),
		idTrans: String(r.idTrans ?? ""),
		tanggal: String(r.tanggal ?? ""),
		idUser: String(r.idUser ?? ""),
		jumlah: Number(r.jumlah) || 0,
		statusText: String(r.statusText ?? ""),
		pgaRefNo: String(r.pgaRefNo ?? ""),
		vendorName: String(r.vendorName ?? ""),
	};
}

export async function wdListedSync(env: Env, token: string, rows: unknown) {
	const s = await requireSession(env, token, { ignoreMaintenance: true, menu: "pga-pending" });
	const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
	const added = await wdListedAdd(env, s.username, list.map(toInput));
	return { success: true, added };
}

export async function wdListedGetList(env: Env, token: string) {
	const s = await requireSession(env, token, { ignoreMaintenance: true, menu: "pga-pending" });
	const rows = await wdListedList(env, s.profile.websites || []);
	return { success: true, rows };
}

export async function wdListedCheck(env: Env, token: string, id: number) {
	const s = await requireSession(env, token, { ignoreMaintenance: true, menu: "pga-pending" });
	const row = await wdListedCheckStatus(env, Number(id), s.profile.websites || []);
	return { success: true, row };
}

export async function wdListedRemove(env: Env, token: string, id: number) {
	const s = await requireSession(env, token, { ignoreMaintenance: true, menu: "pga-pending" });
	await wdListedDelete(env, Number(id), s.profile.websites || []);
	return { success: true };
}
