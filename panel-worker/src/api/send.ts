// Port PanelCore.gs smartAutoSendFastInternal_ + Sending.gs sendSelectedSystemsInternal_
// / retryFailedSystemInternal_ / sendToPanelZOnlyInternal_.
import { requireSession, Session } from "./auth";
import { logActivity } from "../lib/activity";
import { sha256Hex } from "../lib/crypto";
import { processText } from "../lib/parser";
import { getSiteAccount } from "../lib/site";
import { getRegistryEntry, upsertRegistry } from "../lib/registry";
import { sendTelegram } from "../senders/telegram";
import { sendLinktree } from "../senders/linktree";
import { sendCustomPanelZ, sendPanelZ } from "../senders/panelz";
import { autoInputAfterSend } from "./auto-input";
import { getSys } from "../lib/settings";
import { linktreeCfg } from "../lib/integrations";
import { NET_FAIL_RE, netFailWhy, startSendDeadline, TIME_UP_NOT_SENT } from "../lib/send-deadline";

type SystemKey = "telegram" | "linktree" | "panelz";
/** Website yang dikirimi bersamaan (tiap website 1 koneksi aktif; Cloudflare membuka maks 6 koneksi keluar sekaligus). */
const SEND_POOL = 6;
const SYSTEMS: SystemKey[] = ["telegram", "linktree", "panelz"];

interface SysResult {
	status: string; // BERHASIL | GAGAL | DIBLOKIR | SUDAH DIKIRIM | SKIP
	reason: string;
}
interface WebsiteResult {
	website: string;
	telegram: SysResult;
	linktree: SysResult;
	panelz: SysResult;
}

function normalizeSendResult(value: string): SysResult {
	const text = String(value ?? "");
	if (/^(terkirim|berhasil)/i.test(text)) return { status: "BERHASIL", reason: text };
	if (!text) return { status: "GAGAL", reason: "Tidak ada respons" };
	return { status: "GAGAL", reason: text };
}

interface SendOpts {
	targets?: string[];
	forceDuplicate?: boolean;
	onlyWebsites?: string[];
	isPrediksiAuto?: boolean;
	/** Tahap Auto Prediksi SUDAH dijalankan browser sebelum kirim (autoInputBeforeSend) -> jangan dibuat lagi di sini. */
	skipAutoInput?: boolean;
}

