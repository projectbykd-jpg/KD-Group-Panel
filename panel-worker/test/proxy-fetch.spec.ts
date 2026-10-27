import { describe, expect, it } from "vitest";
import { cleanProxyInput, probeTunnel, proxyFetcher, tlsClientHello, type Connector, type Duplex } from "../src/lib/proxy-fetch";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Proxy + admin tiruan dalam memori. `serve(raw)` menerima permintaan HTTP mentah (setelah terowongan) dan memberi balasan mentah. */
function fakeNet(opts: { connectReply?: string; serve?: (raw: string) => string | Uint8Array; seen?: { connect?: string; raw?: string; starttls?: boolean; tlsHost?: string } }): Connector {
	return (_h, _p, starttls) => {
		const seen = opts.seen ?? {};
		seen.starttls = starttls;
		let ctrl!: ReadableStreamDefaultController<Uint8Array>;
		let phase: "connect" | "http" = "connect";
		let buf = "";
		const sock: Duplex = {
			readable: new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) }),
			writable: new WritableStream<Uint8Array>({
				write(chunk) {
					buf += dec.decode(chunk);
					if (phase === "connect" && buf.includes("\r\n\r\n")) {
						seen.connect = buf;
						buf = "";
						ctrl.enqueue(enc.encode(opts.connectReply ?? "HTTP/1.1 200 Connection established\r\n\r\n"));
						if (!(opts.connectReply ?? "200").includes("200")) ctrl.close();
						phase = "http";
					} else if (phase === "http" && buf.includes("\r\n\r\n")) {
						const [head, ...rest] = buf.split("\r\n\r\n");
						const cl = Number(head.match(/content-length: (\d+)/i)?.[1] ?? 0);
						if (enc.encode(rest.join("\r\n\r\n")).length >= cl) {
							seen.raw = buf;
							const out = opts.serve!(buf);
							ctrl.enqueue(typeof out === "string" ? enc.encode(out) : out);
							ctrl.close();
						}
					}
				},
			}),
			startTls: (o) => ((seen.tlsHost = o.expectedServerHostname), sock),
			close: () => undefined,
		};
		return sock;
	};
}

const cfg = { scheme: "http" as const, host: "proxy.example.net", port: 8080, user: "u1", pass: "p@ss:word" };

describe("proxyFetcher (HTTP CONNECT)", () => {
	it("GET https: terowongan CONNECT + Basic auth, TLS ke host tujuan, balasan content-length", async () => {
		const seen: Record<string, unknown> = {};
		const f = proxyFetcher(cfg, {
			connector: fakeNet({ seen, serve: () => "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nSet-Cookie: a=1; path=/\r\nSet-Cookie: koderedis=deleted; Max-Age=0\r\nContent-Length: 5\r\n\r\nhalo!" }),
		});
		const r = await f("https://agwl12.suksesbogil.com/index.php?x=1", { headers: { Cookie: "PHPSESSID=abc", "User-Agent": "UA-X", Host: "evil", "Accept-Encoding": "br" } });
		expect(r.status).toBe(200);
		expect(await r.text()).toBe("halo!");
		expect(r.headers.getSetCookie()).toEqual(["a=1; path=/", "koderedis=deleted; Max-Age=0"]);
		expect(String(seen.connect)).toMatch(/^CONNECT agwl12\.suksesbogil\.com:443 HTTP\/1\.1/);
		expect(String(seen.connect)).toContain("Proxy-Authorization: Basic " + btoa("u1:p@ss:word"));
		expect(seen.starttls).toBe(true);
		expect(seen.tlsHost).toBe("agwl12.suksesbogil.com");
		const raw = String(seen.raw);
		expect(raw).toMatch(/^GET \/index\.php\?x=1 HTTP\/1\.1\r\nHost: agwl12\.suksesbogil\.com\r\n/);
		expect(raw).toContain("cookie: PHPSESSID=abc");
		expect(raw).toContain("Accept-Encoding: identity");
		expect(raw).not.toMatch(/Host: evil/i);
		expect(raw).not.toContain("p@ss"); // kata sandi proxy tidak ikut ke admin website
	});
	it("POST: Content-Length benar + isi form; balasan chunked", async () => {
		const seen: Record<string, unknown> = {};
		const f = proxyFetcher(cfg, {
			connector: fakeNet({ seen, serve: () => "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n4\r\ndefg\r\n0\r\n\r\n" }),
		});
		const r = await f("https://x.example.com/p", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "a=1&b=é" });
		expect(await r.text()).toBe("abcdefg");
		expect(String(seen.raw)).toContain("Content-Length: 8"); // é = 2 byte
		expect(String(seen.raw).endsWith("a=1&b=é")).toBe(true);
	});
	it("redirect tidak diikuti (adminReq mengurusnya) dan Location terbaca", async () => {
		const f = proxyFetcher(cfg, { connector: fakeNet({ serve: () => "HTTP/1.1 302 Found\r\nLocation: /login.php\r\nContent-Length: 0\r\n\r\n" }) });
		const r = await f("https://x.example.com/", { redirect: "manual" });
		expect(r.status).toBe(302);
		expect(r.headers.get("location")).toBe("/login.php");
	});
	it("proxy menolak 407 -> pesan jelas TANPA kata sandi", async () => {
		const f = proxyFetcher(cfg, { connector: fakeNet({ connectReply: "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n" }) });
		const err = await f("https://x.example.com/").catch((e) => e as Error);
		expect(String((err as Error).message)).toMatch(/user\/kata sandi proxy salah \(HTTP 407\)/);
		expect(String((err as Error).message)).not.toContain("p@ss");
	});
	it("tidak menjawab -> galat batas waktu", async () => {
		const hang: Connector = () => ({ readable: new ReadableStream<Uint8Array>({}), writable: new WritableStream<Uint8Array>({}), close: () => undefined });
		const f = proxyFetcher(cfg, { connector: hang, timeoutMs: 50 });
		await expect(f("https://x.example.com/")).rejects.toThrow(/tidak menjawab dalam/);
	});
});

