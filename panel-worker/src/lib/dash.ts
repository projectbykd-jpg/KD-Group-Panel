// Port getDashboardDataFresh_ / normalizeDashboardRequest_ dari PanelCore.gs.
// Jauh lebih ringkas: activity_log di D1 -> WHERE / ORDER BY / LIMIT langsung,
// tidak perlu scan sheet + rollover + arsip seperti versi Apps Script.
import { getSys } from "./settings";
import { getMaintenance, UserProfile } from "./db";
import { dateKeyNow } from "./time";
import { JADWAL_PREDIKSI_CONFIG, CLOSING_PREDICTION_SLOTS } from "./prediction";

export interface DashOptions {
	page: number;
	pageSize: number;
	query: string;
	username: string;
	action: string;
	status: string;
	dateFrom: string; // yyyy-MM-dd
	dateTo: string; // yyyy-MM-dd
	facets: boolean; // hitung filterOptions (DISTINCT full-scan). false utk auto-refresh.
}

export function normalizeDashOptions(raw: unknown): DashOptions {
	if (typeof raw === "number") {
		return {
			page: 1,
			pageSize: Math.min(Math.max(raw || 100, 10), 250),
			query: "",
			username: "",
			action: "",
			status: "",
			dateFrom: "",
			dateTo: "",
			facets: true,
		};
	}
	const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	return {
		page: Math.max(Number(v.page) || 1, 1),
		pageSize: Math.min(Math.max(Number(v.pageSize) || 75, 10), 200),
		query: String(v.query ?? "").trim(),
		username: String(v.username ?? "").trim(),
		action: String(v.action ?? "").trim(),
		status: String(v.status ?? "").trim(),
		dateFrom: String(v.dateFrom ?? "").trim(),
		dateTo: String(v.dateTo ?? "").trim(),
		facets: v.facets !== false,
	};
}

// ---------------------------------------------------------------------------
// Filter tanggal yang RAMAH INDEX
// ---------------------------------------------------------------------------
// activity_log.ts formatnya selalu "yyyy-MM-dd HH:mm:ss" (lihat tsNow() di
// lib/time.ts & DEFAULT kolomnya di migration/001_init.sql), jadi perbandingan
// STRING biasa sudah setara dengan perbandingan tanggal.
//
// Bedanya: `ts >= ? AND ts < ?` masih bisa memakai index ix_activity_ts,
// sedangkan pola lama `substr(ts,1,10) = ?` TIDAK BISA -- SQLite tidak punya
// index untuk hasil pemanggilan fungsi, jadi tiap query tanggal memindai
// SELURUH tabel activity_log. Itu penyebab utama Dashboard & halaman Aktivitas
// terasa berat (dua-duanya query tanggal, dan dipanggil tiap load/refresh).
//
// dayHi memakai "~" (0x7E) sebagai batas atas eksklusif: karakter itu lebih
// besar dari spasi pemisah jam ("2026-09-19 23:59:59" < "2026-09-19~") tapi
// tetap lebih kecil dari tanggal berikutnya ("2026-09-19~" < "2026-09-20"),
// jadi tidak perlu hitung "besoknya tanggal berapa" sama sekali.
const dayLo = (dateKey: string): string => dateKey;
const dayHi = (dateKey: string): string => dateKey + "~";

// Ringkasan aktivitas untuk header/poll — SATU query agregat (bukan 5 full-scan
// seperti getDashboardData). Dipakai live-poll supaya tidak menghabiskan kuota
// "rows read" D1 (5 juta/hari di paket Free).
//
// Cache per-isolate 25 dtk: 16 CS yang poll tiap ~45 dtk sering jatuh di isolate
// Worker yang sama & hangat -> mayoritas poll dilayani dari memori, nol baca D1.
type SumResult = Awaited<ReturnType<typeof buildActivitySummary>>;
const _sumCache = new Map<string, { ts: number; data: SumResult }>();