async function runSend(env: Env, session: Session, rawText: string, opts: SendOpts) {
	const profile = session.profile;
	const processed = processText(rawText);
	const textToSend = opts.isPrediksiAuto
		? String(rawText ?? "")
		: processed.output || String(rawText ?? "").trim();

	if (!textToSend) {
		return { success: false, blocked: true, message: "Isi data kosong.", websiteResults: [] as WebsiteResult[] };
	}

	const targets = (opts.targets ?? SYSTEMS).map((t) => String(t).toLowerCase());
	const requested: Record<SystemKey, boolean> = {
		telegram: targets.includes("telegram"),
		linktree: targets.includes("linktree"),
		panelz: targets.includes("panelz"),
	};

	const selected = new Set(
		(opts.onlyWebsites?.length ? opts.onlyWebsites : profile.websites).map((w) =>
			String(w).trim().toUpperCase(),
		),
	);
	const websites = profile.websites.filter((w) => selected.has(w));
	if (!websites.length) {
		return {
			success: false,
			blocked: true,
			message: "Akun ini belum memiliki website pada data Users.",
			websiteResults: [] as WebsiteResult[],
		};
	}

	const hash = await sha256Hex(textToSend);
	const websiteResults: WebsiteResult[] = [];
	const registryWarnings: string[] = [];

	// Kirim ke semua website PARALEL (maks SEND_POOL sekaligus; tiap website tetap berurutan Telegram -> LinkTree -> Panel-Z).
	// Dulu bergiliran: satu server lambat x batas 25 dtk per panggilan x beberapa website = >100 dtk -> "Permintaan menggantung
	// lebih dari 100 dtk" (smartAutoSendFast 14 Okt 02:04) dan operator tidak melihat hasil apa pun. Pengaman sekarang:
	//  1. server yang tidak menjawab (timeout/jaringan) untuk satu website langsung DILEWATI untuk website lain di putaran ini;
	//  2. TENGGAT KERAS: semua panggilan keluar terikat satu signal yang putus sebelum batas tunggu panel (sisa ±12 dtk untuk
	//     mencatat registry + log). Kiriman yang belum mulai dihentikan rapi ("belum dikirim"); yang sedang jalan diputus dan
	//     dilaporkan "mungkin tetap terkirim". Yang sudah BERHASIL tercatat di registry anti-duplikat -> kirim ulang tidak dobel.
	const run = startSendDeadline();
	const deadHosts = new Map<string, string>();
	const hostOf = (k: SystemKey, acc: Awaited<ReturnType<typeof getSiteAccount>>): string => {
		try {
			if (k === "telegram") return "api.telegram.org";
			if (k === "linktree") return new URL(linktreeCfg().loginUrl).host;
			return acc?.panelz.url ? new URL(acc.panelz.url).host : "";
		} catch {
			return "";
		}
	};
	const LABEL: Record<SystemKey, string> = { telegram: "Telegram", linktree: "LinkTree", panelz: "Panel-Z" };

	const sendWebsite = async (website: string): Promise<WebsiteResult> => {
		const wr: WebsiteResult = {
			website,
			telegram: { status: "SKIP", reason: "Tidak diproses" },
			linktree: { status: "SKIP", reason: "Tidak diproses" },
			panelz: { status: "SKIP", reason: "Tidak diproses" },
		};
		// Registry anti-duplikat ada di Turso. Bila tidak terbaca (down / belum dikonfigurasi) JANGAN mengirim buta (bisa kirim
		// ganda) dan JANGAN melempar error mentah: tandai website ini GAGAL dengan alasan jelas, lanjutkan website berikutnya.
		let previous: Awaited<ReturnType<typeof getRegistryEntry>>;
		try {
			previous = await getRegistryEntry(env, website, hash);
		} catch (e) {
			const why = "Pengecekan anti-duplikat (database) tidak tersedia — tidak dikirim demi mencegah kirim ganda. Coba lagi sebentar atau hubungi admin.";
			for (const k of SYSTEMS) if (requested[k]) wr[k] = profile.permissions[k] ? { status: "GAGAL", reason: why } : { status: "DIBLOKIR", reason: "Tidak diizinkan pada data Users" };
			registryWarnings.push(`${website}: registry tidak terbaca (${e instanceof Error ? e.message.slice(0, 80) : "error"})`);
			return wr;
		}
		const acc = await getSiteAccount(env, website);

		for (const k of SYSTEMS) {
			if (!requested[k]) continue;
			if (!profile.permissions[k]) {
				wr[k] = { status: "DIBLOKIR", reason: "Tidak diizinkan pada data Users" };
				continue;
			}
			if (!opts.forceDuplicate && previous && previous[k]) {
				wr[k] = {
					status: "SUDAH DIKIRIM",
					reason:
						"Pernah dikirim oleh " +
						(previous.username || "user sebelumnya") +
						" pada " +
						(previous.sentAt || "waktu tidak tercatat"),
				};
				continue;
			}
			if (!acc) {
				wr[k] = { status: "GAGAL", reason: "Konfigurasi website " + website + " tidak ditemukan" };
				continue;
			}
			if (run.signal.aborted) {
				wr[k] = { status: "GAGAL", reason: TIME_UP_NOT_SENT };
				continue;
			}
			const host = hostOf(k, acc);
			const dead = host ? deadHosts.get(host) : undefined;
			if (dead) {
				wr[k] = { status: "GAGAL", reason: `Dilewati: ${LABEL[k]} tidak menjawab untuk website lain di putaran ini (${dead}). Kirim ulang sebentar lagi.` };
				continue;
			}
			let r: string;
			try {
				if (k === "telegram") {
					const cfg = opts.isPrediksiAuto ? acc.telegramPred : acc.telegram;
					r = await sendTelegram(textToSend, cfg, run.signal);
				} else if (k === "linktree") {
					r = await sendLinktree(acc.linktree, processed, run.signal);
				} else {
					r = await sendPanelZ(textToSend, acc.panelz, run.signal);
				}
			} catch (e) {
				r = "Error: " + (e instanceof Error ? e.message : String(e));
			}
			wr[k] = normalizeSendResult(r);
			if (wr[k].status === "GAGAL" && run.signal.aborted && NET_FAIL_RE.test(r)) {
				wr[k] = { status: "GAGAL", reason: `${LABEL[k]} belum menjawab saat batas waktu kirim habis — mungkin tetap terkirim; cek dulu sebelum kirim ulang.` };
			} else if (wr[k].status === "GAGAL" && NET_FAIL_RE.test(r)) {
				const why = netFailWhy(r);
				if (host) deadHosts.set(host, why);
				wr[k] = { status: "GAGAL", reason: `${LABEL[k]} ${why} — mungkin tetap terkirim; cek dulu sebelum kirim ulang. (${String(r).slice(0, 120)})` };
			}
		}

		const merged = {
			telegram: !!(previous && previous.telegram) || wr.telegram.status === "BERHASIL",
			linktree: !!(previous && previous.linktree) || wr.linktree.status === "BERHASIL",
			panelz: !!(previous && previous.panelz) || wr.panelz.status === "BERHASIL",
		};
		if (merged.telegram || merged.linktree || merged.panelz) {
			// Pesan SUDAH terkirim di titik ini. Gagal mencatat registry tidak boleh melempar (dulu: log aktivitas terlewat dan
			// operator mengira gagal lalu kirim ulang -> terkirim ganda). Coba 2x, lalu peringatkan dengan jelas.
			try {
				await upsertRegistry(env, hash, website, profile.username, processed.market, merged, textToSend);
			} catch {
				try {
					await upsertRegistry(env, hash, website, profile.username, processed.market, merged, textToSend);
				} catch (e2) {
					registryWarnings.push(`${website}: terkirim tetapi pencatatan anti-duplikat gagal — JANGAN kirim ulang (${e2 instanceof Error ? e2.message.slice(0, 80) : "error"})`);
				}
			}
		}
		return wr;
	};

	const queue = websites.map((w, i) => ({ w, i }));
	const slots: WebsiteResult[] = new Array(websites.length);
	const worker = async () => {
		for (let job = queue.shift(); job; job = queue.shift()) slots[job.i] = await sendWebsite(job.w);
	};
	try {
		await Promise.all(Array.from({ length: Math.min(SEND_POOL, websites.length) }, worker));
	} finally {
		run.stop();
	}
	websiteResults.push(...slots);

	// hitung counter per sistem seluruh website
	const counters = { success: 0, failed: 0, blocked: 0, already: 0, skipped: 0 };
	for (const wr of websiteResults) {
		for (const k of SYSTEMS) {
			const st = String(wr[k]?.status ?? "SKIP").toUpperCase();
			if (st === "BERHASIL") counters.success++;
			else if (st === "GAGAL") counters.failed++;
			else if (st === "DIBLOKIR") counters.blocked++;
			else if (st === "SUDAH DIKIRIM") counters.already++;
			else counters.skipped++;
		}
	}

	const detail = websiteResults
		.map((wr) => {
			const line = (label: string, item: SysResult) => {
				const reason = String(item.reason ?? "").trim();
				const short = reason.length > 70 ? reason.slice(0, 67) + "..." : reason;
				return `${label}: ${String(item.status ?? "SKIP").toUpperCase()}${short ? " — " + short : ""}`;
			};
			return `[${wr.website}]\n${line("Telegram", wr.telegram)}\n${line("LinkTree", wr.linktree)}\n${line("Panel-Z", wr.panelz)}`;
		})
		.join("\n\n") + (registryWarnings.length ? "\n\n⚠ " + registryWarnings.join("\n⚠ ") : "");

	const allDuplicate = counters.success === 0 && counters.failed === 0 && counters.already > 0;
	const logStatus =
		counters.failed > 0 && counters.success === 0
			? "GAGAL"
			: counters.failed > 0
				? "SEBAGIAN"
				: counters.success > 0
					? "BERHASIL"
					: allDuplicate
						? "DIBLOKIR"
						: "INFO";

	await logActivity(
		env,
		profile.username,
		allDuplicate
			? "DUPLIKAT WEBSITE DIBLOKIR"
			: opts.isPrediksiAuto
				? "KIRIM PREDIKSI OTOMATIS"
				: "FAST AUTO SEND",
		detail,
		logStatus,
		textToSend,
	);

	// Auto Prediksi (input Nomor Keluar + Hitung di admin website). Hanya dari
	// KIRIM SEMUA SISTEM -- bukan retry satu sistem / prediksi. Kegagalan di sini
	// TIDAK boleh merusak hasil kirim yang sudah jadi, jadi dibungkus try/catch.
	let autoInput: Awaited<ReturnType<typeof autoInputAfterSend>>;
	if (!opts.forceDuplicate && !opts.isPrediksiAuto && !opts.skipAutoInput) {
		try {
			autoInput = await autoInputAfterSend(env, profile, rawText, processed, websites);
		} catch (e) {
			autoInput = {
				results: [{ website: "-", status: "GAGAL", detail: "Auto Prediksi error: " + (e instanceof Error ? e.message : String(e)), manual: true }],
			};
		}
	}

	return {
		autoInput,
		success: counters.failed === 0 && counters.success > 0,
		partial: counters.success > 0 && counters.failed > 0,
		allAlready: allDuplicate,
		blocked: counters.success === 0 && counters.failed === 0,
		message: allDuplicate
			? "Semua website yang diizinkan sudah pernah menerima data ini."
			: registryWarnings.length
				? "Proses selesai, TETAPI: " + registryWarnings.join("; ")
				: "Proses selesai.",
		websiteResults,
		counters,
		content: textToSend,
		market: processed.market || "-",
	};
}

