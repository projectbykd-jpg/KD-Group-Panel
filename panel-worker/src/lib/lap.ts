// Menu "Laporan Harian" — port PANEL AUTO (Code.cpp) ke Worker.
// Bagian ini: kredensial per operator + snapshot hasil + helper umum.
// Tabel lap_* ada di Turso (bukan D1) -> pakai getTurso(env).
import { tsNow } from "./time";
import { getTurso } from "./turso";

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
let lapVendorColumnEnsured = false;
async function ensureLapVendorColumn(env: Env): Promise<void> {
	if (lapVendorColumnEnsured) return;
	try {
		await getTurso(env).prepare(`ALTER TABLE lap_credentials ADD COLUMN vendor_id_motion TEXT NOT NULL DEFAULT ''`).run();
	} catch {
		/* kolom sudah ada -> abaikan */
	}
	lapVendorColumnEnsured = true;
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
export async function lapSaveResults(env: Env, username: string, map: Record<string, unknown[]>): Promise<void> {
	const now = tsNow();
	const stmts = Object.keys(map).map((mod) =>
		getTurso(env).prepare(
			`INSERT INTO lap_result (username, module, data, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(username, module) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`,
		).bind(username, mod, JSON.stringify(map[mod] ?? []), now),
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

export async function lapLoadResultsModulesRaw(env: Env, username: string, modules: string[]): Promise<string> {
	const wanted = [...new Set(modules.map((m) => String(m || "").trim()).filter((m) => LAP_MODULES.has(m)))];
	if (!wanted.length) return "{}";
	const res = await getTurso(env)
		.prepare(`SELECT module, data FROM lap_result WHERE username = ? AND module IN (${wanted.map(() => "?").join(",")})`)
		.bind(username, ...wanted)
		.all<{ module: string; data: string }>();
	return lapResultsJsonRaw(res.results ?? []);
}

export async function lapLoadResultsModules(env: Env, username: string, modules: string[]): Promise<Record<string, unknown>> {
	const wanted = [...new Set(modules.map((m) => String(m || "").trim()).filter((m) => LAP_MODULES.has(m)))];
	if (!wanted.length) return {};
	const res = await getTurso(env)
		.prepare(`SELECT module, data FROM lap_result WHERE username = ? AND module IN (${wanted.map(() => "?").join(",")})`)
		.bind(username, ...wanted)
		.all<{ module: string; data: string }>();
	return parseLapResults(res.results ?? []);
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
