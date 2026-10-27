// Jalur kedua ke admin website: permintaan HTTPS dikirim LEWAT PROXY milik user (IP tetap yang didaftarkan di admin website).
// Alasan: admin agwl mematikan sesi bila dipakai dari IP selain IP login, sedangkan IP Cloudflare Worker berpindah-pindah.
// Cloudflare Worker tidak bisa memakai proxy lewat fetch(), jadi di sini sambungan TCP dibuka sendiri (cloudflare:sockets):
//   Worker --TCP--> proxy --(CONNECT host:443 / SOCKS5)--> admin website, lalu TLS + HTTP/1.1 dijalankan di atas terowongan itu.
// Hanya dipakai bila user menyalakannya di menu Auto Prediksi > Jalur Kedua. Kata sandi proxy tidak pernah masuk pesan galat/log.
import type { Fetcher } from "./auto-input-run";

export interface ProxyConfig {
	scheme: "http" | "socks5";
	host: string;
	port: number;
	user: string;
	pass: string;
}

/** Soket minimal (cocok dengan Socket cloudflare:sockets) supaya bisa diuji tanpa jaringan. */
export interface Duplex {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	startTls?: (opts: { expectedServerHostname: string }) => Duplex;
	close: () => Promise<void> | void;
}
export type Connector = (host: string, port: number, starttls: boolean) => Duplex;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// Validasi input
// ---------------------------------------------------------------------------
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function cleanProxyInput(raw: { scheme?: unknown; host?: unknown; port?: unknown; user?: unknown; pass?: unknown }): { ok: true; cfg: Omit<ProxyConfig, "pass"> & { pass: string } } | { ok: false; error: string } {
	const scheme = String(raw.scheme ?? "http").toLowerCase() === "socks5" ? "socks5" : "http";
	let host = String(raw.host ?? "").trim();
	let port = Number(raw.port);
	// boleh menempel "host:port" atau "host:port:user:pass" atau "http://user:pass@host:port" di kolom Host
	let user = String(raw.user ?? "").trim();
	let pass = String(raw.pass ?? "");
	const m1 = host.match(/^(?:(?:https?|socks5h?):\/\/)?(?:([^:@/\s]+):([^@/\s]*)@)?([^:/\s]+):(\d{1,5})\/?$/i);
	const m2 = host.match(/^([^:/\s]+):(\d{1,5}):([^:\s]+):(\S+)$/);
	if (m2) {
		host = m2[1];
		port = Number(m2[2]);
		user = user || m2[3];
		pass = pass || m2[4];
	} else if (m1) {
		host = m1[3];
		port = Number(m1[4]);
		user = user || m1[1] || "";
		pass = pass || m1[2] || "";
	}
	if (!HOST_RE.test(host)) return { ok: false, error: "Host proxy tidak valid (isi nama host atau IP, tanpa spasi)." };
	if (/^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(host)) return { ok: false, error: "Host proxy harus alamat publik." };
	if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "Port proxy harus angka 1-65535." };
	if (user.length > 200 || pass.length > 200) return { ok: false, error: "User/kata sandi proxy terlalu panjang." };
	if (/[\r\n]/.test(user + pass)) return { ok: false, error: "User/kata sandi proxy tidak boleh berisi baris baru." };
	return { ok: true, cfg: { scheme, host, port, user, pass } };
}

// ---------------------------------------------------------------------------
// Pembaca byte berpenyangga di atas ReadableStream
// ---------------------------------------------------------------------------
class ByteReader {
	private buf = new Uint8Array(0);
	private done = false;
	constructor(private r: ReadableStreamDefaultReader<Uint8Array>) {}
	private append(c: Uint8Array) {
		const n = new Uint8Array(this.buf.length + c.length);
		n.set(this.buf, 0);
		n.set(c, this.buf.length);
		this.buf = n;
	}
	private async fill(): Promise<boolean> {
		if (this.done) return false;
		const { value, done } = await this.r.read();
		if (done || !value) {
			this.done = true;
			return false;
		}
		this.append(value);
		return true;
	}
	async readUntil(delim: string, max = 1 << 20): Promise<Uint8Array | null> {
		const d = enc.encode(delim);
		for (;;) {
			const i = indexOf(this.buf, d);
			if (i >= 0) {
				const out = this.buf.slice(0, i);
				this.buf = this.buf.slice(i + d.length);
				return out;
			}
			if (this.buf.length > max) throw new Error("Balasan terlalu besar/tidak wajar.");
			if (!(await this.fill())) return null;
		}
	}
	async readExact(n: number): Promise<Uint8Array> {
		while (this.buf.length < n) if (!(await this.fill())) throw new Error("Koneksi putus sebelum balasan lengkap.");
		const out = this.buf.slice(0, n);
		this.buf = this.buf.slice(n);
		return out;
	}
	async readAll(max = 8 << 20): Promise<Uint8Array> {
		while (await this.fill()) if (this.buf.length > max) throw new Error("Balasan terlalu besar.");
		const out = this.buf;
		this.buf = new Uint8Array(0);
		return out;
	}
	/** Sisa byte di penyangga (harus kosong sebelum startTls). */
	pending(): number {
		return this.buf.length;
	}
	release() {
		this.r.releaseLock();
	}
}
function indexOf(h: Uint8Array, n: Uint8Array): number {
	outer: for (let i = 0; i + n.length <= h.length; i++) {
		for (let j = 0; j < n.length; j++) if (h[i + j] !== n[j]) continue outer;
		return i;
	}
	return -1;
}
const concat = (...p: Uint8Array[]) => {
	const out = new Uint8Array(p.reduce((a, b) => a + b.length, 0));
	let o = 0;
	for (const x of p) (out.set(x, o), (o += x.length));
	return out;
};
const b64 = (s: string) => btoa(String.fromCharCode(...enc.encode(s)));

