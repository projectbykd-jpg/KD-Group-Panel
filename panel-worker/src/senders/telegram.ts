// Port sendToTelegramInternal_ — POST form ke Bot API.
import type { TelegramCfg } from "../lib/site";

export async function sendTelegram(text: string, cfg: TelegramCfg): Promise<string> {
	try {
		if (!cfg.token || !cfg.chatId) return "Tele Error: Token/Chat ID kosong";
		const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ chat_id: String(cfg.chatId).trim(), text }),
		});
		const body = await res.text();
		if (res.status !== 200) return "Tele Error: " + body;
		return "Terkirim";
	} catch (e) {
		return "Tele Error: " + (e instanceof Error ? e.message : String(e));
	}
}

export interface TgSendOpts {
	/** "HTML" = caption/teks boleh memakai <b>, <i>, <a href>. Semua teks dinamis WAJIB di-escape pemanggil. */
	parseMode?: "HTML";
	/** Tombol di bawah pesan: baris-baris tombol URL. */
	buttons?: { text: string; url: string }[][];
}

function extra(body: URLSearchParams, o: TgSendOpts): void {
	if (o.parseMode) body.set("parse_mode", o.parseMode);
	if (o.buttons?.length) body.set("reply_markup", JSON.stringify({ inline_keyboard: o.buttons.map((row) => row.map((b) => ({ text: b.text, url: b.url }))) }));
}

/** Kirim FOTO + caption ke chat/kanal (Bot API sendPhoto; foto lewat URL publik). Caption maks 1024 karakter terlihat (batas Telegram). */
export async function sendTelegramPhoto(cfg: TelegramCfg, photoUrl: string, caption: string, o: TgSendOpts = {}): Promise<string> {
	try {
		if (!cfg.token || !cfg.chatId) return "Tele Error: Token/Chat ID kosong";
		const body = new URLSearchParams({ chat_id: String(cfg.chatId).trim(), photo: photoUrl, caption });
		extra(body, o);
		const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendPhoto`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		});
		const text = await res.text();
		if (res.status !== 200) return "Tele Error: " + text;
		return "Terkirim";
	} catch (e) {
		return "Tele Error: " + (e instanceof Error ? e.message : String(e));
	}
}

/** Kirim teks bertombol/berformat ke chat/kanal (tanpa pratinjau tautan otomatis supaya tampil bersih). */
export async function sendTelegramRich(cfg: TelegramCfg, text: string, o: TgSendOpts = {}): Promise<string> {
	try {
		if (!cfg.token || !cfg.chatId) return "Tele Error: Token/Chat ID kosong";
		const body = new URLSearchParams({ chat_id: String(cfg.chatId).trim(), text, disable_web_page_preview: "true" });
		extra(body, o);
		const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		});
		const t = await res.text();
		if (res.status !== 200) return "Tele Error: " + t;
		return "Terkirim";
	} catch (e) {
		return "Tele Error: " + (e instanceof Error ? e.message : String(e));
	}
}
