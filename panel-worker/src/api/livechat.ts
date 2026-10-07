// Endpoint "Live Chat Auto-Reply". Dua jalur auth terpisah:
//   1) Panel (operator login biasa, role ADMIN/OPERATOR) -- lihat/toggle sesi,
//      kelola template. Role VIEWER & BOT ditolak (VIEWER read-only umum,
//      BOT terisolasi ke modul NEWS -- lihat api/bot.ts).
//   2) Userscript browser di daylivechat.com -- TIDAK punya sesi login panel,
//      diautentikasi lewat secret LIVECHAT_BOT_KEY (wrangler secret, sama
//      persis dengan yang ditempel operator ke pengaturan userscript sekali
//      saat instal). Ini SATU-SATUNYA jalur yang bisa jalan -- DayLiveChat
//      mengunci login CS ke IP tertentu, jadi bot TIDAK BISA login dari
//      server (lihat catatan di lib/livechat-bot.ts).
import { requireSession } from "./auth";
import { constEq } from "../lib/crypto";
import type { MenuKey } from "../lib/menus";
import { logActivity } from "../lib/activity";
import {
	deleteTemplate,
	listSessions,
	listTemplates,
	logAutoReply,
	pullEnabledSessions,
	recentLogs,
	saveTemplate,
	setSessionBot,
	syncSessionsFromScript,
} from "../lib/livechat-bot";

async function gatePanel(env: Env, token: string, menu: MenuKey) {
	const s = await requireSession(env, token, { menu });
	if (s.profile.role !== "ADMIN" && s.profile.role !== "OPERATOR") {
		throw new Error("Menu Live Chat hanya untuk ADMIN atau OPERATOR.");
	}
	return s;
}

// --- Kunci Bot PER PENGGUNA ---
// Tiap pengguna panel punya Kunci Bot sendiri (akun DayLiveChat/CS tiap orang berbeda, dan data satu orang tidak boleh
// masuk ke menu orang lain). Kunci diturunkan (HMAC) dari secret LIVECHAT_BOT_KEY -> tanpa tabel baru dan tidak bisa
// dipalsukan untuk pengguna lain. Format: kd1_<base64url("username|versi")>_<mac 32 hex>. "Reset kunci" menaikkan
// versi (settings: livechat_key_ver:<username>) sehingga kunci lama langsung mati. Kunci lama (nilai LIVECHAT_BOT_KEY
// itu sendiri) tetap diterima dan memetakan ke data lama (owner '') yang hanya dilihat ADMIN.
const enc = new TextEncoder();
const b64u = (t: string): string => btoa(String.fromCharCode(...enc.encode(t))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (t: string): string => {
	const bin = atob(t.replace(/-/g, "+").replace(/_/g, "/"));
	return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};
async function macHex(secret: string, msg: string): Promise<string> {
	const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode("livechat-key:" + msg)));
	return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
