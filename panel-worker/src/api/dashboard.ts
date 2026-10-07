// Port getBootstrapData / getDashboardData / getLivePanelData (bagian dashboard).
import { publicProfile, requireSession } from "./auth";
import { getDashboardData, getHomeInsights, normalizeDashOptions } from "../lib/dash";

export async function getBootstrapData(env: Env, token: string) {
	let session;
	try {
		session = await requireSession(env, token, { ignoreMaintenance: true, allowBot: true });
	} catch (e) {
		return { success: false, message: e instanceof Error ? e.message : String(e) };
	}

	// Role BOT: tidak punya akses dashboard — cukup kembalikan profil supaya
	// sesi tetap hidup saat refresh; frontend akan buka halaman BOT.
	if (session.profile.role === "BOT") {
		return {
			success: true as const,
			profile: publicProfile(session.profile, String(token ?? ""), session.maintenance),
			dashboard: null,
			errors: {},
		};
	}

	const out: {
		success: true;
		profile: ReturnType<typeof publicProfile>;
		dashboard: unknown;
		errors: Record<string, string>;
	} = {
		success: true,
		profile: publicProfile(session.profile, String(token ?? ""), session.maintenance),
		dashboard: null,
		errors: {},
	};

	try {
		out.dashboard = await getDashboardData(
			env,
			session.profile,
			normalizeDashOptions({ page: 1, pageSize: 5, facets: true }),
		);
	} catch (e) {
		out.errors.dashboard = e instanceof Error ? e.message : String(e);
	}
	return out;
}

export async function getDashboard(env: Env, token: string, options: unknown) {
	const session = await requireSession(env, token, { ignoreMaintenance: true });
	return getDashboardData(env, session.profile, normalizeDashOptions(options));
}

/** Grafik per jam, top operator (admin), dan jadwal prediksi hari ini untuk halaman Dashboard. */
export async function homeInsights(env: Env, token: string) {
	const session = await requireSession(env, token, { ignoreMaintenance: true });
	return { success: true, ...(await getHomeInsights(env, session.profile)) };
}