describe("proxyFetcher (SOCKS5)", () => {
	it("handshake user/pass lalu domain tujuan, kemudian HTTP biasa", async () => {
		const sent: number[][] = [];
		const connector: Connector = (_h, _p, _tls) => {
			let ctrl!: ReadableStreamDefaultController<Uint8Array>;
			let step = 0;
			let httpBuf = "";
			const sock: Duplex = {
				readable: new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) }),
				writable: new WritableStream<Uint8Array>({
					write(chunk) {
						if (step < 3) sent.push([...chunk]);
						if (step === 0) ctrl.enqueue(Uint8Array.from([5, 2]));
						else if (step === 1) ctrl.enqueue(Uint8Array.from([1, 0]));
						else if (step === 2) ctrl.enqueue(Uint8Array.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
						else {
							httpBuf += dec.decode(chunk);
							if (httpBuf.includes("\r\n\r\n")) {
								ctrl.enqueue(enc.encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"));
								ctrl.close();
							}
						}
						step++;
					},
				}),
				startTls: () => sock,
				close: () => undefined,
			};
			return sock;
		};
		const f = proxyFetcher({ ...cfg, scheme: "socks5", user: "ab", pass: "cd" }, { connector });
		const r = await f("https://host.test/x");
		expect(await r.text()).toBe("ok");
		expect(sent[0]).toEqual([5, 2, 0, 2]);
		expect(sent[1]).toEqual([1, 2, 97, 98, 2, 99, 100]);
		expect(sent[2].slice(0, 5)).toEqual([5, 1, 0, 3, 9]); // domain "host.test"
		expect(sent[2].slice(-2)).toEqual([1, 187]); // port 443
	});
});

describe("cleanProxyInput", () => {
	it("menerima host & port terpisah, host:port:user:pass, dan URL berformat user:pass@host:port", () => {
		expect(cleanProxyInput({ host: "1.2.3.4", port: 8000, user: "a", pass: "b" })).toMatchObject({ ok: true, cfg: { host: "1.2.3.4", port: 8000, user: "a", pass: "b", scheme: "http" } });
		expect(cleanProxyInput({ host: "p.example.com:3128:usr:pw" })).toMatchObject({ ok: true, cfg: { host: "p.example.com", port: 3128, user: "usr", pass: "pw" } });
		expect(cleanProxyInput({ host: "http://usr:pw@p.example.com:3128" })).toMatchObject({ ok: true, cfg: { host: "p.example.com", port: 3128, user: "usr", pass: "pw" } });
		expect(cleanProxyInput({ scheme: "SOCKS5", host: "p.example.com", port: "1080" })).toMatchObject({ ok: true, cfg: { scheme: "socks5", port: 1080 } });
	});
	it("menolak host/port tak wajar, alamat privat, dan baris baru", () => {
		expect(cleanProxyInput({ host: "bad host", port: 80 }).ok).toBe(false);
		expect(cleanProxyInput({ host: "p.example.com", port: 70000 }).ok).toBe(false);
		expect(cleanProxyInput({ host: "127.0.0.1", port: 80 }).ok).toBe(false);
		expect(cleanProxyInput({ host: "192.168.1.5", port: 80 }).ok).toBe(false);
		expect(cleanProxyInput({ host: "p.example.com", port: 80, user: "a\r\nX: y" }).ok).toBe(false);
	});
});

describe("diagnostik terowongan (byte mentah)", () => {
	it("tlsClientHello: header rekaman TLS & panjang konsisten, memuat SNI", () => {
		const b = tlsClientHello("www.google.com");
		expect(b[0]).toBe(0x16);
		expect((b[3] << 8) | b[4]).toBe(b.length - 5);
		expect(b[5]).toBe(1); // ClientHello
		expect(dec.decode(b)).toContain("www.google.com");
	});
	const rawNet = (reply: Uint8Array | null): { c: Connector; got: Uint8Array[] } => {
		const got: Uint8Array[] = [];
		const c: Connector = () => {
			let ctrl!: ReadableStreamDefaultController<Uint8Array>;
			let connected = false;
			const sock: Duplex = {
				readable: new ReadableStream<Uint8Array>({ start: (x) => void (ctrl = x) }),
				writable: new WritableStream<Uint8Array>({
					write(chunk) {
						if (!connected) {
							connected = true;
							ctrl.enqueue(enc.encode("HTTP/1.1 200 OK\r\n\r\n"));
						} else {
							got.push(chunk);
							if (reply) ctrl.enqueue(reply);
							else ctrl.close();
						}
					},
				}),
				close: () => undefined,
			};
			return sock;
		};
		return { c, got };
	};
	it("ada balasan -> dilaporkan byte + 5 byte awal; ditutup -> 'tanpa balasan'", async () => {
		const ok = rawNet(Uint8Array.from([0x16, 3, 3, 0, 2, 9, 9]));
		expect(await probeTunnel(cfg, "x.test", 443, tlsClientHello("x.test"), { connector: ok.c })).toBe("balasan 7 byte (awal: 16 03 03 00 02)");
		expect(ok.got[0][0]).toBe(0x16);
		const closed = rawNet(null);
		expect(await probeTunnel(cfg, "x.test", 443, tlsClientHello("x.test"), { connector: closed.c })).toBe("koneksi ditutup tanpa balasan");
	});
});
