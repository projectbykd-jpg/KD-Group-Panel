// INTEGRASI yang bisa diatur ADMIN dari Admin > Integrasi: token & repo GitHub Actions, endpoint LinkTree, URL web berita,
// URL struk, domain admin yang diizinkan. Dulu semua ini tertanam di kode / variabel Cloudflare / file di GitHub.
//
// Prioritas nilai: diisi admin (D1 `settings`, key "int_*") -> variabel/secret Cloudflare (bila ada) -> bawaan di kode.
// Jadi tanpa mengisi apa pun, perilaku TIDAK berubah. Rahasia (token, API key) disimpan sama seperti key AI di panel
// (D1), TIDAK PERNAH dikirim balik ke browser (hanya 4 karakter terakhir), dan hanya ADMIN yang bisa mengubahnya.

export type IntDef = {
	key: string;
	group: string;
	label: string;
	hint: string;
	secret?: boolean;
	/** Nilai bawaan di kode (dipakai bila admin belum mengisi dan tidak ada variabel Cloudflare). */
	def: string;
	/** Nilai dari variabel/secret Cloudflare, bila ada. */
	fromEnv?: (env: Env) => string | undefined;
	/** Kembalikan pesan galat, atau "" bila valid. Menerima nilai yang sudah di-trim. */
	check: (v: string) => string;
};

const REPO = (v: string) => (/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(v) ? "" : "Format repo: pemilik/nama-repo (mis. projectbykd-jpg/KD-scraper).");
const HTTPS = (v: string) => (/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[^\s]*)?$/.test(v) && v.length <= 300 ? "" : "Harus diawali https:// dan berupa alamat yang valid.");
const HTTP_OR_S = (v: string) => (/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[^\s]*)?$/.test(v) && v.length <= 300 ? "" : "Harus diawali http:// atau https:// dan berupa alamat yang valid.");
const DOMAIN = (v: string) => (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v) && v.length <= 100 ? "" : "Isi nama domain saja (mis. suksesbogil.com), tanpa https:// dan tanpa garis miring.");
const TOKEN = (v: string) => (v.length >= 20 && v.length <= 300 && !/\s/.test(v) ? "" : "Token 20-300 karakter tanpa spasi.");
const TG_TOKEN = (v: string) => (/^\d{5,15}:[A-Za-z0-9_-]{20,60}$/.test(v) ? "" : "Format token bot Telegram: 123456789:AAxxxxxxxx (dari @BotFather).");
const TG_CHAT = (v: string) => (v === "" || /^(-?\d{5,20}|@[A-Za-z0-9_]{5,32})$/.test(v) ? "" : "Chat ID berupa angka (mis. 123456789 atau -1001234567890) atau @namakanal.");
const KEY = (v: string) => (v.length >= 8 && v.length <= 200 && !/\s/.test(v) ? "" : "Kunci 8-200 karakter tanpa spasi.");

