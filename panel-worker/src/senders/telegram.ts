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

/** Kirim FOTO + caption ke chat/kanal (Bot API sendPhoto; foto lewat URL publik). Caption maks 1024 karakter (batas Telegram). */
export async function sendTelegramPhoto(cfg: TelegramCfg, photoUrl: string, caption: string): Promise<string> {
	try {
		if (!cfg.token || !cfg.chatId) return "Tele Error: Token/Chat ID kosong";
		const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendPhoto`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ chat_id: String(cfg.chatId).trim(), photo: photoUrl, caption: caption.slice(0, 1024) }),
		});
		const body = await res.text();
		if (res.status !== 200) return "Tele Error: " + body;
		return "Terkirim";
	} catch (e) {
		return "Tele Error: " + (e instanceof Error ? e.message : String(e));
	}
}
