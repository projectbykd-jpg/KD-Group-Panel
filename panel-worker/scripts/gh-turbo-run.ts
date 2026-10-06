// Dijalankan lewat GitHub Actions (BUKAN Cloudflare Worker) -- panggil ULANG
// botNewsRun() ASLI dari src/lib/bot-news.ts, TIDAK ADA logic yang
// diduplikasi/ditulis ulang di sini sama sekali (biar tidak pernah ketinggalan
// kalau bot-news.ts diubah lagi nanti). Alasan file ini ada: Cloudflare Worker
// Free plan cuma boleh 50 subrequest/invocation, jadi satu kali panggil
// botNewsRun() dibatasi ketat. GitHub Actions TIDAK punya limit semacam itu --
// jadi di sini botNewsRun() dipanggil BERULANG KALI dalam 1 kali jalan job.
//
// Dua mode:
// 1. Terjadwal (RUN_COUNT kosong, tiap 10 menit) -- loop sampai antrean 'new'
//    habis / daily_cap Blogger kena, pakai per_run/site_per_run dari
//    Konfigurasi Lanjutan (panel) persis seperti yang pemilik atur.
// 2. Dipicu tombol panel dengan angka custom (RUN_COUNT terisi) -- proses
//    TEPAT sejumlah itu (Blogger & Situs Sendiri masing-masing), lalu
//    berhenti, TIDAK peduli per_run/site_per_run tersimpan.
//
// Cara pakai: `npx tsx scripts/gh-turbo-run.ts` dengan env TURSO_URL &
// TURSO_TOKEN ter-set (lihat .github/workflows/news-turbo.yml).
import { aiClearAllCooldowns, aiNextReadyInMs } from "../src/lib/ai-provider";
import { botCfg, botCfgSet, botNewsRun } from "../src/lib/bot-news";

const env = {
	TURSO_URL: process.env.TURSO_URL,
	TURSO_TOKEN: process.env.TURSO_TOKEN,
} as any;

const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 12);
// Rate limit per menit (Groq gratis: "try again in 7s") -> tunggu sebentar lalu
// lanjut, jangan akhiri run dgn 0 artikel. Jeda yang lebih lama (provider
// diam / limit harian) TIDAK ditunggu -- run berikutnya yang mencoba lagi.
const MAX_WAIT_MS = 75_000;
const MAX_WAITS = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const runCountRaw = String(process.env.RUN_COUNT || "").trim();
const runCount = runCountRaw ? Math.max(1, Math.floor(Number(runCountRaw))) : 0;
// "Send ke" dropdown di panel -- both (default) = Blogger + Situs Sendiri,
// atau salah satu saja. Dispatch terjadwal tiap 10 menit TIDAK pernah
// mengisi ini (selalu "both").
const runTarget = String(process.env.RUN_TARGET || "both").trim().toLowerCase();
// PERBAIKAN PENTING: sebelumnya SETIAP dispatch tanpa RUN_COUNT (termasuk
// panggilan otomatis tiap tick dari cron eksternal, lihat FULL_DRAIN di
// bawah) otomatis loop SAMPAI 12 PUTARAN (MAX_ROUNDS) x per_run -- artinya
// "auto-post tiap 10 menit" ternyata "habiskan ulang SELURUH antrean tiap 10
// menit" (puluhan artikel per tick, bukan cuma beberapa). Sekarang HANYA
// dispatch dgn FULL_DRAIN="1" (tombol panel dgn kolom "Jumlah artikel"
// dikosongkan -- SENGAJA minta "proses semua") yang boleh loop sampai
// MAX_ROUNDS. Tick otomatis (cron-job.org / jadwal internal GitHub) TIDAK
// PERNAH mengisi ini -- jadi default-nya sekarang cuma 1 PUTARAN per tick
// (persis semantik "Artikel per proses" yang seharusnya: sekian artikel
// TIAP KALI dipanggil, bukan seluruh backlog tiap kali dipanggil).
const fullDrain = String(process.env.FULL_DRAIN || "").trim() === "1";
const maxRoundsThisRun = fullDrain ? MAX_ROUNDS : 1;