export async function getActivitySummary(env: Env, profile: UserProfile): Promise<SumResult> {
	const key = profile.role === "ADMIN" ? "__admin__" : profile.username;
	const hit = _sumCache.get(key);
	if (hit && Date.now() - hit.ts < (await getSys(env, "sys_dash_summary_ttl_sec")) * 1000) return hit.data;
	const data = await buildActivitySummary(env, profile);
	_sumCache.set(key, { ts: Date.now(), data });
	if (_sumCache.size > 64) {
		// jaga-jaga: buang entri terlama
		const oldest = [..._sumCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
		if (oldest) _sumCache.delete(oldest[0]);
	}
	return data;
}

async function buildActivitySummary(env: Env, profile: UserProfile) {
	const isAdmin = profile.role === "ADMIN";
	const today = dateKeyNow();
	const scope = isAdmin ? "ts >= ? AND ts < ?" : "ts >= ? AND ts < ? AND username = ?";
	const args: unknown[] = isAdmin
		? [dayLo(today), dayHi(today)]
		: [dayLo(today), dayHi(today), profile.username];
	// Dua query ini tidak saling bergantung -> jalankan barengan, bukan berurutan.
	const [s, maintenance] = await Promise.all([
		env.DB.prepare(
			`SELECT
			   COUNT(*) AS today,
			   SUM(CASE WHEN action = 'LOGIN' AND status = 'BERHASIL' THEN 1 ELSE 0 END) AS login,
			   SUM(CASE WHEN upper(action) LIKE '%SEND%' OR upper(action) LIKE '%KIRIM%' THEN 1 ELSE 0 END) AS sends,
			   SUM(CASE WHEN status = 'BERHASIL' THEN 1 ELSE 0 END) AS success,
			   SUM(CASE WHEN upper(status) IN ('GAGAL','ERROR') THEN 1 ELSE 0 END) AS failed
			 FROM activity_log WHERE ${scope}`,
		)
			.bind(...args)
			.first<Record<string, number>>(),
		getMaintenance(env),
	]);
	return {
		role: profile.role,
		stats: {
			today: Number(s?.today ?? 0),
			login: Number(s?.login ?? 0),
			sends: Number(s?.sends ?? 0),
			success: Number(s?.success ?? 0),
			failed: Number(s?.failed ?? 0),
			found: Number(s?.today ?? 0),
		},
		maintenance,
	};
}

// ---------------------------------------------------------------------------
// Wawasan untuk halaman Dashboard: aktivitas per jam hari ini (+ yang gagal), top operator (admin), dan jadwal
// prediksi hari ini. Dua query agregat ringan, di-cache per-isolate selama TTL ringkasan (sama seperti _sumCache).
// ---------------------------------------------------------------------------
export interface HomeInsights {
	hourly: number[];
	hourlyFailed: number[];
	topUsers: { username: string; n: number }[];
	schedule: { jam: string; nama: string; total: number }[];
	closing: string[];
	nowMinutes: number;
	/** 'all' = gabungan semua user (admin); 'own' = hanya akun sendiri. */
	scope: "all" | "own";
}
const _insightCache = new Map<string, { ts: number; data: HomeInsights }>();

export async function getHomeInsights(env: Env, profile: UserProfile): Promise<HomeInsights> {
	const isAdmin = profile.role === "ADMIN";
	const key = isAdmin ? "__admin__" : profile.username;
	const hit = _insightCache.get(key);
	const ttl = (await getSys(env, "sys_dash_summary_ttl_sec")) * 1000;
	const nowMinutes = (() => { const d = new Date(Date.now() + 7 * 3600_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); })();
	if (hit && Date.now() - hit.ts < ttl) return { ...hit.data, nowMinutes };

	const today = dateKeyNow();
	const scope = isAdmin ? "ts >= ? AND ts < ?" : "ts >= ? AND ts < ? AND username = ?";
	const args: unknown[] = isAdmin ? [dayLo(today), dayHi(today)] : [dayLo(today), dayHi(today), profile.username];
	const [hr, top] = await Promise.all([
		env.DB.prepare(
			`SELECT substr(ts, 12, 2) AS h, COUNT(*) AS n,
			        SUM(CASE WHEN upper(status) IN ('GAGAL','ERROR') THEN 1 ELSE 0 END) AS f
			 FROM activity_log WHERE ${scope} GROUP BY h`,
		).bind(...args).all<{ h: string; n: number; f: number }>(),
		isAdmin
			? env.DB.prepare(`SELECT username, COUNT(*) AS n FROM activity_log WHERE ${scope} GROUP BY username ORDER BY n DESC LIMIT 5`)
				.bind(...args).all<{ username: string; n: number }>()
			: Promise.resolve({ results: [] as { username: string; n: number }[] }),
	]);
	const hourly = Array(24).fill(0), hourlyFailed = Array(24).fill(0);
	for (const r of hr.results ?? []) {
		const h = Number(r.h);
		if (h >= 0 && h < 24) { hourly[h] = Number(r.n || 0); hourlyFailed[h] = Number(r.f || 0); }
	}
	const data: HomeInsights = {
		hourly, hourlyFailed,
		topUsers: (top.results ?? []).map((r) => ({ username: String(r.username || ""), n: Number(r.n || 0) })),
		schedule: JADWAL_PREDIKSI_CONFIG.map((x) => ({ jam: x.jam, nama: x.nama, total: x.pasaran.length })),
		closing: [...CLOSING_PREDICTION_SLOTS],
		nowMinutes,
		scope: isAdmin ? "all" : "own",
	};
	_insightCache.set(key, { ts: Date.now(), data });
	if (_insightCache.size > 64) {
		const oldest = [..._insightCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
		if (oldest) _insightCache.delete(oldest[0]);
	}
	return data;
}

export interface ActivityRow {
	ts: string;
	username: string;
	action: string;
	status: string;
	detail: string;
	content: string;
}

// Isi dropdown filter (username/action/status) = 3x SELECT DISTINCT atas
// activity_log. Dulu ketiganya dijalankan BERURUTAN setiap halaman dibuka
// (getBootstrapData memanggil dgn facets:true), padahal isinya nyaris tidak
// pernah berubah dalam hitungan detik. Sekarang: dijalankan barengan DAN
// di-cache per-isolate 60 dtk -- mayoritas load tidak menyentuh D1 sama sekali
// untuk bagian ini. Pola & alasannya sama dengan _sumCache di atas.
interface FilterOptions {
	usernames: string[];
	actions: string[];
	statuses: string[];
}
const _facetCache = new Map<string, { ts: number; data: FilterOptions }>();

async function getFilterOptions(env: Env, profile: UserProfile, today: string): Promise<FilterOptions> {
	const isAdmin = profile.role === "ADMIN";
	// Non-admin selalu dibatasi hari ini -> tanggal ikut jadi bagian kunci cache
	// supaya entri kemarin tidak kebawa lewat pergantian hari.
	const key = isAdmin ? "__admin__" : `${profile.username}|${today}`;
	const hit = _facetCache.get(key);
	if (hit && Date.now() - hit.ts < (await getSys(env, "sys_dash_facet_ttl_sec")) * 1000) return hit.data;

	const distinct = async (col: "username" | "action" | "status"): Promise<string[]> => {
		if (isAdmin) {
			const res = await env.DB.prepare(
				`SELECT DISTINCT ${col} AS v FROM activity_log WHERE ${col} <> '' ORDER BY v LIMIT 200`,
			).all<{ v: string }>();
			return (res.results ?? []).map((r) => r.v);
		}
		const res = await env.DB.prepare(
			`SELECT DISTINCT ${col} AS v FROM activity_log
			 WHERE ${col} <> '' AND username = ? AND ts >= ? AND ts < ? ORDER BY v LIMIT 200`,
		)
			.bind(profile.username, dayLo(today), dayHi(today))
			.all<{ v: string }>();
		return (res.results ?? []).map((r) => r.v);
	};

	const [usernames, actions, statuses] = await Promise.all([
		distinct("username"),
		distinct("action"),
		distinct("status"),
	]);
	const data: FilterOptions = { usernames, actions, statuses };
	_facetCache.set(key, { ts: Date.now(), data });
	if (_facetCache.size > 64) {
		const oldest = [..._facetCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
		if (oldest) _facetCache.delete(oldest[0]);
	}
	return data;
}

export async function getDashboardData(env: Env, profile: UserProfile, opts: DashOptions) {
	const isAdmin = profile.role === "ADMIN";
	const today = dateKeyNow();

	const where: string[] = [];
	const args: unknown[] = [];

	if (!isAdmin) {
		// operator/viewer: hanya aktivitas sendiri, hanya hari ini
		where.push("username = ?");
		args.push(profile.username);
		where.push("ts >= ? AND ts < ?");
		args.push(dayLo(today), dayHi(today));
	} else {
		if (opts.username) {
			where.push("username = ?");
			args.push(opts.username);
		}
		if (opts.dateFrom) {
			where.push("ts >= ?");
			args.push(dayLo(opts.dateFrom));
		}
		if (opts.dateTo) {
			// "<= dateTo" versi ramah-index: seluruh hari dateTo ikut (lihat dayHi).
			where.push("ts < ?");
			args.push(dayHi(opts.dateTo));
		}
	}
	if (opts.action) {
		where.push("upper(action) = ?");
		args.push(opts.action.toUpperCase());
	}
	if (opts.status) {
		where.push("upper(status) = ?");
		args.push(opts.status.toUpperCase());
	}
	if (opts.query) {
		const like = `%${opts.query}%`;
		where.push(
			"(username LIKE ? OR action LIKE ? OR status LIKE ? OR detail LIKE ? OR content LIKE ?)",
		);
		args.push(like, like, like, like, like);
	}
	const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

	// Statistik: cakupan HARI INI untuk user ini (admin = semua user hari ini).
	const statArgs: unknown[] = [dayLo(today), dayHi(today)];
	let statScope = "ts >= ? AND ts < ?";
	if (!isAdmin) {
		statScope += " AND username = ?";
		statArgs.push(profile.username);
	}

	const rowsQuery = (off: number) =>
		env.DB.prepare(
			`SELECT ts, username, action, status, detail, content
			 FROM activity_log ${whereSql}
			 ORDER BY id DESC LIMIT ? OFFSET ?`,
		)
			.bind(...args, opts.pageSize, off)
			.all<Record<string, string>>();

	// Semua query di bawah ini saling INDEPENDEN -> dijalankan barengan (dulu
	// berurutan: COUNT -> baris -> statistik -> 3x DISTINCT -> maintenance =
	// 7 round-trip menunggu satu per satu tiap kali halaman dibuka/refresh).
	//
	// Query baris ikut dijalankan duluan memakai halaman yang DIMINTA user,
	// supaya tidak perlu menunggu COUNT selesai. Kalau halaman itu ternyata
	// melebihi jumlah halaman hasil filter (mis. user ada di halaman 5 lalu
	// memfilter sampai sisa 2 halaman), barisnya diambil ulang di bawah dengan
	// offset yang sudah dikoreksi -- kasus jarang, jadi hampir semua request
	// tetap cukup satu gelombang query.
	const optimisticOffset = (opts.page - 1) * opts.pageSize;
	const [totalRow, optimisticRows, s, maintenance, filterOptions] = await Promise.all([
		env.DB.prepare(`SELECT COUNT(*) AS n FROM activity_log ${whereSql}`)
			.bind(...args)
			.first<{ n: number }>(),
		rowsQuery(optimisticOffset),
		env.DB.prepare(
			`SELECT
			   COUNT(*) AS today,
			   SUM(CASE WHEN action = 'LOGIN' AND status = 'BERHASIL' THEN 1 ELSE 0 END) AS login,
			   SUM(CASE WHEN upper(action) LIKE '%SEND%' OR upper(action) LIKE '%KIRIM%' THEN 1 ELSE 0 END) AS sends,
			   SUM(CASE WHEN status = 'BERHASIL' THEN 1 ELSE 0 END) AS success,
			   SUM(CASE WHEN upper(status) IN ('GAGAL','ERROR') THEN 1 ELSE 0 END) AS failed
			 FROM activity_log WHERE ${statScope}`,
		)
			.bind(...statArgs)
			.first<Record<string, number>>(),
		getMaintenance(env),
		opts.facets ? getFilterOptions(env, profile, today) : Promise.resolve(null),
	]);

	const total = Number(totalRow?.n ?? 0);
	const totalPages = Math.max(Math.ceil(total / opts.pageSize), 1);
	const page = Math.min(opts.page, totalPages);
	const offset = (page - 1) * opts.pageSize;
	const rowsRes = offset === optimisticOffset ? optimisticRows : await rowsQuery(offset);

	// Frontend lama membaca baris sebagai ARRAY: [ts, user, action, status, detail, content, source].
	const rows: string[][] = (rowsRes.results ?? []).map((r) => [
		r.ts ?? "",
		r.username ?? "",
		r.action ?? "",
		r.status ?? "",
		r.detail ?? "",
		r.content ?? "",
		"HARI INI",
	]);

	const stats = {
		today: Number(s?.today ?? 0),
		login: Number(s?.login ?? 0),
		sends: Number(s?.sends ?? 0),
		success: Number(s?.success ?? 0),
		failed: Number(s?.failed ?? 0),
		found: total,
	};

	return {
		role: profile.role,
		rows,
		stats,
		maintenance,
		pagination: {
			page,
			pageSize: opts.pageSize,
			total,
			totalPages,
			hasPrev: page > 1,
			hasNext: page < totalPages,
		},
		sourceInfo: { currentTotal: total, backupTotal: 0, archiveScanned: 0, scanLimited: false },
		filterOptions,
	};
}