const verKey = (uname: string): string => "livechat_key_ver:" + uname;
async function keyVersion(env: Env, uname: string): Promise<number> {
	const r = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(verKey(uname)).first<{ value: string }>();
	const n = Number(r?.value ?? 0);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
async function makeUserKey(env: Env, uname: string): Promise<string> {
	if (!env.LIVECHAT_BOT_KEY) throw new Error("Live Chat Bot belum dikonfigurasi (secret LIVECHAT_BOT_KEY). Hubungi admin.");
	const payload = `${uname}|${await keyVersion(env, uname)}`;
	return `kd1_${b64u(payload)}_${await macHex(env.LIVECHAT_BOT_KEY, payload)}`;
}

const keyCache = new Map<string, { owner: string; exp: number }>();
/** Validasi Kunci Bot dari userscript -> pemilik datanya ('' = data lama). Melempar bila tidak sah. */
async function gateBotKey(env: Env, key: string): Promise<string> {
	if (!env.LIVECHAT_BOT_KEY) throw new Error("Live Chat Bot belum dikonfigurasi (secret LIVECHAT_BOT_KEY). Hubungi admin.");
	const bad = new Error("Kunci userscript tidak valid.");
	if (!key) throw bad;
	if (constEq(key, env.LIVECHAT_BOT_KEY)) return "";
	const hit = keyCache.get(key);
	if (hit && hit.exp > Date.now()) return hit.owner;
	const m = /^kd1_(.+)_([0-9a-f]{32})$/.exec(key);
	if (!m) throw bad;
	let payload = "";
	try {
		payload = unb64u(m[1]);
	} catch {
		throw bad;
	}
	if (!constEq(m[2], await macHex(env.LIVECHAT_BOT_KEY, payload))) throw bad;
	const [uname, ver] = payload.split("|");
	if (!uname || Number(ver) !== (await keyVersion(env, uname))) throw bad;
	const u = await env.DB.prepare(`SELECT role, status FROM users WHERE username_lc = ?`).bind(uname).first<{ role: string; status: string }>();
	if (!u || u.status !== "AKTIF" || (u.role !== "ADMIN" && u.role !== "OPERATOR")) throw bad;
	if (keyCache.size > 500) keyCache.clear();
	keyCache.set(key, { owner: uname, exp: Date.now() + 30_000 });
	return uname;
}
/** Hanya untuk test. */
export function resetLivechatKeyCache(): void {
	keyCache.clear();
}

/** Pemilik data yang boleh dilihat pengguna ini: dirinya; ADMIN juga data lama (''). */
function scopeOf(s: { username: string; profile: { role: string } }): { me: string; owners: string[] } {
	const me = s.username.toLowerCase();
	return { me, owners: s.profile.role === "ADMIN" ? [me, ""] : [me] };
}

// --- Panel ---

export async function livechatListSessions(env: Env, token: string) {
	const s = await gatePanel(env, token, "livechat-sessions");
	const { owners } = scopeOf(s);
	const templates = (await listTemplates(env, owners)).filter((t) => Number(t.active) === 1);
	return { success: true, sessions: await listSessions(env, owners), templateCount: templates.length };
}

/** Kunci Bot milik pengguna yang sedang login (hanya untuk dirinya sendiri). */
export async function livechatGetBotKey(env: Env, token: string) {
	const s = await gatePanel(env, token, "livechat-sessions");
	return { success: true, key: await makeUserKey(env, scopeOf(s).me) };
}

/** Buat kunci baru (kunci lama langsung tidak berlaku) -- dipakai bila kunci bocor. */
export async function livechatResetBotKey(env: Env, token: string) {
	const s = await gatePanel(env, token, "livechat-sessions");
	const { me } = scopeOf(s);
	const next = (await keyVersion(env, me)) + 1;
	await env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(verKey(me), String(next)).run();
	keyCache.clear();
	await logActivity(env, s.username, "LIVE CHAT BOT", "Reset Kunci Bot", "BERHASIL", "");
	return { success: true, key: await makeUserKey(env, me) };
}

export async function livechatSetBotEnabled(env: Env, token: string, sessionKey: string, enabled: boolean) {
	const s = await gatePanel(env, token, "livechat-sessions");
	if (!sessionKey) throw new Error("session_key wajib.");
	await setSessionBot(env, scopeOf(s).owners, sessionKey, enabled);
	await logActivity(env, s.username, "LIVE CHAT BOT", `${enabled ? "Aktifkan" : "Matikan"} auto-reply untuk sesi ${sessionKey}`, "BERHASIL", "");
	return { success: true };
}

export async function livechatListTemplates(env: Env, token: string) {
	const s = await gatePanel(env, token, "livechat-templates");
	return { success: true, templates: await listTemplates(env, scopeOf(s).owners) };
}

export async function livechatSaveTemplate(env: Env, token: string, data: Record<string, unknown>) {
	const s = await gatePanel(env, token, "livechat-templates");
	const { me, owners } = scopeOf(s);
	await saveTemplate(env, me, owners, {
		id: data.id ? Number(data.id) : undefined,
		replyText: String(data.replyText ?? data.reply_text ?? ""),
		active: data.active !== false && data.active !== 0 && data.active !== "0",
		sortOrder: data.sortOrder != null ? Number(data.sortOrder) : 0,
	});
	await logActivity(env, s.username, "LIVE CHAT TEMPLATE", data.id ? "Ubah template balasan" : "Tambah template balasan", "BERHASIL", "");
	return { success: true, templates: await listTemplates(env, owners) };
}

export async function livechatDeleteTemplate(env: Env, token: string, id: number) {
	const s = await gatePanel(env, token, "livechat-templates");
	if (!id) throw new Error("id template wajib.");
	const { owners } = scopeOf(s);
	await deleteTemplate(env, owners, id);
	await logActivity(env, s.username, "LIVE CHAT TEMPLATE", "Hapus template balasan #" + id, "BERHASIL", "");
	return { success: true, templates: await listTemplates(env, owners) };
}

export async function livechatRecentLogs(env: Env, token: string) {
	const s = await gatePanel(env, token, "livechat-sessions");
	return { success: true, logs: await recentLogs(env, scopeOf(s).owners) };
}

// --- Userscript (auth via Kunci Bot, bukan sesi) ---

export async function livechatBotSync(env: Env, key: string, rows: unknown) {
	const owner = await gateBotKey(env, key);
	// `rows` kosong ([]) = Kotak Masuk memang kosong -> sesi lama dibuang. Tapi
	// body tanpa `rows` / bukan array (userscript versi lama, request rusak)
	// BUKAN berarti kosong: jangan sampai itu mematikan semua bot & menghapus sesi.
	if (!Array.isArray(rows)) throw new Error("rows wajib berupa array.");
	const list = rows as Array<Record<string, unknown>>;
	const mapped = list.map((r) => ({
		sessionKey: String(r.sessionKey ?? r.session_key ?? ""),
		queueCode: String(r.queueCode ?? r.queue_code ?? ""),
		customerName: String(r.customerName ?? r.customer_name ?? ""),
		divisi: String(r.divisi ?? ""),
		lastMessage: String(r.lastMessage ?? r.last_message ?? ""),
		lastSender: String(r.lastSender ?? r.last_sender ?? ""),
	}));
	return { success: true, ...(await syncSessionsFromScript(env, owner, mapped)) };
}

export async function livechatBotPull(env: Env, key: string) {
	const owner = await gateBotKey(env, key);
	const { enabledKeys, templates } = await pullEnabledSessions(env, owner);
	return { success: true, enabledKeys, templates };
}

export async function livechatBotReport(env: Env, key: string, sessionKey: string, customerMessage: string, matchedTemplateId: number | null, replyText: string) {
	const owner = await gateBotKey(env, key);
	if (!sessionKey || !replyText) throw new Error("session_key & reply_text wajib.");
	await logAutoReply(env, owner, sessionKey, customerMessage || "", matchedTemplateId ?? null, replyText);
	return { success: true };
}
