// Modul NEWS untuk Role BOT: tarik feed berita -> rewrite via Gemini ->
// posting ke Blogger. Semua state di Turso (bot_kv / news_source / news_article).
import { newsSiteUrl } from "./integrations";
import { getSys } from "./settings";
import { getTurso } from "./turso";
import { aiGenerate, aiNextReadyInMs, aiUsableProviders, AiUnavailableError, legacyProviders, parseProviders } from "./ai-provider";
import { tsNow, tsNowIndonesianDate, tsPlusMinutes } from "./time";

// Dipakai dropdown "Tambah Sumber" (panel) & filter kategori di endpoint publik
// /public/news. Daftar cocok dengan kategori RSS Liputan6 yang sudah dicek --
// begitu sumber per-kategori ditambahkan, artikelnya otomatis kebagi rapi.
export const NEWS_CATEGORIES = ["umum", "nasional", "bisnis", "olahraga", "bola", "hiburan", "selebritis", "teknologi", "otomotif", "kesehatan", "lifestyle"] as const;
const NEWS_CATEGORY_LABELS: Record<string, string> = {
	umum: "Umum",
	nasional: "Nasional",
	bisnis: "Bisnis",
	olahraga: "Olahraga",
	bola: "Bola",
	hiburan: "Hiburan",
	selebritis: "Selebritis",
	teknologi: "Teknologi",
	otomotif: "Otomotif",
	kesehatan: "Kesehatan",
	lifestyle: "Lifestyle",
};
function newsCategoryLabel(cat: string): string {
	return NEWS_CATEGORY_LABELS[cat] || NEWS_CATEGORY_LABELS.umum;
}

// Pola error yang sifatnya SEMENTARA (geo-block Gemini/Blogger, rate-limit,
// ATAU limit subrequest Cloudflare per-invocation "Too many subrequests" --
// ini muncul lagi setelah nambah Groq sbg fallback karena tiap artikel yang
// gagal total di Gemini kini nyoba 1 fetch tambahan ke Groq, kadang keburu
// kelewat 50 subrequest/invocation). Dipakai di SEMUA titik tangkap error
// (Blogger, FB langsung, FB template) supaya artikel yang kena ini direset
// balik ke 'new'/'processing' TIDAK PERNAH ditandai 'error' permanen --
// tick berikutnya (kemungkinan lewat edge/invocation lain yang lebih longgar)
// otomatis coba lagi. Ini akar masalah yang sama persis dgn bug geo-block
// yang sudah pernah diperbaiki sebelumnya, cuma pesan errornya beda.
// "Failed to generate JSON"/json_validate_failed = Groq's strict JSON mode
// kadang gagal parse output modelnya sendiri utk artikel TERTENTU (hiccup,
// bukan model/key-nya rusak permanen) -- artikel lain dgn model & key SAMA
// biasa tetap sukses. Perlakukan sbg transient jg spy artikel ini dicoba lagi
// (bukan macet error selamanya), bukan dianggap semua provider mati total.
const TRANSIENT_ERROR_RE =
	/location is not supported|rateLimitExceeded|RESOURCE_EXHAUSTED|resource has been exhausted|user-?Rate ?Limit|too many subrequests|failed to generate json|json_validate_failed|terlalu pendek|judul nyaris sama persis|"code":\s*429|HTTP 429|HTTP 5\d\d|Gagal menghubungi server|tidak membalas|jawaban kosong/i;

// Kolom category ditambahkan belakangan -- migrasi malas (lazy), sama seperti
// fb_template_caption di bawah: dicoba sekali per cold-start isolate, aman
// dipanggil berkali² (duplicate column diabaikan), tidak perlu skrip migrasi
// manual terpisah.
let newsCategoryColumnsEnsured = false;
/** Hanya untuk tes: tiap tes memakai database Turso tiruan baru, jadi penanda "kolom sudah dicek" harus direset. */
export const resetNewsColumnsGuard = (): void => {
	newsCategoryColumnsEnsured = false;
};
export async function ensureNewsCategoryColumns(env: Env): Promise<void> {
	if (newsCategoryColumnsEnsured) return;
	const db = getTurso(env);
	// Satu pragma_table_info per tabel (dulu 7 ALTER yang hampir selalu gagal "duplicate column" -- 7 round-trip sia-sia tiap cold start).
	const colsOf = async (t: string): Promise<Set<string>> => {
		try {
			const r = await db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>();
			return new Set((r.results ?? []).map((x) => String(x.name)));
		} catch {
			return new Set();
		}
	};
	const srcCols = await colsOf("news_source");
	const artCols = await colsOf("news_article");
	for (const stmt of [
		`ALTER TABLE news_source ADD COLUMN category TEXT NOT NULL DEFAULT 'umum'`,
		`ALTER TABLE news_article ADD COLUMN category TEXT NOT NULL DEFAULT 'umum'`,
		// site_posted_at = kapan artikel ini tersedia di LapakStore88 (Berita Terkini) --
		// TERPISAH dari posted_at (kapan sukses posting ke Blogger). Blogger tetap
		// dibatasi daily_cap (anti-spam-flag), tapi situs sendiri TIDAK dibatasi sama
		// sekali (lihat newsProcessOne/botNewsRun) -- pemilik minta situs sendiri boleh
		// jauh lebih banyak daripada Blogger.
		`ALTER TABLE news_article ADD COLUMN site_posted_at TEXT NOT NULL DEFAULT ''`,
		// keywords = kata kunci SEO (dipisah koma) hasil generate AI per-artikel --
		// dipakai sbg label tambahan Blogger & diekspos di JSON publik supaya situs
		// sendiri (frontend terpisah) bisa render <meta name="keywords"> sendiri.
		`ALTER TABLE news_article ADD COLUMN keywords TEXT NOT NULL DEFAULT ''`,
		// meta_description = ringkasan SEO hasil AI (sebelumnya cuma dipakai sesaat
		// utk searchDescription Blogger, TIDAK pernah disimpan ke DB) -- disimpan
		// balik supaya situs sendiri juga bisa pakai deskripsi asli, bukan potongan
		// judul, buat <meta name="description">/Open Graph.
		`ALTER TABLE news_article ADD COLUMN meta_description TEXT NOT NULL DEFAULT ''`,
		// views = penghitung dibaca, naik 1x tiap halaman artikel dibuka di situs
		// sendiri (lihat publicNewsHit). Dipakai buat "Terpopuler" yang JUJUR
		// (berdasar pembaca beneran), bukan sekadar artikel terbaru.
		`ALTER TABLE news_article ADD COLUMN views INTEGER NOT NULL DEFAULT 0`,
		// claimed_at = kapan status artikel diubah jadi 'processing' (lihat
		// newsProcessOne) -- dipakai recoverStuckProcessing() utk membedakan
		// artikel yang BENERAN sedang diproses invocation lain (baru saja
		// diklaim) dari yang NYANGKUT permanen (klaim lama tapi tidak pernah
		// selesai/gagal dengan benar, mis. proses mati mendadak di tengah jalan).
		`ALTER TABLE news_article ADD COLUMN claimed_at TEXT NOT NULL DEFAULT ''`,
		// tg_posted_at = kapan artikel diposting ke channel Telegram ('' = belum, 'error' = gagal permanen).
		`ALTER TABLE news_article ADD COLUMN tg_posted_at TEXT NOT NULL DEFAULT ''`,
		`CREATE INDEX IF NOT EXISTS ix_news_tg ON news_article(tg_posted_at, site_posted_at)`,
		// Index untuk query SITUS PUBLIK (Berita Terkini): semuanya menyaring
		// `site_posted_at != ''` lalu mengurutkan `site_posted_at DESC, id DESC`,
		// dan versi per-kategori menambah `category=?`. Tanpa index ini tiap
		// pembukaan halaman memindai + mengurutkan SELURUH tabel news_article --
		// dan tabel itu tidak pernah dipangkas (artikel yang sudah tayang sengaja
		// disimpan sbg arsip), jadi halaman publik makin lambat seiring waktu.
		// Ditaruh di sini (bukan file migrasi terpisah) supaya ikut jalan sendiri
		// sekali per cold-start, sama seperti ALTER TABLE di atas.
		`CREATE INDEX IF NOT EXISTS ix_news_public ON news_article(site_posted_at, id)`,
		`CREATE INDEX IF NOT EXISTS ix_news_public_cat ON news_article(category, site_posted_at, id)`,
		// Index tambahan utk jalur Facebook Langsung (pilih artikel belum diposting) & "Terpopuler".
		`CREATE INDEX IF NOT EXISTS ix_news_fb ON news_article(fb_direct_posted_at, id)`,
		`CREATE INDEX IF NOT EXISTS ix_news_views ON news_article(views DESC, id DESC)`,
	]) {
		const alt = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(stmt);
		if (alt) {
			const have = alt[1] === "news_source" ? srcCols : artCols;
			if (have.size && have.has(alt[2])) continue; // kolom sudah ada
		}
		try {
			await db.prepare(stmt).run();
		} catch {
			/* kolom/index sudah ada -> abaikan */
		}
	}
	// PEMBALIKAN backfill lama: sempat ada migrasi sementara yang mengisi
	// site_posted_at dari posted_at utk SEMUA artikel status='posted' (Blogger),
	// supaya tidak "hilang" dari Berita Terkini sebelum loop situs sendiri ada.
	// Sekarang pemilik tegas minta 2 jalur ini TIDAK BOLEH dobel -- artikel yang
	// posting ke Blogger TIDAK tampil di situs sendiri. Bersihkan sisa dari
	// backfill lama itu (idempotent: no-op begitu semuanya sudah bersih).
	try {
		await getTurso(env).prepare(`UPDATE news_article SET site_posted_at = '' WHERE status = 'posted' AND site_posted_at != ''`).run();
	} catch {
		/* abaikan */
	}
	newsCategoryColumnsEnsured = true;
}

// ---------------------------------------------------------------------------
// Konfigurasi (key-value)
// ---------------------------------------------------------------------------
export async function botCfg(env: Env): Promise<Record<string, string>> {
	const r = await getTurso(env).prepare(`SELECT k, v FROM bot_kv`).all<{ k: string; v: string }>();
	const o: Record<string, string> = {};
	for (const row of r.results ?? []) o[String(row.k)] = String(row.v ?? "");
	return o;
}

export async function botCfgSet(env: Env, patch: Record<string, string>): Promise<void> {
	const now = tsNow();
	const stmts = Object.entries(patch).map(([k, v]) =>
		getTurso(env)
			.prepare(
				`INSERT INTO bot_kv (k, v, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
			)
			.bind(k, String(v ?? ""), now),
	);
	if (stmts.length) await getTurso(env).batch(stmts);
}

const escHtml = (s: string) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escHtml(s).replace(/"/g, "&quot;");

async function sha256Hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function todayKey(): string {
	return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Feed parsing
// ---------------------------------------------------------------------------
interface FeedItem {
	title: string;
	url: string;
	excerpt: string;
	image: string;
}

function decodeEntities(s: string): string {
	return String(s || "")
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&apos;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
	return decodeEntities(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseRss(xml: string): FeedItem[] {
	const items: FeedItem[] = [];
	const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
	for (const b of blocks) {
		const pick = (tag: string) => {
			const m = b.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
			return m ? decodeEntities(m[1]).trim() : "";
		};
		const title = stripTags(pick("title"));
		let url = pick("link");
		// beberapa feed pakai <link/> kosong + <guid> berisi url, atau link di atribut
		if (!url) url = pick("guid");
		const descRaw = pick("description") || pick("content:encoded");
		const excerpt = stripTags(descRaw).slice(0, 600);
		let image = "";
		const enc = b.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i);
		if (enc) image = decodeEntities(enc[1]);
		if (!image) {
			const media = b.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["']/i);
			if (media) image = decodeEntities(media[1]);
		}
		if (!image) {
			const img = descRaw.match(/<img[^>]+src=["']([^"']+)["']/i);
			if (img) image = decodeEntities(img[1]);
		}
		if (title && url) items.push({ title, url: url.trim(), excerpt, image });
	}
	return items;
}

/** Google News RSS link -> URL artikel asli (ikuti redirect). */
async function resolveGnews(link: string): Promise<string> {
	try {
		const r = await fetch(link, { headers: { "User-Agent": UA }, redirect: "follow" });
		const finalUrl = r.url || link;
		if (finalUrl && !/news\.google\.com/i.test(finalUrl)) return finalUrl;
		// Kadang Google News balas HTML dgn <a href> ke artikel.
		const html = await r.text();
		const m = html.match(/<a[^>]+href=["'](https?:\/\/(?!news\.google)[^"']+)["']/i);
		return m ? m[1] : link;
	} catch {
		return link;
	}
}

/** Gambar utama halaman artikel (og:image / twitter:image / itemprop). */
export function extractOgImage(html: string): string {
	// Beberapa situs (mis. Kompas) menaruh atribut dalam urutan/variasi lain --
	// dicoba beberapa pola sebelum menyerah, bukan cuma og:image standar.
	const m =
		html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
		html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
		html.match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i) ||
		html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i) ||
		html.match(/<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/i) ||
		html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i);
	return m ? decodeEntities(m[1]) : "";
}

/** Bagian isi artikel (tag <article> terbesar); kalau tidak ada, seluruh <body>. */
function articleRegion(html: string): string {
	const arts = html.match(/<article\b[\s\S]*?<\/article>/gi) || [];
	const best = arts.sort((x, y) => y.length - x.length)[0];
	if (best && best.length > 1500) return best;
	const body = html.match(/<body\b[\s\S]*<\/body>/i);
	return body ? body[0] : html;
}

const IMG_JUNK_RE =
	/logo|icon|favicon|avatar|sprite|[\/_-]ads?[\/_.-]|advert|banner|pixel|placeholder|emoji|button|badge|author|profile|spacer|blank\.|1x1|loading|lazy\.(png|gif)|facebook|twitter|whatsapp|instagram|youtube|tiktok|share|appstore|playstore|qr[-_]?code/i;

const attrOf = (tag: string, name: string) => {
	const m = tag.match(new RegExp("\\s" + name + "\\s*=\\s*[\"']([^\"']*)[\"']", "i"));
	return m ? decodeEntities(m[1]).trim() : "";
};

/**
 * Foto-foto di dalam isi artikel sumber (bukan logo/ikon/iklan), urut sesuai
 * kemunculan, tanpa duplikat. Dipakai untuk menambah gambar di artikel hasil
 * tulis ulang (pemilik minta "jangan cuma 1 gambar").
 */
export function extractArticleImages(html: string, pageUrl: string, max: number, skip: string[] = []): string[] {
	const out: string[] = [];
	const seen = new Set(skip.filter(Boolean).map((u) => u.split("?")[0]));
	// Thumbnail "Baca juga"/artikel terkait = gambar di dalam link ke HALAMAN lain
	// (bukan ke file gambarnya sendiri) -> dibuang, begitu juga isi aside/nav/footer.
	const region = articleRegion(html)
		.replace(/<(aside|nav|footer|header)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs: string, inner: string) => {
			const href = (attrs.match(/href\s*=\s*["']([^"']*)["']/i) || [])[1] || "";
			return /\.(jpe?g|png|webp)(\?|$)/i.test(href) ? whole : inner.replace(/<img\b[^>]*>/gi, "");
		});
	for (const m of region.matchAll(/<img\b[^>]*>/gi)) {
		if (out.length >= max) break;
		const tag = m[0];
		let src = attrOf(tag, "data-src") || attrOf(tag, "data-original") || attrOf(tag, "data-lazy-src") || "";
		const srcset = attrOf(tag, "data-srcset") || attrOf(tag, "srcset");
		if (!src && srcset) src = srcset.split(",").map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).pop() || "";
		if (!src) src = attrOf(tag, "src");
		if (!src || /^data:/i.test(src)) continue;
		let abs = "";
		try {
			abs = new URL(src, pageUrl).toString();
		} catch {
			continue;
		}
		if (!/^https?:\/\//i.test(abs) || /\.(svg|gif)(\?|$)/i.test(abs)) continue;
		const meta = [abs, attrOf(tag, "class"), attrOf(tag, "id"), attrOf(tag, "alt")].join(" ");
		if (IMG_JUNK_RE.test(meta)) continue;
		const w = Number(attrOf(tag, "width")) || 0;
		const h = Number(attrOf(tag, "height")) || 0;
		if ((w && w < 300) || (h && h < 200)) continue;
		const key = abs.split("?")[0];
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(abs);
	}
	return out;
}

/** Teks paragraf isi artikel sumber (tanpa navigasi/iklan), maks `maxChars`. */
export function extractArticleText(html: string, maxChars = 6000): string {
	const region = articleRegion(html).replace(/<(script|style|noscript|figure|aside|nav|footer)\b[\s\S]*?<\/\1>/gi, " ");
	const paras: string[] = [];
	let total = 0;
	for (const m of region.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
		const t = decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
		if (t.length < 40) continue;
		if (/^(baca juga|lihat juga|simak juga|advertisement|scroll to continue|copyright|ikuti|follow|download|klik di sini)/i.test(t)) continue;
		paras.push(t);
		total += t.length + 1;
		if (total >= maxChars) break;
	}
	return paras.join("\n").slice(0, maxChars);
}

/** Ambil halaman artikel sumber SEKALI: gambar utama, foto-foto isi, dan teksnya. */
async function fetchSourcePage(pageUrl: string, maxImages: number): Promise<{ ogImage: string; images: string[]; text: string }> {
	try {
		const r = await fetch(pageUrl, { headers: { "User-Agent": UA } });
		if (!r.ok) return { ogImage: "", images: [], text: "" };
		const html = (await r.text()).slice(0, 1_500_000);
		const ogImage = extractOgImage(html);
		return {
			ogImage,
			images: maxImages > 0 ? extractArticleImages(html, pageUrl, maxImages, [ogImage]) : [],
			text: extractArticleText(html),
		};
	} catch {
		return { ogImage: "", images: [], text: "" };
	}
}

/** <meta property="og:image"> dari halaman artikel — fallback saat feed (mis. Google News) tidak kirim gambar. */
async function fetchOgImage(pageUrl: string): Promise<string> {
	return (await fetchSourcePage(pageUrl, 0)).ogImage;
}

/**
 * Sisipkan foto tambahan merata di antara paragraf (bukan menumpuk di atas).
 * Batas paragraf = "</p>"; foto tidak pernah ditaruh sesudah paragraf terakhir.
 */
export function insertImagesBetweenParagraphs(html: string, images: string[], alt: string, credit: string): string {
	if (!images.length) return html;
	const parts = html.split(/(<\/p>)/i);
	const closeIdx: number[] = [];
	parts.forEach((p, i) => {
		if (/^<\/p>$/i.test(p)) closeIdx.push(i);
	});
	const n = closeIdx.length;
	if (n < 2) return html;
	const slots = Math.min(images.length, n - 1);
	const inserts = new Map<number, string>();
	for (let k = 0; k < slots; k++) {
		const after = Math.max(1, Math.round(((k + 1) * n) / (slots + 1))); // paragraf ke-
		const at = closeIdx[Math.min(after, n - 1) - 1];
		const fig =
			`<figure style="margin:22px 0;text-align:center"><img src="${escAttr(images[k])}" alt="${escAttr(alt)} (${k + 2})" loading="lazy" style="max-width:100%;height:auto;border-radius:8px">` +
			(credit ? `<figcaption style="font-size:12px;color:#888;margin-top:6px">Foto: ${escHtml(credit)}</figcaption>` : "") +
			`</figure>`;
		inserts.set(at, (inserts.get(at) || "") + "\n" + fig);
	}
	return parts.map((p, i) => p + (inserts.get(i) || "")).join("");
}

async function fetchFeed(kind: string, url: string): Promise<FeedItem[]> {
	const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml,application/xml,text/xml,*/*" } });
	if (!r.ok) throw new Error(`feed ${url} -> HTTP ${r.status}`);
	const xml = await r.text();
	return parseRss(xml);
}

// ---------------------------------------------------------------------------
// Tarik feed -> simpan artikel baru (status "new")
// ---------------------------------------------------------------------------
export async function newsPullSources(env: Env, perSource = 6): Promise<{ added: number; scanned: number }> {
	await ensureNewsCategoryColumns(env);
	// ORDER BY RANDOM() -- PENTING: EXTERNAL_FETCH_BUDGET di bawah (14) selalu
	// lebih kecil dari jumlah sumber aktif sekarang (~19+ setelah nambah RSS
	// per-kategori Liputan6+Detik), jadi kalau urutannya tetap (id ASC, default
	// SQLite), sumber dgn id lebih besar (yang paling baru ditambah) TIDAK
	// PERNAH kebagian giliran ditarik -- budget selalu habis duluan di sumber
	// lama. Acak urutannya tiap pull supaya semua sumber gantian kebagian.
	const srcs =
		(
			await getTurso(env)
				.prepare(`SELECT id, name, kind, url, category FROM news_source WHERE active = 1 ORDER BY RANDOM()`)
				.all<{ id: number; name: string; kind: string; url: string; category: string }>()
		).results ?? [];
	// Cloudflare Free: 50 subrequest/invocation, TERHITUNG jg query Turso — dan
	// botNewsRun masih lanjut newsProcessOne (fetch Gemini+Blogger) sesudah ini
	// dalam invocation yang SAMA. Batasi total fetch eksternal (feed + resolve
	// gnews) di sini, dan tulis hasil lewat batch (bukan 1 query per artikel) —
	// dulu 10 sumber x 12 item x 1 query = ratusan subrequest -> "Too many
	// subrequests" -> exception tak tertangkap -> auto-post diam tanpa error.
	const EXTERNAL_FETCH_BUDGET = await getSys(env, "sys_news_ext_fetch_budget"); // diatur admin (bawaan 14)
	let extFetches = 0;
	let scanned = 0;
	const rows: { source: string; url: string; hash: string; title: string; excerpt: string; image: string; category: string }[] = [];
	const seenHash = new Set<string>();

	for (const s of srcs) {
		if (extFetches >= EXTERNAL_FETCH_BUDGET) break;
		try {
			extFetches++;
			const items = (await fetchFeed(s.kind, s.url)).slice(0, perSource);
			for (const it of items) {
				if (extFetches >= EXTERNAL_FETCH_BUDGET) break;
				scanned++;
				let realUrl = it.url;
				if (s.kind === "gnews") {
					extFetches++;
					realUrl = await resolveGnews(it.url);
				}
				if (!/^https?:\/\//i.test(realUrl)) continue;
				const h = await sha256Hex(realUrl.split("#")[0]);
				if (seenHash.has(h)) continue;
				seenHash.add(h);
				rows.push({ source: s.name, url: realUrl, hash: h, title: it.title, excerpt: it.excerpt, image: it.image || "", category: s.category || "umum" });
			}
		} catch (e) {
			console.error("newsPullSources", s.name, e instanceof Error ? e.message : e);
		}
	}

	let added = 0;
	const now = tsNow();
	const stmts = rows.map((r) =>
		getTurso(env)
			.prepare(
				`INSERT OR IGNORE INTO news_article
				   (source, url, url_hash, title, excerpt, image_url, status, found_at, category)
				 VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
			)
			.bind(r.source, r.url, r.hash, r.title, r.excerpt, r.image, now, r.category),
	);
	for (let i = 0; i < stmts.length; i += 25) {
		const res = await getTurso(env).batch(stmts.slice(i, i + 25));
		added += res.filter((r) => r.meta.changes > 0).length;
	}
	return { added, scanned };
}

