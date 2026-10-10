// Cek kesehatan dalam: /health?deep=1. Tanpa rahasia & tanpa data pengguna -- hanya ok/gagal + lama (ms)
// supaya "panel tidak jalan" bisa dibedakan: D1 down/kuota, KV down/kuota, atau Worker sehat tapi masalah di browser.
type Check = { ok: boolean; ms: number; error?: string };

async function timed(fn: () => Promise<unknown>, limitMs = 4000): Promise<Check> {
	const t0 = Date.now();
	try {
		await Promise.race([
			fn(),
			new Promise((_, rej) => setTimeout(() => rej(new Error("lebih dari " + limitMs / 1000 + " dtk (menggantung)")), limitMs)),
		]);
		return { ok: true, ms: Date.now() - t0 };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { ok: false, ms: Date.now() - t0, error: msg.slice(0, 200) };
	}
}

export async function deepHealth(env: Env): Promise<{ ok: boolean; checks: Record<string, Check>; at: string }> {
	const [d1, kv] = await Promise.all([
		timed(() => env.DB.prepare("SELECT 1 AS x").first()),
		timed(() => env.SESS.get("health:probe")),
	]);
	return { ok: d1.ok && kv.ok, checks: { d1, kv }, at: new Date().toISOString() };
}
