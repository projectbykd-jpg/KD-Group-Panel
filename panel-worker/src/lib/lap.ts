// Menu "Laporan Harian" — port PANEL AUTO (Code.cpp) ke Worker.
// Bagian ini: kredensial per operator + snapshot hasil + helper umum.
// Tabel lap_* ada di Turso (bukan D1) -> pakai getTurso(env).
import { tsNow } from "./time";
import { getTurso, tursoGeneration } from "./turso";
import { cookieHeader, defaultAdminBase, getSessions, parsePhpSessId, sessionHint, siteBrand } from "./auto-input";

export interface LapCreds {
	linkAdmin: string;
	cookieAdmin: string;
	linkMotion: string;
	tokenMotion: string;
	vendorIdMotion: string;
	linkMozart: string;
	cookieMozart: string;
	mozartAccounts: string;
}

const EMPTY: LapCreds = {
	linkAdmin: "",
	cookieAdmin: "",
	linkMotion: "",
	tokenMotion: "",
	vendorIdMotion: "",
	linkMozart: "",
	cookieMozart: "",
	mozartAccounts: "",
};

// vendor_id_motion ditambahkan belakangan -- migrasi malas (lazy), sama pola
// dengan ensureNewsCategoryColumns di bot-news.ts: dicoba sekali per cold-start
// isolate, aman dipanggil berkali² (duplicate column diabaikan).
// KENAPA field ini perlu: endpoint deposit motionv2.com (/api/deposit/list/pga)
// WAJIB disertai "vendor_id" di body request -- tanpa itu request HANG/timeout
// total (kemungkinan server coba scan tanpa index vendor), BUKAN dibalas error
// jelas. Ketahuan dari membandingkan body request skrip vs body request ASLI
// yang situsnya sendiri kirim (lihat Network tab): asli = {page,start,limit,
// count,vendor_id}, TANPA date1/date2/filter_status/filter_by/sort sama sekali
// (skrip Console filter tanggal di sisi client, bukan server).
/** Generasi database Turso (tursoGeneration) tempat skema ini sudah disiapkan; -1 = belum. */
let lapVendorColumnEnsuredGen = -1;
async function ensureLapVendorColumn(env: Env): Promise<void> {
	if (lapVendorColumnEnsuredGen === tursoGeneration()) return;
	const gen = tursoGeneration();
	try {
		await getTurso(env).prepare(`ALTER TABLE lap_credentials ADD COLUMN vendor_id_motion TEXT NOT NULL DEFAULT ''`).run();
	} catch {
		/* kolom sudah ada -> abaikan */
	}
	lapVendorColumnEnsuredGen = gen;
}

export async function lapLoadCreds(env: Env, username: string): Promise<LapCreds> {
	await ensureLapVendorColumn(env);
	const r = await getTurso(env).prepare(`SELECT * FROM lap_credentials WHERE username = ?`)
		.bind(username)
		.first<Record<string, string>>();
	if (!r) return { ...EMPTY };
	return {
		linkAdmin: String(r.link_admin || ""),
		cookieAdmin: String(r.cookie_admin || ""),
		linkMotion: String(r.link_motion || ""),
		tokenMotion: String(r.token_motion || ""),
		vendorIdMotion: String(r.vendor_id_motion || ""),
		linkMozart: String(r.link_mozart || ""),
		cookieMozart: String(r.cookie_mozart || ""),
		mozartAccounts: String(r.mozart_accounts || ""),
	};
}