// ---------------------------------------------------------------------------
// Terowongan: HTTP CONNECT atau SOCKS5
// ---------------------------------------------------------------------------
async function tunnelHttp(sock: Duplex, cfg: ProxyConfig, host: string, port: number): Promise<void> {
	const w = sock.writable.getWriter();
	const r = new ByteReader(sock.readable.getReader());
	try {
		const auth = cfg.user || cfg.pass ? `Proxy-Authorization: Basic ${b64(`${cfg.user}:${cfg.pass}`)}\r\n` : "";
		await w.write(enc.encode(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}Proxy-Connection: keep-alive\r\n\r\n`));
		const head = await r.readUntil("\r\n\r\n", 16 << 10);
		if (!head) throw new Error("Proxy menutup koneksi tanpa menjawab.");
		const line = dec.decode(head).split("\r\n")[0];
		const code = Number(line.split(" ")[1]);
		if (code !== 200) {
			if (code === 407) throw new Error("Proxy menolak: user/kata sandi proxy salah (HTTP 407).");
			if (code === 403) throw new Error("Proxy menolak (HTTP 403): tujuan/IP asal tidak diizinkan oleh penyedia proxy.");
			throw new Error(`Proxy menolak membuat terowongan (${line.slice(0, 60)}).`);
		}
		if (r.pending()) throw new Error("Proxy mengirim data tak terduga sebelum TLS.");
	} finally {
		w.releaseLock();
		r.release();
	}
}

async function tunnelSocks5(sock: Duplex, cfg: ProxyConfig, host: string, port: number): Promise<void> {
	const w = sock.writable.getWriter();
	const r = new ByteReader(sock.readable.getReader());
	try {
		const useAuth = !!(cfg.user || cfg.pass);
		await w.write(Uint8Array.from(useAuth ? [5, 2, 0, 2] : [5, 1, 0]));
		const m = await r.readExact(2);
		if (m[0] !== 5) throw new Error("Server di alamat itu bukan proxy SOCKS5.");
		if (m[1] === 0xff) throw new Error("Proxy SOCKS5 menolak metode login yang ditawarkan.");
		if (m[1] === 2) {
			const u = enc.encode(cfg.user), p = enc.encode(cfg.pass);
			if (u.length > 255 || p.length > 255) throw new Error("User/kata sandi proxy terlalu panjang untuk SOCKS5.");
			await w.write(concat(Uint8Array.from([1, u.length]), u, Uint8Array.from([p.length]), p));
			const a = await r.readExact(2);
			if (a[1] !== 0) throw new Error("Proxy menolak: user/kata sandi proxy salah.");
		}
		const h = enc.encode(host);
		await w.write(concat(Uint8Array.from([5, 1, 0, 3, h.length]), h, Uint8Array.from([port >> 8, port & 255])));
		const rep = await r.readExact(4);
		if (rep[1] !== 0) {
			const why: Record<number, string> = { 2: "tidak diizinkan aturan proxy", 3: "jaringan tujuan tidak terjangkau", 4: "host tujuan tidak terjangkau", 5: "tujuan menolak sambungan" };
			throw new Error(`Proxy SOCKS5 gagal membuat sambungan (${why[rep[1]] ?? "kode " + rep[1]}).`);
		}
		// buang alamat terikat (BND.ADDR + BND.PORT)
		if (rep[3] === 1) await r.readExact(4 + 2);
		else if (rep[3] === 4) await r.readExact(16 + 2);
		else await r.readExact((await r.readExact(1))[0] + 2);
	} finally {
		w.releaseLock();
		r.release();
	}
}

// ---------------------------------------------------------------------------
// HTTP/1.1 di atas terowongan
// ---------------------------------------------------------------------------
const SKIP_REQ = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding", "proxy-authorization"]);

async function gunzip(data: Uint8Array, format: "gzip" | "deflate"): Promise<Uint8Array> {
	const ds = new DecompressionStream(format);
	const out = new Response(new Blob([data]).stream().pipeThrough(ds));
	return new Uint8Array(await out.arrayBuffer());
}

async function readChunked(r: ByteReader): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	for (;;) {
		const line = await r.readUntil("\r\n");
		if (line === null) throw new Error("Koneksi putus di tengah balasan.");
		const size = parseInt(dec.decode(line).split(";")[0].trim(), 16);
		if (!Number.isFinite(size) || size < 0) throw new Error("Balasan chunked tidak valid.");
		if (size === 0) {
			// trailer sampai baris kosong
			for (;;) {
				const t = await r.readUntil("\r\n");
				if (t === null || t.length === 0) break;
			}
			return concat(...parts);
		}
		parts.push(await r.readExact(size));
		await r.readExact(2);
	}
}

export interface ProxyFetchOpts {
	connector?: Connector;
	timeoutMs?: number;
}

async function defaultConnector(): Promise<Connector> {
	const { connect } = await import("cloudflare:sockets");
	return (host, port, starttls) => connect({ hostname: host, port }, { secureTransport: starttls ? "starttls" : "off", allowHalfOpen: false }) as unknown as Duplex;
}

/** Fetcher yang meneruskan SETIAP permintaan lewat proxy. Satu sambungan baru per permintaan (Connection: close). */
export function proxyFetcher(cfg: ProxyConfig, opts: ProxyFetchOpts = {}): Fetcher {
	return async (url, init = {}) => {
		const u = new URL(url);
		const isTls = u.protocol === "https:";
		const port = Number(u.port) || (isTls ? 443 : 80);
		const connector = opts.connector ?? (await defaultConnector());
		const timeoutMs = opts.timeoutMs ?? 25_000;
		const socks: { base?: Duplex; conn?: Duplex; stage: string } = { stage: "menyambung ke proxy" };
		const run = async (): Promise<Response> => {
			const base = (socks.base = connector(cfg.host, cfg.port, isTls));
			socks.stage = "login & terowongan proxy";
			if (cfg.scheme === "socks5") await tunnelSocks5(base, cfg, u.hostname, port);
			else await tunnelHttp(base, cfg, u.hostname, port);
			socks.stage = isTls ? "TLS/HTTP ke tujuan (terowongan proxy sudah berhasil)" : "HTTP ke tujuan";
			const conn = (socks.conn = isTls ? (base.startTls ? base.startTls({ expectedServerHostname: u.hostname }) : base) : base);
			const method = (init.method ?? "GET").toUpperCase();
			const body = init.body == null ? "" : String(init.body);
			const lines = [`${method} ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`];
			const hs = new Headers(init.headers as HeadersInit | undefined);
			hs.forEach((v, k) => {
				if (!SKIP_REQ.has(k.toLowerCase()) && !/[\r\n]/.test(v)) lines.push(`${k}: ${v}`);
			});
			lines.push("Accept-Encoding: identity", "Connection: close");
			if (body || method === "POST") lines.push(`Content-Length: ${enc.encode(body).length}`);
			const w = conn.writable.getWriter();
			await w.write(enc.encode(lines.join("\r\n") + "\r\n\r\n" + body));
			w.releaseLock();
			const r = new ByteReader(conn.readable.getReader());
			const head = await r.readUntil("\r\n\r\n", 64 << 10);
			if (!head) throw new Error("Tujuan/proxy menutup koneksi tanpa menjawab (proxy mungkin hanya mengizinkan domain tertentu, atau memblokir permintaan dari Cloudflare).");
			const hl = dec.decode(head).split("\r\n");
			const status = Number(hl[0].split(" ")[1]);
			if (!Number.isInteger(status) || status < 100) throw new Error("Balasan admin website tidak valid.");
			const headers = new Headers();
			for (const l of hl.slice(1)) {
				const i = l.indexOf(":");
				if (i > 0) headers.append(l.slice(0, i).trim(), l.slice(i + 1).trim());
			}
			let data: Uint8Array;
			if (method === "HEAD" || status === 204 || status === 304 || status < 200) data = new Uint8Array(0);
			else if (/chunked/i.test(headers.get("transfer-encoding") ?? "")) data = await readChunked(r);
			else if (headers.has("content-length")) data = await r.readExact(Number(headers.get("content-length")) || 0);
			else data = await r.readAll();
			const ce = (headers.get("content-encoding") ?? "").toLowerCase();
			if (ce === "gzip" || ce === "deflate") {
				data = await gunzip(data, ce);
				headers.delete("content-encoding");
			}
			headers.delete("transfer-encoding");
			headers.set("content-length", String(data.length));
			return new Response(status === 204 || status === 304 || status < 200 ? null : data, { status: status < 200 ? 502 : status, headers });
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				run(),
				new Promise<Response>((_, rej) => {
					timer = setTimeout(() => rej(new Error(`Proxy/admin website tidak menjawab dalam ${Math.round(timeoutMs / 1000)} detik.`)), timeoutMs);
				}),
			]);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(`${msg} [tahap: ${socks.stage}]`);
		} finally {
			if (timer) clearTimeout(timer);
			try {
				await (socks.conn ?? socks.base)?.close();
			} catch {
				/* sudah tertutup */
			}
		}
	};
}