/** autoInputDone = browser sudah menjalankan input angka -> Hitung -> baca Total (autoInputBeforeSend) SEBELUM kirim.
 *  Browser lama (tanpa penanda) tetap memakai urutan lama: kirim dulu, Auto Prediksi sesudahnya. */
/** systems (opsional) = bagian sistem yang dikirim di panggilan ini. KIRIM SEMUA (25 Okt 2026): Panel-Z DULU -> Auto Prediksi
 *  -> Telegram & LinkTree. Data produksi: dengan Panel-Z sesudah Auto Prediksi, halaman Nomor Keluar admin tidak memberi form
 *  (0 berhasil / 16 gagal), sedangkan urutan lama (Panel-Z sebelum admin dibuka) 173-201 berhasil per hari. */
export async function smartAutoSendFast(env: Env, token: string, rawText: string, autoInputDone = false, systems?: unknown) {
	const session = await requireSession(env, token, { menu: "result" });
	const pick = Array.isArray(systems) ? SYSTEMS.filter((k) => systems.map((x) => String(x).toLowerCase()).includes(k)) : [];
	return runSend(env, session, rawText, { targets: pick.length ? pick : SYSTEMS, forceDuplicate: false, skipAutoInput: autoInputDone });
}

/**
 * KIRIM SEMUA tahap 1 (perintah pemilik 24 Okt 2026: "input angka, hitung, catat angka prediksi dulu baru send ke tele,
 * linktree, sosmed"). Membuat job Auto Prediksi untuk SEMUA website akun -- sama persis dengan yang dulu dibuat sesudah kirim --
 * lalu browser menjalankannya (autoInputRun / autoInputTotalsCheck) dan baru memanggil smartAutoSendFast(..., true).
 * Galat apa pun di sini tidak boleh menghalangi kiriman: dilaporkan sebagai hasil GAGAL, browser tetap mengirim.
 */