export async function lapSaveCreds(env: Env, username: string, data: Partial<LapCreds>): Promise<LapCreds> {
	await ensureLapVendorColumn(env);
	const cur = await lapLoadCreds(env, username);
	const linkAdminRaw = pick(data.linkAdmin, cur.linkAdmin);
	const linkMotionRaw = pick(data.linkMotion, cur.linkMotion);
	const linkMozartRaw = pick(data.linkMozart, cur.linkMozart);
	const next: LapCreds = {
		// Link disimpan sebagai scheme://host saja — path seperti "/wd" atau
		// "/riwayat-pga" bikin URL API salah.
		linkAdmin: linkAdminRaw ? hostOnly(linkAdminRaw) : "",
		cookieAdmin: pick(data.cookieAdmin, cur.cookieAdmin),
		linkMotion: linkMotionRaw ? hostOnly(linkMotionRaw) : "",
		tokenMotion: pick(data.tokenMotion, cur.tokenMotion),
		vendorIdMotion: pick(data.vendorIdMotion, cur.vendorIdMotion),
		linkMozart: linkMozartRaw ? hostOnly(linkMozartRaw) : "",
		cookieMozart: pick(data.cookieMozart, cur.cookieMozart),
		mozartAccounts: data.mozartAccounts === undefined ? cur.mozartAccounts : String(data.mozartAccounts),
	};
	await getTurso(env).prepare(
		`INSERT INTO lap_credentials
		   (username, link_admin, cookie_admin, link_motion, token_motion, vendor_id_motion, link_mozart, cookie_mozart, mozart_accounts, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(username) DO UPDATE SET
		   link_admin=excluded.link_admin, cookie_admin=excluded.cookie_admin,
		   link_motion=excluded.link_motion, token_motion=excluded.token_motion,
		   vendor_id_motion=excluded.vendor_id_motion,
		   link_mozart=excluded.link_mozart, cookie_mozart=excluded.cookie_mozart,
		   mozart_accounts=excluded.mozart_accounts,
		   updated_at=excluded.updated_at`,
	)
		.bind(
			username,
			next.linkAdmin,
			next.cookieAdmin,
			next.linkMotion,
			next.tokenMotion,
			next.vendorIdMotion,
			next.linkMozart,
			next.cookieMozart,
			next.mozartAccounts,
			tsNow(),
		)
		.run();
	return next;
}
function pick(v: string | undefined, fallback: string): string {
	return v === undefined ? fallback : String(v).trim();
}