export const INT_DEFS: IntDef[] = [
	{ key: "int_gh_token", group: "GitHub Actions", label: "Token GitHub", secret: true, def: "", fromEnv: (e) => e.GH_TOKEN,
		hint: "Fine-grained token dengan izin Actions: Read and write. Harus mencakup SEMUA repo di bawah (scraper, Bot News, Invest). Tidak pernah ditampilkan ulang.", check: TOKEN },
	{ key: "int_gh_repo", group: "GitHub Actions", label: "Repo scraper Laporan Harian", def: "projectbykd-jpg/KD-scraper", fromEnv: (e) => e.GH_REPO,
		hint: "Repo yang berisi workflow scrape.yml (tombol Tarik Data di Lap Admin).", check: REPO },
	{ key: "int_news_turbo_repo", group: "GitHub Actions", label: "Repo workflow Bot News turbo", def: "projectbykd-jpg/KD-Group-Panel",
		hint: "Repo yang berisi news-turbo.yml.", check: REPO },
	{ key: "int_invest_turbo_repo", group: "GitHub Actions", label: "Repo workflow Invest turbo", def: "projectbykd-jpg/KD-Group-Panel",
		hint: "Repo yang berisi invest-turbo.yml.", check: REPO },
	{ key: "int_public_url", group: "Alamat Panel", label: "Alamat publik panel", def: "https://panel-worker.projectbykd.workers.dev", fromEnv: (e) => e.PUBLIC_URL,
		hint: "Alamat yang dipanggil balik oleh scraper GitHub. Ubah hanya bila panel pindah domain.", check: HTTPS },
	{ key: "int_linktree_login_url", group: "LinkTree (kirim hasil)", label: "URL login LinkTree", def: "http://ec2-13-250-131-148.ap-southeast-1.compute.amazonaws.com:8069/index",
		hint: "Endpoint login sistem LinkTree.", check: HTTP_OR_S },
	{ key: "int_linktree_post_url", group: "LinkTree (kirim hasil)", label: "URL kirim notifikasi LinkTree", def: "http://ec2-13-250-131-148.ap-southeast-1.compute.amazonaws.com:8069/notif_send_post",
		hint: "Endpoint pengiriman notifikasi hasil.", check: HTTP_OR_S },
	{ key: "int_linktree_api_key", group: "LinkTree (kirim hasil)", label: "API key LinkTree", secret: true, def: "bbd53ebb-ba2b-11ec-9377-f2937b475656",
		hint: "Kunci API pengiriman LinkTree. Bawaan lama masih tertanam di kode repo -- sebaiknya isi kunci baru di sini.", check: KEY },
	{ key: "int_alert_tg_token", group: "Notifikasi Galat (Telegram)", label: "Token bot Telegram notifikasi", secret: true, def: "",
		hint: "Bot Telegram (dari @BotFather) yang mengirim pemberitahuan saat ada galat baru di Admin > Error & Bug. Kosong = tidak ada notifikasi. Tidak pernah ditampilkan ulang.", check: TG_TOKEN },
	{ key: "int_alert_tg_chat", group: "Notifikasi Galat (Telegram)", label: "Chat ID tujuan notifikasi", def: "",
		hint: "Chat ID admin/grup yang menerima notifikasi (kirim pesan ke bot dulu, lalu cek lewat @userinfobot / getUpdates). Pakai tombol TES TELEGRAM di Admin > Error & Bug untuk memastikan.", check: TG_CHAT },
	{ key: "int_news_site_url", group: "Web Berita & Struk", label: "Alamat web berita sendiri", def: "https://lokalstore88.online",
		hint: "Dipakai untuk backlink, caption Facebook, dan alamat artikel di sitemap. Tanpa garis miring di akhir.", check: HTTPS },
	{ key: "int_struk_base_url", group: "Web Berita & Struk", label: "Alamat dasar struk disbursement", def: "https://dbb2b.q2checkout.com/struk/disbursement/",
		hint: "Dipakai WD Listed untuk mengambil struk. Harus berakhir dengan garis miring.", check: (v) => HTTPS(v) || (v.endsWith("/") ? "" : "Harus berakhir dengan garis miring (/).") },
	{ key: "int_admin_domain", group: "Keamanan Auto Input", label: "Domain admin yang diizinkan", def: "suksesbogil.com",
		hint: "Auto Input hanya boleh mengakses domain ini dan sub-domainnya (pagar anti penyalahgunaan). Ubah dengan hati-hati.", check: DOMAIN },
];

const BY_KEY = new Map(INT_DEFS.map((d) => [d.key, d]));
const TTL_MS = 15_000;
let stored = new Map<string, string>();
let loadedAt = 0;
let inflight: Promise<void> | null = null;

export function resetIntegrationsCache(): void {
	loadedAt = 0;
}

export async function loadIntegrations(env: Env): Promise<void> {
	if (Date.now() - loadedAt < TTL_MS) return;
	if (inflight) return inflight;
	inflight = (async () => {
		try {
			const rows = await env.DB.prepare(`SELECT key, value FROM settings WHERE key LIKE 'int\\_%' ESCAPE '\\'`).all<{ key: string; value: string }>();
			const m = new Map<string, string>();
			for (const r of rows.results ?? []) {
				const d = BY_KEY.get(r.key);
				const v = String(r.value ?? "").trim();
				if (d && v && !d.check(v)) m.set(r.key, v); // nilai tersimpan yang tak valid diabaikan -> bawaan
			}
			stored = m;
		} catch {
			/* tabel settings belum siap -> nilai yang sedang berlaku */
		} finally {
			loadedAt = Date.now();
			inflight = null;
		}
	})();
	return inflight;
}