// ---------------------------------------------------------------------------
// Tulis ulang artikel (provider dari BOT -> Setting -> AI Provider)
// ---------------------------------------------------------------------------
// Target panjang bawaan (paragraf). Dinaikkan dari 8-14 atas permintaan
// pemilik ("artikel lebih panjang"); bisa diubah di Setting -> Konten.
export const DEFAULT_PARA_MIN = 12;
export const DEFAULT_PARA_MAX = 18;
// Jumlah gambar per artikel (1 gambar utama + foto tambahan dari isi artikel sumber).
export const DEFAULT_IMAGES_PER_ARTICLE = 4;
/**
 * Sekali saja sesudah update "artikel lebih panjang + lebih banyak gambar":
 * pengaturan lama yang di bawah target baru dinaikkan. Sesudah itu pemilik
 * bebas mengubahnya lagi di Setting -> Konten (tidak ditimpa ulang).
 */
export async function ensureContentDefaultsV2(env: Env, cfg: Record<string, string>): Promise<void> {
	if (cfg.content_v2 === "1") return;
	const patch: Record<string, string> = { content_v2: "1" };
	if (!(Number(cfg.para_min) >= DEFAULT_PARA_MIN)) patch.para_min = String(DEFAULT_PARA_MIN);
	if (!(Number(cfg.para_max) >= DEFAULT_PARA_MAX)) patch.para_max = String(DEFAULT_PARA_MAX);
	if (!cfg.images_per_article) patch.images_per_article = String(DEFAULT_IMAGES_PER_ARTICLE);
	await botCfgSet(env, patch);
	Object.assign(cfg, patch);
}

export function imagesPerArticle(cfg: Record<string, string>): number {
	const n = Math.floor(Number(cfg.images_per_article || DEFAULT_IMAGES_PER_ARTICLE));
	return Math.min(8, Math.max(1, Number.isFinite(n) ? n : DEFAULT_IMAGES_PER_ARTICLE));
}

interface Rewritten {
	title: string;
	html: string;
	metaDescription: string;
	category: string;
	keywords: string[];
	ctaParagraph: string;
}

