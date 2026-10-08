#!/usr/bin/env node
// Agent Live Chat Auto-Reply (TANPA browser / Tampermonkey).
//
// Logika sama persis dengan userscripts/daylivechat-autobot.user.js, tetapi berjalan sebagai program
// Node.js di komputer yang IP-nya SUDAH diizinkan DayLiveChat (login CS dikunci ke IP tertentu, jadi
// program ini TIDAK bisa jalan dari server/Cloudflare). Login memakai email+password CS dari file .env
// LOKAL (tidak pernah dikirim ke panel), lalu: REST /api/chats/inbox, Socket.IO (auth token), dan
// melapor ke panel lewat LIVECHAT_BOT_KEY. Lihat README.md.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

const DIR = dirname(fileURLToPath(import.meta.url));

// ---------- konfigurasi (.env lokal + variabel lingkungan) ----------
function loadEnvFile(path) {
	if (!existsSync(path)) return {};
	const out = {};
	for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const i = line.indexOf("=");
		if (i < 1) continue;
		let v = line.slice(i + 1).trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		out[line.slice(0, i).trim()] = v;
	}
	return out;
}
const ENV = { ...loadEnvFile(join(DIR, ".env")), ...process.env };
const CFG = {
	panelUrl: String(ENV.PANEL_URL || "https://panel-worker.projectbykd.workers.dev").replace(/\/+$/, ""),
	botKey: String(ENV.BOT_KEY || ""),
	base: String(ENV.LC_BASE || "https://daylivechat.com").replace(/\/+$/, ""),
	email: String(ENV.LC_EMAIL || ""),
	password: String(ENV.LC_PASSWORD || ""),
	ua: String(ENV.LC_UA || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"),
	tickMs: Number(ENV.TICK_MS || 5000),
};

// Toleransi/antar-balasan: HARUS sama dengan userscript.
const GRACE_MS = 30_000;
const BURST_RESET_MS = 90_000;

export function log(msg) {
	console.log("[" + new Date().toLocaleTimeString("id-ID", { hour12: false }) + "] " + msg);
}

// ---------- state ringan (anti-balas ganda setelah restart) ----------
const STATE_FILE = join(DIR, "agent-state.json");
let REPLIED = {};
try {
	REPLIED = JSON.parse(readFileSync(STATE_FILE, "utf8")).replied || {};
} catch {
	REPLIED = {};
}
function saveReplied() {
	const keys = Object.keys(REPLIED);
	if (keys.length > 500) {
		keys.sort((a, b) => (REPLIED[a] || 0) - (REPLIED[b] || 0)).slice(0, keys.length - 500).forEach((k) => delete REPLIED[k]);
	}
	try {
		writeFileSync(STATE_FILE, JSON.stringify({ replied: REPLIED }));
	} catch {
		/* disk read-only: abaikan, hanya kehilangan dedupe lintas-restart */
	}
}

// ---------- login DayLiveChat ----------
let token = "";

/** Cari token di balasan login tanpa menebak satu nama field saja. */
export function findToken(o, depth = 0) {
	if (!o || typeof o !== "object" || depth > 4) return "";
	for (const k of ["token", "accessToken", "access_token", "jwt", "lc_token"]) if (typeof o[k] === "string" && o[k].length > 20) return o[k];
	for (const [k, v] of Object.entries(o)) {
		if (/token/i.test(k) && typeof v === "string" && v.length > 20) return v;
		if (v && typeof v === "object") {
			const t = findToken(v, depth + 1);
			if (t) return t;
		}
	}
	return "";
}

let lastLoginAt = 0;
let loginFails = 0;
let loginInflight = null;
async function login(force = false) {
	if (!force && token) return token;
	if (loginInflight) return loginInflight;
	// Jangan menggedor login (bisa mengunci akun): jeda makin panjang tiap gagal, maks 5 menit.
	const wait = Math.min(300_000, 15_000 * 2 ** Math.max(0, loginFails - 1));
	if (loginFails && Date.now() - lastLoginAt < wait) return "";
	loginInflight = (async () => {
		lastLoginAt = Date.now();
		try {
			const res = await fetch(CFG.base + "/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json", accept: "*/*", origin: CFG.base, referer: CFG.base + "/login", "user-agent": CFG.ua },
				body: JSON.stringify({ email: CFG.email, password: CFG.password }),
			});
			const text = await res.text();
			let body = null;
			try {
				body = JSON.parse(text);
			} catch {
				body = null;
			}
			if (res.status === 403) throw new Error("Login ditolak 403 (" + String((body && (body.message || body.error)) || text).slice(0, 120) + ") -- kemungkinan IP komputer ini belum diizinkan DayLiveChat. Jalankan di komputer/jaringan CS yang biasa dipakai login.");
			if (!res.ok) throw new Error("Login gagal HTTP " + res.status + ": " + String((body && (body.message || body.error)) || text).slice(0, 120));
			const t = findToken(body);
			if (!t) throw new Error("Login berhasil tetapi token tidak ditemukan di balasan. Field yang ada: " + (body && typeof body === "object" ? Object.keys(body).join(", ") : "(bukan JSON)") + ". Kirim daftar field ini ke pengembang.");
			token = t;
			loginFails = 0;
			log("Login DayLiveChat berhasil.");
			return token;
		} catch (e) {
			loginFails += 1;
			token = "";
			log("Login gagal: " + (e instanceof Error ? e.message : e) + " (coba lagi nanti)");
			return "";
		} finally {
			loginInflight = null;
		}
	})();
	return loginInflight;
}

