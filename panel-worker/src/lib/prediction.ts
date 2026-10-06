// Port Prediction.gs + bagian prediksi V6Core.gs.
// Smart Content V5.1 (generator angka per-website via seed) + Smart Lock registry
// (kunci permanen TANGGAL || SESI || WEBSITE) di tabel D1 prediction_registry /
// prediction_content.
import { sha256Hex } from "./crypto";
import { getSiteAccount } from "./site";
import { sendTelegram } from "../senders/telegram";
import { logActivity } from "./activity";

const OFFSET_MS = 7 * 60 * 60 * 1000;
export const PREDICTION_SERVER_VERSION = "SMART-CONTENT-V5.1";
const PROCESSING_TTL_MS = 3 * 60 * 1000;

export const JADWAL_PREDIKSI_CONFIG: { jam: string; nama: string; pasaran: string[] }[] = [
	{ jam: "02:35", nama: "PREDIKSI CAROLINA EVE s/d OREGON 12", pasaran: ["CAROLINA EVE", "LISBON", "CAIRO", "DALLAS", "KHMER LOTTO", "OREGON 12"] },
	{ jam: "06:15", nama: "PREDIKSI BULLSEYE s/d NEW MEXICO", pasaran: ["BULLSEYE", "BAHRAIN", "HK SIANG", "SAPPORO EVE", "TOTOMACAU 4D SIANG", "SYDNEY", "NEW MEXICO"] },
	{ jam: "08:40", nama: "PREDIKSI IDAHO s/d THAILAND", pasaran: ["IDAHO", "TIONGKOK 4D", "TOTOMACAU 5D SIANG", "JAKARTA LOTTO", "BRAZIL LOTTO", "MANILA LOTTO", "BALI LOTTO", "TOTOMACAU 4D SORE", "LAOS SIANG", "TURKEY", "KINGKONG 4D SORE", "NIPPON LOTTO", "SINGAPORE", "THAILAND"] },
	{ jam: "12:40", nama: "PREDIKSI PANAMA s/d KANSAS", pasaran: ["PANAMA", "MALAYSIA", "BUSAN", "TOTOMACAU 4D MALAM 1", "AUSTRIA", "PARIS", "INDIA", "LISBON NIGHT", "TAIPEI LOTTO", "OSAKA", "KANSAS"] },
	{ jam: "16:00", nama: "PREDIKSI TOTOMACAU 5D MALAM s/d RUSIA", pasaran: ["TOTOMACAU 5D MALAM", "TOTOMACAU 4D MALAM", "BERLIN", "PARMA", "ROMA", "HONGKONG", "TOTOMACAU 4D MALAM 3", "KINGKONG 4D MALAM 2", "LAOS MALAM", "MEXICO", "RUSIA"] },
	{ jam: "21:20", nama: "PREDIKSI TOTOMACAU 4D PAGI s/d OHIO", pasaran: ["TOTOMACAU 4D PAGI", "NEBRASKA", "KENTUCKY MID", "FLORIDA MID", "MONTANA", "SAPPORO", "NEWYORK MID", "MICHIGAN", "CAROLINA DAY", "OHIO"] },
	{ jam: "23:25", nama: "PREDIKSI COLORADO s/d KENTUCKY EVE", pasaran: ["ARIZONA POOLS", "COLORADO", "OREGON 03", "CANADA POOLS", "INDIA MORNING", "ATHENS", "OREGON 06", "CALIFORNIA", "FLORIDA EVE", "OREGON 09", "NEWYORK EVE", "KENTUCKY EVE"] },
];

const DAFTAR_SHIO = [
	"ANJING - KUDA", "KERBAU - AYAM", "ANJING - ANJING", "HARIMAU - AYAM",
	"BABI - AYAM", "MONYET - HARIMAU", "NAGA - KELINCI", "ULAR - TIKUS",
	"KAMBING - KUDA", "BABI - TIKUS", "KERBAU - NAGA", "MONYET - AYAM",
];

