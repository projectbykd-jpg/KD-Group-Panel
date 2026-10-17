// Cek kesehatan dalam: /health?deep=1. Tanpa rahasia & tanpa data pengguna -- hanya ok/gagal + lama (ms) + alasan singkat,
// supaya "panel tidak jalan" bisa dibedakan: D1/KV/Turso mati, cron Cloudflare berhenti, atau Worker sehat tapi masalah di browser.
// Dipakai pil status di Dashboard dan workflow GitHub "Penjaga panel" (.github/workflows/watchdog.yml).
import { getSys } from "./settings";
import { getTurso, tursoStatus } from "./turso";

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

export interface DeepHealth {
	ok: boolean;
	checks: Record<string, Check>;
	/** Masalah yang tidak mematikan panel tetapi membuat fitur berhenti diam-diam (mis. channel Telegram gagal posting). */
	warnings: string[];
	at: string;
}

export async function deepHealth(env: Env, nowMs = Date.now()): Promise<DeepHealth> {
	const tursoOn = !!(String(env.TURSO_URL ?? "").trim() && String(env.TURSO_TOKEN ?? "").trim());
	const warnings: string[] = [];
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
					const r = await getTurso(env)
						.prepare(`SELECT k, v FROM bot_kv WHERE k IN ('tg_channel_enabled', 'tg_channel_last_error')`)
						.all<{ k: string; v: string }>();
					const kvs: Record<string, string> = {};
					for (const x of r.results ?? []) kvs[String(x.k)] = String(x.v ?? "");
					if (kvs.tg_channel_enabled === "1" && kvs.tg_channel_last_error) {
						warnings.push("Channel Telegram tidak bisa posting: " + kvs.tg_channel_last_error.slice(0, 160));
					}
					// database cadangan: sedang dipakai? sudah pernah disalin? salinan basi?
					const ts = await tursoStatus(env);
					if (ts.active === "spare") warnings.push(`Turso utama kena kuota — panel memakai database CADANGAN sejak ${ts.spareSince || "?"}. Kembalikan lewat workflow 'Turso sinkron cadangan' (mode failback) setelah utama pulih.`);
					else if (ts.spareConfigured && !ts.spareSyncedAt) warnings.push("Database cadangan Turso belum pernah disalin — belum bisa dipakai bila utama kena kuota. Jalankan workflow 'Turso sinkron cadangan'.");
					else if (ts.spareConfigured && cronAgeMin(ts.spareSyncedAt, nowMs) !== null && (cronAgeMin(ts.spareSyncedAt, nowMs) as number) > 180) warnings.push(`Salinan database cadangan Turso basi (terakhir ${ts.spareSyncedAt}). Cek workflow 'Turso sinkron cadangan'.`);
					return ts.spareConfigured ? `aktif: ${ts.active === "spare" ? "CADANGAN" : "utama"}, cadangan disalin ${ts.spareSyncedAt || "belum pernah"}` : "aktif: utama (cadangan belum diatur)";
				})
			: Promise.resolve<Check>({ ok: true, ms: 0, note: "tidak dikonfigurasi" }),
	]);
	const checks = { d1, kv, turso, cron };
	return { ok: Object.values(checks).every((c) => c.ok), checks, warnings, at: new Date(nowMs).toISOString() };
}