// -------------------------------------------------------------------------
// Snapshot hasil per modul
// -------------------------------------------------------------------------
export async function lapSaveResults(env: Env, username: string, map: Record<string, unknown[]>, site = ""): Promise<void> {
	const now = tsNow();
	const stmts = Object.keys(map).map((mod) =>
		getTurso(env).prepare(
			`INSERT INTO lap_result (username, module, data, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(username, module) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
		).bind(username, lapSiteKey(mod, site), JSON.stringify(map[mod] ?? []), now),
	);
	for (let i = 0; i < stmts.length; i += 40) await getTurso(env).batch(stmts.slice(i, i + 40));
}

export async function lapLoadResults(env: Env, username: string): Promise<Record<string, unknown>> {
	const res = await getTurso(env).prepare(`SELECT module, data, updated_at FROM lap_result WHERE username = ?`)
		.bind(username)
		.all<{ module: string; data: string; updated_at: string }>();
	return parseLapResults(res.results ?? []);
}

export const LAP_RESULT_MODULES = [
	"register", "registerMeta", "reportAgent", "reportAgentMeta",
	"checkCoin", "checkCoinMeta", "idSelisih", "withdrawPgaIdf",
	"_motionMeta", "motionDpPga", "motionPendingError", "motionWd",
	"_mozartMeta", "mozartDepo", "mozartWd",
];
const LAP_MODULES = new Set([
	"register", "registerMeta", "reportAgent", "reportAgentMeta",
	"checkCoin", "checkCoinMeta", "idSelisih", "withdrawPgaIdf",
	"_motionMeta", "motionDpPga", "motionPendingError", "motionWd",
	"_mozartMeta", "mozartDepo", "mozartWd",
]);

function parseLapResults(rows: { module: string; data: string }[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const r of rows) {
		try {
			out[r.module] = JSON.parse(r.data);
		} catch {
			out[r.module] = [];
		}
	}
	return out;
}

/**
 * Gabungkan blob JSON hasil laporan APA ADANYA menjadi satu objek JSON, tanpa
 * JSON.parse + JSON.stringify ulang di Worker. Blob laporan bisa ratusan KB
 * sampai beberapa MB; parse+stringify-nya memakan CPU Worker (paket Free
 * cuma 10 ms/request) dan memperlambat respons. Blob ditulis oleh kode ini
 * sendiri lewat JSON.stringify, jadi cukup dicek bentuk luarnya; yang tidak
 * wajar diganti [] (sama seperti parseLapResults).
 */
export function lapResultsJsonRaw(rows: { module: string; data: string }[]): string {
	const parts: string[] = [];
	for (const r of rows) {
		const raw = String(r.data ?? "").trim();
		const ok = (raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("{") && raw.endsWith("}"));
		parts.push(JSON.stringify(String(r.module)) + ":" + (ok ? raw : "[]"));
	}
	return "{" + parts.join(",") + "}";
}

/** Baris hasil modul yang diminta (modul Lap Admin milik `site`), nama modul dikembalikan tanpa akhiran "@SITE". */
async function loadModuleRows(env: Env, username: string, modules: string[], site: string): Promise<{ module: string; data: string }[]> {
	const wanted = [...new Set(modules.map((m) => String(m || "").trim()).filter((m) => LAP_MODULES.has(m)))];
	if (!wanted.length) return [];
	const keys = wanted.map((m) => lapSiteKey(m, site));
	const res = await getTurso(env)
		.prepare(`SELECT module, data FROM lap_result WHERE username = ? AND module IN (${keys.map(() => "?").join(",")})`)
		.bind(username, ...keys)
		.all<{ module: string; data: string }>();
	return (res.results ?? []).map((r) => ({ module: String(r.module).split("@")[0], data: r.data }));
}

export async function lapLoadResultsModulesRaw(env: Env, username: string, modules: string[], site = ""): Promise<string> {
	const rows = await withSharedMotion(env, username, modules, site, await loadModuleRows(env, username, modules, site));
	return rows.length ? lapResultsJsonRaw(rows) : "{}";
}

/**
 * Lap Motion per website: modul yang BELUM punya data khusus website ini (data lama sebelum per website, atau Withdraw
 * yang tidak bisa dipisah karena barisnya tidak membawa vendor) memakai data gabungan semua website. Daftarnya dikirim
 * sebagai "_motionShared" supaya browser memberi label "gabungan" -- tidak pernah diam-diam dianggap milik satu website.
 */
async function withSharedMotion(env: Env, username: string, modules: string[], site: string, rows: { module: string; data: string }[]) {
	if (!site) return rows;
	const have = new Set(rows.map((r) => r.module));
	const missing = LAP_MOTION_MODULES.filter((m) => modules.includes(m) && !have.has(m));
	if (!missing.length) return rows;
	const shared = await loadModuleRows(env, username, missing, "");
	if (!shared.length) return rows;
	return [...rows, ...shared, { module: "_motionShared", data: JSON.stringify(shared.map((r) => r.module)) }];
}

export async function lapLoadResultsModules(env: Env, username: string, modules: string[], site = ""): Promise<Record<string, unknown>> {
	return parseLapResults(await loadModuleRows(env, username, modules, site));
}

// -------------------------------------------------------------------------
// LAP ADMIN PER WEBSITE (perintah pemilik 25 Okt 2026): user dengan akses 1, 2, 3+ website (profile.websites) otomatis
// punya Lap Admin untuk SETIAP website-nya -- tanpa pengaturan tambahan:
//  - Link Admin bawaan = server admin website itu (Data Master, sama dengan Auto Prediksi);
//  - Cookie Admin = isian Setting untuk website itu, kosong -> cookie website itu di menu Auto Prediksi (login agen sama);
//  - hasil disimpan terpisah per website (modul "register@HUGO"), jadi website satu tidak menimpa website lain.
// Motion, Mozart & PGA Pending TIDAK dipecah: satu login gateway memang menangani banyak website (Vendor ID dipisah koma,
// "panel:4 = HUGOTOGEL"). User tanpa daftar website (mis. ADMIN) tetap memakai satu set Setting seperti dulu (site "").
// -------------------------------------------------------------------------
export const LAP_ADMIN_MODULES = ["register", "registerMeta", "reportAgent", "reportAgentMeta", "checkCoin", "checkCoinMeta", "idSelisih", "withdrawPgaIdf"];
/** Modul Lap Motion juga per website (Deposit ditarik per Vendor ID website; Withdraw dipisah bila barisnya membawa vendor). */
export const LAP_MOTION_MODULES = ["_motionMeta", "motionDpPga", "motionPendingError", "motionWd"];
const SITE_MODULE_SET = new Set([...LAP_ADMIN_MODULES, ...LAP_MOTION_MODULES]);

/** Kunci baris lap_result: modul Lap Admin/Motion milik satu website -> "modul@WEBSITE"; lainnya (Mozart, mode lama) apa adanya. */
export function lapSiteKey(module: string, site: string): string {
	return site && SITE_MODULE_SET.has(module) ? `${module}@${site}` : module;
}

/** Generasi database Turso (tursoGeneration) tempat tabel ini sudah disiapkan; -1 = belum. */
let lapAdminSiteGen = -1;
async function ensureLapAdminSiteTable(env: Env): Promise<void> {
	if (lapAdminSiteGen === tursoGeneration()) return;
	const gen = tursoGeneration();
	await getTurso(env)
		.prepare(
			`CREATE TABLE IF NOT EXISTS lap_admin_site (
				username     TEXT NOT NULL,
				website      TEXT NOT NULL,
				link_admin   TEXT NOT NULL DEFAULT '',
				cookie_admin TEXT NOT NULL DEFAULT '',
				vendor_id_motion TEXT NOT NULL DEFAULT '',
				link_motion  TEXT NOT NULL DEFAULT '',
				token_motion TEXT NOT NULL DEFAULT '',
				updated_at   TEXT NOT NULL DEFAULT '',
				PRIMARY KEY (username, website)
			)`,
		)
		.run();
	// tabel yang sudah dibuat sebelum kolom Motion per website ada
	for (const col of ["vendor_id_motion", "link_motion", "token_motion"]) {
		try {
			await getTurso(env).prepare(`ALTER TABLE lap_admin_site ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`).run();
		} catch {
			/* kolom sudah ada */
		}
	}
	lapAdminSiteGen = gen;
}
/** Hanya untuk test (tiap test memakai database baru). */
export function resetLapAdminSiteForTest(): void {
	lapAdminSiteGen = -1;
	lapVendorColumnEnsuredGen = -1;
	migrated.clear();
}

export interface LapAdminSite {
	website: string;
	/** Nama merek untuk tampilan ("HUGOTOGEL"). */
	brand: string;
	linkAdmin: string;
	/** Cookie yang DIPAKAI (Setting, atau cookie Auto Prediksi bila Setting kosong). */
	cookieAdmin: string;
	/** Cookie isian Setting untuk website ini (kosong = memakai Auto Prediksi). */
	settingCookie: string;
	source: "setting" | "auto-prediksi" | "";
	/** 4 karakter terakhir PHPSESSID Auto Prediksi (tidak pernah nilai penuh). */
	autoHint: string;
	/** Vendor ID Motion website ini (Motion: tiap website punya vendor_id sendiri; boleh beberapa, dipisah koma). */
	vendorIdMotion: string;
	/** Link & token Motion khusus website ini; kosong = memakai Motion bawaan (Setting "Semua website"). */
	linkMotion: string;
	tokenMotion: string;
}

/** Kredensial Lap Admin untuk tiap website (satu query tabel + satu baca sesi Auto Prediksi). */
export async function lapAdminSites(env: Env, username: string, websites: string[]): Promise<LapAdminSite[]> {
	if (!websites.length) return [];
	await ensureLapAdminSiteTable(env);
	const rows =
		(await getTurso(env).prepare(`SELECT website, link_admin, cookie_admin, vendor_id_motion, link_motion, token_motion FROM lap_admin_site WHERE username = ?`).bind(username).all<Record<string, string>>())
			.results ?? [];
	const saved = new Map(rows.map((r) => [String(r.website), r]));
	let sessions: Awaited<ReturnType<typeof getSessions>> = [];
	try {
		sessions = await getSessions(env, username);
	} catch {
		/* Auto Prediksi belum dipakai / gagal dibaca -> hanya isian Setting */
	}
	return websites.map((website) => {
		const row = saved.get(website);
		const auto = sessions.find((x) => x.website === website);
		const settingCookie = String(row?.cookie_admin ?? "");
		const autoCookie = auto?.phpsessid ? cookieHeader(auto.phpsessid) : "";
		const linkAdmin = hostOnly(String(row?.link_admin ?? "")) || hostOnly(auto?.baseUrl ?? "") || hostOnly(defaultAdminBase(website));
		return {
			website,
			brand: siteBrand(website) ?? website,
			linkAdmin,
			cookieAdmin: settingCookie || autoCookie,
			settingCookie,
			source: settingCookie ? "setting" : autoCookie ? "auto-prediksi" : "",
			autoHint: auto?.phpsessid ? sessionHint(auto.phpsessid) : "",
			vendorIdMotion: String(row?.vendor_id_motion ?? ""),
			linkMotion: String(row?.link_motion ?? ""),
			tokenMotion: String(row?.token_motion ?? ""),
		};
	});
}

/** Simpan isian Setting satu website. undefined = pertahankan; cookie "" = kosongkan (kembali memakai cookie Auto Prediksi). */
export async function lapSaveAdminSite(
	env: Env,
	username: string,
	website: string,
	data: { linkAdmin?: string; cookieAdmin?: string; vendorIdMotion?: string; linkMotion?: string; tokenMotion?: string },
): Promise<void> {
	await ensureLapAdminSiteTable(env);
	const cur = await getTurso(env)
		.prepare(`SELECT link_admin, cookie_admin, vendor_id_motion, link_motion, token_motion FROM lap_admin_site WHERE username = ? AND website = ?`)
		.bind(username, website)
		.first<{ link_admin: string; cookie_admin: string; vendor_id_motion: string; link_motion: string; token_motion: string }>();
	// Link sama dengan server admin bawaan disimpan kosong: tetap ikut otomatis bila server website diganti di Data Master.
	const typed = data.linkAdmin === undefined ? undefined : data.linkAdmin.trim() ? hostOnly(data.linkAdmin) : "";
	const link = typed === undefined ? String(cur?.link_admin ?? "") : typed === hostOnly(defaultAdminBase(website)) ? "" : typed;
	const cookie = data.cookieAdmin === undefined ? String(cur?.cookie_admin ?? "") : data.cookieAdmin.trim();
	const vendor =
		data.vendorIdMotion === undefined
			? String(cur?.vendor_id_motion ?? "")
			: data.vendorIdMotion.split(/[\s,]+/).map((v) => v.trim()).filter((v) => /^[A-Za-z0-9_-]{1,40}$/.test(v)).join(",");
	const linkMotion = data.linkMotion === undefined ? String(cur?.link_motion ?? "") : data.linkMotion.trim() ? hostOnly(data.linkMotion) : "";
	// token (x-access-token JWT): tanpa spasi; "Bearer " dibuang
	const tokenMotion = data.tokenMotion === undefined ? String(cur?.token_motion ?? "") : data.tokenMotion.replace(/^Bearer\s+/i, "").replace(/\s+/g, "").slice(0, 4000);
	await getTurso(env)
		.prepare(
			`INSERT INTO lap_admin_site (username, website, link_admin, cookie_admin, vendor_id_motion, link_motion, token_motion, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(username, website) DO UPDATE SET link_admin = excluded.link_admin, cookie_admin = excluded.cookie_admin,
			   vendor_id_motion = excluded.vendor_id_motion, link_motion = excluded.link_motion, token_motion = excluded.token_motion,
			   updated_at = excluded.updated_at`,
		)
		.bind(username, website, link, cookie, vendor, linkMotion, tokenMotion, tsNow())
		.run();
}

/**
 * Data lama (sebelum per website): satu Cookie Admin + hasil Lap Admin tanpa akhiran milik user. Dipindah SEKALI ke
 * website pemiliknya: PHPSESSID sama dengan cookie Auto Prediksi website itu -> isi cookie ("<agen>=HUGOTOGEL.COM")
 * -> website pertama user. Cookie lama ikut disalin ke Setting website itu (bila Setting-nya masih kosong).
 */
const migrated = new Set<string>();
export async function lapMigrateLegacyAdmin(env: Env, username: string, websites: string[]): Promise<void> {
	const memo = `${tursoGeneration()}|${username}`;
	if (!websites.length || migrated.has(memo)) return;
	const legacy =
		(
			await getTurso(env)
				.prepare(`SELECT module FROM lap_result WHERE username = ? AND module IN (${LAP_ADMIN_MODULES.map(() => "?").join(",")})`)
				.bind(username, ...LAP_ADMIN_MODULES)
				.all<{ module: string }>()
		).results ?? [];
	const creds = await lapLoadCreds(env, username);
	if (legacy.length || creds.cookieAdmin) {
		const target = await legacyOwner(env, username, websites, creds.cookieAdmin);
		if (legacy.length) {
			const db = getTurso(env);
			const stmts = LAP_ADMIN_MODULES.flatMap((m) => [
				db
					.prepare(
						`INSERT OR IGNORE INTO lap_result (username, module, data, updated_at)
						 SELECT username, ?, data, updated_at FROM lap_result WHERE username = ? AND module = ?`,
					)
					.bind(`${m}@${target}`, username, m),
				db.prepare(`DELETE FROM lap_result WHERE username = ? AND module = ?`).bind(username, m),
			]);
			await db.batch(stmts);
		}
		const sites = await lapAdminSites(env, username, [target]);
		if (creds.cookieAdmin && !sites[0]?.settingCookie) {
			await lapSaveAdminSite(env, username, target, { linkAdmin: creds.linkAdmin || undefined, cookieAdmin: creds.cookieAdmin });
		}
	}
	migrated.add(memo);
}

async function legacyOwner(env: Env, username: string, websites: string[], cookie: string): Promise<string> {
	const sid = parsePhpSessId(cookieHeader(String(cookie ?? "").trim()));
	if (sid) {
		try {
			const hit = (await getSessions(env, username)).find((x) => websites.includes(x.website) && parsePhpSessId(cookieHeader(x.phpsessid)) === sid);
			if (hit) return hit.website;
		} catch {
			/* lanjut ke isi cookie */
		}
	}
	const brand = String(cookie ?? "").toUpperCase().match(/=\s*([A-Z0-9]{2,20}(?:TOGEL|TOTO))\.COM\b/)?.[1];
	const byBrand = brand ? websites.find((w) => w === brand || siteBrand(w) === brand) : undefined;
	return byBrand ?? websites[0];
}

// -------------------------------------------------------------------------
// Helper umum
// -------------------------------------------------------------------------
export const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export function normLink(raw: string, fallback: string): string {
	let s = String(raw || "").trim() || fallback;
	if (!/^https?:\/\//i.test(s)) s = "https://" + s;
	return s.replace(/\/+$/, "");
}

/** Ambil scheme://host saja (buang path/query/hash) — untuk base URL API. */
export function hostOnly(raw: string, fallback = ""): string {
	let s = String(raw || "").trim() || fallback;
	if (!s) return "";
	if (!/^https?:\/\//i.test(s)) s = "https://" + s;
	const m = s.match(/^(https?:\/\/[^/\s?#]+)/i);
	return m ? m[1] : s.replace(/\/+$/, "");
}

export function num(v: unknown): number {
	const n = Number(String(v === undefined || v === null ? 0 : v).replace(/[^0-9.\-]/g, ""));
	return isNaN(n) ? 0 : n;
}

/** POST JSON, paralel per batch, dengan batas total request. */
export async function postJsonBatch(
	reqs: { url: string; headers: Record<string, string>; body: unknown }[],
	batchSize = 15,
): Promise<(unknown | null)[]> {
	const out: (unknown | null)[] = [];
	for (let i = 0; i < reqs.length; i += batchSize) {
		const chunk = reqs.slice(i, i + batchSize);
		const settled = await Promise.allSettled(
			chunk.map((r) =>
				fetch(r.url, {
					method: "POST",
					headers: { "content-type": "application/json", ...r.headers },
					body: JSON.stringify(r.body),
				}).then((res) => res.text()),
			),
		);
		for (const s of settled) {
			if (s.status !== "fulfilled") {
				out.push(null);
				continue;
			}
			try {
				out.push(JSON.parse(s.value));
			} catch {
				out.push(null);
			}
		}
	}
	return out;
}

/** Ambil username murni dari deskripsi transaksi Motion. */
export function extractPureUsername(item: Record<string, unknown>): string {
	if (!item) return "-";
	const desc = typeof item.description === "string" ? item.description.trim() : "";
	if (desc) {
		const m = desc.match(/Deposit from\s+([a-zA-Z0-9_.-]+)/i);
		if (m) return m[1].trim();
		const first = desc.split(/\s+/)[0];
		if (first && first.length > 1) return first.replace(/[^a-zA-Z0-9_.-]/g, "").trim();
	}
	for (const k of ["user", "customer_name"]) {
		const v = item[k];
		if (typeof v === "string" && v.trim()) return v.trim().split(/\s+/)[0];
	}
	const cust = item.customer as Record<string, unknown> | undefined;
	if (cust && typeof cust.name === "string" && cust.name.trim()) return cust.name.trim().split(/\s+/)[0];
	return "-";
}