export const CLOSING_PREDICTION_NAME = "KATA-KATA PENUTUP PREDIKSI";
export const CLOSING_PREDICTION_SLOTS = ["06:15", "16:00"];
const CLOSING_PREDICTION_VARIANTS = [
	"Prediksi di atas hanyalah referensi angka hari ini. Tepat atau tidaknya tetap bergantung pada hoki anda bosku.",
	"Gunakan prediksi ini sebagai bahan pertimbangan saja. Hasil akhirnya tetap bergantung pada keberuntungan anda bosku.",
	"Angka di atas merupakan prediksi untuk hari ini, bukan jaminan hasil. Semoga hoki selalu menyertai anda bosku.",
	"Prediksi ini dibuat sebagai referensi hiburan hari ini. Cocok atau tidaknya tetap ditentukan oleh hoki anda bosku.",
	"Silakan gunakan angka di atas dengan bijak. Ketepatan prediksi tetap bergantung pada keberuntungan anda bosku.",
	"Prediksi hari ini tidak menjamin hasil akhir. Semoga pilihan anda membawa hoki terbaik bosku.",
];

/** Kode website panel -> nama merek penuh (dipakai juga Auto Prediksi). */
export const PREDICTION_SITE_NAMES: Record<string, string> = {
	SOHO: "SOHOTOGEL", LIMA: "LIMATOGEL", RETRO: "RETROTOGEL", HUGO: "HUGOTOGEL",
	XO: "XOTOGEL", SENJA: "SENJATOGEL", DODO: "DODOTOGEL", AXIS: "AXISTOGEL",
	REMBO: "REMBOTOGEL", HELEN: "HELENTOGEL", FOLA: "FOLATOTO", YEL: "YELTOTO",
};

// ---------------------------------------------------------------------------
// Waktu (GMT+7)
// ---------------------------------------------------------------------------
function now7(): Date {
	return new Date(Date.now() + OFFSET_MS);
}
export function predictionTodayKey(): string {
	return now7().toISOString().slice(0, 10);
}
function nowMinutes7(): number {
	const d = now7();
	return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function ts7(): string {
	return now7().toISOString().slice(0, 19).replace("T", " ");
}
/** "yyyy-MM-dd HH:mm:ss" (GMT+7) -> ms sejak epoch pada dinding waktu yang sama. */
function textToMs(text: string): number {
	const t = String(text || "").trim();
	if (!t) return 0;
	const p = Date.parse(t.replace(" ", "T") + "Z");
	return isNaN(p) ? 0 : p;
}
function toDisplayTime(text: string): string {
	const m = String(text || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2}:\d{2})/);
	if (!m) return String(text || "");
	return `${m[3]}/${m[2]}/${m[1]} ${m[4]}`;
}

export function predictionScheduleId(index: number): string {
	return "PRED-" + (Number(index) + 1);
}
export function normalizeClosingSlot(slot: string): string {
	const clean = String(slot || "").trim();
	return CLOSING_PREDICTION_SLOTS.indexOf(clean) >= 0 ? clean : getActiveClosingSlot();
}
export function getActiveClosingSlot(): string {
	return nowMinutes7() < 16 * 60 ? "06:15" : "16:00";
}
export function closingScheduleId(slot: string): string {
	return "CLOSING-" + normalizeClosingSlot(slot).replace(":", "");
}
function predictionUniqueKey(dateKey: string, scheduleId: string, website: string): string {
	return [
		String(dateKey || "").trim(),
		String(scheduleId || "").trim().toUpperCase(),
		String(website || "").trim().toUpperCase(),
	].join("||");
}
export function predictionSiteDisplayName(website: string): string {
	const key = String(website || "").trim().toUpperCase();
	return PREDICTION_SITE_NAMES[key] || key;
}