async function lcFetch(path) {
	const t = await login();
	if (!t) return null;
	let res = await fetch(CFG.base + path, { headers: { authorization: "Bearer " + t, "user-agent": CFG.ua } });
	if (res.status === 401 || res.status === 403) {
		// token kedaluwarsa/dicabut -> login ulang sekali
		token = "";
		const t2 = await login(true);
		if (!t2) return null;
		res = await fetch(CFG.base + path, { headers: { authorization: "Bearer " + t2, "user-agent": CFG.ua } });
	}
	return res;
}

// ---------- panel ----------
async function panelApi(action, body) {
	try {
		const r = await fetch(CFG.panelUrl + "/api", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action, key: CFG.botKey, ...(body || {}) }),
		});
		return await r.json();
	} catch (e) {
		log("Panel error: " + (e instanceof Error ? e.message : e));
		return null;
	}
}

// ---------- inbox & template ----------
const inboxCache = new Map();
async function refreshInbox() {
	try {
		const res = await lcFetch("/api/chats/inbox");
		if (!res || !res.ok) return;
		const rows = await res.json();
		if (!Array.isArray(rows)) return;
		const syncRows = [];
		for (const r of rows) {
			inboxCache.set(String(r.id), r);
			syncRows.push({ sessionKey: String(r.id), queueCode: r.queue_code || "", customerName: r.visitor_display_name || r.queue_code || "", divisi: r.division_name || "" });
		}
		await panelApi("livechatBotSync", { rows: syncRows });
	} catch (e) {
		log("Sync inbox gagal: " + (e instanceof Error ? e.message : e));
	}
}

let enabledKeys = [];
let templates = [];
async function pullPanel() {
	const r = await panelApi("livechatBotPull", {});
	if (r && r.success) {
		enabledKeys = r.enabledKeys || [];
		templates = r.templates || [];
		await catchUpNewlyEnabled();
	} else if (r && r.message) {
		log("Panel menolak: " + r.message);
	}
}

export function pickTemplate(list, excludeId) {
	if (!list.length) return null;
	const pool = list.length > 1 && excludeId != null ? list.filter((t) => t.id !== excludeId) : list;
	const from = pool.length ? pool : list;
	return from[Math.floor(Math.random() * from.length)];
}
function hashText(s) {
	let h = 0;
	s = String(s || "");
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return String(h);
}

// ---------- Socket.IO ----------
let socket = null;
let socketToken = "";
function ensureSocket() {
	if (!token) return;
	if (socket && socketToken === token) return;
	if (socket) {
		socket.removeAllListeners();
		socket.disconnect();
		socket = null;
	}
	socketToken = token;
	socket = io(CFG.base, { auth: { token }, extraHeaders: { "user-agent": CFG.ua }, transports: ["websocket", "polling"], reconnection: true });
	socket.on("connect", () => log("Socket.IO terhubung."));
	socket.on("disconnect", (why) => log("Socket.IO terputus (" + why + "), menyambung ulang..."));
	socket.on("connect_error", (e) => {
		const m = String((e && e.message) || e);
		log("Socket.IO gagal: " + m);
		if (/unauthor|token|jwt|expired|auth/i.test(m)) token = ""; // paksa login ulang di tick berikutnya
	});
	socket.on("chat:new_message", (msg) => onNewMessage(msg));
}

function sendReply(chatId, text) {
	return new Promise((resolve) => {
		if (!socket || !socket.connected) return resolve(null);
		const timer = setTimeout(() => resolve(null), 8000);
		socket.emit("cs:message", { chat_id: Number(chatId), content: text }, (ack) => {
			clearTimeout(timer);
			resolve(ack);
		});
	});
}

