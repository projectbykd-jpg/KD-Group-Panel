// Port checkLogin / resumeSession / requireSession_ / logout dari V6Core.gs.
import { getSys } from "../lib/settings";
import { getMaintenance, getUserProfile, Maintenance, UserProfile } from "../lib/db";
import { hashPassword, isHashed, verifyPassword } from "../lib/crypto";
import { createSession, deleteSession, loadSession } from "../lib/session";
import { logActivity } from "../lib/activity";
import { tsNow, tsPlusMinutes } from "../lib/time";
import { clearLoginFailures, loginBlockedMinutes, recordLoginFailure } from "../lib/login-throttle";
import { hasMenu, menuLabel, type MenuKey } from "../lib/menus";

const SERVER_VERSION = "PANEL-WORKER-1.0";

export function publicProfile(p: UserProfile, token: string, maintenance: Maintenance) {
	return {
		success: true,
		user: p.username,
		username: p.username,
		role: p.role,
		displayName: p.displayName,
		permissions: p.permissions,
		websites: p.websites,
		// null = semua menu (default); array = hanya menu ini (+ Dashboard).
		menus: p.role === "ADMIN" ? null : p.menus,
		maintenance,
		sessionToken: token,
		serverVersion: SERVER_VERSION,
	};
}

export async function checkLogin(env: Env, username: string, password: string, ip = "") {
	const clean = String(username ?? "").trim();
	try {
		const blockedMin = await loginBlockedMinutes(env, ip);
		if (blockedMin > 0) {
			await logActivity(env, clean || "UNKNOWN", "LOGIN", "Diblokir: terlalu banyak percobaan gagal dari IP " + ip, "GAGAL");
			return {
				success: false,
				message: `Terlalu banyak percobaan login gagal dari jaringan ini. Coba lagi dalam ${blockedMin} menit.`,
			};
		}
		const p = await getUserProfile(env, clean);
		if (!p) {
			await recordLoginFailure(env, ip);
			await logActivity(env, clean || "UNKNOWN", "LOGIN", "Username tidak ditemukan", "GAGAL");
			return { success: false, message: "Username atau Password Salah!" };
		}
		if (p.status !== "AKTIF") {
			await logActivity(env, p.username, "LOGIN", "Akun tidak aktif: " + p.status, "GAGAL");
			return { success: false, message: "Akun sedang " + p.status.toLowerCase() + ". Hubungi admin." };
		}
		if (p.lockedUntil && p.lockedUntil > tsNow()) {
			return { success: false, message: "Akun terkunci sementara. Coba lagi nanti." };
		}

		const ok = await verifyPassword(p.passwordHash, password);
		if (!ok) {
			await recordLoginFailure(env, ip);
			// Kunci lama yang SUDAH lewat tidak boleh terbawa: tanpa reset ini,
			// failed_login tetap >= 5 sesudah kunci habis, jadi satu salah ketik
			// berikutnya langsung mengunci akun 10 menit lagi.
			const prevFails = p.lockedUntil && p.lockedUntil <= tsNow() ? 0 : p.failedLogin;
			const n = prevFails + 1;
			const lock = n >= (await getSys(env, "sys_login_max_fails")) ? tsPlusMinutes(await getSys(env, "sys_login_lock_minutes")) : null;
			await env.DB.prepare(`UPDATE users SET failed_login = ?, locked_until = ? WHERE id = ?`)
				.bind(n, lock, p.id)
				.run();
			await logActivity(env, p.username, "LOGIN", "Password salah", "GAGAL");
			return { success: false, message: "Username atau Password Salah!" };
		}

		// migrasi otomatis password plaintext -> hash
		if (!isHashed(p.passwordHash)) {
			const h = await hashPassword(password);
			await env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(h, p.id).run();
		}

		await env.DB.prepare(
			`UPDATE users SET failed_login = 0, locked_until = NULL, last_login_at = ? WHERE id = ?`,
		)
			.bind(tsNow(), p.id)
			.run();

		await clearLoginFailures(env, ip);
		const maintenance = await getMaintenance(env);
		const token = await createSession(env, p.username);
		await logActivity(env, p.username, "LOGIN", "Login berhasil ke KD-Group Panel", "BERHASIL");
		if (maintenance.enabled && p.role !== "ADMIN") {
			await logActivity(
				env,
				p.username,
				"LOGIN",
				"Login saat mode maintenance (pengiriman dikunci)",
				"INFO",
				maintenance.message,
			);
		}
		return publicProfile(p, token, maintenance);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await logActivity(env, clean || "UNKNOWN", "LOGIN", "Kesalahan validasi login: " + msg, "ERROR");
		return { success: false, message: "Terjadi kesalahan saat login." };
	}
}