export async function geminiRewrite(
	env: Env,
	cfg: Record<string, string>,
	art: { title: string; excerpt: string; source: string; url: string; sourceText?: string },
): Promise<Rewritten> {
	// Provider AI diambil dari daftar BOT -> Setting -> AI Provider (urutan =
	// prioritas, lihat lib/ai-provider.ts). Hasil tiap provider DIVALIDASI di
	// sini (format, panjang, judul tidak disalin); kalau jelek, provider
	// berikutnya langsung dicoba -- artikel tidak dibakar jadi error.
	const style = cfg.rewrite_style || "Tulis ulang jadi artikel berbahasa Indonesia yang mengalir, gaya jurnalistik ringan, tapi tetap menarik dan enak dibaca -- bukan kaku/datar seperti siaran pers.";
	const pMin = Math.max(1, Number(cfg.para_min || String(DEFAULT_PARA_MIN)));
	const pMax = Math.max(pMin, Number(cfg.para_max || String(DEFAULT_PARA_MAX)));
	const paraTarget = pMin + Math.floor(Math.random() * (pMax - pMin + 1));
	const minWords = paraTarget * 65;
	const sourceText = String(art.sourceText || "").slice(0, 6000);
	const prompt =
		`${style}\n\n` +
		`Berdasarkan ringkasan berikut, tulis artikel BARU yang PANJANG dan MENDALAM, sepanjang ${paraTarget} paragraf ` +
		`(jangan menyalin kalimat asli, jangan mengarang fakta/angka spesifik yang tidak ada di ringkasan). ` +
		`Supaya pembahasannya detail dan tidak terasa diulur-ulur, bangun artikel dengan beberapa sudut berikut ` +
		`(pilih yang relevan dengan topiknya, TIDAK harus semua): ` +
		`(1) pembukaan yang menjelaskan inti kejadian, (2) latar belakang/kronologi/konteks sebelumnya, ` +
		`(3) penjelasan lebih rinci tiap poin penting di ringkasan — pecah jadi beberapa paragraf, jangan digabung jadi satu, ` +
		`(4) dampak atau relevansinya bagi pembaca/masyarakat/industri terkait, ` +
		`(5) reaksi atau sudut pandang pihak-pihak terkait (SECARA UMUM/wajar, JANGAN mengarang kutipan/nama yang tidak ada di ringkasan), ` +
		`(6) penutup yang merangkum & memberi gambaran ke depan. ` +
		`Paragraf PERTAMA WAJIB jadi hook yang bikin pembaca penasaran lanjut baca -- JANGAN mulai dengan mengulang ` +
		`judul atau basa-basi umum ("Baru-baru ini...", "Dalam sebuah peristiwa..."). Mulai langsung dengan sesuatu yang ` +
		`konkret & spesifik: angka/fakta paling mengejutkan dari ringkasan, gambaran singkat momen kejadiannya, atau ` +
		`pertanyaan tajam yang langsung dijawab kalimat berikutnya -- lalu di kalimat ke-2/ke-3 baru jelaskan kenapa ini ` +
		`penting buat pembaca. 2-3 kalimat pertama ini yang menentukan pembaca lanjut baca atau tidak, jadi jangan datar. ` +
		`Variasikan struktur kalimat (jangan semua paragraf mulai dengan pola subjek yang sama), pakai bahasa yang hidup ` +
		`dan konkret (bukan klise/basa-basi berita formal yang datar), tapi tetap akurat dan tidak berlebihan/clickbait. ` +
		`Tiap paragraf WAJIB 4-6 kalimat yang mengalir (kira-kira 70-110 kata), bukan poin-poin pendek. ` +
		`Total isi artikel MINIMAL ${minWords} kata -- kalau bahannya terasa kurang, perdalam konteks, latar belakang, ` +
		`penjelasan istilah, dan dampaknya bagi pembaca, TANPA mengarang fakta, angka, nama, atau kutipan baru. ` +
		`Kalau artikelnya cukup panjang (kira-kira lebih dari 6 paragraf), sisipkan 2-4 sub-judul singkat pakai tag ` +
		`<h2>...</h2> di body_html untuk memecah bagian-bagian di atas (mis. sebelum bagian latar belakang, dampak, ` +
		`reaksi, dst) -- ini membantu SEO & pembaca yang skimming, JANGAN pakai <h1> (judul utama sudah ada terpisah). ` +
		`Sertakan juga "meta_description": ringkasan 1 kalimat (maks 155 karakter) utk cuplikan hasil pencarian Google — ` +
		`bukan copy kalimat pertama artikel, tapi rangkuman inti isi artikel. ` +
		`Sertakan juga "category": kategori artikel ini, PILIH TEPAT SATU dari daftar berikut sesuai topik sebenarnya ` +
		`(jangan mengarang kategori lain di luar daftar): ${NEWS_CATEGORIES.join(", ")}. ` +
		`Sertakan juga "keywords": array berisi 5-8 kata kunci/frasa pendek berbahasa Indonesia yang RELEVAN dengan topik artikel ` +
		`ini dan SERING dicari orang di Google (search term populer terkait topiknya, bukan kalimat lengkap) -- untuk SEO. ` +
		`Sertakan juga "title": JUDUL BARU -- WAJIB ditulis ulang dgn susunan kata & struktur kalimat yang BEDA dari JUDUL ASLI ` +
		`di bawah (bukan cuma ganti 1-2 kata atau tukar posisi kata), tetap akurat & merangkum inti berita yang sama, TIDAK ` +
		`clickbait/menyesatkan, panjang wajar buat judul berita (bukan kalimat lengkap super panjang). Kalau JUDUL ASLI ` +
		`disalin/nyaris disalin mentah, itu SALAH -- judul harus benar-benar hasil tulisan ulangmu sendiri, sama seperti isi artikelnya. ` +
		`Sertakan juga "cta_paragraph": SATU paragraf pendek (2-3 kalimat) TERPISAH dari body_html, ditulis dgn gaya ` +
		`ngobrol yang hangat (bukan iklan kaku) mengajak pembaca terus mantengin berita terkini dari LapakStore88 -- ` +
		`misal ajak follow/gabung kanal resminya biar tidak ketinggalan update berikutnya. JANGAN sertakan link/URL apa pun ` +
		`di sini (link sebenarnya sudah ditempel otomatis terpisah oleh sistem) -- cukup ajakannya saja, dan JANGAN ` +
		`menyebut platform spesifik (WhatsApp/Facebook/dll) supaya tetap relevan dipasang di mana saja. ` +
		`Balas HANYA JSON valid tanpa markdown: {"title": "...", "meta_description": "...", "category": "...", "keywords": ["...", "..."], "cta_paragraph": "...", "body_html": "<p>...</p><p>...</p>"}.\n\n` +
		`JUDUL ASLI (JANGAN disalin, tulis ulang beda): ${art.title}\n` +
		`RINGKASAN: ${art.excerpt || "(tidak ada, tulis ringkas dari judul saja)"}\n` +
		(sourceText ? `BAHAN DARI ARTIKEL SUMBER (fakta yang boleh dipakai; JANGAN salin kalimatnya, tulis ulang dgn kata-katamu sendiri):\n${sourceText}\n` : "") +
		`SUMBER: ${art.source}`;
	const parseRewritten = (raw: string): Rewritten => {
		let text = raw.replace(/^﻿/, "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

		let title = "";
		let html = "";
		let metaDescription = "";
		let category = "";
		let keywords: string[] = [];
		let ctaParagraph = "";

		// 1) coba parse JSON apa adanya
		const tryParse = (s: string): boolean => {
			try {
				const p = JSON.parse(s);
				if (p && (p.body_html || p.html)) {
					title = String(p.title || "").trim();
					html = String(p.body_html || p.html || "").trim();
					metaDescription = String(p.meta_description || "").trim();
					category = String(p.category || "").trim().toLowerCase();
					ctaParagraph = String(p.cta_paragraph || "").trim();
					if (Array.isArray(p.keywords)) {
						keywords = p.keywords.map((k: unknown) => String(k || "").trim()).filter(Boolean);
					}
					return true;
				}
			} catch {
				/* noop */
			}
			return false;
		};
		const jsonM = text.match(/\{[\s\S]*\}/);
		if (!tryParse(text) && jsonM) {
			// 2) perbaiki masalah umum: newline mentah di dalam string JSON
			const repaired = jsonM[0].replace(/([^\\])\n/g, "$1\\n").replace(/\r/g, "");
			tryParse(repaired);
		}
		// 3) kalau JSON tetap gagal, ekstrak field pakai regex (JANGAN buang mentah JSON)
		if (!html) {
			const tm = text.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
			const bm = text.match(/"body_html"\s*:\s*"((?:[^"\\]|\\.)*)"/);
			const dm = text.match(/"meta_description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
			const cm = text.match(/"category"\s*:\s*"((?:[^"\\]|\\.)*)"/);
			const ctam = text.match(/"cta_paragraph"\s*:\s*"((?:[^"\\]|\\.)*)"/);
			if (bm) {
				const unesc = (x: string) => x.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
				html = unesc(bm[1]).trim();
				if (tm) title = unesc(tm[1]).trim();
				if (dm) metaDescription = unesc(dm[1]).trim();
				if (cm) category = unesc(cm[1]).trim().toLowerCase();
				if (ctam) ctaParagraph = unesc(ctam[1]).trim();
			}
		}
		// 4) benar-benar bukan JSON: anggap teks polos = body (bersihkan sisa JSON kalau ada)
		if (!html && text && !/^[\s{[]*["{]?\s*"?title"?\s*:/.test(text)) {
			html = text
				.split(/\n{2,}/)
				.map((p) => `<p>${p.replace(/<[^>]+>/g, "").trim()}</p>`)
				.filter((p) => p !== "<p></p>")
				.join("\n");
		}

		if (!html || /^\s*\{[\s\S]*"body_html"/.test(html)) {
			throw new Error("AI balas format tidak bisa dibaca (bukan artikel).");
		}
		// PERBAIKAN: sebelum ini, artikel 1 paragraf pendek (atau kalimat ngaco dari
		// model kualitas rendah, mis. model "agent/routing" yg salah kepilih) tetap
		// LOLOS & terbit apa adanya -- tidak ada validasi panjang sama sekali.
		// Prompt minta ${paraTarget} paragraf (target pMin..pMax, biasanya 8-14);
		// kalau hasilnya jauh di bawah itu, besar kemungkinan modelnya tidak becus
		// ikuti instruksi -- tolak & coba lagi (retryable), JANGAN diterbitkan
		// apa adanya.
		const plainWordCount = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).length;
		// Minimal ~separuh target: di bawah itu modelnya jelas tidak ikuti instruksi.
		const MIN_WORDS = Math.max(250, Math.round(minWords / 2));
		if (plainWordCount < MIN_WORDS) {
			throw new Error(`AI balas artikel terlalu pendek (${plainWordCount} kata, target ${paraTarget} paragraf) -- kemungkinan model yang dipakai kualitasnya rendah/salah/tidak ikuti instruksi.`);
		}
		// PERBAIKAN: judul hasil AI kadang nyaris disalin mentah dari judul asli
		// (cuma tukar 1-2 kata) walau sudah diminta ditulis ulang di prompt --
		// AI kadang tidak patuh instruksi. Cek kemiripan kata (bukan exact match
		// saja, biar nangkep parafrase tipis juga) -- kalau terlalu mirip, tolak &
		// coba lagi (retryable), sama seperti validasi panjang body di atas.
		if (title) {
			const normWords = (s: string) =>
				s
					.toLowerCase()
					.replace(/[^\p{L}\p{N}\s]/gu, " ")
					.split(/\s+/)
					.filter(Boolean);
			const aiWords = new Set(normWords(title));
			const origWords = new Set(normWords(art.title));
			const overlap = [...aiWords].filter((w) => origWords.has(w)).length;
			const similarity = overlap / Math.max(1, Math.min(aiWords.size, origWords.size));
			if (aiWords.size >= 3 && similarity >= 0.85) {
				throw new Error(`AI balas judul nyaris sama persis dgn judul asli (mirip ${Math.round(similarity * 100)}%) -- harus ditulis ulang, bukan disalin/parafrase tipis.`);
			}
		}
		if (!title) title = art.title;
		if (!metaDescription) {
			// fallback: potong dari teks polos hasil rewrite (tanpa tag HTML)
			metaDescription = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 155);
		}
		// Kategori dari AI dipakai HANYA kalau cocok salah satu dari daftar resmi --
		// kalau Gemini "mengarang" nilai di luar daftar, biarkan kosong supaya
		// pemanggil (newsProcessOne) jatuh balik ke kategori sumbernya (aman,
		// tidak pernah menyimpan kategori sampah/tidak dikenal ke database).
		if (!(NEWS_CATEGORIES as readonly string[]).includes(category)) category = "";
		// Keyword cuma pemanis SEO tambahan -- kalau AI tidak balas array yang valid
		// (mis. lewat jalur fallback regex/teks-polos di atas), biarkan kosong saja,
		// JANGAN sampai bikin seluruh rewrite gagal cuma gara-gara field ini.
		keywords = keywords
			.map((k) => k.replace(/^[#\-*\s]+/, "").trim())
			.filter((k) => k.length > 1 && k.length <= 60)
			.slice(0, 8);
		// Jaring pengaman -- AI diminta TIDAK menyertakan link/tag di cta_paragraph,
		// tapi kalau tetap ada (mis. model kurang patuh), dibersihkan di sini supaya
		// tidak nyelip <a> ganda/rusak berdampingan dgn link resmi yang ditempel
		// terpisah oleh newsProcessOne. Kosong = wajar, blok ini nanti dilewati saja
		// (bukan error) -- paragraf ajakan follow ini pemanis, bukan wajib.
		ctaParagraph = ctaParagraph
			.replace(/<[^>]+>/g, " ")
			.replace(/https?:\/\/\S+/gi, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 400);
		return { title: title.slice(0, 180), html, metaDescription: metaDescription.slice(0, 155), category, keywords, ctaParagraph };
	};
	const { value } = await aiGenerate(
		env,
		cfg,
		{ purpose: "news-rewrite", messages: [{ role: "user", content: prompt }], temperature: 0.85, maxTokens: 8192, json: true },
		parseRewritten,
	);
	return value;
}

// ---------------------------------------------------------------------------
// Blogger API v3
// ---------------------------------------------------------------------------
let _bloggerTok: { token: string; exp: number } | null = null;

export const BLOGGER_SCOPE = "https://www.googleapis.com/auth/blogger";

/**
 * Izin Google untuk Blogger sudah tidak berlaku (refresh token kedaluwarsa /
 * dicabut / client OAuth salah). BUKAN masalah sementara: setiap percobaan
 * berikutnya pasti gagal sampai pemilik menghubungkan ulang dari panel
 * (BOT -> Setting -> Koneksi Blogger). Dibedakan dari error biasa supaya
 * artikel TIDAK dibakar jadi 'error' satu per satu tiap tick.
 *
 * Penyebab paling sering: app OAuth di Google Cloud masih berstatus
 * "Testing" -> refresh token otomatis mati 7 hari setelah dibuat.
 */
export class BloggerAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BloggerAuthError";
	}
}

export function isBloggerAuthMessage(msg: string): boolean {
	return /Blogger terputus|Blogger OAuth refresh gagal|invalid_grant/i.test(String(msg || ""));
}

export function resetBloggerTokenCache(): void {
	_bloggerTok = null;
}

export async function bloggerAccessToken(env: Env, cfg: Record<string, string>, opts: { fresh?: boolean } = {}): Promise<string> {
	if (!opts.fresh && _bloggerTok && _bloggerTok.exp > Date.now() + 60_000) return _bloggerTok.token;
	if (!cfg.blogger_client_id || !cfg.blogger_client_secret) {
		throw new BloggerAuthError("Blogger terputus: Client ID / Client Secret OAuth belum diisi (BOT -> Setting -> Koneksi Blogger).");
	}
	if (!cfg.blogger_refresh_token) {
		throw new BloggerAuthError("Blogger terputus: belum pernah dihubungkan. Klik Hubungkan Ulang di BOT -> Setting -> Koneksi Blogger.");
	}
	const body = new URLSearchParams({
		client_id: cfg.blogger_client_id,
		client_secret: cfg.blogger_client_secret,
		refresh_token: cfg.blogger_refresh_token,
		grant_type: "refresh_token",
	});
	const r = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
	const j = (await r.json().catch(() => ({}))) as any;
	if (!r.ok || !j.access_token) {
		const code = String(j?.error || "");
		if (code === "invalid_grant") {
			throw new BloggerAuthError(
				"Blogger terputus: izin Google kedaluwarsa/dicabut (invalid_grant). Hubungkan ulang di BOT -> Setting -> Koneksi Blogger.",
			);
		}
		if (code === "invalid_client" || code === "unauthorized_client") {
			throw new BloggerAuthError(`Blogger terputus: Client ID/Secret OAuth ditolak Google (${code}). Periksa di BOT -> Setting -> Koneksi Blogger.`);
		}
		throw new Error("Blogger OAuth sementara gagal (HTTP " + r.status + "): " + JSON.stringify(j).slice(0, 200));
	}
	_bloggerTok = { token: j.access_token, exp: Date.now() + Number(j.expires_in || 3500) * 1000 };
	return _bloggerTok.token;
}

/** Simpan/hapus status "Blogger terputus" -- hanya menulis kalau berubah. */
export async function bloggerSetAuthState(env: Env, cfg: Record<string, string>, error: string): Promise<void> {
	const current = cfg.blogger_auth_error || "";
	if (current === error) return;
	await botCfgSet(env, { blogger_auth_error: error, blogger_auth_error_at: error ? tsNow() : "" });
	cfg.blogger_auth_error = error;
}

export function bloggerRedirectUri(cfg: Record<string, string>): string {
	// Client OAuth jenis "Desktop app" menerima redirect ke localhost. Halaman
	// localhost memang tidak terbuka di browser -- yang dibutuhkan cuma `code`
	// di address bar, lalu ditempel ke panel (lihat bloggerExchangeCode).
	return (cfg.blogger_redirect_uri || "http://localhost").trim();
}

export function bloggerAuthUrl(cfg: Record<string, string>): string {
	if (!cfg.blogger_client_id) throw new Error("Isi Client ID OAuth dulu (BOT -> Setting -> Koneksi Blogger).");
	const q = new URLSearchParams({
		client_id: cfg.blogger_client_id,
		redirect_uri: bloggerRedirectUri(cfg),
		response_type: "code",
		scope: BLOGGER_SCOPE,
		// offline + consent = Google SELALU memberi refresh_token baru.
		access_type: "offline",
		prompt: "consent",
	});
	return "https://accounts.google.com/o/oauth2/v2/auth?" + q.toString();
}

/** Terima URL lengkap dari address bar ("http://localhost/?code=...&scope=...") ATAU kode mentahnya saja. */
export function extractOAuthCode(input: string): string {
	const raw = String(input || "").trim();
	if (!raw) return "";
	const m = raw.match(/[?&#]code=([^&#\s]+)/);
	const code = m ? m[1] : raw;
	try {
		return decodeURIComponent(code).trim();
	} catch {
		return code.trim();
	}
}

export async function bloggerExchangeCode(
	cfg: Record<string, string>,
	input: string,
): Promise<{ refreshToken: string; refreshExpiresAt: string }> {
	const code = extractOAuthCode(input);
	if (!code || code.length < 10) throw new Error("Kode izin Google tidak ditemukan. Tempel URL lengkap dari address bar setelah klik Izinkan.");
	if (!cfg.blogger_client_id || !cfg.blogger_client_secret) throw new Error("Client ID / Client Secret OAuth belum diisi.");
	const r = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: cfg.blogger_client_id,
			client_secret: cfg.blogger_client_secret,
			redirect_uri: bloggerRedirectUri(cfg),
			grant_type: "authorization_code",
		}).toString(),
	});
	const j = (await r.json().catch(() => ({}))) as any;
	if (!r.ok || !j.refresh_token) {
		const code = String(j?.error || "");
		const hint =
			code === "invalid_grant"
				? " Kode sudah dipakai/kedaluwarsa (kode cuma berlaku beberapa menit & sekali pakai) -- ulangi dari langkah 1."
				: code === "redirect_uri_mismatch"
					? " Redirect URI tidak cocok dengan client OAuth -- pakai client jenis Desktop app."
					: !j.refresh_token && j.access_token
						? " Google tidak memberi refresh token -- ulangi dari langkah 1 (link sudah memakai prompt=consent)."
						: "";
		throw new Error("Gagal menukar kode izin Google: " + (code || "HTTP " + r.status) + "." + hint);
	}
	// Ada refresh_token_expires_in = app OAuth masih "Testing": token mati
	// otomatis setelah ~7 hari. Disimpan supaya panel bisa memperingatkan.
	const expIn = Number(j.refresh_token_expires_in || 0);
	const refreshExpiresAt = expIn > 0 ? new Date(Date.now() + expIn * 1000 + 7 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ") : "";
	return { refreshToken: String(j.refresh_token), refreshExpiresAt };
}

/** Cek token + akses ke blog yang diset. Mengembalikan nama & URL blog. */
export async function bloggerVerify(env: Env, cfg: Record<string, string>): Promise<{ name: string; url: string }> {
	const token = await bloggerAccessToken(env, cfg, { fresh: true });
	const blogId = cfg.blogger_blog_id;
	if (!blogId) throw new Error("Blog ID belum diisi (BOT -> Setting -> Blogger).");
	const r = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(blogId)}?fields=name,url`, {
		headers: { Authorization: "Bearer " + token },
	});
	const j = (await r.json().catch(() => ({}))) as any;
	if (!r.ok) {
		const msg = String(j?.error?.message || "HTTP " + r.status);
		if (r.status === 401) throw new BloggerAuthError("Blogger terputus: akses ditolak (401). Hubungkan ulang. " + msg);
		throw new Error(`Blog ${blogId} tidak bisa diakses akun Google ini: ${msg}`);
	}
	return { name: String(j.name || ""), url: String(j.url || "") };
}

/**
 * Artikel yang sempat GAGAL hanya karena izin Blogger mati (dulu langsung
 * ditandai 'error' permanen tiap tick) dikembalikan ke antrean -- dipanggil
 * sesudah berhasil menghubungkan ulang, supaya artikelnya tidak hilang.
 */
export async function requeueBloggerAuthFailures(env: Env): Promise<number> {
	const r = await getTurso(env)
		.prepare(
			`UPDATE news_article SET status='new', error='' WHERE status='error'
			 AND (error LIKE 'Blogger OAuth refresh gagal%' OR error LIKE 'Blogger terputus%')`,
		)
		.run();
	return r.meta.changes;
}

export async function bloggerCreatePost(
	env: Env,
	cfg: Record<string, string>,
	post: { title: string; content: string; labels?: string[]; searchDescription?: string },
): Promise<string> {
	const token = await bloggerAccessToken(env, cfg);
	const blogId = cfg.blogger_blog_id;
	if (!blogId) throw new Error("blogger_blog_id belum diisi.");
	const r = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(blogId)}/posts/`, {
		method: "POST",
		headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
		body: JSON.stringify({
			kind: "blogger#post",
			title: post.title,
			content: post.content,
			labels: post.labels || [],
			// Field ini yang tampil sebagai cuplikan di hasil pencarian Google
			// (SEO meta description) -- tanpa ini Google ambil cuplikan asal dari isi.
			searchDescription: (post.searchDescription || "").slice(0, 155),
		}),
	});
	const j = (await r.json().catch(() => ({}))) as any;
	if (r.status === 401) {
		resetBloggerTokenCache();
		throw new BloggerAuthError("Blogger terputus: akses posting ditolak (401). Hubungkan ulang di BOT -> Setting -> Koneksi Blogger.");
	}
	if (!r.ok || !j.url) throw new Error("Blogger post gagal: " + JSON.stringify(j).slice(0, 300));
	return String(j.url);
}

// ---------------------------------------------------------------------------
// Facebook Page — auto-share tiap artikel yang terbit di Blogger
// ---------------------------------------------------------------------------
// Domain situs sendiri (LapakStore88 / "Berita Terkini") -- dipromosikan di
// setiap posting Facebook Page bersama link Blogger & toko, sesuai permintaan
// pemilik supaya ketiga aset (Blogger, situs berita sendiri, toko) selalu
// saling mempromosikan satu sama lain.

// ---------------------------------------------------------------------------
// Backlink acak (foto + kata dalam kalimat) -- pemilik minta tiap artikel yang
// diposting (Blogger maupun situs sendiri, karena `content` yang sama dipakai
// untuk keduanya) menyertakan link balik ke aset sendiri, dipilih ACAK per
// artikel, TANPA pernah mengarah ke situs luar.
// ---------------------------------------------------------------------------
function ownLinkTargets(cfg: Record<string, string>): { url: string; label: string }[] {
	const targets = [
		{ url: `${newsSiteUrl()}/`, label: "LapakStore88" },
		{ url: `${newsSiteUrl()}/produk.html`, label: "Katalog Produk" },
		{ url: `${newsSiteUrl()}/berita.html`, label: "Berita Terkini" },
	];
	const bloggerSite = (cfg.blogger_site_url || "").trim();
	if (bloggerSite) targets.push({ url: bloggerSite, label: "Blog Resmi" });
	return targets;
}
function pickOwnLink(cfg: Record<string, string>): { url: string; label: string } {
	const targets = ownLinkTargets(cfg);
	return targets[Math.floor(Math.random() * targets.length)];
}

