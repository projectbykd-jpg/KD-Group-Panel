/**
 * Runner Jalur Kedua (GitHub Actions) — menjalankan Auto Prediksi untuk SATU user lewat PROXY milik user itu.
 *
 * KENAPA ADA: Cloudflare Worker tidak bisa HTTPS ke admin lewat terowongan proxy (startTls di atas CONNECT/SOCKS5 selalu
 * ditutup — terbukti lewat diagnosa). Node biasa (di GitHub Actions) PUNYA TLS stack normal, dan curl mendukung SOCKS5 +
 * TLS dengan sempurna. Jadi di sini kita jalankan runAutoInput yang SAMA PERSIS dengan Worker, hanya fetch-nya lewat curl
 * --socks5-hostname ke proxy user (IP tetap yang terdaftar di admin). Logika bisnis TIDAK diduplikasi.
 *
 * Alur: minta job (aiproxy_next) -> jalankan runAutoInput lewat curl-proxy -> lapor hasil (aiproxy_done). Ulangi s/d habis.
 * Worker tetap pemegang database & aturan; runner hanya "tangan" ber-IP benar.
 *
 * Rahasia (PHPSESSID, sandi proxy) TIDAK PERNAH ditulis ke log.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAutoInput } from "../src/lib/auto-input-run";

const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const CRON_KEY = process.env.CRON_KEY || "";
const USER = (process.env.AUTOINPUT_USER || "").trim();
const MAX_JOBS = Number(process.env.AUTOINPUT_MAX_JOBS || "80");
const REQ_TIMEOUT = Number(process.env.AUTOINPUT_REQ_TIMEOUT || "30"); // detik per request admin

if (!PUBLIC_URL || !CRON_KEY || !USER) {
	console.error("::error::PUBLIC_URL / CRON_KEY / AUTOINPUT_USER wajib diisi.");
	process.exit(1);
}

type ProxyCfg = { scheme: "http" | "socks5"; host: string; port: number; user: string; pass: string };

/** fetch() seperti milik Worker, tapi lewat curl + proxy user (TLS normal). redirect:"manual" (adminReq yang mengurus redirect). */
function curlFetch(proxy: ProxyCfg) {
	return async (url: string, init: RequestInit = {}): Promise<Response> => {
		const dir = mkdtempSync(join(tmpdir(), "aip-"));
		const hdrFile = join(dir, "h");
		const bodyFile = join(dir, "b");
		const method = (init.method ?? "GET").toUpperCase();
		const proxyArg = proxy.scheme === "socks5" ? `--socks5-hostname` : `--proxy`;
		const proxyUrl = proxy.scheme === "socks5" ? `${proxy.host}:${proxy.port}` : `http://${proxy.host}:${proxy.port}`;
		const args = ["-sS", "--compressed", "--max-time", String(REQ_TIMEOUT), proxyArg, proxyUrl];
		if (proxy.user || proxy.pass) args.push("--proxy-user", `${proxy.user}:${proxy.pass}`);
		args.push("-X", method);
		const hs = new Headers(init.headers as HeadersInit | undefined);
		hs.forEach((v, k) => {
			if (!/[\r\n]/.test(v)) args.push("-H", `${k}: ${v}`);
		});
		let bodyReq = "";
		if (init.body != null && method !== "GET" && method !== "HEAD") {
			bodyReq = join(dir, "req");
			writeFileSync(bodyReq, String(init.body));
			args.push("--data-binary", `@${bodyReq}`);
		}
		args.push("-D", hdrFile, "-o", bodyFile, "-w", "%{http_code}", "--url", url);
		try {
			const code: string = await new Promise((resolve, reject) => {
				execFile("curl", args, { timeout: (REQ_TIMEOUT + 5) * 1000, maxBuffer: 16 << 20 }, (err, stdout) => {
					if (err) return reject(new Error(curlReason(err)));
					resolve(String(stdout).trim());
				});
			});
			const status = Number(code) || 0;
			if (status < 100) throw new Error("curl tidak mendapat status HTTP (proxy/tujuan bermasalah).");
			const rawHead = safeRead(hdrFile);
			const headers = new Headers();
			// Hanya blok header TERAKHIR (tanpa -L tidak ada redirect, tapi tetap aman): pisah per baris, abaikan baris status.
			for (const line of rawHead.split(/\r?\n/)) {
				const i = line.indexOf(":");
				if (i <= 0 || /^HTTP\//i.test(line)) continue;
				const name = line.slice(0, i).trim();
				// curl --compressed sudah men-decode body & panjangnya berubah -> jangan teruskan header ini (bisa menyesatkan pembaca).
				if (/^(content-encoding|content-length|transfer-encoding)$/i.test(name)) continue;
				headers.append(name, line.slice(i + 1).trim());
			}
			const body = status === 204 || status === 304 || status < 200 ? null : new Uint8Array(safeReadBuf(bodyFile));
			return new Response(body, { status, headers });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}
function curlReason(err: unknown): string {
	const m: Record<number, string> = { 5: "proxy tidak dikenal/tidak terjangkau", 7: "gagal menyambung ke proxy", 28: "waktu habis", 35: "gagal TLS ke tujuan", 97: "proxy SOCKS menolak" };
	const e = (err ?? {}) as { code?: unknown; message?: unknown };
	const c = typeof e.code === "number" ? e.code : undefined;
	return `curl gagal${c !== undefined ? ` (kode ${c}${m[c] ? ": " + m[c] : ""})` : ""}: ${String(e.message || "").split("\n").pop()?.slice(0, 160) || ""}`.trim();
}
const safeRead = (f: string): string => {
	try {
		return readFileSync(f, "utf8");
	} catch {
		return "";
	}
};
const safeReadBuf = (f: string): Buffer => {
	try {
		return readFileSync(f);
	} catch {
		return Buffer.alloc(0);
	}
};

async function api(job: string, params: Record<string, string | number | undefined>): Promise<Record<string, unknown>> {
	const u = new URL(PUBLIC_URL + "/__cron");
	u.searchParams.set("key", CRON_KEY);
	u.searchParams.set("job", job);
	for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
	const res = await fetch(u, { method: "GET" });
	const txt = await res.text();
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(txt) as Record<string, unknown>;
	} catch {
		throw new Error(`Balasan panel bukan JSON (HTTP ${res.status}): ${txt.slice(0, 120)}`);
	}
	if (!res.ok) throw new Error(`Panel menolak (HTTP ${res.status}): ${JSON.stringify(parsed).slice(0, 160)}`);
	return parsed;
}

async function main() {
	console.log(`[runner] Jalur Kedua untuk user: ${USER}`);
	let processed = 0;
	let emptyStreak = 0;
	for (let i = 0; i < MAX_JOBS; i++) {
		const res = (await api("aiproxy_next", { user: USER }).catch((e) => ({ ok: false, message: String((e as Error).message) }))) as Record<string, unknown>;
		const out = (res.result ?? res) as Record<string, unknown>; // /__cron membungkus hasil di .result
		if (!out.ok) {
			console.error(`::error::aiproxy_next gagal: ${out.message ?? JSON.stringify(out).slice(0, 160)}`);
			break;
		}
		if (out.done) {
			console.log(`[runner] Tidak ada job lagi. (${out.message ?? ""})`);
			break;
		}
		const job = out.job as null | Record<string, unknown>;
		if (!job) {
			// job dilewati di sisi Worker (mis. PHPSESSID kosong) — coba beberapa kali lalu berhenti biar tidak loop selamanya.
			if (out.note) console.log(`[runner] ${out.note}`);
			if (++emptyStreak >= 3) {
				console.log("[runner] Tidak ada job yang bisa dijalankan.");
				break;
			}
			continue;
		}
		emptyStreak = 0;
		const proxy = out.proxy as ProxyCfg;
		const fetchFn = curlFetch(proxy);
		const session = { website: String(job.website), baseUrl: String(job.baseUrl), phpsessid: String(job.phpsessid), ua: String(job.ua || "") };
		const plan = { ok: true as const, market: String(job.market), prizes: (job.prizes as string[]) ?? [], date: String(job.date), key: "" };
		const retry = !!job.retry;
		let r: Awaited<ReturnType<typeof runAutoInput>>;
		try {
			r = await runAutoInput({ session, plan, fetchFn, allowNextDay: !!out.allowNextDay, resumePeriod: retry ? String(job.period || "") || undefined : undefined });
		} catch (e) {
			r = { ok: false, stage: "cek", detail: "Runner error: " + (e instanceof Error ? e.message : String(e)).slice(0, 160), period: "" };
		}
		await api("aiproxy_done", {
			user: USER,
			jobId: Number(job.id),
			ok: r.ok ? "1" : "0",
			stage: r.stage,
			period: r.period || "",
			detail: r.detail.slice(0, 480),
			note: r.totalsNote || "",
			retry: retry ? "1" : "0",
			omset: r.totals?.omset,
			referal: r.totals?.referal,
			menang: r.totals?.menang,
		}).catch((e) => console.error(`::warning::Gagal lapor job ${job.id}: ${(e as Error).message}`));
		processed++;
		console.log(`[runner] ${session.website} ${plan.market} ${plan.prizes.join("/")} -> ${r.ok ? "BERHASIL" : "GAGAL (" + r.stage + ")"}`);
	}
	console.log(`[runner] Selesai. ${processed} job diproses.`);
}

main().catch((e) => {
	console.error(`::error::Runner berhenti: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
