// Batas waktu bawaan untuk SEMUA fetch keluar yang tidak punya signal sendiri (Telegram, LinkTree, Panel-Z, panel agen Invest,
// feed berita, GitHub, dst). Dulu hampir semuanya tanpa timeout: satu situs yang menggantung menahan seluruh invocation, lock
// pump kedaluwarsa sehingga scan berjalan ganda, dan cron berita macet. Panggilan yang SUDAH punya signal (mis. provider AI
// yang mengatur timeout sendiri, streaming) tidak disentuh.
const DEFAULT_TIMEOUT_MS = 25_000;

type Guarded = typeof globalThis & { __kdFetchGuard?: boolean };

export function installFetchGuard(): void {
	const g = globalThis as Guarded;
	if (g.__kdFetchGuard) return;
	g.__kdFetchGuard = true;
	const orig = g.fetch.bind(globalThis);
	g.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.signal || (typeof Request !== "undefined" && input instanceof Request)) return orig(input, init);
		return orig(input, { ...init, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
	}) as typeof fetch;
}
