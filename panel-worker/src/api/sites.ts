// Kelola tabel site_accounts (kredensial per website) dari menu Admin,
// supaya admin tidak perlu mengedit database langsung untuk menambah
// token / chat id / login Panel-Z / LinkTree.
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";

const FIELDS = [
	"display_name",
	"tg_token",
	"tg_chat_id",
	"tg_pred_token",
	"tg_pred_chat_id",
	"lt_email",
	"lt_pass",
	"pz_user",
	"pz_pass",
	"pz_user2",
	"pz_pass2",
	"pz_url",
] as const;

type Row = Record<string, string>;

function toClient(r: Row) {
	const o: Record<string, string> = { website: String(r.website || "").toUpperCase() };
	for (const f of FIELDS) o[f] = String(r[f] ?? "");
	return o;
}

export async function adminListSites(env: Env, token: string) {
	await requireSession(env, token, { admin: true });
	const res = await env.DB.prepare(`SELECT * FROM site_accounts ORDER BY website`).all<Row>();
	return { success: true, sites: (res.results ?? []).map(toClient) };
}

export async function adminSaveSite(env: Env, token: string, data: Record<string, unknown>) {
	const s = await requireSession(env, token, { admin: true });
	const website = String(data.website ?? "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
	if (!website) return { success: false, message: "Kode website wajib diisi (huruf/angka, mis. HUGO)." };
	const original = String(data.originalWebsite ?? "").trim().toUpperCase();

	const vals: Record<string, string> = {};
	for (const f of FIELDS) vals[f] = String(data[f] ?? "").trim();

	const cols = ["website", ...FIELDS];
	const placeholders = cols.map(() => "?").join(", ");
	const updates = FIELDS.map((f) => `${f} = excluded.${f}`).join(", ");
	const upsert = env.DB.prepare(
		`INSERT INTO site_accounts (${cols.join(", ")}) VALUES (${placeholders})
		 ON CONFLICT(website) DO UPDATE SET ${updates}`,
	).bind(website, ...FIELDS.map((f) => vals[f]));
	// Ganti kode website: simpan yang baru LALU hapus yang lama dalam SATU batch atomik (dulu hapus dulu -> bila simpan gagal,
	// token & kredensial website hilang).
	if (original && original !== website) {
		await env.DB.batch([upsert, env.DB.prepare(`DELETE FROM site_accounts WHERE website = ?`).bind(original)]);
	} else {
		await upsert.run();
	}

	await logActivity(
		env,
		s.username,
		"KELOLA WEBSITE",
		(original && original !== website ? `${original} → ${website}` : website) + " disimpan",
		"BERHASIL",
		"",
	);
	return { success: true, message: `Website ${website} tersimpan.` };
}

export async function adminDeleteSite(env: Env, token: string, website: string) {
	const s = await requireSession(env, token, { admin: true });
	const w = String(website ?? "").trim().toUpperCase();
	if (!w) return { success: false, message: "Kode website kosong." };
	const r = await env.DB.prepare(`DELETE FROM site_accounts WHERE website = ?`).bind(w).run();
	await logActivity(env, s.username, "KELOLA WEBSITE", `${w} dihapus`, "BERHASIL", "");
	return { success: true, message: `Website ${w} dihapus.`, changed: r.meta?.changes ?? 0 };
}
