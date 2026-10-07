// Port logClientActivity — log aktivitas dari frontend (mis. COPY TELEGRAM, dll).
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";

export async function logClientActivity(
	env: Env,
	token: string,
	action: string,
	detail: string,
	status: string,
	content: string,
) {
	try {
		const session = await requireSession(env, token, { ignoreMaintenance: true, allowBot: true });
		// Catatan dari browser tidak dipercaya: batasi panjang (cegah baris raksasa) dan jangan biarkan ia menyamar sebagai
		// aksi milik server (LOGIN, KIRIM, MAINTENANCE, dst) yang menggelembungkan statistik / jejak audit.
		let act = String(action ?? "AKTIVITAS").trim().slice(0, 60) || "AKTIVITAS";
		if (/^(LOGIN|LOGOUT|FAST AUTO SEND|KIRIM PREDIKSI OTOMATIS|DUPLIKAT WEBSITE DIBLOKIR|MODE MAINTENANCE|ASISTEN KD|KELOLA |LIVE CHAT|LAP ADMIN|SEND PANEL-Z|ADMIN)/i.test(act)) act = "KLIEN: " + act;
		const st = String(status ?? "INFO").toUpperCase();
		await logActivity(
			env,
			session.username,
			act,
			String(detail ?? "").slice(0, 500),
			["BERHASIL", "GAGAL", "SEBAGIAN", "DIBLOKIR", "INFO"].includes(st) ? st : "INFO",
			String(content ?? "").slice(0, 2000),
		);
		return { success: true };
	} catch (e) {
		return { success: false, message: e instanceof Error ? e.message : String(e) };
	}
}
