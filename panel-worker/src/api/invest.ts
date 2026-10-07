// Port endpoint publik Invest.gs (investGetConfig / investSaveConfig / investTestSession /
// investStartScan / investContinueScan / investResetScan / investGetStatus / investGetWarnings).
import { ghToken, investTurboRepo } from "../lib/integrations";
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import { tsNow } from "../lib/time";
import {
	INVEST_PASARAN,
	InvestSessionExpired,
	investConfigForClient,
	investFetch,
	investGetState,
	investGetWarningsList,
	investLoadConfig,
	investSaveConfig as investSaveConfigDb,
	investSetState,
	investWarningCount,
} from "../lib/invest";

async function investUser(env: Env, token: string): Promise<string> {
	const s = await requireSession(env, token, { ignoreMaintenance: true, menu: "invest" });
	return s.username;
}

export async function investGetConfig(env: Env, token: string) {
	const user = await investUser(env, token);
	// Tiga query Turso ini tidak saling bergantung -> jalan barengan. Turso
	// diakses lewat HTTP, jadi tiap round-trip berurutan menambah jeda nyata.
	const [cfg, state, warningCount] = await Promise.all([
		investLoadConfig(env, user),
		investGetState(env, user),
		investWarningCount(env, user),
	]);
	return {
		success: true,
		config: investConfigForClient(cfg),
		state,
		warningCount,
	};
}

export async function investSaveConfig(env: Env, token: string, data: Record<string, unknown>) {
	const user = await investUser(env, token);
	const cfg = await investSaveConfigDb(env, user, data ?? {});
	try {
		await logActivity(
			env,
			user,
			"INVEST SIMPAN SETTING",
			`BASE_URL: ${cfg.BASE_URL} | PHPSESSID ${cfg.PHPSESSID ? "terisi (" + cfg.PHPSESSID.length + " char)" : "kosong"}` +
				` | limit 2D/3D/4D: ${cfg.LIMIT_2D}/${cfg.LIMIT_3D}/${cfg.LIMIT_4D}`,
			"BERHASIL",
			"",
		);
	} catch {
		/* abaikan */
	}
	return { success: true, config: investConfigForClient(cfg) };
}

export async function investTestSession(env: Env, token: string) {
	const user = await investUser(env, token);
	try {
		const html = await investFetch(await investLoadConfig(env, user), "agentoverview.php");
		return { success: true, message: `Session valid (${html.length} bytes diterima).` };
	} catch (e) {
		const expired = e instanceof InvestSessionExpired;
		return {
			success: false,
			message: expired
				? "Session sudah tidak valid / expired. Ambil PHPSESSID baru dari browser lalu simpan."
				: e instanceof Error
					? e.message
					: String(e),
		};
	}
}

// Repo tempat workflow invest-turbo.yml hidup -- sama seperti news-turbo.yml,
// jalan sebagai plain fetch (bukan Playwright), jadi cukup di repo panel ini
// sendiri (Day-Group-Panel), tidak perlu daygroup-scraper.
const GH_HEADERS = (ghToken: string) => ({
	Authorization: `Bearer ${ghToken}`,
	Accept: "application/vnd.github+json",
	"User-Agent": "daygroup-panel",
	"X-GitHub-Api-Version": "2022-11-28",
});

/**
 * Pemicu workflow GitHub Actions "invest-turbo.yml" -- alternatif dari cron
 * Cloudflare (`* * * * *`) & live-polling ctx.waitUntil yang sudah ada.
 * TIDAK menggantikan keduanya (tetap jalan sbg jaring pengaman kalau tombol
 * GitHub gagal/GH_TOKEN belum di-set) -- workflow-nya sendiri cuma nge-loop
 * manggil endpoint /__cron?job=investuser yang PAKAI lock per-user yang SAMA
 * (env.SESS) dgn investPumpUser Cloudflare, jadi tidak pernah race walau
 * jalan bersamaan. Gagal memicu = non-fatal (dicatat, tidak bikin
 * investStartScan/investContinueScan gagal -- scan tetap jalan pelan-pelan
 * lewat cron/live-poll seperti sebelum fitur ini ada).
 */