/** Nilai efektif: diisi admin -> variabel/secret Cloudflare -> bawaan kode. (Sinkron; data dimuat di awal tiap request.) */
export function intVal(key: string, env?: Env): string {
	const d = BY_KEY.get(key);
	if (!d) throw new Error("Integrasi tidak dikenal: " + key);
	const s = stored.get(key);
	if (s) return s;
	const e = env && d.fromEnv ? String(d.fromEnv(env) ?? "").trim() : "";
	return e || d.def;
}
export const ghToken = (env: Env) => intVal("int_gh_token", env);
export const ghRepo = (env: Env) => intVal("int_gh_repo", env);
export const newsTurboRepo = (env: Env) => intVal("int_news_turbo_repo", env);
export const investTurboRepo = (env: Env) => intVal("int_invest_turbo_repo", env);
export const publicUrl = (env: Env) => intVal("int_public_url", env).replace(/\/+$/, "");
export const newsSiteUrl = () => intVal("int_news_site_url").replace(/\/+$/, "");
export const strukBaseUrl = () => intVal("int_struk_base_url");
export const adminDomain = () => intVal("int_admin_domain").toLowerCase();
export const alertTgCfg = () => ({ token: intVal("int_alert_tg_token"), chatId: intVal("int_alert_tg_chat") });
export const linktreeCfg = () => ({ loginUrl: intVal("int_linktree_login_url"), postUrl: intVal("int_linktree_post_url"), apiKey: intVal("int_linktree_api_key") });

export type IntView = { key: string; group: string; label: string; hint: string; secret: boolean; value: string; mask: string; source: "admin" | "env" | "bawaan"; def: string };

/** Tampilan untuk admin. Rahasia TIDAK dikirim; hanya 4 karakter terakhir. */
export async function listIntegrations(env: Env): Promise<IntView[]> {
	const rows = await env.DB.prepare(`SELECT key, value FROM settings WHERE key LIKE 'int\\_%' ESCAPE '\\'`).all<{ key: string; value: string }>();
	const st = new Map((rows.results ?? []).map((r) => [r.key, String(r.value ?? "").trim()]));
	return INT_DEFS.map((d) => {
		const s = st.get(d.key) && !d.check(st.get(d.key)!) ? st.get(d.key)! : "";
		const e = d.fromEnv ? String(d.fromEnv(env) ?? "").trim() : "";
		const eff = s || e || d.def;
		const source: IntView["source"] = s ? "admin" : e ? "env" : "bawaan";
		return {
			key: d.key, group: d.group, label: d.label, hint: d.hint, secret: !!d.secret,
			value: d.secret ? "" : eff,
			mask: d.secret && eff ? "••••" + eff.slice(-4) : "",
			source, def: d.secret ? "" : d.def,
		};
	});
}

/** values[key]: string baru = simpan; null = kembalikan ke bawaan; secret kosong ("") = biarkan seperti sekarang. */
export async function saveIntegrations(env: Env, values: Record<string, unknown>): Promise<{ ok: true; changed: string[] } | { ok: false; error: string }> {
	const ops: { key: string; v: string | null }[] = [];
	for (const d of INT_DEFS) {
		if (!(d.key in values)) continue;
		const raw = values[d.key];
		if (raw === null) { ops.push({ key: d.key, v: null }); continue; }
		const v = String(raw ?? "").trim();
		if (!v) {
			if (d.secret) continue; // kolom rahasia dikosongkan = tidak diubah
			ops.push({ key: d.key, v: null }); // kolom biasa dikosongkan = kembali ke bawaan
			continue;
		}
		const err = d.check(v);
		if (err) return { ok: false, error: `${d.label}: ${err}` };
		ops.push({ key: d.key, v });
	}
	for (const o of ops) {
		if (o.v === null) await env.DB.prepare(`DELETE FROM settings WHERE key = ?`).bind(o.key).run();
		else await env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(o.key, o.v).run();
	}
	resetIntegrationsCache();
	await loadIntegrations(env);
	return { ok: true, changed: ops.map((o) => `${BY_KEY.get(o.key)!.label}${o.v === null ? " (bawaan)" : ""}`) };
}