// Kata-kata GENERIK yang aman disisipi link (bukan nama orang/tempat/istilah
// penting, tidak mengubah makna kalimat kalau jadi link biru) -- dipilih 1
// kandidat yang MEMANG muncul di artikel, hanya kemunculan PERTAMA yang
// ditautkan. Kalau tidak ada satu pun kandidat yang cocok, artikel dibiarkan
// apa adanya (tidak dipaksakan menyisipkan kata baru).
export const ANCHOR_WORD_CANDIDATES = [
	"informasi", "resmi", "terkini", "selengkapnya", "terbaru",
	"kabar", "laporan", "diketahui", "tersebut", "berlangsung",
];
function insertAnchorBacklink(html: string, cfg: Record<string, string>): string {
	const order = [...ANCHOR_WORD_CANDIDATES].sort(() => Math.random() - 0.5);
	for (const word of order) {
		const re = new RegExp(`\\b(${word})\\b`, "i");
		if (re.test(html)) {
			const pick = pickOwnLink(cfg);
			return html.replace(re, (m) => `<a href="${escAttr(pick.url)}" rel="noopener">${m}</a>`);
		}
	}
	return html;
}

function buildFbCaption(title: string, metaDescription: string, links: { blogger?: string; site?: string; store?: string; tg?: string }): string {
	const lines = [`📰 ${title}`];
	if (metaDescription) lines.push("", metaDescription);
	lines.push("");
	if (links.blogger) lines.push(`🔗 Baca di blog kami: ${links.blogger}`);
	if (links.site) lines.push(`📰 Baca di web berita kami: ${links.site}`);
	if (links.store) lines.push(`🛒 Toko aplikasi premium: ${links.store}`);
	if (links.tg) lines.push(`${TG_PROMO_LINE}: ${links.tg}`);
	return lines.join("\n").slice(0, 1900); // batas wajar caption FB
}

/** Posting ke Facebook Page (foto+caption kalau ada gambar, teks+link kalau tidak). Gagal = non-fatal, dicatat saja. */
export async function fbPostToPage(
	cfg: Record<string, string>,
	post: { title: string; metaDescription: string; postUrl: string; imageUrl?: string; siteUrl?: string; storeUrl?: string },
): Promise<string | null> {
	const pageId = cfg.fb_page_id;
	const token = cfg.fb_page_token;
	if (!pageId || !token) return null; // belum disetel -> lewati diam-diam
	const caption = buildFbCaption(post.title, post.metaDescription, { blogger: post.postUrl, site: post.siteUrl, store: post.storeUrl, tg: tgPromoUrl(cfg) });
	const primaryLink = post.postUrl || post.siteUrl || post.storeUrl || "";
	const endpoint = post.imageUrl
		? `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/photos`
		: `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/feed`;
	const body = new URLSearchParams({ access_token: token });
	if (post.imageUrl) {
		body.set("url", post.imageUrl);
		body.set("caption", caption);
	} else {
		body.set("message", caption);
		body.set("link", primaryLink);
	}
	let r: Response;
	let j: any;
	try {
		r = await fetch(endpoint, { method: "POST", body, signal: AbortSignal.timeout(20000) });
		j = await r.json();
	} catch (e) {
		throw new Error("Gagal menghubungi server Facebook: " + (e instanceof Error ? e.message : String(e)).slice(0, 200));
	}
	if (!r.ok || (!j.id && !j.post_id)) {
		throw new Error("Facebook post gagal: " + JSON.stringify(j?.error || j).slice(0, 300));
	}
	return String(j.post_id || j.id);
}

// ---------------------------------------------------------------------------
// FACEBOOK LANGSUNG — jalur terpisah dari Blogger. Ambil artikel dari kolam
// yang sama (news_article) tapi dilacak lewat kolom fb_direct_posted_at
// sendiri, jadi TIDAK terganggu kalau Blogger sedang kena rate-limit, dan
// TIDAK bentrok dgn newsProcessOne (keduanya boleh memproses artikel yg sama,
// masing-masing independen).
// ---------------------------------------------------------------------------

/** Caption pendek & menarik ala media sosial — LEBIH RINGAN dari rewrite artikel penuh (hemat token & subrequest). */
async function geminiFbCaption(env: Env, cfg: Record<string, string>, art: { title: string; excerpt: string; source: string }): Promise<string> {
	const prompt =
		`Buatkan caption Facebook yang singkat, menarik, dan mengundang rasa penasaran (gaya media sosial, ` +
		`boleh pakai 1-2 emoji, MAKS 3 kalimat, JANGAN mengarang fakta baru di luar ringkasan). ` +
		`Balas HANYA teks captionnya saja, tanpa tanda kutip, tanpa markdown.\n\n` +
		`JUDUL: ${art.title}\nRINGKASAN: ${art.excerpt || "(tidak ada)"}\nSUMBER: ${art.source}`;
	try {
		const { value } = await aiGenerate(env, cfg, { purpose: "fb-caption", messages: [{ role: "user", content: prompt }], temperature: 0.9, maxTokens: 400 }, (raw) => {
			const text = stripEchoedPlaceholders(raw).slice(0, 500);
			if (!text) throw new Error("caption kosong");
			return text;
		});
		return value;
	} catch {
		// fallback tanpa AI kalau semua provider gagal -- tetap bisa posting, cuma polos.
		return `${art.title}`;
	}
}

export async function fbDirectProcessOne(env: Env): Promise<{ done: boolean; title?: string; error?: string }> {
	const cfg = await botCfg(env);
	if (!cfg.fb_page_id || !cfg.fb_page_token) return { done: false, error: "Facebook belum tersambung." };
	const row = await getTurso(env)
		.prepare(`SELECT * FROM news_article WHERE fb_direct_posted_at = '' ORDER BY id ASC LIMIT 1`)
		.first<Record<string, string>>();
	if (!row) return { done: false };
	const id = Number(row.id);
	try {
		const caption = await geminiFbCaption(env, cfg, { title: String(row.title), excerpt: String(row.excerpt), source: String(row.source) });
		let imageUrl = String(row.image_url || "");
		if (!imageUrl) imageUrl = await fetchOgImage(String(row.url));
		// Kalau artikel ini SUDAH ada versi Blogger-nya, arahkan ke situ (bangun
		// trafik blog); kalau belum, arahkan ke sumber asli sbg atribusi.
		const linkUrl = row.post_url || row.url;
		await fbPostToPage(cfg, {
			title: String(row.title),
			metaDescription: caption,
			postUrl: String(linkUrl),
			imageUrl,
			siteUrl: `${newsSiteUrl()}/berita/artikel/?id=${id}`,
			storeUrl: (cfg.promo_url || "").trim() || undefined,
		});
		await getTurso(env).prepare(`UPDATE news_article SET fb_direct_posted_at = ? WHERE id = ?`).bind(tsNow(), id).run();
		return { done: true, title: String(row.title) };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		// Transient (geo-block/rate-limit) -> JANGAN tandai selesai, biarkan dicoba lagi.
		if (TRANSIENT_ERROR_RE.test(msg)) {
			return { done: true, error: msg + " (akan dicoba lagi otomatis)" };
		}
		// Error lain (mis. token FB kadaluwarsa) -> tandai supaya tidak diulang
		// tanpa henti, tapi catat alasannya di kolom error (dipakai bareng Blogger).
		await getTurso(env).prepare(`UPDATE news_article SET fb_direct_posted_at = 'error' WHERE id = ?`).bind(id).run();
		return { done: true, error: msg };
	}
}

// ---------------------------------------------------------------------------
// TEMPLATE FB — pengganti posting otomatis (Facebook API sering diblokir
// Facebook untuk Page baru/kategori berita). Sama sekali TIDAK menyentuh
// Graph API: cuma menyiapkan gambar + caption supaya pemilik tinggal
// copy-paste & posting MANUAL dari akun Facebook-nya sendiri.
// ---------------------------------------------------------------------------

// Hashtag "evergreen" biar postingan gampang ketemu orang yang lagi cari/scroll berita,
// dipasang tetap di tiap template supaya jangkauan konsisten walau AI-nya kadang pelit hashtag.
export const FB_TEMPLATE_EVERGREEN_HASHTAGS = ["#LapakStore88", "#BeritaTerkini", "#BeritaHariIni", "#InfoTerkini", "#BeritaViral", "#BeritaUpdate"];

/**
 * AI kadang menyalin placeholder format prompt mentah-mentah (mis. baris "<caption>" atau "Caption:" di awal) --
 * buang baris pembuka/penutup semacam itu supaya tidak ikut ke caption yang dicopy-paste ke Facebook.
 */