async function dispatchInvestTurbo(env: Env, user: string): Promise<void> {
	if (!ghToken(env)) return; // belum dikonfigurasi -> diam-diam andalkan cron/live-poll
	try {
		const resp = await fetch(`https://api.github.com/repos/${investTurboRepo(env)}/actions/workflows/invest-turbo.yml/dispatches`, {
			method: "POST",
			headers: GH_HEADERS(ghToken(env)),
			body: JSON.stringify({ ref: "main", inputs: { user } }),
		});
		if (resp.status !== 204) {
			console.error("dispatchInvestTurbo gagal:", resp.status, await resp.text());
		}
	} catch (e) {
		console.error("dispatchInvestTurbo error:", e instanceof Error ? e.message : e);
	}
}

export async function investStartScan(env: Env, token: string) {
	const user = await investUser(env, token);
	const cfg = await investLoadConfig(env, user);
	if (!cfg.PHPSESSID && !cfg.COOKIE_EXTRA) {
		return { success: false, message: "PHPSESSID belum diisi. Simpan dulu sesinya." };
	}
	const cur = await investGetState(env, user);
	if (cur.state === "running") {
		return { success: false, message: "Scan kamu sedang berjalan. Tunggu selesai atau klik RESET." };
	}
	const state = await investSetState(env, user, {
		state: "running",
		cursor: 0,
		total: INVEST_PASARAN.length,
		startedAt: tsNow(),
		finishedAt: "",
		warningCount: 0,
		message: "Scan dijadwalkan…",
	});
	await dispatchInvestTurbo(env, user);
	try {
		await logActivity(
			env,
			user,
			"INVEST SCAN MULAI",
			`Scan invest dijadwalkan (${INVEST_PASARAN.length} pasaran).`,
			"INFO",
			"",
		);
	} catch {
		/* abaikan */
	}
	return { success: true, message: "Scan dijadwalkan — worker akan memprosesnya di latar belakang.", state };
}

export async function investContinueScan(env: Env, token: string) {
	const user = await investUser(env, token);
	const cur = await investGetState(env, user);
	if (cur.state === "running") return { success: false, message: "Scan kamu sedang berjalan." };
	const state = await investSetState(env, user, { state: "running", message: "Melanjutkan scan…" });
	await dispatchInvestTurbo(env, user);
	try {
		await logActivity(
			env,
			user,
			"INVEST SCAN LANJUT",
			cur.cursor != null ? `Lanjut dari pasaran ${cur.cursor}` : "Lanjut scan",
			"INFO",
			"",
		);
	} catch {
		/* abaikan */
	}
	return { success: true, message: "Scan dilanjutkan — worker akan memprosesnya di latar belakang.", state };
}

export async function investResetScan(env: Env, token: string) {
	const user = await investUser(env, token);
	await investSetState(env, user, {
		state: "idle",
		cursor: 0,
		message: "Scan di-reset. Hasil lama tetap ada sampai scan berikutnya.",
	});
	try {
		await logActivity(env, user, "INVEST SCAN RESET", "Scan invest di-reset", "INFO", "");
	} catch {
		/* abaikan */
	}
	return { success: true, message: "Scan di-reset." };
}

export async function investGetStatus(env: Env, token: string) {
	const user = await investUser(env, token);
	// Endpoint ini di-poll tiap beberapa detik selama scan jalan -> dua query
	// Turso-nya dibuat barengan, bukan berurutan.
	const [st, warningCount] = await Promise.all([investGetState(env, user), investWarningCount(env, user)]);
	return { ...st, success: true, warningCount };
}

export async function investGetWarnings(env: Env, token: string) {
	const user = await investUser(env, token);
	const [users, state] = await Promise.all([investGetWarningsList(env, user), investGetState(env, user)]);
	return { success: true, users, state, warningCount: users.length };
}
