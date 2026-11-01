/**
 * Runner Jalur Kedua Auto Check TOTO MACAU (GitHub Actions) — membaca halaman admin "Daftar Nomor ... Yang Keluar" untuk
 * website yang MENYALAKAN Jalur Kedua, lewat PROXY milik user (IP tetap yang terdaftar di admin), lalu mengirim baris
 * mentahnya ke panel. Worker yang mencocokkan ke Panel-Z & menulis database (reconcileWebsite) — logika TIDAK diduplikasi.
 *
 * KENAPA ADA: Cloudflare Worker tidak bisa HTTPS ke admin agwl lewat terowongan proxy (startTls di atas CONNECT/SOCKS5
 * selalu ditutup). Node + curl di sini punya TLS normal + dukungan SOCKS5. Hanya baca admin yang perlu proxy; Panel-Z
 * (login basic-auth terpisah) tetap dibuka Worker sendiri.
 *
 * Alur: (totoproxy_users ->) totoproxy_next (daftar website due + proxy) -> collectTotoAdminRows lewat curl-proxy ->
 * totoproxy_done (kirim baris mentah, Worker cocokkan). Rahasia (PHPSESSID, sandi proxy) TIDAK PERNAH ditulis ke log.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTotoAdminRows } from "../src/lib/toto-macau-admin";

const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const CRON_KEY = process.env.CRON_KEY || "";
const ONLY_USER = (process.env.TOTO_USER || "").trim(); // kosong = semua user Jalur Kedua (dicari lewat totoproxy_users)
const FORCE = (process.env.TOTO_FORCE || "").trim() === "1";
const REQ_TIMEOUT = Number(process.env.TOTO_REQ_TIMEOUT || "30"); // detik per request admin

if (!PUBLIC_URL || !CRON_KEY) {
	console.error("::error::PUBLIC_URL / CRON_KEY wajib diisi.");
	process.exit(1);
}

type ProxyCfg = { scheme: "http" | "socks5"; host: string; port: number; user: string; pass: string };

/** fetch() seperti milik Worker, tapi lewat curl + proxy user (TLS normal). redirect:"manual" (adminReq yang mengurus redirect). */
function curlFetch(proxy: ProxyCfg) {
	return async (url: string, init: RequestInit = {}): Promise<Response> => {
		const dir = mkdtempSync(join(tmpdir(), "toto-"));
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
			for (const line of rawHead.split(/\r?\n/)) {
				const i = line.indexOf(":");
				if (i <= 0 || /^HTTP\//i.test(line)) continue;
				const name = line.slice(0, i).trim();
				if (/^(content-encoding|content-length|transfer-encoding)$/i.test(name)) continue; // curl --compressed sudah men-decode
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

async function apiGet(job: string, params: Record<string, string | number | undefined>): Promise<Record<string, unknown>> {
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
	return (parsed.result ?? parsed) as Record<string, unknown>; // /__cron membungkus hasil di .result
}

async function apiPost(job: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const u = new URL(PUBLIC_URL + "/__cron");
	u.searchParams.set("key", CRON_KEY);
	u.searchParams.set("job", job);
	const res = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const txt = await res.text();
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(txt) as Record<string, unknown>;
	} catch {
		throw new Error(`Balasan panel bukan JSON (HTTP ${res.status}): ${txt.slice(0, 120)}`);
	}
	if (!res.ok) throw new Error(`Panel menolak (HTTP ${res.status}): ${JSON.stringify(parsed).slice(0, 160)}`);
	return (parsed.result ?? parsed) as Record<string, unknown>;
}

type ProxyWebsite = { website: string; baseUrl: string; phpsessid: string; ua: string; since: string; today: string };

async function main() {
	let users: string[] = ONLY_USER ? [ONLY_USER] : [];
	if (!users.length) {
		const r = await apiGet("totoproxy_users", {}).catch((e) => ({ ok: false, message: String((e as Error).message) }) as Record<string, unknown>);
		users = Array.isArray(r.users) ? (r.users as string[]) : [];
	}
	if (!users.length) {
		console.log("[toto-runner] Tidak ada user Jalur Kedua yang perlu diproses.");
		return;
	}
	console.log(`[toto-runner] ${users.length} user Jalur Kedua.`);
	let processed = 0;
	for (const user of users) {
		const next = await apiGet("totoproxy_next", { user, force: FORCE ? "1" : undefined }).catch((e) => ({ ok: false, message: String((e as Error).message) }) as Record<string, unknown>);
		if (!next.ok) {
			console.error(`::warning::totoproxy_next ${user}: ${next.message ?? JSON.stringify(next).slice(0, 160)}`);
			continue;
		}
		const websites = (next.websites as ProxyWebsite[]) ?? [];
		if (next.done || !websites.length) {
			console.log(`[toto-runner] ${user}: ${next.message ?? "tidak ada website due"}`);
			continue;
		}
		const proxy = next.proxy as ProxyCfg;
		const fetchFn = curlFetch(proxy);
		for (const w of websites) {
			const sess = { website: w.website, baseUrl: w.baseUrl, phpsessid: w.phpsessid, ua: w.ua || "" };
			let rows: Awaited<ReturnType<typeof collectTotoAdminRows>> = {};
			try {
				rows = await collectTotoAdminRows(fetchFn, sess, w.since);
			} catch (e) {
				console.error(`::warning::Baca admin ${w.website} gagal: ${(e as Error).message}`);
			}
			const done = await apiPost("totoproxy_done", { user, website: w.website, rows }).catch((e) => ({ ok: false, message: String((e as Error).message) }) as Record<string, unknown>);
			processed++;
			console.log(`[toto-runner] ${user} ${w.website} -> ${done.ok ? (done.summary ? JSON.stringify(done.summary) : "ok") : "GAGAL: " + (done.message ?? "?")}`);
		}
	}
	console.log(`[toto-runner] Selesai. ${processed} website diproses.`);
}

main().catch((e) => {
	console.error(`::error::Runner berhenti: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