/**
 * botNewsRun() SENGAJA mengunci opts.count ke maksimal 5/panggilan
 * (MAX_RUN_COUNT, lihat bot-news.ts) -- itu batas keamanan utk invocation
 * Cloudflare sinkron, TIDAK diubah di sini (jangan lemahkan pagar itu, masih
 * dipakai tombol manual "PROSES KE BLOGGER"/"PROSES KE SITUS SENDIRI" yang
 * lama). Jadi target custom besar (mis. 50) tetap harus dicicil per 5 --
 * di GitHub Actions ini AMAN diulang banyak kali (tidak ada limit
 * subrequest), beda dgn di Cloudflare.
 */
async function runLoop(mode: "blogger" | "site"): Promise<number> {
	const target = runCount || null; // null = tanpa batas total per-putaran, ikut cfg
	// count custom (RUN_COUNT) -> tetap boleh sampai MAX_ROUNDS putaran (dicicil
	// per 5, lihat komentar MAX_RUN_COUNT) krn itu permintaan EKSPLISIT sejumlah
	// artikel. Tanpa RUN_COUNT -> patuhi maxRoundsThisRun (1 kalau tick otomatis,
	// MAX_ROUNDS kalau FULL_DRAIN diminta lewat tombol panel).
	const roundsAllowed = target != null ? MAX_ROUNDS : maxRoundsThisRun;
	let total = 0;
	let waits = 0;
	for (let i = 1; i <= roundsAllowed; i++) {
		const remaining = target != null ? target - total : null;
		if (remaining != null && remaining <= 0) break;
		const opts: Parameters<typeof botNewsRun>[1] = { force: true, mode };
		if (remaining != null) opts.count = Math.min(5, remaining);
		const r = await botNewsRun(env, opts);
		const got = mode === "blogger" ? r.posted : r.siteOnly;
		const tag = target != null ? `custom target=${target}` : `${i}/${roundsAllowed}`;
		console.log(`[${mode} ${tag}] got=${got} capped=${r.capped} :: ${r.message}`);
		total += got;
		if (mode === "blogger" && r.capped) break; // daily_cap Blogger tercapai
		if (got === 0 && waits < MAX_WAITS) {
			const wait = await aiNextReadyInMs(env, await botCfg(env));
			if (wait != null && wait > 0 && wait <= MAX_WAIT_MS) {
				waits++;
				console.log(`[${mode}] AI provider dijeda ${Math.ceil(wait / 1000)} dtk (rate limit) -- tunggu lalu lanjut.`);
				await sleep(wait + 500);
				i--; // putaran yang cuma menunggu tidak dihitung
				continue;
			}
		}
		if (got === 0) break; // antrean 'new' habis ATAU macet di error yang sama terus
	}
	return total;
}