export interface Session {
	token: string;
	username: string;
	profile: UserProfile;
	maintenance: Maintenance;
}

export async function requireSession(
	env: Env,
	token: string,
	opts: { admin?: boolean; ignoreMaintenance?: boolean; allowBot?: boolean; menu?: MenuKey | readonly MenuKey[] } = {},
): Promise<Session> {
	// Status maintenance TIDAK bergantung pada sesi/profil -> dimulai barengan
	// dengan pembacaan sesi, bukan menunggu giliran sesudahnya. Fungsi ini jalan
	// di SETIAP request yang butuh login, jadi memangkas satu round-trip di sini
	// terasa di semua halaman sekaligus.
	// .catch kosong di bawah HANYA menandai promise-nya "sudah ditangani" supaya
	// tidak jadi unhandled rejection kalau alur ini keburu throw duluan (sesi
	// tidak valid dsb). Promise aslinya tetap utuh -- kalau query-nya memang
	// gagal, `await maintenanceP` di bawah tetap melempar error yang sama
	// seperti sebelumnya.
	const maintenanceP = getMaintenance(env);
	maintenanceP.catch(() => {});

	const rec = await loadSession(env, token);
	if (!rec) throw new Error("Sesi tidak valid atau telah berakhir. Silakan login kembali.");
	const p = await getUserProfile(env, rec.username);
	if (!p) throw new Error("Akun tidak ditemukan.");
	if (p.status !== "AKTIF") throw new Error("Akun sedang " + String(p.status || "NONAKTIF").toLowerCase() + ".");
	if (p.lockedUntil && p.lockedUntil > tsNow()) throw new Error("Akun terkunci sementara.");
	const maintenance = await maintenanceP;
	if (maintenance.enabled && p.role !== "ADMIN" && !opts.ignoreMaintenance) {
		throw new Error(maintenance.message);
	}
	if (opts.admin && p.role !== "ADMIN") throw new Error("Akses ditolak. Hanya ADMIN yang diizinkan.");
	// Role BOT TERISOLASI: hanya boleh endpoint yang eksplisit mengizinkan
	// (opts.allowBot). Semua handler lama otomatis menolak BOT.
	if (p.role === "BOT" && !opts.allowBot) {
		throw new Error("Akun BOT hanya bisa mengakses fitur BOT.");
	}
	// Hak akses menu per user (diatur admin). Pesannya sengaja tidak memuat
	// kata "sesi"/"akun sedang" supaya panel tidak mengira sesinya habis.
	if (opts.menu && !hasMenu(p, opts.menu)) {
		throw new Error(`Menu ${menuLabel(opts.menu)} tidak diizinkan untuk akun ini. Minta admin membukanya di Admin -> Users.`);
	}
	return { token: String(token), username: p.username, profile: p, maintenance };
}

export async function resumeSession(env: Env, token: string) {
	try {
		const s = await requireSession(env, token, { ignoreMaintenance: true, allowBot: true });
		return publicProfile(s.profile, String(token ?? ""), s.maintenance);
	} catch (e) {
		return { success: false, message: e instanceof Error ? e.message : String(e) };
	}
}

export async function logout(env: Env, token: string) {
	const rec = await loadSession(env, token);
	if (rec) await logActivity(env, rec.username, "LOGOUT", "User keluar dari panel", "BERHASIL");
	await deleteSession(env, token);
	return { success: true };
}