// ---------- logika burst (SAMA dengan userscript) ----------
const burst = new Map();
const getBurst = (id) => burst.get(id) || { count: 0, lastMsgAt: 0, lastReplyAt: 0, lastTemplateId: null, replied: false };

async function tryReply(chatId) {
	if (!enabledKeys.includes(String(chatId))) return;
	const b = getBurst(chatId);
	if (!b.lastMsgAt || b.lastMsgAt <= b.lastReplyAt) return;
	// Sudah dibalas di burst ini -> diam, seberapa pun member spam (cukup 1 balasan per burst).
	if (b.replied) return;
	if (b.count < 1) return;
	const tpl = pickTemplate(templates, b.lastTemplateId);
	if (!tpl) {
		log("Tidak ada template balasan aktif -- lewati sesi " + chatId);
		return;
	}
	const ack = await sendReply(chatId, tpl.reply_text);
	if (ack && ack.error) {
		log("Gagal kirim balasan ke " + chatId + ": " + ack.error);
		return;
	}
	if (!ack) {
		log("Balasan ke " + chatId + " tidak terkonfirmasi (socket belum siap?) -- akan dicoba lagi bila member menulis lagi.");
		return;
	}
	b.lastReplyAt = Date.now();
	b.lastTemplateId = tpl.id;
	b.replied = true;
	burst.set(chatId, b);
	log("Auto-balas terkirim ke sesi " + chatId + ".");
	panelApi("livechatBotReport", { sessionKey: String(chatId), customerMessage: "", matchedTemplateId: tpl.id || null, replyText: tpl.reply_text });
}

function handleMemberMessage(chatId, content, hint) {
	if (!enabledKeys.includes(chatId)) return;
	const key = chatId + "::" + (hint != null ? hint : hashText(content));
	if (REPLIED[key]) return;
	REPLIED[key] = Date.now();
	saveReplied();
	const now = Date.now();
	const b = getBurst(chatId);
	if (b.lastMsgAt && now - b.lastMsgAt > BURST_RESET_MS) {
		b.count = 0;
		b.replied = false; // burst baru -> boleh dibalas 1x lagi
	}
	b.count += 1;
	b.lastMsgAt = now;
	burst.set(chatId, b);
	if (b.count === 1) setTimeout(() => tryReply(chatId), GRACE_MS);
	else tryReply(chatId);
}

function onNewMessage(msg) {
	if (!msg || msg.sender_type !== "member" || msg.chat_id == null) return;
	handleMemberMessage(String(msg.chat_id), msg.content);
}

const previouslyEnabled = new Set();
async function catchUpNewlyEnabled() {
	for (const chatId of enabledKeys) {
		if (previouslyEnabled.has(chatId)) continue;
		previouslyEnabled.add(chatId);
		const row = inboxCache.get(chatId);
		const queueCode = row && row.queue_code;
		if (!queueCode) continue;
		try {
			const res = await lcFetch("/api/chats/" + encodeURIComponent(queueCode) + "/messages");
			if (!res || !res.ok) continue;
			const data = await res.json();
			const messages = (data && data.messages) || [];
			const last = messages[messages.length - 1];
			if (last && last.sender_type === "member") handleMemberMessage(chatId, last.content, "catchup:" + (last.id != null ? last.id : hashText(last.content)));
		} catch (e) {
			log("Cek riwayat sesi " + chatId + " gagal: " + (e instanceof Error ? e.message : e));
		}
	}
	for (const chatId of Array.from(previouslyEnabled)) if (!enabledKeys.includes(chatId)) previouslyEnabled.delete(chatId);
}

// ---------- jalankan ----------
async function main() {
	const missing = [];
	if (!CFG.botKey) missing.push("BOT_KEY");
	if (!CFG.email) missing.push("LC_EMAIL");
	if (!CFG.password) missing.push("LC_PASSWORD");
	if (missing.length) {
		console.error("Isi dulu di file .env: " + missing.join(", ") + " (salin dari .env.example).");
		process.exit(1);
	}
	log("Agent Live Chat mulai. Panel: " + CFG.panelUrl + " | DayLiveChat: " + CFG.base);
	await login(true);
	const tick = async () => {
		if (!token) await login();
		ensureSocket();
	};
	await tick();
	await refreshInbox();
	await pullPanel();
	setInterval(tick, CFG.tickMs);
	setInterval(refreshInbox, CFG.tickMs);
	setInterval(pullPanel, CFG.tickMs);
	for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { log("Dihentikan."); process.exit(0); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