export function stripEchoedPlaceholders(text: string): string {
	return String(text ?? "")
		.replace(/^\s*(?:<\/?\s*(?:caption|hashtag|hashtags)\s*>|\[\s*(?:caption|hashtag)[^\]]*\]|\*{0,2}caption\s*:\s*\*{0,2})\s*/gi, "")
		.replace(/<\/?\s*(?:caption|hashtag|hashtags)\s*>/gi, "")
		.replace(/^["']|["']$/g, "")
		.trim();
}

/** Urai balasan AI template FB: "caption ===HASHTAG=== hashtag". Murni (tanpa I/O) supaya bisa diuji. */
export function parseFbTemplateReply(raw: string): { text: string; hashtags: string[] } {
	const [captionPart, hashtagPart] = raw.trim().split(/===HASHTAG===/i);
	const text = stripEchoedPlaceholders(captionPart || raw).slice(0, 500);
	if (!text) throw new Error("caption kosong");
	const aiTags = (hashtagPart || "").match(/#[\p{L}\p{N}_]+/gu) || [];
	return { text, hashtags: aiTags.slice(0, 8) };
}

/** Link promosi channel Telegram (BOT > Setting > Sosial & Promo). Kosong = tidak ada promosi Telegram. */
export const tgPromoUrl = (cfg: Record<string, string>): string => {
	const u = String(cfg.tg_channel_url || "").trim();
	return /^https?:\/\//i.test(u) ? u : "";
};
const TG_PROMO_LINE = "✈️ Gabung Channel Telegram kami";

/** Caption + hashtag utk template manual — link ditambahkan terpisah di bawah (bukan oleh AI). */
async function geminiFbTemplateCaption(
	env: Env,
	cfg: Record<string, string>,
	art: { title: string; excerpt: string; source: string },
): Promise<{ text: string; hashtags: string[] }> {
	const prompt =
		`Buatkan caption Facebook yang singkat, menarik, dan memancing rasa penasaran pembaca (gaya media sosial, ` +
		`boleh pakai 1-3 emoji, MAKS 4 kalimat, JANGAN mengarang fakta baru di luar ringkasan). ` +
		`Tutup dengan satu kalimat ajakan yang bikin orang PENASARAN untuk klik link selengkapnya ` +
		`(JANGAN tulis link/URL apa pun, link akan ditambahkan otomatis di bawah captionmu). ` +
		`SETELAH itu, di baris terpisah setelah tanda "===HASHTAG===", tuliskan 5-8 hashtag ` +
		`(gabungan Bahasa Indonesia, dipisah spasi, huruf tanpa spasi di dalamnya, contoh: #BeritaJakarta) ` +
		`yang relevan dengan topik/tokoh/kategori berita ini SUPAYA postingan gampang muncul di pencarian & ` +
		`beranda orang yang suka/cari berita. Balas HANYA dengan teks captionnya (tanpa judul/label/tag apa pun di awal), ` +
		`lalu baris baru berisi ===HASHTAG===, lalu baris baru berisi hashtagnya dipisah spasi. ` +
		`JANGAN menulis kata "caption" atau tanda < > dalam balasanmu.\n\n` +
		`JUDUL: ${art.title}\nRINGKASAN: ${art.excerpt || "(tidak ada)"}\nSUMBER: ${art.source}`;
	try {
		const { value } = await aiGenerate(env, cfg, { purpose: "fb-template", messages: [{ role: "user", content: prompt }], temperature: 0.9, maxTokens: 500 }, parseFbTemplateReply);
		return value;
	} catch {
		return { text: art.title, hashtags: [] };
	}
}

// Kolom penyimpan hasil template supaya bisa "dibuka lagi" dari Riwayat (caption
// tadinya cuma balikan sesaat, hilang begitu di-refresh). Migrasi malas (lazy) --
// dicoba sekali per cold-start isolate, aman dipanggil berkali² (duplicate column
// diabaikan) jadi tidak perlu skrip migrasi terpisah lagi.
let fbTemplateColumnEnsured = false;
async function ensureFbTemplateColumn(env: Env): Promise<void> {
	if (fbTemplateColumnEnsured) return;
	try {
		await getTurso(env).prepare(`ALTER TABLE news_article ADD COLUMN fb_template_caption TEXT NOT NULL DEFAULT ''`).run();
	} catch {
		/* kolom sudah ada -> abaikan */
	}
	fbTemplateColumnEnsured = true;
}

/** Ambil 1 artikel berikutnya & siapkan gambar+caption utk di-copy manual ke Facebook. Tidak memanggil Graph API sama sekali. */
export async function fbTemplateGenerate(
	env: Env,
): Promise<{ done: boolean; title?: string; imageUrl?: string; caption?: string; error?: string }> {
	await ensureFbTemplateColumn(env);
	const cfg = await botCfg(env);
	// ORDER BY id DESC (bukan ASC) -- pemilik minta template FB fokus ke artikel
	// TERBARU, bukan menggali antrean lama dari belakang. Sebelumnya ASC bikin
	// fitur ini terus mengambil artikel yang makin basi kalau backlog menumpuk.
	const row = await getTurso(env)
		.prepare(`SELECT * FROM news_article WHERE fb_direct_posted_at = '' ORDER BY id DESC LIMIT 1`)
		.first<Record<string, string>>();
	if (!row) return { done: false, error: "Tidak ada artikel baru untuk dibuatkan template." };
	const id = Number(row.id);
	try {
		const gen = await geminiFbTemplateCaption(env, cfg, {
			title: String(row.title),
			excerpt: String(row.excerpt),
			source: String(row.source),
		});
		let imageUrl = String(row.image_url || "");
		if (!imageUrl) imageUrl = await fetchOgImage(String(row.url));
		// "Baca selengkapnya" DIUTAMAKAN ke aset MILIK SENDIRI -- sebelumnya jatuh
		// balik ke row.url (situs SUMBER berita asli, mis. detik.com) kalau artikel
		// ini belum sempat posting ke Blogger, yang berarti caption promosi malah
		// nyasar promosiin situs orang lain. Urutan: Blogger (post_url) -> situs
		// sendiri (site_posted_at) -> baru row.url sbg jalan terakhir.
		const siteArticleUrl = row.site_posted_at ? `${newsSiteUrl()}/berita/artikel/?id=${id}` : "";
		const linkUrl = String(row.post_url || siteArticleUrl || row.url || "");
		const hashtags = [...new Set([...gen.hashtags, ...FB_TEMPLATE_EVERGREEN_HASHTAGS])].slice(0, 12);
		const parts = [gen.text];
		if (linkUrl) parts.push(`🔗 Baca selengkapnya: ${linkUrl}`);
		// Promosi website UTAMA (lokalstore88.online) -- SELALU disisipkan, terpisah
		// dari link artikel spesifik di atas (yang bisa saja belum ada kalau artikel
		// ini belum tayang di Blogger/situs sendiri). Pemilik minta caption manual
		// ini ikut mempromosikan website utama tiap kali diposting, bukan cuma toko.
		parts.push(`📰 Kunjungi web berita kami: ${newsSiteUrl()}/berita.html`);
		// Promosi toko -- sama seperti yang otomatis disisipkan di artikel Blogger/
		// situs sendiri, supaya caption manual ini juga ikut mempromosikan toko.
		const promoUrl = (cfg.promo_url || "").trim();
		if (promoUrl) parts.push(`🛒 ${(cfg.promo_text || "Butuh aplikasi premium termurah? Kunjungi LapakStore88").trim()}: ${promoUrl}`);
		// Fanspage & Saluran WhatsApp -- sama seperti yang otomatis disisipkan di
		// artikel Blogger/situs sendiri (lihat newsProcessOne), supaya caption
		// manual dari menu Template FB ini ikut mempromosikan kanal-kanal itu juga.
		const fbPageUrlTpl = (cfg.fb_page_url || "").trim();
		if (fbPageUrlTpl) parts.push(`📘 Follow Fanspage kami: ${fbPageUrlTpl}`);
		const waChannelUrlTpl = (cfg.wa_channel_url || "").trim();
		if (waChannelUrlTpl) parts.push(`💬 Gabung Saluran WhatsApp kami: ${waChannelUrlTpl}`);
		const tgUrlTpl = tgPromoUrl(cfg);
		if (tgUrlTpl) parts.push(`${TG_PROMO_LINE}: ${tgUrlTpl}`);
		if (hashtags.length) parts.push(hashtags.join(" "));
		const caption = parts.join("\n\n");
		// Simpan hasilnya (bukan cuma tandai selesai) supaya bisa "dibuka lagi" dari Riwayat.
		await getTurso(env)
			.prepare(
				`UPDATE news_article SET fb_direct_posted_at = ?, fb_template_caption = ?, image_url = CASE WHEN image_url = '' THEN ? ELSE image_url END WHERE id = ?`,
			)
			.bind(tsNow(), caption, imageUrl, id)
			.run();
		return { done: true, title: String(row.title), imageUrl, caption };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (TRANSIENT_ERROR_RE.test(msg)) {
			return { done: false, error: msg + " (coba lagi sebentar)" };
		}
		await getTurso(env).prepare(`UPDATE news_article SET fb_direct_posted_at = 'error' WHERE id = ?`).bind(id).run();
		return { done: false, error: msg };
	}
}

async function fbDirectPostedToday(env: Env): Promise<number> {
	const r = await getTurso(env)
		.prepare(`SELECT COUNT(*) AS c FROM news_article WHERE fb_direct_posted_at NOT IN ('', 'error') AND substr(fb_direct_posted_at,1,10) = ?`)
		.bind(todayKey())
		.first<{ c: number }>();
	return Number(r?.c ?? 0);
}

/** Entry cron: /__cron?job=fbdirect (disarankan tiap 10 menit -> 1 artikel/panggilan). */
export async function fbDirectRun(env: Env): Promise<{ posted: number; message: string }> {
	const cfg = await botCfg(env);
	if (String(cfg.fb_direct_enabled || "0") !== "1") {
		return { posted: 0, message: "Facebook Langsung dimatikan (fb_direct_enabled=0)." };
	}
	const capN = Number(cfg.fb_direct_daily_cap || "50");
	const cap = Number.isFinite(capN) ? capN : 50; // nilai non-angka dulu = NaN -> batas harian mati
	if ((await fbDirectPostedToday(env)) >= cap) {
		return { posted: 0, message: "Batas harian Facebook Langsung tercapai." };
	}
	const r = await fbDirectProcessOne(env);
	if (!r.done) return { posted: 0, message: r.error || "Tidak ada artikel baru untuk diposting." };
	if (r.error) return { posted: 0, message: r.error };
	return { posted: 1, message: `Terposting: ${r.title}` };
}

// ---------------------------------------------------------------------------
// Proses 1 artikel: rewrite -> post -> tandai
// ---------------------------------------------------------------------------
export async function newsProcessOne(
	env: Env,
	opts: { postToBlogger: boolean } = { postToBlogger: true },
): Promise<{ done: boolean; title?: string; postUrl?: string; error?: string; siteOnly?: boolean; aiWait?: boolean }> {
	await ensureNewsCategoryColumns(env);
	const cfg = await botCfg(env);
	// RANDOM PER-KATEGORI (bukan RANDOM mentah atas semua baris, dan bukan
	// FIFO/id ASC) -- pemilik minta semua kategori kebagian, bukan cuma "umum".
	// RANDOM mentah tetap bias ke kategori dengan backlog paling besar (mis.
	// "umum" yang sumbernya sudah lama aktif) sehingga kategori baru dgn
	// backlog kecil (Bola/Selebritis dll) nyaris tidak pernah kepilih selama
	// backlog besar itu belum habis. Di sini kategori dipilih acak dulu
	// (tiap kategori yg masih punya antrean == peluang sama), baru artikel
	// acak DI DALAM kategori itu.
	const row = await getTurso(env)
		.prepare(
			`SELECT * FROM news_article WHERE status = 'new' AND category = (
				SELECT category FROM news_article WHERE status = 'new' GROUP BY category ORDER BY RANDOM() LIMIT 1
			) ORDER BY RANDOM() LIMIT 1`,
		)
		.first<Record<string, string>>();
	if (!row) return { done: false };
	const id = Number(row.id);
	// Klaim atomik: loop Blogger & loop situs sendiri jalan berurutan dalam 1
	// invocation (aman), TAPI 2 jadwal cron yang tumpang-tindih (lihat
	// wrangler.jsonc: */5 & tiap menit) bisa saja overlap jadi 2 invocation
	// berbeda -- tanpa klaim ini, keduanya bisa SELECT baris 'new' yang SAMA
	// sebelum salah satu sempat UPDATE status-nya -> artikel yang sama diproses
	// dobel (dobel post Blogger, atau dobel di situs sendiri). UPDATE ... WHERE
	// status='new' ini atomik di level SQLite -- kalau invocation lain sudah
	// lebih dulu mengklaim, changes=0 di sini dan kita mundur dgn aman.
	const claim = await getTurso(env).prepare(`UPDATE news_article SET status='processing', claimed_at=? WHERE id=? AND status='new'`).bind(tsNow(), id).run();
	if (!claim.meta.changes) return { done: false };
	try {
		// Halaman sumber diambil SEKALI: teksnya jadi bahan AI (artikel panjang
		// tapi tetap berisi fakta, bukan diulur-ulur dari ringkasan RSS 2
		// kalimat), foto-fotonya jadi gambar tambahan di dalam artikel.
		const imagesWanted = imagesPerArticle(cfg);
		const page = await fetchSourcePage(String(row.url), Math.max(0, imagesWanted - 1));
		const rw = await geminiRewrite(env, cfg, {
			title: String(row.title),
			excerpt: String(row.excerpt),
			source: String(row.source),
			url: String(row.url),
			sourceText: page.text,
		});
		let imageUrl = String(row.image_url || "") || page.ogImage;
		const extraImages = page.images.filter((u) => u.split("?")[0] !== imageUrl.split("?")[0]).slice(0, Math.max(0, imagesWanted - 1));
		// Backlink DULU, baru foto: insertAnchorBacklink mengganti kata pertama
		// yang cocok -- kalau foto sudah ada, kata itu bisa kena di dalam alt="".
		let content = insertImagesBetweenParagraphs(
			insertAnchorBacklink(rw.html, cfg),
			extraImages,
			rw.title,
			String(cfg.attribution || "1") === "1" ? String(row.source) : "",
		);
		// Kategori otomatis dari AI (klasifikasi isi artikel yang sebenarnya) --
		// menang atas kategori bawaan sumbernya (yang cuma tebakan kasar per-feed).
		// Kalau Gemini tidak balas kategori valid, tetap pakai punya sumber.
		const category = rw.category || String(row.category || "umum");

		// Blok promo (disisipkan setelah paragraf ke-2 kalau bisa, biar natural).
		const promoUrl = (cfg.promo_url || "").trim();
		if (promoUrl) {
			const promoText = (cfg.promo_text || "Butuh aplikasi premium termurah? Kunjungi LapakStore88").trim();
			// Tint pakai rgba semi-transparan (BUKAN warna solid #fafafa) supaya kotak ini
			// tetap enak dilihat baik di halaman Blogger (biasanya terang) MAUPUN di
			// artikel Berita Terkini (tema gelap) -- warna solid terang dulu bikin kotak
			// putih mencolok aneh di tengah halaman gelap.
			const promo =
				`\n<div style="border:1px solid rgba(127,127,127,.35);border-radius:10px;padding:14px 16px;margin:20px 0;background:rgba(127,127,127,.08)">` +
				`<p style="margin:0;font-size:14px">🛒 <strong>${escHtml(promoText)}</strong> &mdash; ` +
				`<a href="${escAttr(promoUrl)}" rel="noopener" target="_blank"><strong>Kunjungi Toko &raquo;</strong></a></p></div>`;
			const parts = content.split(/(<\/p>)/i);
			if (parts.length >= 6) {
				parts.splice(4, 0, promo); // setelah </p> ke-2
				content = parts.join("");
			} else {
				content += promo;
			}
		}

		if (String(cfg.attribution || "1") === "1") {
			content +=
				`\n<p style="font-size:13px;color:#666;margin-top:24px">Sumber: ` +
				`<a href="${escAttr(String(row.url))}" rel="nofollow noopener" target="_blank">${escHtml(String(row.source))}</a></p>`;
		}

		// Paragraf ajakan follow hasil AI (gaya ngobrol, bukan link mentah) --
		// SELALU disisipkan kalau AI berhasil menghasilkannya (kosong = wajar,
		// bukan error, lihat geminiRewrite), jadi pengantar natural sebelum
		// link Fanspage/Saluran WhatsApp di bawahnya.
		if (rw.ctaParagraph) {
			content += `\n<p style="font-size:14px;margin-top:20px">${escHtml(rw.ctaParagraph)}</p>`;
		}
		// Ajakan follow Fanspage Facebook (kalau sudah diisi di Konfigurasi Lanjutan).
		const fbPageUrl = (cfg.fb_page_url || "").trim();
		if (fbPageUrl) {
			content +=
				`\n<p style="font-size:14px;margin-top:14px">📘 Follow Fanspage kami di Facebook: ` +
				`<a href="${escAttr(fbPageUrl)}" rel="noopener" target="_blank"><strong>klik di sini</strong></a></p>`;
		}
		// Ajakan gabung Saluran WhatsApp (kalau sudah diisi) -- pola SAMA persis
		// dgn Fanspage Facebook di atas, SELALU disisipkan (tidak digate
		// postToBlogger) krn `content` yang sama ini ikut tayang di Berita Terkini.
		const waChannelUrl = (cfg.wa_channel_url || "").trim();
		if (waChannelUrl) {
			content +=
				`\n<p style="font-size:14px;margin-top:10px">💬 Gabung Saluran WhatsApp kami: ` +
				`<a href="${escAttr(waChannelUrl)}" rel="noopener" target="_blank"><strong>klik di sini</strong></a></p>`;
		}
		// Ajakan gabung Channel Telegram -- tombol biru khas Telegram; ikut tayang di Blogger & Berita Terkini (content yang sama).
		const tgChannelUrl = tgPromoUrl(cfg);
		if (tgChannelUrl) {
			content +=
				`\n<div style="margin:16px 0;padding:14px 16px;border:1px solid rgba(34,158,217,.45);border-radius:12px;background:rgba(34,158,217,.08)">` +
				`<p style="margin:0 0 10px;font-size:14px">✈️ <strong>Update berita tercepat ada di Channel Telegram kami.</strong> Gabung sekarang, gratis, tanpa ketinggalan kabar terbaru.</p>` +
				`<a href="${escAttr(tgChannelUrl)}" rel="noopener" target="_blank" style="display:inline-block;background:#229ED9;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:9px 18px;border-radius:999px">Gabung Channel Telegram &raquo;</a></div>`;
		}
		// Promosi silang ke situs Blogger -- SELALU disisipkan (tidak digate
		// postToBlogger) karena ini juga ikut tayang di artikel Berita Terkini
		// LapakStore88, bukan cuma di postingan Blogger itu sendiri.
		const bloggerSiteUrl = (cfg.blogger_site_url || "").trim();
		if (bloggerSiteUrl) {
			content +=
				`\n<p style="font-size:14px;margin-top:10px">📰 Baca artikel lainnya di blog kami: ` +
				`<a href="${escAttr(bloggerSiteUrl)}" rel="noopener" target="_blank"><strong>kunjungi blog</strong></a></p>`;
		}

		// Internal link acak ("Baca juga") -- diambil dari artikel yang SUDAH
		// pernah terbit sebelumnya, gabungan dari 2 aset: yang posting ke Blogger
		// (pakai post_url) MAUPUN yang cuma tayang di situs sendiri (pakai pola URL
		// LapakStore88 yang sama seperti dipakai fbPostToPage di atas). Tujuannya
		// internal linking utk SEO -- link SELALU domain milik sendiri, tidak pernah
		// link acak ke situs luar. Kalau belum ada artikel lain yg pernah tayang
		// (situs baru), query ini balas kosong -> blok ini dilewati begitu saja,
		// TIDAK bikin artikel gagal.
		try {
			const related = await getTurso(env)
				.prepare(
					`SELECT id, title, post_url FROM news_article
					 WHERE id != ? AND (status = 'posted' OR status = 'site')
					 ORDER BY RANDOM() LIMIT 3`,
				)
				.bind(id)
				.all<{ id: number; title: string; post_url: string }>();
			const rows = related.results || [];
			if (rows.length) {
				const items = rows
					.map((r) => {
						const href = r.post_url ? r.post_url : `${newsSiteUrl()}/berita/artikel/?id=${r.id}`;
						return `<li><a href="${escAttr(href)}" rel="noopener">${escHtml(r.title)}</a></li>`;
					})
					.join("");
				content +=
					`\n<div style="margin-top:18px"><p style="font-size:14px;font-weight:700;margin:0 0 6px">Baca juga:</p>` +
					`<ul style="margin:0;padding-left:20px;font-size:14px">${items}</ul></div>`;
			}
		} catch (e) {
			console.error("internal link acak gagal (dilewati):", e instanceof Error ? e.message : e);
		}

		// Kata kunci SEO (hasil generate AI) -- disisipkan sebagai baris kecil di
		// akhir artikel (tidak mengganggu isi utama) + ikut jadi label Blogger
		// tambahan di bawah. Kalau AI tidak menghasilkan keyword (mis. jalur
		// fallback), rw.keywords kosong -> blok ini otomatis dilewati.
		if (rw.keywords.length) {
			content +=
				`\n<p style="font-size:12px;color:#888;margin-top:16px">Kata kunci terkait: ${escHtml(rw.keywords.join(", "))}</p>`;
		}

		// Hashtag brand -- SELALU disisipkan di SETIAP artikel (tidak digate
		// postToBlogger) sama seperti promo/Baca-juga di atas, karena `content`
		// yang sama ini dipakai baik utk postingan Blogger MAUPUN yang tayang di
		// situs sendiri (Berita Terkini) -- jadi 1 baris ini otomatis ikut
		// tampil di kedua tempat tanpa perlu ubah apa pun di frontend.
		content += `\n<p style="font-size:12px;color:#888;margin-top:8px">#LapakStore88</p>`;

		// Feed Google News (dipakai Kompas/Tribunnews) tidak menyertakan gambar
		// sama sekali -> post-nya tampil tanpa thumbnail di daftar Blogger. Kalau
		// image_url kosong, coba ambil <meta og:image> dari halaman artikel asli
		// (1 fetch tambahan, cuma dipanggil di sini per-artikel yang DIPROSES,
		// bukan saat pull massal -> anggaran subrequest masih aman).
		// Byline tanggal WAJIB di awal SETIAP artikel (Blogger maupun situs sendiri --
		// keduanya pakai `content` yang sama ini) -- pemilik minta format persis:
		// "LokalStore88 <NamaHari>,<tanggal> <bulan> <tahun>." dengan "LokalStore88"
		// jadi link biru ke Fanspage Facebook. Prepend INI DULU sebelum gambar (bukan
		// sesudah) -- supaya urutan akhirnya: gambar paling atas, byline PERSIS DI
		// BAWAH gambar, baru isi artikel (pemilik minta byline pindah dari atas ke
		// bawah foto).
		const fbPageUrlForByline = (cfg.fb_page_url || "").trim();
		const bylineBrand = fbPageUrlForByline
			? `<a href="${escAttr(fbPageUrlForByline)}" rel="noopener" target="_blank" style="color:#1877f2;text-decoration:none;font-weight:700">LokalStore88</a>`
			: `<strong style="color:#1877f2">LokalStore88</strong>`;
		// TIDAK set warna teks tanggalnya sendiri (cuma "LokalStore88" yg biru) --
		// biar warna teks default IKUT tema halaman (gelap di situs sendiri, terang
		// di Blogger), sama seperti perbaikan kotak promo sebelumnya yg sempat
		// tidak kebaca di tema gelap gara-gara warna solid di-hardcode.
		content = `<p style="margin:0 0 14px;font-size:13px">${bylineBrand} ${escHtml(tsNowIndonesianDate())}.</p>\n` + content;

		if (imageUrl) {
			// alt text diisi judul artikel (sebelumnya kosong) -- Google Image Search
			// & aksesibilitas butuh alt yang deskriptif, bukan cuma dekorasi kosong.
			// Foto dibungkus link ke aset sendiri (acak) -- backlink acak, sama
			// seperti yang sudah dipasang di tema Blogger, tapi di sini berlaku
			// juga utk artikel yang tayang di situs sendiri (content yang sama).
			const heroLink = pickOwnLink(cfg);
			content =
				`<p><a href="${escAttr(heroLink.url)}" rel="noopener"><img src="${escAttr(imageUrl)}" alt="${escAttr(rw.title)}" style="max-width:100%"></a></p>\n` +
				content;
		}

		// Structured data (schema.org NewsArticle) -- murni data buat mesin
		// pencari, TIDAK tampil ke pembaca (browser tidak merender isi <script>).
		// Ini yang dibaca Google utk rich snippet / kandidat Google News, bukan
		// meta keyword tag (yang sudah tidak dipakai Google sejak lama). Nempel di
		// `content` yang sama -> otomatis ikut ke Blogger MAUPUN situs sendiri,
		// tidak perlu ubah apa pun di frontend. Kalau Blogger/tampilan situs
		// sendiri ternyata menyaring tag <script>, blok ini cuma hilang -- TIDAK
		// pernah bikin artikel gagal tampil (dibungkus try/catch, murni tambahan).
		try {
			const ldJson = {
				"@context": "https://schema.org",
				"@type": "NewsArticle",
				headline: rw.title,
				description: rw.metaDescription,
				image: imageUrl ? [imageUrl, ...extraImages] : undefined,
				datePublished: tsNow().replace(" ", "T") + "+07:00",
				keywords: rw.keywords.length ? rw.keywords.join(", ") : undefined,
				articleSection: newsCategoryLabel(category),
				author: { "@type": "Organization", name: "LokalStore88" },
				publisher: { "@type": "Organization", name: "LokalStore88" },
				mainEntityOfPage: `${newsSiteUrl()}/berita/artikel/?id=${id}`,
			};
			content += `\n<script type="application/ld+json">${JSON.stringify(ldJson).replace(/</g, "\\u003c")}</script>`;
		} catch (e) {
			console.error("JSON-LD gagal dibangun (dilewati):", e instanceof Error ? e.message : e);
		}

		// Label: "LapakStore88" (brand sendiri) + kategori otomatis (dari AI) + label
		// tambahan dari config -- SENGAJA TIDAK menyertakan nama sumber berita lagi
		// (mis. "Detik News") sesuai permintaan pemilik, supaya Label Blogger selalu
		// menonjolkan brand sendiri. Atribusi sumber di ISI artikel (paragraf
		// "Sumber: ...") TIDAK diubah -- itu kewajiban hak cipta yang beda urusan.
		const labels = ["LapakStore88", newsCategoryLabel(category)];
		for (const l of String(cfg.post_labels || "").split(",").map((x) => x.trim()).filter(Boolean)) {
			if (!labels.includes(l)) labels.push(l);
		}
		// Keyword SEO (hasil generate AI) ikut jadi label Blogger tambahan --
		// dibatasi 4 biar label tidak kebanjiran & tetap didominasi brand/kategori.
		for (const kw of rw.keywords.slice(0, 4)) {
			if (!labels.some((l) => l.toLowerCase() === kw.toLowerCase())) labels.push(kw);
		}
		// Blogger (dan Facebook auto-share yang menyertainya) TETAP dibatasi
		// daily_cap milik pemilik akun -- kalau limit sudah tercapai, lewati
		// langkah ini, tapi artikel TETAP disimpan & tersedia di situs sendiri
		// (site_posted_at) lewat cabang else di bawah. Jadi situs sendiri tidak
		// pernah "menunggu jatah" Blogger.
		let postUrl = "";
		if (opts.postToBlogger) {
			postUrl = await bloggerCreatePost(env, cfg, { title: rw.title, content, labels, searchDescription: rw.metaDescription });
			if (String(cfg.fb_enabled || "0") === "1") {
				try {
					await fbPostToPage(cfg, {
						title: rw.title,
						metaDescription: rw.metaDescription,
						postUrl,
						imageUrl,
						siteUrl: `${newsSiteUrl()}/berita/artikel/?id=${id}`,
						storeUrl: promoUrl || undefined,
					});
				} catch (e) {
					console.error("fbPostToPage gagal:", e instanceof Error ? e.message : e);
				}
			}
		}
		// site_posted_at HANYA diisi untuk artikel yang TIDAK diposting ke Blogger
		// (postUrl kosong) -- pemilik minta 2 kumpulan ini benar-benar terpisah,
		// TIDAK boleh dobel tampil di Blogger maupun situs sendiri sekaligus.
		// image_url DISIMPAN BALIK ke sini (kalau tadinya kosong) -- sebelumnya
		// imageUrl yang sudah ketemu (dari RSS atau fetchOgImage) cuma dipakai
		// sesaat utk konten Blogger, tidak pernah ditulis ke kolomnya sendiri.
		// Akibatnya proses LAIN yang baca ulang artikel yang sama nanti (mis.
		// Template FB) melihat image_url kosong lagi & harus coba cari ulang dari
		// nol -- padahal sudah pernah ketemu sebelumnya.
		const now = tsNow();
		await getTurso(env)
			.prepare(
				`UPDATE news_article SET status=?, rewritten_html=?, post_url=?, posted_at=?, site_posted_at=?, category=?, keywords=?, meta_description=?, image_url=CASE WHEN image_url='' THEN ? ELSE image_url END, error='' WHERE id=?`,
			)
			.bind(postUrl ? "posted" : "site", content, postUrl, postUrl ? now : "", postUrl ? "" : now, category, rw.keywords.join(", "), rw.metaDescription, imageUrl, id)
			.run();

		return { done: true, title: rw.title, postUrl: postUrl || undefined, siteOnly: !postUrl };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		// Izin Blogger mati: artikel ini TIDAK salah apa-apa -- kembalikan ke
		// antrean (dulu ditandai 'error' permanen, jadi tiap tick "membakar" satu
		// artikel + kuota AI tanpa hasil sampai Blogger dihubungkan ulang).
		if (e instanceof BloggerAuthError || isBloggerAuthMessage(msg)) {
			await getTurso(env).prepare(`UPDATE news_article SET status='new' WHERE id=? AND status='processing'`).bind(id).run();
			await bloggerSetAuthState(env, cfg, msg).catch(() => {});
			return { done: false, error: msg };
		}
		// Belum ada AI provider aktif (semua dihapus / dimatikan / kuota habis /
		// masa aktif lewat): artikel tidak salah apa-apa -> kembalikan ke antrean.
		if (e instanceof AiUnavailableError) {
			await getTurso(env).prepare(`UPDATE news_article SET status='new' WHERE id=? AND status='processing'`).bind(id).run();
			return { done: false, error: msg, aiWait: true };
		}
		// "User location is not supported" = Cloudflare edge yg kebagian request ini
		// kena geo-block Gemini, sifatnya per-titik-edge & sementara (edge lain masih
		// jalan). JANGAN tandai error permanen -> biarkan 'new' supaya tick berikutnya
		// (kemungkinan lewat edge lain) otomatis coba lagi, tidak nyangkut butuh skip manual.
		// Sama dgn geo-block Gemini: rate limit Blogger (429 rateLimitExceeded/
		// RESOURCE_EXHAUSTED) sifatnya SEMENTARA (reda dlm hitungan menit) -- JANGAN
		// tandai error permanen, biar dicoba lagi otomatis tick berikutnya.
		if (TRANSIENT_ERROR_RE.test(msg)) {
			// BUG YANG DIPERBAIKI: komentar di atas bilang "biarkan 'new'" tapi baris ini
			// dulu TIDAK PERNAH mengembalikan status artikel -- padahal claim di atas
			// (UPDATE ... status='processing') sudah mengubahnya duluan. Akibatnya tiap
			// kali geo-block/rate-limit kena, artikel itu nyangkut PERMANEN di
			// status='processing' (SELECT pemilih artikel cuma lihat status='new'),
			// hilang dari antrean selama-lamanya walau errornya cuma sementara. Ini
			// penyebab utama "situs sendiri gak bisa posting banyak" -- makin sering
			// geo-block kena, makin banyak artikel yang "termakan" diam-diam tanpa
			// pernah benar-benar gagal ATAU berhasil. Reset eksplisit ke 'new' di sini
			// supaya tick berikutnya (kemungkinan lewat edge Cloudflare lain) beneran
			// mencobanya lagi, sesuai yang sudah diniatkan dari awal.
			await getTurso(env).prepare(`UPDATE news_article SET status='new' WHERE id=? AND status='processing'`).bind(id).run();
			return { done: true, error: msg + " (akan dicoba lagi otomatis)" };
		}
		await getTurso(env).prepare(`UPDATE news_article SET status='error', error=? WHERE id=?`).bind(msg.slice(0, 400), id).run();
		return { done: true, error: msg };
	}
}

async function postedToday(env: Env): Promise<number> {
	const r = await getTurso(env)
		.prepare(`SELECT COUNT(*) AS c FROM news_article WHERE status='posted' AND substr(posted_at,1,10) = ?`)
		.bind(todayKey())
		.first<{ c: number }>();
	return Number(r?.c ?? 0);
}

// ---------------------------------------------------------------------------
// Pembersihan antrean harian -- pemilik minta antrean RSS yang BELUM diproses
// tidak numpuk: tiap hari, buang yang lebih lama dari kemarin jam 22:00 WIB.
// Kalau ternyata TIDAK ADA satu pun artikel yang lebih baru dari jam itu
// (mis. RSS lagi sepi/macet beberapa hari), jangan sampai antrean kosong sama
// sekali -- sisakan 5 yang paling baru saja, baru buang sisanya.
//
// PENTING (keamanan): scope HANYA status 'new'/'error'/'skipped' (antrean
// yang belum/gagal diproses). Artikel status 'posted' (Blogger) & 'site'
// (situs sendiri) TIDAK PERNAH ikut disentuh sama sekali -- itu artikel yang
// SUDAH TAYANG dengan URL publik yang mungkin sudah terindeks Google/dibagikan
// orang; menghapusnya akan mematahkan link itu. Lihat memory
// "dont-break-working-logic" -- fitur baru harus aditif, tidak boleh
// mengganggu yang sudah benar.
const NEWS_QUEUE_PRUNE_STATUSES = "('new','error','skipped')";
let newsQueuePrunedDay = "";
export async function newsPruneQueueDaily(env: Env): Promise<{ pruned: number; kept: number; mode: string } | "skip"> {
	const nowWib = new Date(Date.now() + 7 * 3600 * 1000);
	const dayKey = nowWib.toISOString().slice(0, 10);
	if (newsQueuePrunedDay === dayKey) return "skip";
	// Guard KV juga (aman lintas cold-start/isolate berbeda, pola sama dengan dailyPrune di index.ts).
	const guardKey = "newsqueueprune:" + dayKey;
	try {
		if (await env.SESS.get(guardKey)) {
			newsQueuePrunedDay = dayKey;
			return "skip";
		}
		await env.SESS.put(guardKey, "1", { expirationTtl: 172800 });
	} catch {
		/* kalau KV gagal, tetap lanjut sekali jalan (guard in-memory di atas cukup utk 1 isolate) */
	}
	newsQueuePrunedDay = dayKey;

	// Cutoff = KEMARIN jam 22:00:00 WIB.
	const yesterdayWib = new Date(nowWib.getTime() - 24 * 3600 * 1000);
	const cutoff = `${yesterdayWib.toISOString().slice(0, 10)} 22:00:00`;

	const above = await getTurso(env)
		.prepare(`SELECT COUNT(*) AS c FROM news_article WHERE status IN ${NEWS_QUEUE_PRUNE_STATUSES} AND found_at >= ?`)
		.bind(cutoff)
		.first<{ c: number }>();
	const aboveCount = Number(above?.c ?? 0);

	if (aboveCount > 0) {
		const del = await getTurso(env)
			.prepare(`DELETE FROM news_article WHERE status IN ${NEWS_QUEUE_PRUNE_STATUSES} AND found_at < ?`)
			.bind(cutoff)
			.run();
		return { pruned: del.meta.changes, kept: aboveCount, mode: "cutoff" };
	}

	// Tidak ada satu pun di atas cutoff -> sisakan 5 TERBARU (bukan hapus semua).
	const keep = await getTurso(env)
		.prepare(`SELECT id FROM news_article WHERE status IN ${NEWS_QUEUE_PRUNE_STATUSES} ORDER BY found_at DESC, id DESC LIMIT 5`)
		.all<{ id: number }>();
	const keepIds = (keep.results ?? []).map((r) => Number(r.id));
	if (!keepIds.length) return { pruned: 0, kept: 0, mode: "kosong" };
	const placeholders = keepIds.map(() => "?").join(",");
	const del = await getTurso(env)
		.prepare(`DELETE FROM news_article WHERE status IN ${NEWS_QUEUE_PRUNE_STATUSES} AND id NOT IN (${placeholders})`)
		.bind(...keepIds)
		.run();
	return { pruned: del.meta.changes, kept: keepIds.length, mode: "fallback5" };
}

// Sembuhkan artikel yang nyangkut di status='processing' (lihat catatan bug di
// newsProcessOne: dulu geo-block/rate-limit Gemini bikin baris permanen
// nyangkut karena tidak pernah dikembalikan ke 'new'). Ambang (lihat cutoff di bawah) JAUH di
// atas waktu proses 1 artikel yang sebenarnya (~8 detik, lihat catatan di
// botNewsRun) -- jadi aman dari race dengan invocation LAIN yang mungkin
// benar-benar sedang memproses baris itu (klaimnya baru), hanya menyembuhkan
// yang klaimnya sudah lama & jelas tidak pernah selesai.
async function recoverStuckProcessing(env: Env): Promise<number> {
	await ensureNewsCategoryColumns(env);
	// 20 menit, bukan 3: satu artikel sekarang bisa makan beberapa menit
	// (teks sumber panjang, provider timeout 90 dtk lalu pindah ke provider
	// lain) dan loop Blogger & situs berjalan bersamaan di GitHub -- batas 3
	// menit bisa mengembalikan artikel yang MASIH dikerjakan ke antrean ->
	// diproses dobel. 20 menit > batas job GitHub (15 menit), jadi klaim yang
	// tersisa dari job yang dimatikan tetap disapu.
	const cutoff = tsPlusMinutes(-20);
	const r = await getTurso(env)
		.prepare(`UPDATE news_article SET status='new' WHERE status='processing' AND claimed_at != '' AND claimed_at < ?`)
		.bind(cutoff)
		.run();
	// PERBAIKAN: sebelum "too many subrequests" ikut dianggap transient (lihat
	// TRANSIENT_ERROR_RE), artikel yang kena error itu KETERLANJUR ditandai
	// status='error' PERMANEN (bukan 'processing'), jadi tidak pernah ke-sapu
	// sama query di atas. Sapu SEKALI di sini juga -- artikel LAMA yang errornya
	// jelas-jelas sesuatu yang seharusnya transient, kembalikan ke 'new' supaya
	// ikut dicoba lagi, bukan nyangkut selamanya.
	// PERBAIKAN: model Groq default lama sempat tidak valid (model_not_found)
	// dan bikin banyak artikel kadung ditandai error PERMANEN -- sapu juga
	// pola ini sekali supaya otomatis dicoba ulang begitu fix model di atas
	// aktif, tidak nyangkut selamanya menunggu recovery manual.
	const r2 = await getTurso(env)
		.prepare(
			`UPDATE news_article SET status='new', error='' WHERE status='error' AND (` +
				`error LIKE '%too many subrequests%' OR error LIKE '%location is not supported%' OR ` +
				`error LIKE '%rateLimitExceeded%' OR error LIKE '%RESOURCE_EXHAUSTED%' OR ` +
				`error LIKE '%model_not_found%' OR error LIKE '%does not exist or you do not have access%' OR ` +
				`error LIKE '%decommissioned%' OR error LIKE '%blocked at the project level%' OR ` +
				`error LIKE '%Failed to generate JSON%' OR error LIKE '%json_validate_failed%' OR ` +
				`error LIKE '%Resource has been exhausted%' OR error LIKE '%"code":429%' OR ` +
				`error LIKE '%judul nyaris sama persis%')`,
		)
		.run();
	return r.meta.changes + r2.meta.changes;
}

/** Entry cron: /__cron?job=news */
// Batas keras utk sekali panggil (tombol "Proses Sekarang" manual TERMASUK):
// tiap artikel makan ~4-8 subrequest (Gemini + Blogger + Turso). Cloudflare Free
// cuma kasih 50 subrequest/invocation -- lihat catatan di newsPullSources.

export async function botNewsRun(
	env: Env,
	opts: { force?: boolean; count?: number; mode?: "both" | "blogger" | "site" } = {},
): Promise<{ pulled: number; posted: number; siteOnly: number; capped: boolean; message: string; bloggerBlocked: string }> {
	const mode = opts.mode || "both";
	const cfg = await botCfg(env);
	if (!opts.force && String(cfg.enabled || "0") !== "1") {
		return { pulled: 0, posted: 0, siteOnly: 0, capped: false, message: "BOT NEWS dimatikan (enabled=0).", bloggerBlocked: "" };
	}
	await ensureContentDefaultsV2(env, cfg);
	// Tanpa AI provider aktif tidak ada yang bisa ditulis -> jangan sentuh
	// antrean sama sekali (artikel tidak di-klaim, tidak ada yang dibakar).
	if (!(await aiUsableProviders(env, cfg)).length) {
		const wait = await aiNextReadyInMs(env, cfg);
		const message =
			wait != null
				? `Semua AI provider sedang dijeda (error sementara: timeout / rate limit) -- siap lagi dalam ${Math.ceil(wait / 1000)} dtk.`
				: "Tidak ada AI provider aktif -- tambah/aktifkan di BOT -> Setting -> AI Provider (cek kuota & masa aktif).";
		return { pulled: 0, posted: 0, siteOnly: 0, capped: false, message, bloggerBlocked: "" };
	}
	const countOverride = opts.count ? Math.max(1, Math.min(await getSys(env, "sys_news_max_run_count"), Math.floor(opts.count))) : 0;
	let perRun = mode === "site" ? 0 : countOverride || Math.max(1, Number(cfg.per_run || "2"));
	// Pace KHUSUS situs sendiri (LapakStore88) -- SENGAJA terpisah total dari
	// per_run/daily_cap Blogger di atas. PENTING: pakai "||" bukan "??" -- kalau
	// field ini pernah tersimpan sebagai string kosong (mis. form disimpan tanpa
	// diisi), "" ?? "5" tetap "" (cuma null/undefined yg ke-catch "??"), lalu
	// Number("")=0 -> loop situs mati total tanpa pesan error apa pun. "||" aman
	// dari kasus itu, dan tetap menghormati "0" eksplisit (mematikan loop situs).
	let sitePerRun = mode === "blogger" ? 0 : countOverride || Math.max(0, Number(cfg.site_per_run || "5"));

	// Cek izin Blogger SEKALI di awal, sebelum mengambil artikel apa pun.
	// Kalau izinnya mati, loop Blogger dilewati (artikel tidak disentuh, kuota
	// AI tidak terpakai) dan jatahnya diberikan ke situs sendiri. Token yang
	// didapat di sini ter-cache, jadi tidak menambah subrequest saat posting.
	let bloggerBlocked = "";
	if (perRun > 0) {
		try {
			await bloggerAccessToken(env, cfg);
			if (cfg.blogger_auth_error) await bloggerSetAuthState(env, cfg, "");
		} catch (e) {
			if (e instanceof BloggerAuthError) {
				bloggerBlocked = e.message;
				await bloggerSetAuthState(env, cfg, e.message);
				perRun = 0;
			}
			// error lain (jaringan dsb) -> biarkan loop di bawah mencoba seperti biasa
		}
	}
	// PENTING: kalau mode="both" (ini yang dipanggil cron eksternal otomatis),
	// loop Blogger & situs jalan dalam 1 INVOCATION yang SAMA -> subrequest-nya
	// NUMPUK (tiap artikel Blogger ~6-9 subrequest: Gemini+Blogger+FB+Turso;
	// situs ~3-4). Cloudflare Free cuma 50 subrequest/invocation, dan begitu
	// kelewat, SELURUH invocation mati mendadak (exception tidak tertangkap
	// try/catch manapun) -- bukan cuma loop situs yang gagal, Blogger yang
	// sudah jalan duluan pun ikut tidak sempat tersimpan. Makanya cron
	// otomatis "kelihatan cuma posting Blogger" (kadang malah dua²nya gagal
	// diam²): total gabungan kelewat limit. Klik manual TIDAK kena batas ini
	// (mode="site"/"blogger" sendiri-sendiri, tidak ada loop lain yang numpuk
	// di invocation yang sama).
	if (mode === "both") {
		// 6 ternyata masih kena "Too many subrequests" sesekali (tiap artikel Blogger
		// bisa sampai ~4 subrequest CUMA utk retry beberapa model Gemini kalau satu
		// model gagal, belum lagi Blogger+FB+Turso) -- turun ke angka yang jauh lebih
		// konservatif. Klik manual "PROSES KE SITUS SENDIRI" TIDAK kena batas ini
		// (invocation sendiri, tidak numpuk dgn loop Blogger), jadi tetap jadi cara
		// utama isi banyak sekaligus; otomatis cukup nyicil pasti-jalan tiap tick.
		//
		// KEDUA: dibatasi juga demi WAKTU, bukan cuma subrequest -- 1 artikel
		// (Gemini rewrite + posting Blogger + Facebook, semua berurutan) makan
		// ~8 detik rata-rata (terukur langsung). 4 artikel/panggilan = ~32 detik,
		// TERBUKTI kelewat batas tunggu banyak layanan cron eksternal (~30 detik)
		// -- begitu lewat, layanan cron itu melaporkan "timeout" (walau Worker-nya
		// sendiri tetap selesai normal). Coba dibalas cepat + lanjut di
		// background lewat ctx.waitUntil TERNYATA LEBIH BURUK: Cloudflare
		// membatalkan task waitUntil yang belum selesai dalam waktu tertentu,
		// jadi artikelnya malah TIDAK PERNAH selesai diproses sama sekali
		// (dibuktikan lewat wrangler tail: "waitUntil() tasks did not complete
		// ... have been cancelled"). Solusi yang benar-benar aman: kecilkan
		// beban per panggilan supaya beneran selesai jauh di bawah 30 detik.
		// Jatah situs SELALU disisakan (>=1) kalau site_per_run pemilik >0 --
		// kalau perRun (Blogger) dibiarkan menghabiskan SELURUH budget duluan
		// (mis. perRun=2, budget=2 -> sitePerRun kebagian 0), cron otomatis jadi
		// TIDAK PERNAH lagi posting ke situs sendiri sampai daily_cap Blogger
		// tercapai -- persis kekhawatiran pemilik ("nanti kalau habis blogger
		// gak ada jatah situs"). Situs & Blogger masing² dijatah rata dulu SEBELUM
		// Blogger boleh pakai sisanya.
		const SAFE_COMBINED_BUDGET = 2;
		const siteWanted = sitePerRun > 0 ? 1 : 0;
		perRun = Math.min(perRun, SAFE_COMBINED_BUDGET - siteWanted);
		sitePerRun = Math.max(0, Math.min(sitePerRun, SAFE_COMBINED_BUDGET - perRun));
	}

	// Coba pull+proses dalam 1 invocation ternyata TETAP kelewat limit 50
	// subrequest walau sudah dikecilkan -- perkiraan biaya per artikel di
	// kondisi geo-block Gemini (retry beberapa model, masing² 1 subrequest)
	// ternyata lebih mahal dari perkiraan. Daripada tebak-tebak angka lagi,
	// PISAH TOTAL: pull TIDAK PERNAH jalan inline di sini lagi -- jalankan
	// lewat job KHUSUS (/__cron?job=pullnews) yang isinya CUMA
	// newsPullSources tanpa proses apa pun sesudahnya (aman sendiri, ~10
	// subrequest), dipanggil cron eksternal terpisah dari job=news.
	const pull = { added: 0, scanned: 0 };

	// 1 subrequest ekstra tapi murah & penting -- sembuhkan artikel yang nyangkut
	// dari tick sebelumnya (lihat recoverStuckProcessing) SEBELUM memilih artikel
	// baru, supaya langsung ikut kepilih lagi di run yang sama kalau ada slot.
	await recoverStuckProcessing(env);

	const cap = Number(cfg.daily_cap || "8");
	// Query 1x, lalu update di memori -> bukan 1 query/iterasi (hemat subrequest).
	let postedSoFar = await postedToday(env);
	let posted = 0;
	let lastError = "";
	// ---- Loop 1: BLOGGER -- pace & limit persis seperti yang sudah disetel pemilik, TIDAK diubah. ----
	for (let i = 0; i < perRun; i++) {
		if (postedSoFar >= cap) break; // Blogger capped -> loop Blogger cukup di sini, bukan urusan loop situs di bawah.
		const r = await newsProcessOne(env, { postToBlogger: true });
		if (!r.done) {
			if (r.aiWait) lastError = r.error || "";
			else if (r.error) bloggerBlocked = r.error; // izin Blogger mati di tengah jalan
			break; // tidak ada artikel 'new' / Blogger terputus
		}
		if (r.postUrl) {
			posted++;
			postedSoFar++;
		}
		if (r.error) lastError = r.error;
		// Geo-block sementara di edge ini -> hentikan tick, jangan ulang artikel yang
		// sama berkali-kali (edge-nya sama sepanjang 1 invocation).
		if (r.error && TRANSIENT_ERROR_RE.test(r.error)) break;
	}
	// ---- Loop 2: SITUS SENDIRI -- 100% terpisah, postToBlogger SELALU false di
	// sini (tidak pernah coba posting Blogger sama sekali), pace-nya cuma dari
	// site_per_run. Berjalan tiap tick TERLEPAS dari status cap Blogger di atas. ----
	let siteOnly = 0;
	for (let i = 0; i < sitePerRun; i++) {
		const r = await newsProcessOne(env, { postToBlogger: false });
		if (!r.done) {
			if (r.error) lastError = r.error; // semua AI provider dijeda
			break; // tidak ada artikel 'new' lagi
		}
		if (r.siteOnly) siteOnly++;
		if (r.error) lastError = r.error;
		if (r.error && TRANSIENT_ERROR_RE.test(r.error)) break;
	}
	const capped = postedSoFar >= cap;
	const parts: string[] = [`Feed +${pull.added} artikel baru`];
	if (mode !== "site") parts.push(`diposting ${posted} ke Blogger`);
	if (mode !== "blogger") parts.push(`${siteOnly} ke situs sendiri`);
	return {
		pulled: pull.added,
		posted,
		siteOnly,
		capped,
		// Kalau 0 posting & ada error, tampilkan alasannya -- biar user/kita tidak
		// perlu buka database tiap kali cuma buat tahu KENAPA 0.
		message:
			parts.join("; ") +
			"." +
			(bloggerBlocked ? ` [${bloggerBlocked.slice(0, 220)}]` : "") +
			(posted === 0 && siteOnly === 0 && lastError && lastError !== bloggerBlocked ? ` [${lastError.slice(0, 200)}]` : ""),
		bloggerBlocked,
	};
}


/** Hitungan harian per jalur (Blogger / Situs Sendiri / Template FB) untuk 7 hari terakhir (WIB), tanggal terlama dulu. */
async function newsDaily7(env: Env): Promise<{ date: string; blogger: number; site: number; fb: number }[]> {
	const days: string[] = [];
	const base = new Date(todayKey() + "T00:00:00Z").getTime();
	for (let i = 6; i >= 0; i--) days.push(new Date(base - i * 86400_000).toISOString().slice(0, 10));
	const from = days[0];
	const q = async (sql: string) =>
		((await getTurso(env).prepare(sql).bind(from).all<{ d: string; c: number }>()).results ?? []);
	const [b, st, fb] = await Promise.all([
		q(`SELECT substr(posted_at,1,10) AS d, COUNT(*) AS c FROM news_article WHERE status='posted' AND substr(posted_at,1,10) >= ? GROUP BY d`),
		q(`SELECT substr(site_posted_at,1,10) AS d, COUNT(*) AS c FROM news_article WHERE site_posted_at != '' AND substr(site_posted_at,1,10) >= ? GROUP BY d`),
		q(`SELECT substr(fb_direct_posted_at,1,10) AS d, COUNT(*) AS c FROM news_article WHERE fb_direct_posted_at NOT IN ('', 'error') AND substr(fb_direct_posted_at,1,10) >= ? GROUP BY d`),
	]);
	const m = (rows: { d: string; c: number }[]) => new Map(rows.map((r) => [String(r.d), Number(r.c)]));
	const mb = m(b), ms = m(st), mf = m(fb);
	return days.map((date) => ({ date, blogger: mb.get(date) ?? 0, site: ms.get(date) ?? 0, fb: mf.get(date) ?? 0 }));
}
/** Ringkasan posting channel Telegram untuk panel BOT (jumlah hari ini, antrean, posting terakhir). */
export async function tgChannelStats(env: Env): Promise<{ postedToday: number; queue: number; lastAt: string }> {
	try {
		const wib = (h: number) => new Date(Date.now() + 7 * 3600_000 - h * 3600_000).toISOString().slice(0, 19).replace("T", " ");
		const r = await getTurso(env)
			.prepare(
				`SELECT SUM(CASE WHEN substr(tg_posted_at,1,10) = ? AND tg_posted_at LIKE '20%' THEN 1 ELSE 0 END) AS today,
				        SUM(CASE WHEN tg_posted_at = '' AND site_posted_at != '' AND site_posted_at >= ? THEN 1 ELSE 0 END) AS queue,
				        MAX(CASE WHEN tg_posted_at LIKE '20%' THEN tg_posted_at ELSE NULL END) AS last
				 FROM news_article`,
			)
			.bind(todayKey(), wib(await getSys(env, "sys_tgch_max_age_h")))
			.first<{ today: number | null; queue: number | null; last: string | null }>();
		return { postedToday: Number(r?.today ?? 0), queue: Number(r?.queue ?? 0), lastAt: String(r?.last ?? "") };
	} catch {
		return { postedToday: 0, queue: 0, lastAt: "" };
	}
}

async function siteCounts(env: Env): Promise<{ today: number; total: number }> {
	const r = await getTurso(env)
		.prepare(
			`SELECT COUNT(*) AS total, SUM(CASE WHEN substr(site_posted_at,1,10) = ? THEN 1 ELSE 0 END) AS today
			 FROM news_article WHERE site_posted_at != ''`,
		)
		.bind(todayKey())
		.first<{ total: number; today: number }>();
	return { today: Number(r?.today ?? 0), total: Number(r?.total ?? 0) };
}

// ---------------------------------------------------------------------------
// Untuk panel (API)
// ---------------------------------------------------------------------------
export async function botNewsSnapshot(env: Env) {
	await ensureNewsCategoryColumns(env);
	const cfg = await botCfg(env);
	const sources =
		(await getTurso(env).prepare(`SELECT id, name, kind, url, active, category FROM news_source ORDER BY id`).all()).results ?? [];
	const counts =
		(await getTurso(env).prepare(`SELECT status, COUNT(*) AS c FROM news_article GROUP BY status`).all<{ status: string; c: number }>())
			.results ?? [];
	const recent =
		(await getTurso(env)
			.prepare(`SELECT id, source, title, status, url, post_url, error, found_at, posted_at FROM news_article ORDER BY id DESC LIMIT 40`)
			.all()).results ?? [];
	await ensureFbTemplateColumn(env);
	const fbDirectHistory = (
		(await getTurso(env)
			.prepare(
				`SELECT id, source, title, url, post_url, image_url, fb_direct_posted_at, fb_template_caption
				 FROM news_article WHERE fb_direct_posted_at NOT IN ('', 'error')
				 ORDER BY fb_direct_posted_at DESC, id DESC LIMIT 100`,
			)
			.all()).results ?? []).map((r) => ({ ...r, fb_template_caption: stripEchoedPlaceholders(String(r.fb_template_caption ?? "")) }));
	const history =
		(await getTurso(env)
			.prepare(
				`SELECT id, source, title, url, post_url, posted_at
				 FROM news_article WHERE status='posted' ORDER BY posted_at DESC, id DESC LIMIT 200`,
			)
			.all()).results ?? [];
	// Riwayat KHUSUS situs sendiri -- terpisah total dari history Blogger di atas
	// (lihat newsProcessOne: site_posted_at cuma keisi kalau TIDAK diposting ke
	// Blogger, jadi tidak ada baris yang muncul di kedua riwayat sekaligus).
	const siteHistory =
		(await getTurso(env)
			.prepare(
				`SELECT id, source, title, url, category, site_posted_at
				 FROM news_article WHERE site_posted_at != '' ORDER BY site_posted_at DESC, id DESC LIMIT 200`,
			)
			.all()).results ?? [];
	const byStatus: Record<string, number> = {};
	for (const r of counts) byStatus[String(r.status)] = Number(r.c);
	const [site, daily7, fbTotal] = await Promise.all([
		siteCounts(env),
		newsDaily7(env),
		getTurso(env).prepare(`SELECT COUNT(*) AS c FROM news_article WHERE fb_direct_posted_at NOT IN ('', 'error')`).first<{ c: number }>().then((r) => Number(r?.c ?? 0)),
	]);
	return {
		success: true,
		config: {
			enabled: String(cfg.enabled || "0") === "1",
			per_run: Number(cfg.per_run || "2"),
			daily_cap: Number(cfg.daily_cap || "8"),
			site_per_run: Number(cfg.site_per_run || "5"),
			auto_interval_minutes: Number(cfg.auto_interval_minutes || "10"),
			attribution: String(cfg.attribution || "1") === "1",
			rewrite_style: cfg.rewrite_style || "",
			para_min: Number(cfg.para_min || DEFAULT_PARA_MIN),
			para_max: Number(cfg.para_max || DEFAULT_PARA_MAX),
			images_per_article: imagesPerArticle(cfg),
			promo_url: cfg.promo_url || "",
			promo_text: cfg.promo_text || "",
			post_labels: cfg.post_labels || "",
			// Ringkasan AI provider (detail & counter token: botAiList).
			ai_providers: (parseProviders(cfg) ?? legacyProviders(cfg)).length,
			ai_providers_on: (parseProviders(cfg) ?? legacyProviders(cfg)).filter((p) => p.enabled && p.key && p.base_url && p.model).length,
			has_blogger: !!(cfg.blogger_refresh_token && cfg.blogger_blog_id),
			has_blogger_client: !!(cfg.blogger_client_id && cfg.blogger_client_secret),
			blogger_client_id: cfg.blogger_client_id || "",
			blogger_auth_error: cfg.blogger_auth_error || "",
			blogger_auth_error_at: cfg.blogger_auth_error_at || "",
			blogger_refresh_expires_at: cfg.blogger_refresh_expires_at || "",
			blogger_connected_at: cfg.blogger_connected_at || "",
			blogger_redirect_uri: bloggerRedirectUri(cfg),
			blog_id: cfg.blogger_blog_id || "",
			blogger_site_url: cfg.blogger_site_url || "",
			site_url: newsSiteUrl(), // alamat web berita sendiri (Admin > Integrasi) -- dipakai tautan riwayat di UI
			fb_enabled: String(cfg.fb_enabled || "0") === "1",
			fb_page_id: cfg.fb_page_id || "",
			has_facebook: !!(cfg.fb_page_id && cfg.fb_page_token),
			fb_direct_enabled: String(cfg.fb_direct_enabled || "0") === "1",
			fb_direct_daily_cap: Number(cfg.fb_direct_daily_cap || "50"),
			fb_page_url: cfg.fb_page_url || "",
			wa_channel_url: cfg.wa_channel_url || "",
			tg_channel_enabled: String(cfg.tg_channel_enabled || "0") === "1",
			tg_channel_id: cfg.tg_channel_id || "",
			tg_channel_url: cfg.tg_channel_url || "",
			tg_channel_last_error: cfg.tg_channel_last_error || "",
			news_banner_enabled: String(cfg.news_banner_enabled || "0") === "1",
			news_banner_image: cfg.news_banner_image || "",
			news_banner_url: cfg.news_banner_url || "",
			news_banner_text: cfg.news_banner_text || "",
		},
		postedToday: await postedToday(env),
		tg: await tgChannelStats(env),
		siteToday: site.today,
		siteTotal: site.total,
		fbTotal: fbTotal,
		fbDirectPostedToday: await fbDirectPostedToday(env),
		daily7,
		fbDirectQueue: Number(
			(await getTurso(env).prepare(`SELECT COUNT(*) AS c FROM news_article WHERE fb_direct_posted_at = ''`).first<{ c: number }>())?.c ?? 0,
		),
		byStatus,
		sources,
		recent,
		history,
		siteHistory,
		fbDirectHistory,
	};
}

// ---------------------------------------------------------------------------
// Untuk situs publik (LapakStore88 "Berita Terkini") — TANPA sesi/auth. Filter
// pakai site_posted_at (BUKAN status='posted') karena situs sendiri sengaja
// TIDAK dibatasi daily_cap Blogger -- artikel bisa "site_posted_at" terisi
// (status='site') meski belum/tidak pernah diposting ke Blogger. Tetap tidak
// pernah menampilkan artikel 'new'/'error' yang isinya masih mentah/gagal.
// ---------------------------------------------------------------------------
export async function publicNewsList(env: Env, category: string, page: number, pageSize: number) {
	await ensureNewsCategoryColumns(env);
	const size = Math.min(30, Math.max(1, pageSize || 20));
	const offset = Math.max(0, (Math.max(1, page || 1) - 1) * size);
	const cat = category && (NEWS_CATEGORIES as readonly string[]).includes(category) ? category : "";
	const where = cat ? `WHERE site_posted_at != '' AND category=?` : `WHERE site_posted_at != ''`;
	const args = cat ? [cat] : [];
	// Daftar artikel & hitungan totalnya tidak saling bergantung -> barengan,
	// bukan berurutan (halaman ini dibuka pengunjung situs, jadi tiap jeda
	// round-trip Turso langsung terasa di waktu muat halaman).
	const [rowsRes, totalRow] = await Promise.all([
		getTurso(env)
			.prepare(
				`SELECT id, title, excerpt, image_url, category, source, site_posted_at AS posted_at FROM news_article ${where} ORDER BY site_posted_at DESC, id DESC LIMIT ? OFFSET ?`,
			)
			.bind(...args, size, offset)
			.all<{ id: number; title: string; excerpt: string; image_url: string; category: string; source: string; posted_at: string }>(),
		getTurso(env).prepare(`SELECT COUNT(*) AS c FROM news_article ${where}`).bind(...args).first<{ c: number }>(),
	]);
	const rows = rowsRes.results ?? [];
	const total = Number(totalRow?.c ?? 0);
	return { success: true, articles: rows, total, page: Math.max(1, page || 1), pageSize: size, categories: NEWS_CATEGORIES };
}

export async function publicNewsDetail(env: Env, id: number) {
	await ensureNewsCategoryColumns(env);
	const row = await getTurso(env)
		.prepare(`SELECT id, title, rewritten_html, image_url, category, source, url, keywords, meta_description, views, site_posted_at AS posted_at FROM news_article WHERE id=? AND site_posted_at != ''`)
		.bind(id)
		.first<{ id: number; title: string; rewritten_html: string; image_url: string; category: string; source: string; url: string; keywords: string; meta_description: string; views: number; posted_at: string }>();
	if (!row) return { success: false, message: "Artikel tidak ditemukan." };
	// Hitung 1 pembaca per pembukaan halaman -- dipakai buat ranking "Terpopuler"
	// yang beneran (lihat publicNewsPopular), bukan sekadar "terbaru" yang dilabeli
	// populer asal-asalan. Tidak menunggu hasilnya (tidak kritikal kalau gagal).
	getTurso(env)
		.prepare(`UPDATE news_article SET views = views + 1 WHERE id = ?`)
		.bind(id)
		.run()
		.catch(() => {});
	row.views = (row.views || 0) + 1;
	return { success: true, article: row };
}

/** Artikel terpopuler beneran (diurut dari jumlah pembaca/views, bukan cuma terbaru) --
 * dipakai buat widget "Terpopuler" di beranda & sidebar artikel LapakStore88. */
export async function publicNewsPopular(env: Env, category: string, limit: number) {
	await ensureNewsCategoryColumns(env);
	const n = Math.min(20, Math.max(1, limit || 5));
	const cat = category && (NEWS_CATEGORIES as readonly string[]).includes(category) ? category : "";
	const where = cat ? `WHERE site_posted_at != '' AND category=?` : `WHERE site_posted_at != ''`;
	const args = cat ? [cat] : [];
	const rows =
		(
			await getTurso(env)
				.prepare(
					`SELECT id, title, excerpt, image_url, category, source, views, site_posted_at AS posted_at FROM news_article ${where} ORDER BY views DESC, id DESC LIMIT ?`,
				)
				.bind(...args, n)
				.all<{ id: number; title: string; excerpt: string; image_url: string; category: string; source: string; views: number; posted_at: string }>()
		).results ?? [];
	return { success: true, articles: rows };
}

/** Suntik sumber RSS per-kategori Liputan6 sekali jalan (dipanggil dari /__cron?job=seednews,
 * gate cron-key BUKAN sesi -- pemilik tidak perlu ketik 8 baris manual di panel).
 * Idempotent: kalau URL sudah ada di news_source, dilewati (tidak dobel). */
export async function seedCategorySources(env: Env): Promise<{ added: string[]; skipped: string[] }> {
	await ensureNewsCategoryColumns(env);
	const seeds: { name: string; url: string; category: string }[] = [
		{ name: "Liputan6 Bisnis", url: "https://feed.liputan6.com/rss/bisnis", category: "bisnis" },
		{ name: "Liputan6 Bola", url: "https://feed.liputan6.com/rss/bola", category: "bola" },
		{ name: "Liputan6 Showbiz", url: "https://feed.liputan6.com/rss/showbiz", category: "hiburan" },
		{ name: "Liputan6 Tekno", url: "https://feed.liputan6.com/rss/tekno", category: "teknologi" },
		{ name: "Liputan6 Otomotif", url: "https://feed.liputan6.com/rss/otomotif", category: "otomotif" },
		{ name: "Liputan6 Kesehatan", url: "https://feed.liputan6.com/rss/kesehatan", category: "kesehatan" },
		{ name: "Liputan6 Lifestyle", url: "https://feed.liputan6.com/rss/lifestyle", category: "lifestyle" },
		{ name: "Liputan6 Cek Fakta", url: "https://feed.liputan6.com/rss/cek-fakta", category: "umum" },
		// Detik per-channel -- supaya tiap kategori punya LEBIH DARI 1 sumber
		// (bukan cuma Liputan6), volumenya jadi jauh lebih banyak per kategori.
		{ name: "Detik Finance", url: "https://finance.detik.com/rss", category: "bisnis" },
		{ name: "Detik Sepakbola", url: "https://sport.detik.com/sepakbola/rss", category: "bola" },
		{ name: "Detik Sport", url: "https://sport.detik.com/rss", category: "olahraga" },
		{ name: "Detik Hot", url: "https://hot.detik.com/rss", category: "hiburan" },
		{ name: "Detik Inet", url: "https://inet.detik.com/rss", category: "teknologi" },
		{ name: "Detik Oto", url: "https://oto.detik.com/rss", category: "otomotif" },
		{ name: "Detik Health", url: "https://health.detik.com/rss", category: "kesehatan" },
		{ name: "Detik Wolipop", url: "https://wolipop.detik.com/rss", category: "lifestyle" },
		{ name: "Detik Travel", url: "https://travel.detik.com/rss", category: "lifestyle" },
		{ name: "Liputan6 Selebritis", url: "https://feed.liputan6.com/rss/showbiz/celeb", category: "selebritis" },
	];
	const added: string[] = [];
	const skipped: string[] = [];
	for (const s of seeds) {
		const exists = await getTurso(env).prepare(`SELECT id FROM news_source WHERE url = ?`).bind(s.url).first();
		if (exists) {
			skipped.push(s.name);
			continue;
		}
		await getTurso(env)
			.prepare(`INSERT INTO news_source (name, kind, url, active, added_at, category) VALUES (?, 'rss', ?, 1, ?, ?)`)
			.bind(s.name, s.url, tsNow(), s.category)
			.run();
		added.push(s.name);
	}
	return { added, skipped };
}

/** One-shot: matikan sumber "gnews" (Kompas via Google News) -- Google mengubah
 * halaman redirect artikelnya jadi full client-side JS (dikonfirmasi manual: HTML
 * mentahnya 0 <a href>, 0 kata "kompas.com"), jadi resolveGnews/fetchOgImage tidak
 * akan pernah dapat URL/gambar asli lagi. Pemilik pilih matikan sumbernya saja
 * daripada membangun scraper ke API privat Google (yang dilarang di ToS RSS-nya). */
export async function disableGnewsSources(env: Env): Promise<{ disabled: string[] }> {
	// Cocokkan lewat kind='gnews' ATAU nama mengandung "ompas" -- source Kompas
	// ternyata bisa saja terdaftar kind='rss' langsung ke URL search Google News
	// (bukan lewat kind='gnews'+resolveGnews), jadi jangan cuma andalkan kind.
	const rows =
		(
			await getTurso(env)
				.prepare(`SELECT id, name FROM news_source WHERE active = 1 AND (kind = 'gnews' OR name LIKE '%ompas%' OR url LIKE '%kompas%')`)
				.all<{ id: number; name: string }>()
		).results ?? [];
	const disabled: string[] = [];
	for (const r of rows) {
		await getTurso(env).prepare(`UPDATE news_source SET active = 0 WHERE id = ?`).bind(r.id).run();
		disabled.push(r.name);
	}
	return { disabled };
}

/** Banner promosi sidebar Berita Terkini -- diatur dari Panel BOT (Konfigurasi Lanjutan). */
export async function publicNewsBanner(env: Env) {
	const cfg = await botCfg(env);
	if (String(cfg.news_banner_enabled || "0") !== "1" || !cfg.news_banner_image) return { success: true, banner: null };
	return {
		success: true,
		banner: { image: cfg.news_banner_image, url: cfg.news_banner_url || "", text: cfg.news_banner_text || "" },
	};
}

/** Beberapa artikel acak (utk widget "Arsip Berita" sidebar) -- kalau category dikirim, hanya dari kategori itu. */
export async function publicNewsRandom(env: Env, category: string, limit: number) {
	await ensureNewsCategoryColumns(env);
	const n = Math.min(20, Math.max(1, limit || 6));
	const cat = category && (NEWS_CATEGORIES as readonly string[]).includes(category) ? category : "";
	const where = cat ? `WHERE site_posted_at != '' AND category=?` : `WHERE site_posted_at != ''`;
	const args = cat ? [cat] : [];
	const rows =
		(
			await getTurso(env)
				.prepare(`SELECT id, title, image_url, category FROM news_article ${where} ORDER BY RANDOM() LIMIT ?`)
				.bind(...args, n)
				.all<{ id: number; title: string; image_url: string; category: string }>()
		).results ?? [];
	return { success: true, articles: rows };
}

const xmlEsc = (s: string) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const imgMime = (u: string) => (/\.png(\?|$)/i.test(u) ? "image/png" : /\.webp(\?|$)/i.test(u) ? "image/webp" : /\.gif(\?|$)/i.test(u) ? "image/gif" : "image/jpeg");

/** Caption Facebook siap pakai untuk satu artikel (tanpa AI, jadi umpan tetap cepat & gratis): judul, ringkasan, tautan, promosi, hashtag.
 * Susunan & hashtag tetap sama dengan menu Template FB (Hashtag Tetap dari Admin > Data Master). */
function fbFeedCaption(r: { title: string; excerpt: string; category: string }, link: string, cfg: Record<string, string>): string {
	const parts: string[] = [r.title];
	const ex = String(r.excerpt || "").trim();
	if (ex && ex !== r.title) parts.push(ex);
	parts.push(`🔗 Baca selengkapnya: ${link}`);
	parts.push(`📰 Kunjungi web berita kami: ${newsSiteUrl()}/berita.html`);
	const promoUrl = (cfg.promo_url || "").trim();
	if (promoUrl) parts.push(`🛒 ${(cfg.promo_text || "Butuh aplikasi premium termurah? Kunjungi LapakStore88").trim()}: ${promoUrl}`);
	const fbPage = (cfg.fb_page_url || "").trim();
	if (fbPage) parts.push(`📘 Follow Fanspage kami: ${fbPage}`);
	const wa = (cfg.wa_channel_url || "").trim();
	if (wa) parts.push(`💬 Gabung Saluran WhatsApp kami: ${wa}`);
	const tgUrl = tgPromoUrl(cfg);
	if (tgUrl) parts.push(`${TG_PROMO_LINE}: ${tgUrl}`);
	const cat = String(r.category || "").replace(/[^A-Za-z0-9]/g, "");
	const tags = [...new Set([...(cat ? ["#" + cat.charAt(0).toUpperCase() + cat.slice(1)] : []), ...FB_TEMPLATE_EVERGREEN_HASHTAGS])].slice(0, 12);
	if (tags.length) parts.push(tags.join(" "));
	return parts.join("\n\n");
}

/** Umpan RSS 2.0 artikel situs sendiri (30 terbaru). Untuk layanan RSS-ke-Facebook (Make, dlvr.it, IFTTT, dst) yang memposting ke
 * Fanspage memakai aplikasi Meta mereka sendiri -- admin tidak perlu membuat app/token Meta. <description> berisi CAPTION LENGKAP
 * (lihat fbFeedCaption) dan <enclosure> berisi gambar utama artikel (dipakai untuk posting foto). */
export async function publicNewsRssXml(env: Env): Promise<string> {
	await ensureNewsCategoryColumns(env);
	const rows =
		(
			await getTurso(env)
				.prepare(`SELECT id, title, excerpt, image_url, category, site_posted_at FROM news_article WHERE site_posted_at != '' ORDER BY site_posted_at DESC, id DESC LIMIT 30`)
				.all<{ id: number; title: string; excerpt: string; image_url: string; category: string; site_posted_at: string }>()
		).results ?? [];
	const cfg = await botCfg(env);
	const base = newsSiteUrl();
	const items = rows
		.map((r) => {
			const link = `${base}/berita/artikel/?id=${r.id}`;
			const t = new Date(String(r.site_posted_at || "").replace(" ", "T") + "+07:00"); // waktu simpan = WIB
			const pub = Number.isNaN(t.getTime()) ? "" : `<pubDate>${t.toUTCString()}</pubDate>`;
			const img = r.image_url && /^https?:\/\//i.test(r.image_url) ? `<enclosure url="${xmlEsc(r.image_url)}" type="${imgMime(r.image_url)}" length="0"/>` : "";
			const cat = r.category ? `<category>${xmlEsc(r.category)}</category>` : "";
			return `<item><title>${xmlEsc(r.title)}</title><link>${xmlEsc(link)}</link><guid isPermaLink="true">${xmlEsc(link)}</guid>${pub}<description>${xmlEsc(fbFeedCaption(r, link, cfg))}</description>${cat}${img}</item>`;
		})
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Berita Terkini</title><link>${xmlEsc(base)}</link><description>Berita terbaru</description><language>id</language>${items}</channel></rss>`;
}

/** Sitemap XML utk artikel "Berita Terkini" LapakStore88 -- dipakai Google supaya
 * bisa menemukan & meng-crawl semua artikel yang tayang di situs sendiri (tanpa
 * ini, Google cuma bisa nemu artikel lewat link internal satu-satu / backlink,
 * jauh lebih lambat & sering kelewat). CATATAN buat pemilik: file sitemap harus
 * dibuka DI DOMAIN yang sama dengan artikelnya (aturan sitemap protocol) --
 * endpoint worker ini (panel-worker.workers.dev) TIDAK bisa langsung dipakai
 * Search Console utk properti lokalstore88.online, kecuali frontend-nya (repo
 * terpisah) proxy/fetch XML ini lalu disajikan lewat lokalstore88.online/sitemap.xml
 * sendiri. Limit 5000 URL/sitemap (jauh di atas kebutuhan sekarang, standar sitemap
 * protocol maksimal 50.000). */
export async function publicNewsSitemapXml(env: Env): Promise<string> {
	await ensureNewsCategoryColumns(env);
	const rows =
		(
			await getTurso(env)
				.prepare(
					`SELECT id, site_posted_at FROM news_article WHERE site_posted_at != '' ORDER BY site_posted_at DESC LIMIT 5000`,
				)
				.all<{ id: number; site_posted_at: string }>()
		).results ?? [];
	const urls = rows
		.map((r) => {
			const loc = `${newsSiteUrl()}/berita/artikel/?id=${r.id}`;
			const lastmod = String(r.site_posted_at || "").replace(" ", "T") + "+07:00";
			return `<url><loc>${xmlEsc(loc)}</loc><lastmod>${xmlEsc(lastmod)}</lastmod></url>`;
		})
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}
