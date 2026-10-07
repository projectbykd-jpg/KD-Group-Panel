// Diagnosa koneksi Facebook Page (Graph API). Dipakai tombol "TES FACEBOOK" di Bot > Setting > Sosial & Promo.
// Tujuannya satu: kalau posting ke Fanspage gagal, admin tahu PENYEBAB PASTI (token salah/kedaluwarsa, bukan token halaman,
// Page ID salah, izin kurang, diblokir) -- bukan sekadar "gagal". Token TIDAK PERNAH muncul di hasil.

const GRAPH = "https://graph.facebook.com/v21.0";

export type FbStep = { name: string; ok: boolean; detail: string };
export type FbDiagnosis = { ok: boolean; verdict: string; steps: FbStep[]; page?: { id: string; name: string } };

type GraphErr = { message?: string; type?: string; code?: number; error_subcode?: number };
type GraphRes = { status: number; body: any; netError?: string };

async function graph(method: "GET" | "POST" | "DELETE", path: string, token: string, params?: Record<string, string>): Promise<GraphRes> {
	try {
		const qs = new URLSearchParams({ ...(params ?? {}), access_token: token });
		const url = method === "POST" ? `${GRAPH}${path}` : `${GRAPH}${path}${path.includes("?") ? "&" : "?"}${qs}`;
		const r = await fetch(url, { method, body: method === "POST" ? qs : undefined, signal: AbortSignal.timeout(12_000) });
		let body: any = null;
		try {
			body = await r.json();
		} catch {
			/* balasan bukan JSON */
		}
		return { status: r.status, body };
	} catch (e) {
		return { status: 0, body: null, netError: e instanceof Error ? e.message : String(e) };
	}
}

/** Terjemahkan galat Graph API ke penjelasan + langkah perbaikan. */
export function explainFbError(res: GraphRes, token: string): string {
	if (res.netError) return "Panel tidak bisa menghubungi Facebook (jaringan/timeout). Coba lagi sebentar lagi.";
	const e: GraphErr = res.body?.error ?? {};
	const code = Number(e.code ?? 0);
	const sub = Number(e.error_subcode ?? 0);
	const raw = String(e.message ?? "").split(token).join("***");
	if (code === 190 || code === 102) {
		if (sub === 463) return "Token sudah KEDALUWARSA. Buat Page Access Token baru (jangka panjang) lalu tempel di kolom token.";
		if (sub === 460) return "Token dicabut karena password/sesi Facebook pemilik berubah. Buat Page Access Token baru.";
		if (sub === 467) return "Token tidak valid lagi (sesi dihapus/logout). Buat Page Access Token baru.";
		return "Token TIDAK VALID atau kedaluwarsa. Buat Page Access Token baru lalu tempel di kolom token.";
	}
	if (code === 200 || code === 10 || code === 299 || code === 3 || /permission/i.test(raw)) {
		return "IZIN KURANG: token butuh izin pages_manage_posts (dan pages_read_engagement), dan akun pembuat token harus ADMIN halaman itu. Buat ulang token dengan izin tersebut.";
	}
	if (code === 100 && /does not exist|cannot be loaded|unsupported get request|unknown path/i.test(raw)) {
		return "Page ID SALAH, atau token tidak punya akses ke halaman itu. Cek Page ID (angka) dan pastikan token milik halaman yang sama.";
	}
	if ([4, 17, 32, 341, 613].includes(code)) return "Terkena BATAS KECEPATAN Facebook. Tunggu beberapa menit/jam lalu coba lagi.";
	if (code === 368) return "Facebook MEMBLOKIR aksi memposting untuk halaman ini sementara (kebijakan/spam). Tunggu atau cek Pusat Dukungan Halaman Anda.";
	if (code === 1 || code === 2) return "Gangguan sementara di sisi Facebook. Coba lagi nanti.";
	return `Facebook menolak: ${raw.slice(0, 200) || `HTTP ${res.status}`}${code ? ` (kode ${code}${sub ? "/" + sub : ""})` : ""}`;
}

export async function fbDiagnose(pageId: string, token: string): Promise<FbDiagnosis> {
	const steps: FbStep[] = [];
	const fail = (name: string, detail: string): FbDiagnosis => {
		steps.push({ name, ok: false, detail });
		return { ok: false, verdict: detail, steps };
	};

	// 1. Siapa pemilik token? Token HALAMAN -> /me = halaman itu sendiri. Token USER -> /me = orang.
	const me = await graph("GET", "/me?fields=id,name", token);
	if (me.status !== 200 || !me.body?.id) return fail("Token", explainFbError(me, token));
	if (String(me.body.id) !== pageId) {
		return fail(
			"Token",
			`Token ini milik "${String(me.body.name ?? "?")}" (id ${String(me.body.id)}), BUKAN halaman ${pageId}. Anda memakai token USER. Ambil Page Access Token halaman itu (lewat Graph API Explorer: pilih Halaman, bukan User) lalu tempel.`,
		);
	}
	steps.push({ name: "Token", ok: true, detail: `Token milik halaman "${String(me.body.name ?? "")}" ✓` });

	// 2. Akses ke halaman.
	const pg = await graph("GET", `/${encodeURIComponent(pageId)}?fields=id,name,fan_count`, token);
	if (pg.status !== 200 || !pg.body?.id) return fail("Akses halaman", explainFbError(pg, token));
	const page = { id: String(pg.body.id), name: String(pg.body.name ?? "") };
	steps.push({ name: "Akses halaman", ok: true, detail: `Halaman "${page.name}" terbaca${pg.body.fan_count != null ? ` (${pg.body.fan_count} pengikut)` : ""} ✓` });

	// 3. Izin posting: buat posting TIDAK DITAYANGKAN (published=false, tidak tampil publik) lalu langsung dihapus.
	const post = await graph("POST", `/${encodeURIComponent(pageId)}/feed`, token, { message: "Tes koneksi panel (tidak ditayangkan)", published: "false" });
	const postId = String(post.body?.id ?? "");
	if (post.status !== 200 || !postId) {
		const d = explainFbError(post, token);
		steps.push({ name: "Izin posting", ok: false, detail: d });
		return { ok: false, verdict: d, steps, page };
	}
	const del = await graph("DELETE", `/${encodeURIComponent(postId)}`, token);
	const cleaned = del.status === 200 && del.body?.success !== false;
	steps.push({
		name: "Izin posting",
		ok: true,
		detail: cleaned
			? "Bisa membuat posting (tes tersembunyi, sudah dihapus lagi) ✓"
			: `Bisa membuat posting ✓, tetapi posting tes tersembunyi (id ${postId}) belum terhapus; hapus manual di Meta Business Suite bila terlihat.`,
	});
	return { ok: true, verdict: `Koneksi Facebook SEHAT: halaman "${page.name}" siap menerima posting otomatis.`, steps, page };
}
