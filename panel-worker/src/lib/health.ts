// Cek kesehatan dalam: /health?deep=1. Tanpa rahasia & tanpa data pengguna -- hanya ok/gagal + lama (ms) + alasan singkat,
// supaya "panel tidak jalan" bisa dibedakan: D1/KV/Turso mati, cron Cloudflare berhenti, atau Worker sehat tapi masalah di browser.
// Dipakai pil status di Dashboard dan workflow GitHub "Penjaga panel" (.github/workflows/watchdog.yml).
import { getSys } from "./settings";
import { deleteSession, loadSession } from "./session";
import { getTurso, tursoLayout, TURSO_QUOTA_RE } from "./turso";

type Check = { ok: boolean; ms: number; error?: string; note?: string };

async function timed(fn: () => Promise<string | void>, limitMs = 4000): Promise<Check> {
	const t0 = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const note = await Promise.race([
			fn(),
			new Promise<never>((_, rej) => {
				timer = setTimeout(() => rej(new Error("lebih dari " + limitMs / 1000 + " dtk (menggantung)")), limitMs);
			}),
		]);
		return note ? { ok: true, ms: Date.now() - t0, note } : { ok: true, ms: Date.now() - t0 };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, ms: Date.now() - t0, error: msg.slice(0, 200) };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Umur detak cron (menit). Detak ditulis scheduled() tiap menit sebagai "YYYY-MM-DD HH:MM:SS | cron=..." dalam WIB. */
export function cronAgeMin(raw: string | null | undefined, nowMs = Date.now()): number | null {
	const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/.exec(String(raw || ""));
	if (!m) return null;
	const t = Date.parse(m[1] + "T" + m[2] + "+07:00");
	return Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 60000)) : null;
}

/** Kategori alasan job Auto Prediksi dari Keterangan-nya (TANPA isi Keterangan: tidak ada angka/cuplikan halaman admin). */
export function autoInputWhy(detail: string, status: string): string {
	const d = String(detail || "");
	if (status === "DONE") return /\[Omset belum terbaca/.test(d) ? "dihitung, Total belum terbaca" : "dihitung + Total tercatat";
	if (status === "QUEUED") return "antre (belum dijalankan browser)";
	if (status === "RUNNING") return "sedang berjalan";
	// Urutan penting: pesan paling spesifik dulu (teks persis dari auto-input-run.ts / api/auto-input.ts).
	const rules: [RegExp, string][] = [
		[/PHPSESSID belum/i, "PHPSESSID belum disimpan"],
		[/tidak di-auto/i, "pasaran tidak di-auto"],
		[/tidak dianggap sedang login|Sesi \(PHPSESSID\) sudah habis|login\.php/i, "sesi admin habis (PHPSESSID)"],
		[/Cookie ini milik/i, "cookie website lain"],
		[/URL admin .*ditolak/i, "URL admin ditolak"],
		[/tidak ditemukan \(atau ganda\) di dropdown/i, "pasaran tidak ada di dropdown admin"],
		[/Tanggal form .* ≠ tanggal result/i, "tanggal form admin ≠ tanggal result"],
		[/Periode form .* ≠ periode terakhir/i, "periode admin tidak berurutan (terlewat/sudah terinput)"],
		[/Kolom angka sudah terisi/i, "angka sudah terisi di admin"],
		[/tidak berisi form input/i, "halaman Nomor Keluar tanpa form (pasaran diinput di halaman lain?)"],
		[/Pasaran di halaman .* ≠ pasaran result/i, "pasaran di halaman admin beda"],
		[/butuh \d+ angka/i, "jumlah prize kurang"],
		[/Halaman Nomor Keluar tidak dikenali|Tabel Daftar Nomor|Kolom Periode|Nilai Periode|Pilihan tanggal|Form dengan tombol Kirim|Kolom angka/i, "halaman Nomor Keluar tidak dikenali"],
		[/Terlalu banyak redirect|HTTP \d{3}/i, "admin menjawab HTTP galat/redirect"],
		[/waktu|timeout|menggantung|tidak menjawab|aborted|fetch failed|network/i, "admin tidak menjawab (timeout/jaringan)"],
		[/halaman Hitung|tombol Hitung/i, "gagal di tahap Hitung"],
		[/TIDAK muncul di tabel/i, "angka dikirim tapi tidak muncul"],
	];
	for (const [re, label] of rules) if (re.test(d)) return label;
	return "lain";
}

/** Bagian TEKNIS halaman admin yang diterima (HTTP, redirect, kode pasaran, judul, cuplikan isi dengan nama agen disensor). */
export function autoInputPageMeta(detail: string): string {
	const d = String(detail || "");
	const http = d.match(/HTTP (\d{3}) \[([^\]]*)\]/);
	if (!http) return "";
	const psr = d.match(/psr=(p\d+)/)?.[1];
	const pool = d.match(/pool=(\S+)/)?.[1];
	const title = d.match(/judul "([^"]{0,80})"/)?.[1];
	const extra = [d.match(/form=\d+/)?.[0], d.match(/\S+ (?:ADA|TIDAK ada) di daftar Pools/)?.[0], d.match(/heading "([^"]{1,120})"/)?.[0]].filter(Boolean).join(", ");
	// Cuplikan isi halaman: perlu untuk tahu KENAPA form tidak ada (pesan admin). Nama agen ("Agent (xxx)") & email disensor.
	const body = d.match(/isi "([^"]*)"?/)?.[1]?.replace(/Agent\s*\([^)]*\)/gi, "Agent (…)").replace(/\S+@\S+/g, "…").replace(/\s+/g, " ").trim().slice(0, 160);
	return [`HTTP ${http[1]}`, http[2] ? `redirect ${http[2].slice(0, 80)}` : "", psr ? `psr=${psr}` : "", pool ? `pool=${pool.slice(0, 40)}` : "", title !== undefined ? `judul "${title}"` : "", extra, body !== undefined ? `isi "${body}"` : ""].filter(Boolean).join(", ");
}

