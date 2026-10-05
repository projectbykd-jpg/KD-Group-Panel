// CORS terbuka: endpoint /api dipanggil juga dari bookmarklet yang jalan di
// origin situs lain (mis. Mozart) untuk impor data dari browser user.
export const CORS_HEADERS: Record<string, string> = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "content-type",
	"access-control-max-age": "86400",
};

export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
	});
}

/** Respons JSON dari teks yang SUDAH berupa JSON (tanpa stringify ulang). */
export function rawJson(text: string, status = 200): Response {
	return new Response(text, {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
	});
}