export async function autoInputBeforeSend(env: Env, token: string, rawText: string) {
	const session = await requireSession(env, token, { menu: "result" });
	const profile = session.profile;
	const waitSec = await getSys(env, "sys_send_wait_auto_sec");
	if (!profile.websites.length) return { success: true, autoInput: undefined, waitSec };
	try {
		return { success: true, autoInput: await autoInputAfterSend(env, profile, rawText, processText(rawText), profile.websites), waitSec };
	} catch (e) {
		return {
			success: true,
			waitSec,
			autoInput: { results: [{ website: "-", status: "GAGAL" as const, detail: "Auto Prediksi error: " + (e instanceof Error ? e.message : String(e)), manual: true }] },
		};
	}
}

export async function retryFailedSystem(
	env: Env,
	token: string,
	rawText: string,
	systemName: string,
	websiteName?: string,
) {
	const session = await requireSession(env, token, { menu: "result" });
	return runSend(env, session, rawText, {
		targets: [String(systemName ?? "").toLowerCase()],
		forceDuplicate: true,
		onlyWebsites: websiteName ? [websiteName] : undefined,
	});
}

export async function sendToPanelZOnly(env: Env, token: string, market: string, angka: string) {
	const session = await requireSession(env, token, { menu: "result" });
	const profile = session.profile;
	// Izin Panel-Z pada data Users juga berlaku di sini (runSend sudah memeriksanya; jalur manual ini dulu terlewat).
	if (!profile.permissions.panelz) return { success: false, message: "Akun ini tidak diizinkan memakai Panel-Z (atur di Admin → Users)." };
	// Hasil SETIAP website dikumpulkan -- dulu cuma hasil website terakhir yang
	// disimpan, jadi kegagalan di website sebelumnya tertutup "Berhasil".
	// Website dikirimi PARALEL dengan tenggat keras yang sama seperti Kirim Semua (dulu bergiliran: login + baca + kirim per
	// website x 25 dtk bila Panel-Z lambat -> bisa melewati batas tunggu panel dan operator tidak melihat hasil apa pun).
	const targets: { website: string; acc: NonNullable<Awaited<ReturnType<typeof getSiteAccount>>> }[] = [];
	for (const website of profile.websites) {
		const acc = await getSiteAccount(env, website);
		// Website tanpa Panel-Z memang tidak dikirimi -- bukan kegagalan.
		if (acc && acc.panelz.url && acc.panelz.user) targets.push({ website, acc });
	}
	const run = startSendDeadline();
	const results: { website: string; msg: string }[] = new Array(targets.length);
	const queue = targets.map((t, i) => ({ ...t, i }));
	const worker = async () => {
		for (let job = queue.shift(); job; job = queue.shift()) {
			if (run.signal.aborted) {
				results[job.i] = { website: job.website, msg: TIME_UP_NOT_SENT };
				continue;
			}
			const msg = await sendCustomPanelZ(market, angka, job.acc.panelz, run.signal);
			results[job.i] = {
				website: job.website,
				msg: run.signal.aborted && !msg.includes("Berhasil") && NET_FAIL_RE.test(msg)
					? "Panel-Z belum menjawab saat batas waktu kirim habis — mungkin tetap terkirim; cek dulu sebelum kirim ulang."
					: msg,
			};
		}
	};
	try {
		await Promise.all(Array.from({ length: Math.min(SEND_POOL, targets.length) }, worker));
	} finally {
		run.stop();
	}
	const success = results.length > 0 && results.every((r) => r.msg.includes("Berhasil"));
	const last = !results.length
		? "Panel-Z belum dikonfigurasi untuk website akun ini"
		: results.length === 1
			? results[0].msg
			: results.map((r) => `${r.website}: ${r.msg}`).join(" | ");
	await logActivity(
		env,
		profile.username,
		"SEND PANEL-Z",
		`Pasaran: ${market} | Hasil: ${last}`,
		success ? "BERHASIL" : "GAGAL",
		`Angka yang dikirim: ${angka}`,
	);
	return { success, message: last };
}