/** Ringkasan Auto Prediksi untuk watchdog: hanya hitungan & kategori (tanpa username, angka, PHPSESSID, atau isi halaman). */
async function autoInputSummary(env: Env): Promise<Record<string, unknown>> {
	const db = getTurso(env);
	const one = async <T>(sql: string): Promise<T | null> => {
		try {
			return (await db.prepare(sql).first<T>()) ?? null;
		} catch {
			return null;
		}
	};
	const cfg = await one<{ n_on: number; n: number }>(`SELECT SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS n_on, COUNT(*) AS n FROM auto_input_config`);
	const ses = await one<{ n: number; last: string }>(`SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM auto_input_session WHERE phpsessid <> ''`);
	let jobs: { status: string; stage: string; at: string; why: string; market: string; page?: string }[] = [];
	try {
		const r = await db.prepare(`SELECT status, stage, created_at, market, detail FROM auto_input_job WHERE result_key NOT LIKE 'manual:%' ORDER BY id DESC LIMIT 6`).all<Record<string, unknown>>();
		jobs = (r.results ?? []).map((x) => {
			const detail = String(x.detail ?? "");
			const page = autoInputPageMeta(detail);
			return { status: String(x.status), stage: String(x.stage ?? ""), at: String(x.created_at ?? ""), market: String(x.market ?? ""), why: autoInputWhy(detail, String(x.status)), ...(page ? { page } : {}) };
		});
	} catch {
		/* tabel belum ada di database aktif */
	}
	// Rekap 7 hari per tanggal WIB: kapan mulai gagal? (bandingkan dengan waktu rilis perubahan)
	let byDay: { day: string; done: number; failed: number; other: number; reasons: Record<string, number> }[] = [];
	try {
		const r = await db
			.prepare(`SELECT substr(created_at, 1, 10) AS day, status, detail, market FROM auto_input_job WHERE result_key NOT LIKE 'manual:%' ORDER BY id DESC LIMIT 400`)
			.all<Record<string, unknown>>();
		const m = new Map<string, { day: string; done: number; failed: number; other: number; reasons: Record<string, number> }>();
		for (const x of r.results ?? []) {
			const day = String(x.day ?? "");
			const st = String(x.status ?? "");
			const e = m.get(day) ?? { day, done: 0, failed: 0, other: 0, reasons: {} };
			if (st === "DONE") e.done++;
			else if (st === "FAILED") {
				e.failed++;
				const why = autoInputWhy(String(x.detail ?? ""), st) + " " + String(x.market ?? "");
				e.reasons[why] = (e.reasons[why] ?? 0) + 1;
			} else e.other++;
			m.set(day, e);
		}
		byDay = [...m.values()].sort((p, q) => (p.day < q.day ? 1 : -1)).slice(0, 8);
	} catch {
		/* tabel belum ada */
	}
	return { switchOn: Number(cfg?.n_on ?? 0), accounts: Number(cfg?.n ?? 0), sessions: Number(ses?.n ?? 0), lastSessionSaved: String(ses?.last ?? ""), lastJobs: jobs, byDay };
}

export interface DeepHealth {
	ok: boolean;
	checks: Record<string, Check>;
	/** Ringkasan Auto Prediksi (tidak mempengaruhi ok): saklar, sesi tersimpan, kategori alasan job terakhir. */
	autoInput?: Record<string, unknown>;
	/** Masalah yang tidak mematikan panel tetapi membuat fitur berhenti diam-diam (mis. channel Telegram gagal posting). */
	warnings: string[];
	at: string;
}

/**
 * Uji tulis-baca SESI login (hanya dengan ?session=1: menulis ke KV + D1, jadi tidak ikut pemeriksaan berkala watchdog).
 * Membuat sesi percobaan seperti createSession, membacanya lewat loadSession yang SAMA dengan yang dipakai tiap permintaan, lalu menghapusnya.
 * Gagal baca = persis gejala "login berhasil tapi 2 detik kemudian 'Sesi tidak valid'".
 */