async function main() {
	const url = String(process.env.TURSO_URL ?? "").trim();
	const token = String(process.env.TURSO_TOKEN ?? "").trim();
	if (!url || !token) {
		throw new Error("TURSO_URL / TURSO_TOKEN belum di-set sbg GitHub Actions secret (Settings > Secrets and variables > Actions).");
	}
	// Diagnostik AMAN (tidak membocorkan isi TURSO_TOKEN sama sekali, cuma
	// panjangnya) -- kejadian sebelumnya: TURSO_URL & TURSO_TOKEN kebalik atau
	// ikut ke-paste tanda kutip/spasi, dan pesan error Turso aslinya ("URL_INVALID")
	// tidak bilang secret MANA yang salah -- baris di bawah ini bikin ketahuan
	// dari log run mana yang keliru tanpa perlu buka nilai secret di GitHub.
	console.log(`[diag] TURSO_URL = "${url}" (harus diawali libsql:// atau https://)`);
	console.log(`[diag] TURSO_TOKEN panjang = ${token.length} karakter (JWT asli biasanya 150+)`);
	if (!/^(libsql|https?):\/\//i.test(url)) {
		throw new Error(`TURSO_URL sepertinya bukan URL Turso yang valid: "${url}". Cek lagi -- mungkin isinya kebalik/ketuker dengan TURSO_TOKEN.`);
	}
	if (token.length < 50) {
		throw new Error(`TURSO_TOKEN kependekan (${token.length} karakter) utk sebuah JWT asli -- cek lagi, mungkin ketuker dengan TURSO_URL atau ke-potong pas paste.`);
	}
	if (runCount) console.log(`[diag] RUN_COUNT custom = ${runCount} (dipicu tombol panel, bukan jadwal otomatis)`);
	if (runTarget !== "both") console.log(`[diag] RUN_TARGET custom = ${runTarget} (dipicu tombol panel, bukan jadwal otomatis)`);
	if (fullDrain) console.log(`[diag] FULL_DRAIN=1 (tombol panel, kolom "Jumlah artikel" dikosongkan) -- boleh sampai ${MAX_ROUNDS} putaran.`);

	// PACING: berlaku utk SEMUA tick OTOMATIS -- baik jadwal internal GitHub
	// ("schedule") MAUPUN tick dari cron eksternal cron-job.org yg memicu
	// /__cron?job=githubnews (itu jg workflow_dispatch, TAPI tanpa FULL_DRAIN/
	// RUN_COUNT, beda dari klik tombol panel yg SELALU salah satu dari itu).
	// Tombol panel manual (fullDrain=true ATAU runCount terisi) SELALU jalan
	// langsung tanpa pacing -- itu permintaan eksplisit pemilik saat itu juga.
	const isAutoTick = !fullDrain && !runCount;
	if (isAutoTick) {
		const cfg = await botCfg(env);
		const intervalMin = Math.max(1, Number(cfg.auto_interval_minutes || "10"));
		const lastRunAt = Number(cfg.auto_last_run_ts || "0");
		const elapsedMin = (Date.now() - lastRunAt) / 60000;
		if (lastRunAt && elapsedMin < intervalMin) {
			console.log(`[diag] Lewat jadwal (interval ${intervalMin} menit), baru ${elapsedMin.toFixed(1)} menit sejak proses otomatis terakhir -- lewati run ini.`);
			return;
		}
		await botCfgSet(env, { auto_last_run_ts: String(Date.now()) });
		console.log(`[diag] Proses otomatis (interval ${intervalMin} menit) -- lanjut.`);
	} else {
		// Tombol PROSES manual: coba semua provider sekarang, abaikan jeda dari run sebelumnya.
		await aiClearAllCooldowns(env, await botCfg(env));
	}

	// Blogger & situs sendiri jalan BERSAMAAN (dulu berurutan: situs baru mulai
	// sesudah Blogger selesai). Aman: tiap artikel diklaim atomik
	// (UPDATE ... WHERE status='new'), jadi tidak ada artikel yang diproses dobel.
	const [posted, siteOnly] = await Promise.all([
		runTarget === "site" ? 0 : runLoop("blogger"),
		runTarget === "blogger" ? 0 : runLoop("site"),
	]);
	console.log(`\n=== SELESAI: ${posted} artikel ke Blogger, ${siteOnly} artikel ke situs sendiri ===`);
	// Izin Blogger mati -> tandai jelas di halaman run GitHub (annotation
	// kuning), supaya tidak tersembunyi di balik status "success".
	if (runTarget !== "site") {
		const cfg = await botCfg(env);
		if (cfg.blogger_auth_error) console.log(`::warning title=Blogger terputus::${cfg.blogger_auth_error}`);
	}
}

main().catch((e) => {
	console.error("GAGAL:", e instanceof Error ? e.stack || e.message : e);
	process.exit(1);
});
