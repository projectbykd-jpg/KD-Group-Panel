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

function gateBotKey(env: Env, key: string) {
	if (!env.LIVECHAT_BOT_KEY) throw new Error("Live Chat Bot belum dikonfigurasi (secret LIVECHAT_BOT_KEY). Hubungi admin.");
	if (!key || !constEq(key, env.LIVECHAT_BOT_KEY)) throw new Error("Kunci userscript tidak valid.");
}

// --- Panel ---

export async function livechatListSessions(env: Env, token: string) {
	await gatePanel(env, token, "livechat-sessions");
	return { success: true, sessions: await listSessions(env) };
}

export async function livechatSetBotEnabled(env: Env, token: string, sessionKey: string, enabled: boolean) {
	const s = await gatePanel(env, token, "livechat-sessions");
	if (!sessionKey) throw new Error("session_key wajib.");
	await setSessionBot(env, sessionKey, enabled);
	await logActivity(env, s.username, "LIVE CHAT BOT", `${enabled ? "Aktifkan" : "Matikan"} auto-reply untuk sesi ${sessionKey}`, "BERHASIL", "");
	return { success: true };
}

export async function livechatListTemplates(env: Env, token: string) {
	await gatePanel(env, token, "livechat-templates");
	return { success: true, templates: await listTemplates(env) };
}

export async function livechatSaveTemplate(env: Env, token: string, data: Record<string, unknown>) {
	const s = await gatePanel(env, token, "livechat-templates");
	await saveTemplate(env, {
		id: data.id ? Number(data.id) : undefined,
		replyText: String(data.replyText ?? data.reply_text ?? ""),
		active: data.active !== false && data.active !== 0 && data.active !== "0",
		sortOrder: data.sortOrder != null ? Number(data.sortOrder) : 0,
	});
	await logActivity(env, s.username, "LIVE CHAT TEMPLATE", data.id ? "Ubah template balasan" : "Tambah template balasan", "BERHASIL", "");
	return { success: true, templates: await listTemplates(env) };
}

export async function livechatDeleteTemplate(env: Env, token: string, id: number) {
	const s = await gatePanel(env, token, "livechat-templates");
	if (!id) throw new Error("id template wajib.");
	await deleteTemplate(env, id);
	await logActivity(env, s.username, "LIVE CHAT TEMPLATE", "Hapus template balasan #" + id, "BERHASIL", "");
	return { success: true, templates: await listTemplates(env) };
}

export async function livechatRecentLogs(env: Env, token: string) {
	await gatePanel(env, token, "livechat-sessions");
	return { success: true, logs: await recentLogs(env) };
}

// --- Userscript (auth via key, bukan sesi) ---

export async function livechatBotSync(env: Env, key: string, rows: unknown) {
	gateBotKey(env, key);
	const list = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
	const mapped = list.map((r) => ({
		sessionKey: String(r.sessionKey ?? r.session_key ?? ""),
		queueCode: String(r.queueCode ?? r.queue_code ?? ""),
		customerName: String(r.customerName ?? r.customer_name ?? ""),
		divisi: String(r.divisi ?? ""),
		lastMessage: String(r.lastMessage ?? r.last_message ?? ""),
		lastSender: String(r.lastSender ?? r.last_sender ?? ""),
	}));
	return { success: true, ...(await syncSessionsFromScript(env, mapped)) };
}

export async function livechatBotPull(env: Env, key: string) {
	gateBotKey(env, key);
	const { enabledKeys, templates } = await pullEnabledSessions(env);
	return { success: true, enabledKeys, templates };
}

export async function livechatBotReport(env: Env, key: string, sessionKey: string, customerMessage: string, matchedTemplateId: number | null, replyText: string) {
	gateBotKey(env, key);
	if (!sessionKey || !replyText) throw new Error("session_key & reply_text wajib.");
	await logAutoReply(env, sessionKey, customerMessage || "", matchedTemplateId ?? null, replyText);
	return { success: true };
}