async function sessionProbe(env: Env, warnings: string[]): Promise<string> {
	const token = "dg_healthprobe" + crypto.randomUUID().replace(/-/g, "");
	const now = Date.now();
	const exp = now + 120_000;
	const problems: string[] = [];
	const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 140);
	try {
		await env.DB.prepare(`INSERT OR REPLACE INTO sessions (token, username, created_at, expires_at) VALUES (?, ?, ?, ?)`).bind(token, "__health__", now, exp).run();
	} catch (e) {
		problems.push("tulis D1: " + why(e));
	}
	try {
		await env.SESS.put(token, JSON.stringify({ username: "__health__", createdAt: now, expiresAt: exp }), { expirationTtl: 60 });
	} catch (e) {
		problems.push("tulis KV: " + why(e));
	}
	let rec: Awaited<ReturnType<typeof loadSession>> = null;
	let readErr = "";
	try {
		rec = await loadSession(env, token);
	} catch (e) {
		readErr = "baca: " + why(e);
	}
	await deleteSession(env, token).catch(() => {});
	if (!rec) throw new Error(`sesi percobaan yang baru ditulis TIDAK terbaca (${[...problems, readErr].filter(Boolean).join("; ") || "tulis OK tapi baca kosong"})`);
	if (problems.length) {
		warnings.push("Penyimpanan sesi login sebagian gagal (" + problems.join("; ") + ") — sesi baru hanya tersimpan di satu tempat.");
		return "terbaca, tapi " + problems.join("; ");
	}
	return "tulis + baca KV & D1 OK";
}

export async function deepHealth(env: Env, nowMs = Date.now(), opts: { session?: boolean } = {}): Promise<DeepHealth> {
	const tursoOn = !!(String(env.TURSO_URL ?? "").trim() && String(env.TURSO_TOKEN ?? "").trim());
	const warnings: string[] = [];
	// DB 1 (utama) = BOT News, diperiksa paralel; gagal/kena kuota TIDAK mematikan panel (panel di DB 2) -> peringatan saja.
	const newsP: Promise<Check> | null = tursoOn
		? timed(async () => {
				const r = await getTurso(env)
					.prepare(`SELECT k, v FROM bot_kv WHERE k IN ('tg_channel_enabled', 'tg_channel_last_error')`)
					.all<{ k: string; v: string }>();
				const kvs: Record<string, string> = {};
				for (const x of r.results ?? []) kvs[String(x.k)] = String(x.v ?? "");
				if (kvs.tg_channel_enabled === "1" && kvs.tg_channel_last_error) {
					warnings.push("Channel Telegram tidak bisa posting: " + kvs.tg_channel_last_error.slice(0, 160));
				}
			})
		: null;
	const [d1, kv, cron, turso] = await Promise.all([
		timed(async () => void (await env.DB.prepare("SELECT 1 AS x").first())),
		timed(async () => void (await env.SESS.get("health:probe"))),
		timed(async () => {
			const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'cron_heartbeat'`).first<{ value: string }>();
			const age = cronAgeMin(row?.value, nowMs);
			const limit = await getSys(env, "sys_health_cron_stale_min");
			if (age === null) throw new Error("detak cron belum pernah tercatat");
			if (age > limit) throw new Error(`cron terakhir jalan ${age} menit lalu (batas ${limit}) — auto posting, Toto Macau & channel Telegram ikut berhenti`);
			return `${age} menit lalu`;
		}),
		tursoOn
			? timed(async () => {
					// DB 2 (cadangan) = database panel: inilah yang menentukan panel sehat atau tidak.
					await getTurso(env).prepare(`SELECT 1 AS x`).first();
					return tursoLayout(env).spareConfigured ? "panel di DB 2 (cadangan) · BOT News di DB 1 (utama)" : "satu database (utama) — DB 2 cadangan belum diatur";
				})
			: Promise.resolve<Check>({ ok: true, ms: 0, note: "tidak dikonfigurasi" }),
	]);
	const news = newsP && (await newsP);
	if (news && !news.ok) {
		const quota = TURSO_QUOTA_RE.test(news.error ?? "");
		warnings.push(
			`DB 1 (BOT News) ${quota ? "kena kuota Turso" : "gagal dibaca"}: BOT News berhenti sampai DB 1 pulih — panel tetap jalan di DB 2. (${String(news.error ?? "").slice(0, 140)})`,
		);
	}
	if (news && turso.ok) turso.note = `${turso.note} · DB 1 News: ${news.ok ? "ok" : "BERMASALAH"}`;
	const checks: Record<string, Check> = { d1, kv, turso, cron };
	if (opts.session) checks.session = await timed(() => sessionProbe(env, warnings));
	let autoInput: Record<string, unknown> | undefined;
	if (tursoOn) {
		const t = await timed(async () => void (autoInput = await autoInputSummary(env)), 6000);
		if (!t.ok) autoInput = { error: t.error };
	}
	return { ok: Object.values(checks).every((c) => c.ok), checks, warnings, autoInput, at: new Date(nowMs).toISOString() };
}