// ---------------------------------------------------------------------------
// Generator angka per-website (seeded — identik dgn Prediction.gs)
// ---------------------------------------------------------------------------
async function seededRandom(seedText: string): Promise<() => number> {
	const hex = await sha256Hex(String(seedText || ""));
	let state = parseInt(hex.substring(0, 8), 16) >>> 0;
	if (!state) state = 0x6d2b79f5;
	return function () {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function randInt(fn: () => number, min: number, max: number): number {
	return Math.floor(fn() * (max - min + 1)) + min;
}

async function generatePrediksiTextForWebsite(namaPasaran: string, seedKey: string): Promise<string> {
	const random = await seededRandom(seedKey);
	const tarung1 = randInt(random, 1000, 9999);
	let tarung2 = randInt(random, 1000, 9999);
	if (tarung2 === tarung1) tarung2 = tarung2 === 9999 ? 1000 : tarung2 + 1;

	const bbfs = String(randInt(random, 10000, 99999));
	const shioPilihan = DAFTAR_SHIO[randInt(random, 0, DAFTAR_SHIO.length - 1)];

	const b1 = bbfs.charAt(0), b2 = bbfs.charAt(1), b3 = bbfs.charAt(2), b4 = bbfs.charAt(3);
	// 4 digit pertama BBFS -> 12 pasangan berurutan dengan posisi berbeda.
	// (Dulu b2+b2 & b4+b3 tertulis dobel, jadi b2b4/b4b2 tidak pernah muncul.)
	const line12 = [
		b1 + b2, b1 + b3, b1 + b4,
		b2 + b1, b2 + b3, b2 + b4,
		b3 + b1, b3 + b2, b3 + b4,
		b4 + b1, b4 + b2, b4 + b3,
	].join(" ");

	let hasil = "PREDIKSI <" + namaPasaran + "> HARI INI\n\n";
	hasil += "ANGKA TARUNG:\n" + tarung1 + " vs " + tarung2 + "\n\n";
	hasil += "BBFS 5 DIGIT : " + bbfs + "\n\n";
	hasil += "TEBAK SHIO : " + shioPilihan + "\n\n";
	hasil += "TOP 2D 12 LINE  🔥\n\n" + line12 + "\n\n";
	return hasil;
}

async function buildPredictionBundle(index: number, website: string, salt: string | number): Promise<string> {
	const config = JADWAL_PREDIKSI_CONFIG[Number(index)];
	if (!config) throw new Error("Jadwal prediksi tidak ditemukan.");
	const cleanWebsite = String(website || "GLOBAL").trim().toUpperCase();
	const dateKey = predictionTodayKey();
	const scheduleId = predictionScheduleId(index);
	const s = String(salt ?? "0");
	let message = "";
	for (let marketIndex = 0; marketIndex < config.pasaran.length; marketIndex++) {
		const pasaran = config.pasaran[marketIndex];
		const seedKey = [
			"SMART-CONTENT-V5.1", dateKey, scheduleId, cleanWebsite,
			String(pasaran || "").toUpperCase(), marketIndex, s,
		].join("|");
		message += (await generatePrediksiTextForWebsite(pasaran, seedKey)) + "----------------------------------\n\n";
	}
	return message.trim();
}

// ---------------------------------------------------------------------------
// Kata-kata penutup
// ---------------------------------------------------------------------------
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function formatClosingDateEnglish(d: Date): string {
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${day} ${MONTHS_EN[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export async function buildClosingPredictionMessage(website: string, date: Date, slot: string): Promise<string> {
	const siteName = predictionSiteDisplayName(website);
	const activeSlot = normalizeClosingSlot(slot);
	const dateText = formatClosingDateEnglish(date || now7());
	const seed = await sha256Hex(String(website || "") + "|" + dateText + "|" + activeSlot);
	const variantIndex = parseInt(seed.substring(0, 8), 16) % CLOSING_PREDICTION_VARIANTS.length;
	return "Prediksi Togel Gacor " + siteName + " " + dateText + "\n\n" + CLOSING_PREDICTION_VARIANTS[variantIndex];
}

// ---------------------------------------------------------------------------
// prediction_content — buat / ambil isi harian per website
// ---------------------------------------------------------------------------
export async function getOrCreateDailyPredictionContents(
	env: Env,
	index: number,
	websites: string[],
): Promise<Record<string, string>> {
	const config = JADWAL_PREDIKSI_CONFIG[Number(index)];
	if (!config) return {};
	const clean = Array.from(new Set((websites || []).map((w) => String(w || "").trim().toUpperCase()).filter(Boolean)));
	if (!clean.length) return {};

	const dateKey = predictionTodayKey();
	const scheduleId = predictionScheduleId(index);
	const placeholders = clean.map(() => "?").join(",");
	const existing = await env.DB.prepare(
		`SELECT website, content FROM prediction_content
		 WHERE date_key = ? AND schedule_id = ? AND website IN (${placeholders})`,
	)
		.bind(dateKey, scheduleId, ...clean)
		.all<{ website: string; content: string }>();

	const result: Record<string, string> = {};
	for (const r of existing.results ?? []) result[String(r.website).toUpperCase()] = String(r.content || "");

	const usedHashes: Record<string, string> = {};
	const rebuild: string[] = [];
	for (const website of clean) {
		const content = String(result[website] || "");
		const hash = content ? await sha256Hex(content) : "";
		const isLegacy = /^\s*PREDIKSI\s+KHUSUS\b/i.test(content);
		const isDuplicate = !!(hash && usedHashes[hash]);
		if (!content || isLegacy || isDuplicate) {
			rebuild.push(website);
			delete result[website];
		} else {
			usedHashes[hash] = website;
		}
	}

	if (rebuild.length) {
		const createdAt = ts7();
		const stmts: D1PreparedStatement[] = [];
		for (const website of rebuild) {
			let attempt = 0;
			let content = "";
			let hash = "";
			do {
				content = await buildPredictionBundle(index, website, attempt);
				hash = await sha256Hex(content);
				attempt++;
			} while (usedHashes[hash] && attempt < 20);
			result[website] = content;
			usedHashes[hash] = website;
			stmts.push(
				env.DB.prepare(
					`INSERT INTO prediction_content (date_key, schedule_id, website, prediction_name, content, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT(date_key, schedule_id, website)
					 DO UPDATE SET content = excluded.content, prediction_name = excluded.prediction_name, created_at = excluded.created_at`,
				).bind(dateKey, scheduleId, website, config.nama, content, createdAt),
			);
		}
		if (stmts.length) await env.DB.batch(stmts);
	}
	return result;
}

// ---------------------------------------------------------------------------
// prediction_registry — Smart Lock
// ---------------------------------------------------------------------------
export interface RegEntry {
	dateKey: string;
	scheduleId: string;
	website: string;
	status: string;
	username: string;
	timeMs: number;
	timeText: string;
	requestId: string;
	detail: string;
	processingFresh: boolean;
}
function entryRank(e: RegEntry | null): number {
	if (!e) return -1;
	if (e.status === "BERHASIL") return 100;
	if (e.status === "PROCESSING" && e.processingFresh) return 60;
	if (e.status === "GAGAL") return 30;
	if (e.status === "PROCESSING") return 10;
	return 0;
}
export async function readPredictionRegistryForDate(env: Env, dateKey: string): Promise<Record<string, RegEntry>> {
	const res = await env.DB.prepare(
		`SELECT date_key, schedule_id, website, status, username, sent_at, request_id, detail
		 FROM prediction_registry WHERE date_key = ?`,
	)
		.bind(String(dateKey || "").trim())
		.all<Record<string, string>>();

	const out: Record<string, RegEntry> = {};
	const nowMs = Date.now() + OFFSET_MS;
	for (const row of res.results ?? []) {
		const scheduleId = String(row.schedule_id || "").trim().toUpperCase();
		const website = String(row.website || "").trim().toUpperCase();
		if (!scheduleId || !website) continue;
		const status = String(row.status || "").trim().toUpperCase();
		const timeMs = textToMs(row.sent_at);
		const entry: RegEntry = {
			dateKey: String(row.date_key || ""),
			scheduleId,
			website,
			status,
			username: String(row.username || ""),
			timeMs,
			timeText: toDisplayTime(row.sent_at),
			requestId: String(row.request_id || ""),
			detail: String(row.detail || ""),
			processingFresh: status === "PROCESSING" && timeMs > 0 && nowMs - timeMs < PROCESSING_TTL_MS,
		};
		const key = scheduleId + "||" + website;
		const cur = out[key] || null;
		const cr = entryRank(cur);
		const er = entryRank(entry);
		if (!cur || er > cr || (er === cr && entry.timeMs >= cur.timeMs)) out[key] = entry;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Kirim satu sesi (schedule / closing) — inti sendPredictionJob_
// ---------------------------------------------------------------------------
export interface PredJobOptions {
	env: Env;
	username: string;
	websites: string[];
	dateKey?: string;
	scheduleId: string;
	predictionName: string;
	predictionIndex?: number;
	kind: "schedule" | "closing";
	activeSlot?: string;
	logAction: string;
	messageForWebsite: (website: string) => Promise<string> | string;
}
export interface WebsiteResult {
	website: string;
	status: string;
	reason: string;
}

function normalizePred(value: string): { status: string; reason: string } {
	const text = String(value ?? "");
	if (/^(terkirim|berhasil)/i.test(text)) return { status: "BERHASIL", reason: text };
	if (!text) return { status: "GAGAL", reason: "Tidak ada respons Telegram" };
	return { status: "GAGAL", reason: text };
}

export async function sendPredictionJob(opts: PredJobOptions) {
	const env = opts.env;
	const started = Date.now();
	const websites = Array.from(new Set((opts.websites || []).map((w) => String(w || "").trim().toUpperCase()).filter(Boolean)));
	const kind = opts.kind || "schedule";
	if (!websites.length) {
		return { success: false, blocked: true, message: "Tidak ada website untuk diproses.", websiteResults: [], kind };
	}

	const cleanUser = String(opts.username || "AUTO");
	const dateKey = opts.dateKey && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateKey) ? opts.dateKey : predictionTodayKey();
	const scheduleId = String(opts.scheduleId || "").trim().toUpperCase();
	const predictionName = String(opts.predictionName || "PREDIKSI");
	const requestId = crypto.randomUUID();

	const contentMap: Record<string, string> = {};
	for (const w of websites) {
		try {
			contentMap[w] = String((await opts.messageForWebsite(w)) || "");
		} catch {
			contentMap[w] = "";
		}
	}

	const registry = await readPredictionRegistryForDate(env, dateKey);
	const resultMap: Record<string, WebsiteResult> = {};
	const reservations: { website: string; content: string; uniqueKey: string }[] = [];
	const reserveStmts: D1PreparedStatement[] = [];
	const nowText = ts7();

	for (const w of websites) {
		const prev = registry[scheduleId + "||" + w] || null;
		if (prev && prev.status === "BERHASIL") {
			resultMap[w] = {
				website: w,
				status: "SUDAH DIKIRIM",
				reason: "Smart Lock memblokir duplikat. Sudah dikirim oleh " + (prev.username || "user lain") +
					(prev.timeText ? " pada " + prev.timeText : "") + ".",
			};
			continue;
		}
		if (prev && prev.status === "PROCESSING" && prev.processingFresh) {
			resultMap[w] = {
				website: w,
				status: "SEDANG DIPROSES",
				reason: "Website ini sedang diproses oleh " + (prev.username || "user lain") + ".",
			};
			continue;
		}
		const content = contentMap[w];
		if (!content) {
			resultMap[w] = { website: w, status: "GAGAL", reason: "Isi pesan kosong." };
			continue;
		}
		const uniqueKey = predictionUniqueKey(dateKey, scheduleId, w);
		reservations.push({ website: w, content, uniqueKey });
		reserveStmts.push(
			env.DB.prepare(
				`INSERT INTO prediction_registry
				   (date_key, schedule_id, prediction_name, website, status, username, sent_at, request_id, detail, content_hash, unique_key)
				 VALUES (?, ?, ?, ?, 'PROCESSING', ?, ?, ?, 'Reservasi Smart Content V6', ?, ?)
				 ON CONFLICT(unique_key) DO UPDATE SET
				   status = 'PROCESSING', prediction_name = excluded.prediction_name, username = excluded.username,
				   sent_at = excluded.sent_at, request_id = excluded.request_id,
				   detail = excluded.detail, content_hash = excluded.content_hash
				 WHERE prediction_registry.status <> 'BERHASIL'
				   AND prediction_registry.request_id <> ?`,
			).bind(dateKey, scheduleId, predictionName, w, cleanUser, nowText, requestId, await sha256Hex(content), uniqueKey, requestId),
		);
	}
	if (reserveStmts.length) await env.DB.batch(reserveStmts);

	// ATOMIC CLAIM: baca ulang baris yang barusan kita reservasi. Karena D1 men-
	// serialkan write, kalau ada run lain yang jalan barengan (RUN_LOCK KV gagal
	// mis. kuota habis) maka request_id di baris itu bukan milik kita -> JANGAN
	// kirim, tandai "SEDANG DIPROSES". Ini lapis anti-dobel terakhir untuk
	// closing/prediksi auto yang sempat kekirim 2x.
	if (reservations.length) {
		const keys = reservations.map((r) => r.uniqueKey);
		const ph = keys.map(() => "?").join(",");
		const claimed = await env.DB.prepare(
			`SELECT unique_key, request_id, status FROM prediction_registry WHERE unique_key IN (${ph})`,
		).bind(...keys).all<{ unique_key: string; request_id: string; status: string }>();
		const owned: Record<string, string> = {};
		for (const row of claimed.results ?? []) owned[String(row.unique_key)] = String(row.request_id || "") + "|" + String(row.status || "").toUpperCase();
		for (let i = reservations.length - 1; i >= 0; i--) {
			const r = reservations[i];
			const tag = owned[r.uniqueKey] || "";
			const [rid, st] = tag.split("|");
			if (st === "BERHASIL") {
				resultMap[r.website] = { website: r.website, status: "SUDAH DIKIRIM", reason: "Smart Lock: sudah dikirim oleh permintaan lain." };
				reservations.splice(i, 1);
			} else if (rid !== requestId) {
				resultMap[r.website] = { website: r.website, status: "SEDANG DIPROSES", reason: "Permintaan lain sedang memproses website ini." };
				reservations.splice(i, 1);
			}
		}
	}

	// Kirim Telegram Prediksi per website
	for (const r of reservations) {
		const acc = await getSiteAccount(env, r.website);
		if (!acc || !acc.telegramPred.token || !acc.telegramPred.chatId) {
			resultMap[r.website] = {
				website: r.website,
				status: "GAGAL",
				reason: "TOKEN atau CHAT_ID Telegram Prediksi tidak ditemukan pada data website.",
			};
			continue;
		}
		const resp = await sendTelegram(r.content, acc.telegramPred);
		const n = normalizePred(resp);
		resultMap[r.website] = { website: r.website, status: n.status, reason: n.reason };
	}

	// Tulis hasil akhir (hanya kalau request_id masih milik kita)
	if (reservations.length) {
		const upd: D1PreparedStatement[] = reservations.map((r) => {
			const res = resultMap[r.website];
			return env.DB.prepare(
				`UPDATE prediction_registry
				 SET status = ?, username = ?, sent_at = ?, detail = ?
				 WHERE unique_key = ? AND request_id = ?`,
			).bind(res.status === "BERHASIL" ? "BERHASIL" : "GAGAL", cleanUser, ts7(), res.reason, r.uniqueKey, requestId);
		});
		await env.DB.batch(upd);
	}

	const websiteResults: WebsiteResult[] = websites.map(
		(w) => resultMap[w] || { website: w, status: "GAGAL", reason: "Status pengiriman tidak tersedia." },
	);
	const counters = { success: 0, failed: 0, already: 0, processing: 0 };
	for (const it of websiteResults) {
		const s = String(it.status || "").toUpperCase();
		if (s === "BERHASIL") counters.success++;
		else if (s === "SUDAH DIKIRIM") counters.already++;
		else if (s === "SEDANG DIPROSES") counters.processing++;
		else counters.failed++;
	}
	const pendingWebsites = websiteResults.filter((it) => String(it.status).toUpperCase() === "GAGAL").map((it) => it.website);
	const allAlready = counters.already === websiteResults.length;
	const noNew = counters.success === 0 && counters.failed === 0;
	const anySuccess = counters.success > 0;
	const anyFailure = counters.failed > 0;
	const logStatus = allAlready ? "DIBLOKIR" : anySuccess && anyFailure ? "SEBAGIAN" : anyFailure && !anySuccess ? "GAGAL" : anySuccess ? "BERHASIL" : "INFO";
	const logDetail = predictionName + " | " + websiteResults.map((x) => {
		const st = String(x.status || "").toUpperCase();
		return x.website + ": " + x.status + (st !== "BERHASIL" && st !== "SUDAH DIKIRIM" && x.reason ? " (" + x.reason + ")" : "");
	}).join(" | ");

	await logActivity(
		env,
		cleanUser,
		allAlready ? "DUPLIKAT PREDIKSI DIBLOKIR" : String(opts.logAction || "KIRIM PREDIKSI AUTO"),
		logDetail,
		logStatus,
		reservations.map((x) => x.content).join("\n\n"),
	);

	return {
		success: anySuccess && !anyFailure,
		partial: anySuccess && anyFailure,
		blocked: noNew,
		allAlready,
		message: allAlready
			? "Smart Lock memblokir pengiriman karena seluruh website sudah menerima sesi ini hari ini."
			: pendingWebsites.length
				? "Sebagian website belum berhasil dikirim."
				: counters.processing > 0 && !anySuccess
					? "Pengiriman sedang diproses oleh permintaan lain."
					: "Proses pengiriman selesai.",
		kind,
		activeSlot: opts.activeSlot || "",
		predictionIndex: opts.predictionIndex == null ? -1 : Number(opts.predictionIndex),
		predictionName,
		dateKey,
		scheduleId,
		websiteResults,
		pendingWebsites,
		counters,
		durationMs: Date.now() - started,
		serverVersion: PREDICTION_SERVER_VERSION,
	};
}

// ---------------------------------------------------------------------------
// Status halaman prediksi
// ---------------------------------------------------------------------------
function buildScheduleStatus(
	scheduleId: string,
	name: string,
	time: string,
	websites: string[],
	registry: Record<string, RegEntry>,
	hasProfile: boolean,
	telegramAllowed: boolean,
) {
	const siteStatus = websites.map((website) => {
		const entry = registry[scheduleId + "||" + website] || null;
		const status = entry && entry.status === "PROCESSING" && !entry.processingFresh
			? "BELUM DIKIRIM"
			: entry
				? entry.status
				: "BELUM DIKIRIM";
		return { website, status, username: entry ? entry.username : "", time: entry ? entry.timeText : "" };
	});
	const sentCount = siteStatus.filter((s) => s.status === "BERHASIL").length;
	const processingCount = siteStatus.filter((s) => s.status === "PROCESSING").length;
	const totalWebsites = websites.length;
	let status = "ACTIVE";
	if (!hasProfile || !telegramAllowed || totalWebsites === 0) status = "NO_ACCESS";
	else if (sentCount === totalWebsites) status = "POSTED";
	else if (sentCount > 0 || processingCount > 0) status = "PARTIAL";
	return {
		name,
		time,
		status,
		sentCount,
		processingCount,
		totalWebsites,
		pendingCount: Math.max(totalWebsites - sentCount - processingCount, 0),
		websiteStatus: siteStatus,
	};
}

export async function getPredictionStatusDataInternal(
	env: Env,
	profile: { websites: string[]; permissions: { telegram: boolean } } | null,
) {
	const dateKey = predictionTodayKey();
	const registry = await readPredictionRegistryForDate(env, dateKey);
	const websites = profile
		? Array.from(new Set((profile.websites || []).map((s) => String(s || "").trim().toUpperCase()).filter(Boolean)))
		: [];
	const telegramAllowed = !!(profile && profile.permissions && profile.permissions.telegram);

	const schedules = JADWAL_PREDIKSI_CONFIG.map((item, index) =>
		buildScheduleStatus(predictionScheduleId(index), item.nama, item.jam, websites, registry, !!profile, telegramAllowed),
	);

	const activeSlot = getActiveClosingSlot();
	const closingSlots = CLOSING_PREDICTION_SLOTS.map((slot) => {
		const state = buildScheduleStatus(
			closingScheduleId(slot), CLOSING_PREDICTION_NAME, slot, websites, registry, !!profile, telegramAllowed,
		) as ReturnType<typeof buildScheduleStatus> & { slot: string };
		state.slot = slot;
		return state;
	});

	let infoText = "Klik SEND AUTO. Smart Content akan memeriksa tanggal, sesi, website, dan variasi isi sebelum Telegram dikirim.";
	if (!profile) infoText = "User tidak ditemukan. Silakan login ulang.";
	else if (!telegramAllowed) infoText = "Akses Telegram pada data Users belum diaktifkan untuk akun ini.";
	else if (!websites.length) infoText = "Akun ini belum memiliki akses website pada data Users.";

	return {
		serverVersion: PREDICTION_SERVER_VERSION,
		infoText,
		dateKey,
		websites,
		telegramAllowed,
		schedules,
		closing: {
			kind: "closing",
			name: CLOSING_PREDICTION_NAME,
			time: "06:15 & 16:00",
			activeSlot,
			totalWebsites: websites.length,
			exampleText: await buildClosingPredictionMessage("HUGO", now7(), activeSlot),
			slots: closingSlots,
		},
	};
}

// ---------------------------------------------------------------------------
// Bundle copy + closing copy
// ---------------------------------------------------------------------------
export interface PredContext {
	error?: string;
	cleanUser?: string;
	websites?: string[];
}
export function validatePredictionContext(
	profile: { username: string; status: string; role: string; websites: string[]; permissions: { telegram: boolean } } | null,
	onlyWebsites?: string[] | null,
): PredContext {
	if (!profile) return { error: "User tidak ditemukan. Silakan login ulang." };
	if (profile.status !== "AKTIF") return { error: "Akun tidak aktif." };
	if (!profile.permissions.telegram) return { error: "Akses Telegram pada data Users belum diaktifkan." };
	const allowed = Array.from(new Set((profile.websites || []).map((s) => String(s || "").trim().toUpperCase()).filter(Boolean)));
	const requested = Array.isArray(onlyWebsites) && onlyWebsites.length
		? new Set(onlyWebsites.map((s) => String(s || "").trim().toUpperCase()))
		: null;
	const websites = requested ? allowed.filter((s) => requested.has(s)) : allowed;
	if (!websites.length) return { error: "Tidak ada website yang dapat diproses untuk akun ini." };
	return { cleanUser: profile.username, websites };
}

export async function generatePredictionCopyBundleInternal(
	env: Env,
	index: number,
	profile: Parameters<typeof validatePredictionContext>[0],
) {
	const scheduleIndex = Number(index);
	const config = JADWAL_PREDIKSI_CONFIG[scheduleIndex];
	if (!config) return { success: false, message: "Jadwal prediksi tidak ditemukan.", messages: [] };
	const context = validatePredictionContext(profile, null);
	if (context.error) return { success: false, message: context.error, messages: [] };

	const contents = await getOrCreateDailyPredictionContents(env, scheduleIndex, context.websites!);
	const messages = context.websites!
		.map((website) => ({
			website,
			siteName: predictionSiteDisplayName(website),
			text: String(contents[website] || ""),
		}))
		.filter((m) => m.text);

	return {
		success: messages.length > 0,
		predictionName: config.nama,
		messages,
		copyText: messages.map((m) => "【" + m.siteName + "】\n" + m.text).join("\n\n" + "━".repeat(32) + "\n\n"),
		serverVersion: PREDICTION_SERVER_VERSION,
	};
}

export async function generateClosingPredictionCopyInternal(
	profile: Parameters<typeof validatePredictionContext>[0],
	slot: string,
) {
	const context = validatePredictionContext(profile, null);
	if (context.error) return { success: false, message: context.error, messages: [] };
	const activeSlot = normalizeClosingSlot(slot);
	const messages = await Promise.all(
		context.websites!.map(async (website) => ({
			website,
			siteName: predictionSiteDisplayName(website),
			text: await buildClosingPredictionMessage(website, now7(), activeSlot),
		})),
	);
	return {
		success: true,
		kind: "closing",
		activeSlot,
		predictionName: CLOSING_PREDICTION_NAME,
		messages,
		copyText: messages.map((m) => "【" + m.siteName + "】\n" + m.text).join("\n\n" + "━".repeat(32) + "\n\n"),
		serverVersion: PREDICTION_SERVER_VERSION,
	};
}
