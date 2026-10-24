// Gerbang DB 1 (BOT News) -- perintah pemilik 25 Okt 2026: "jangan spam kalau sudah terdeteksi DB 1 limit ... test 1 hari 1
// kali saja ... kalau berhasil jalan maka lanjutkan terus".
//
// Dulu, saat DB 1 (Turso utama, khusus BOT News) kena kuota, SETIAP tick tetap mencoba: cron-job.org memicu workflow
// "BOT NEWS turbo" tiap 10 menit (run merah, mengantre di GitHub Actions), cron Cloudflare membaca bot_kv tiap 5 menit
// (galat berulang), dan /health?deep=1 memperingatkan tiap 5 menit sehingga "Penjaga panel" merah terus.
//
// Sekarang: galat KUOTA pertama dari DB 1 menutup gerbang (disimpan di DB 2, jadi terbaca worker DAN skrip GitHub Actions).
// Selama tertutup, semua jalur otomatis BOT News dilewati tanpa menyentuh DB 1. Sekali per `sys_db1_probe_hours` (bawaan 24
// jam) satu pemanggil -- siapa pun yang pertama sampai (cron, pemicu turbo, /health) -- menguji DB 1 dengan satu baca kecil:
// berhasil -> gerbang dibuka, BOT News langsung Online lagi; masih kuota -> coba lagi periode berikutnya.
// Galat BUKAN kuota (jaringan putus sesaat) tidak pernah menutup gerbang; saat uji harian, galat begitu dicoba lagi 1 jam lagi.
// Tanpa DB 2 (dev/test) gerbang tidak dipakai: penandanya sendiri akan tersimpan di DB 1 yang sedang diblokir.
import { getSys } from "./settings";
import { getTurso, spareConfigured, takePrimaryQuotaError, TURSO_QUOTA_RE, tursoGeneration } from "./turso";

const TABLE = "turso_db1_gate";
const RETRY_NON_QUOTA_MS = 3600_000;

export type Db1Gate =
	| { open: true; recovered?: boolean }
	| { open: false; since: string; nextProbeAt: number; error: string; message: string };

interface Row {
	since: string;
	next_probe_at: number;
	last_error: string;
}

let tableGen = -1;
async function ensureTable(env: Env): Promise<void> {
	if (tableGen === tursoGeneration()) return;
	await getTurso(env)
		.prepare(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), since TEXT NOT NULL, next_probe_at INTEGER NOT NULL, last_error TEXT NOT NULL DEFAULT '')`)
		.run();
	tableGen = tursoGeneration();
}

/** Hanya untuk test. */
export function resetDb1GateForTest(): void {
	tableGen = -1;
}

const wib = (ms: number) => new Date(ms + 7 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const isDb1Quota = (e: unknown): boolean => TURSO_QUOTA_RE.test(errText(e));

function closed(r: Row): Db1Gate {
	return {
		open: false,
		since: r.since,
		nextProbeAt: Number(r.next_probe_at),
		error: r.last_error,
		message: `BOT News dijeda: DB 1 kena kuota Turso sejak ${r.since} WIB. Diuji otomatis lagi ±${wib(Number(r.next_probe_at))} WIB — panel lain tetap jalan di DB 2.`,
	};
}

async function readRow(env: Env): Promise<Row | null> {
	await ensureTable(env);
	return (await getTurso(env).prepare(`SELECT since, next_probe_at, last_error FROM ${TABLE} WHERE id = 1`).first<Row>()) ?? null;
}

async function probeIntervalMs(env: Env): Promise<number> {
	return (await getSys(env, "sys_db1_probe_hours")) * 3600_000;
}

/**
 * Tutup gerbang bila `e` adalah galat kuota DB 1. Sudah tertutup -> jadwal uji tidak dimundurkan. true = gerbang (kini) tertutup.
 * Gagal menulis penanda (DB 2 bermasalah) tidak boleh menutupi galat aslinya -> diam.
 */
export async function db1MarkBlocked(env: Env, e: unknown, nowMs = Date.now()): Promise<boolean> {
	if (!spareConfigured(env) || !isDb1Quota(e)) return false;
	try {
		await ensureTable(env);
		await getTurso(env)
			.prepare(`INSERT INTO ${TABLE} (id, since, next_probe_at, last_error) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_error = excluded.last_error`)
			.bind(wib(nowMs), nowMs + (await probeIntervalMs(env)), errText(e).slice(0, 300))
			.run();
		return true;
	} catch {
		return false;
	}
}

/**
 * Panggil SESUDAH menjalankan pekerjaan BOT News: bila selama itu DB 1 menolak karena kuota (dicatat lib/turso.ts, apa pun
 * bentuk galat yang akhirnya dilempar pemanggil), gerbang ditutup. true = baru saja/masih tertutup karena galat itu.
 */
export async function db1Settle(env: Env, nowMs = Date.now()): Promise<boolean> {
	const e = takePrimaryQuotaError();
	return e ? db1MarkBlocked(env, new Error(e), nowMs) : false;
}

/**
 * Boleh menyentuh DB 1 sekarang? Tertutup & belum waktunya -> tidak (tanpa menyentuh DB 1). Waktunya uji -> SATU pemanggil
 * mengklaim uji (UPDATE bersyarat, aman dari tick paralel), membaca bot_kv sekali, lalu membuka/menutup gerbang.
 * `force` (tombol manual pemilik) menguji sekarang juga tanpa menunggu jadwal.
 * Penanda tidak terbaca (DB 2 bermasalah) -> dianggap terbuka: perilaku lama, BOT News tidak ikut berhenti karena gerbangnya.
 */
export async function db1Gate(env: Env, opts: { force?: boolean; nowMs?: number } = {}): Promise<Db1Gate> {
	if (!spareConfigured(env)) return { open: true };
	const now = opts.nowMs ?? Date.now();
	let row: Row | null;
	try {
		row = await readRow(env);
	} catch {
		return { open: true };
	}
	if (!row) return { open: true };
	if (!opts.force && now < Number(row.next_probe_at)) return closed(row);
	const db = getTurso(env);
	const claimed = await db
		.prepare(`UPDATE ${TABLE} SET next_probe_at = ? WHERE id = 1 AND next_probe_at = ?`)
		.bind(now + (await probeIntervalMs(env)), Number(row.next_probe_at))
		.run()
		.catch(() => null);
	if (!claimed || claimed.meta.changes !== 1) return closed((await readRow(env).catch(() => null)) ?? row);
	try {
		await db.prepare(`SELECT k FROM bot_kv LIMIT 1`).first();
	} catch (e) {
		takePrimaryQuotaError(); // sudah ditangani di sini
		const quota = isDb1Quota(e);
		const next = quota ? now + (await probeIntervalMs(env)) : now + RETRY_NON_QUOTA_MS;
		await db
			.prepare(`UPDATE ${TABLE} SET next_probe_at = ?, last_error = ? WHERE id = 1`)
			.bind(next, errText(e).slice(0, 300))
			.run()
			.catch(() => {});
		return closed({ since: row.since, next_probe_at: next, last_error: errText(e).slice(0, 300) });
	}
	await db.prepare(`DELETE FROM ${TABLE} WHERE id = 1`).run().catch(() => {});
	return { open: true, recovered: true };
}

/** Status untuk /health & admin TANPA menguji DB 1 (hanya baca penanda di DB 2). */
export async function db1GatePeek(env: Env): Promise<Db1Gate> {
	if (!spareConfigured(env)) return { open: true };
	try {
		const row = await readRow(env);
		return row ? closed(row) : { open: true };
	} catch {
		return { open: true };
	}
}
