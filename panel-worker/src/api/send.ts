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

type SystemKey = "telegram" | "linktree" | "panelz";
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

	for (const website of websites) {
		const previous = await getRegistryEntry(env, website, hash);
		const acc = await getSiteAccount(env, website);
		const wr: WebsiteResult = {
			website,
			telegram: { status: "SKIP", reason: "Tidak diproses" },
			linktree: { status: "SKIP", reason: "Tidak diproses" },
			panelz: { status: "SKIP", reason: "Tidak diproses" },
		};

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
			let r: string;
			try {
				if (k === "telegram") {
					const cfg = opts.isPrediksiAuto ? acc.telegramPred : acc.telegram;
					r = await sendTelegram(textToSend, cfg);
				} else if (k === "linktree") {
					r = await sendLinktree(acc.linktree, processed);
				} else {
					r = await sendPanelZ(textToSend, acc.panelz);
				}
			} catch (e) {
				r = "Error: " + (e instanceof Error ? e.message : String(e));
			}
			wr[k] = normalizeSendResult(r);
		}

		const merged = {
			telegram: !!(previous && previous.telegram) || wr.telegram.status === "BERHASIL",
			linktree: !!(previous && previous.linktree) || wr.linktree.status === "BERHASIL",
			panelz: !!(previous && previous.panelz) || wr.panelz.status === "BERHASIL",
		};
		if (merged.telegram || merged.linktree || merged.panelz) {
			await upsertRegistry(env, hash, website, profile.username, processed.market, merged, textToSend);
		}
		websiteResults.push(wr);
	}

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
		.join("\n\n");

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

	return {
		success: counters.failed === 0 && counters.success > 0,
		partial: counters.success > 0 && counters.failed > 0,
		allAlready: allDuplicate,
		blocked: counters.success === 0 && counters.failed === 0,
		message: allDuplicate
			? "Semua website yang diizinkan sudah pernah menerima data ini."
			: "Proses selesai.",
		websiteResults,
		counters,
		content: textToSend,
		market: processed.market || "-",
	};
}

export async function smartAutoSendFast(env: Env, token: string, rawText: string) {
	const session = await requireSession(env, token, { menu: "result" });
	return runSend(env, session, rawText, { targets: SYSTEMS, forceDuplicate: false });
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
	// Hasil SETIAP website dikumpulkan -- dulu cuma hasil website terakhir yang
	// disimpan, jadi kegagalan di website sebelumnya tertutup "Berhasil".
	const results: { website: string; msg: string }[] = [];
	for (const website of profile.websites) {
		const acc = await getSiteAccount(env, website);
		// Website tanpa Panel-Z memang tidak dikirimi -- bukan kegagalan.
		if (!acc || !acc.panelz.url || !acc.panelz.user) continue;
		results.push({ website, msg: await sendCustomPanelZ(market, angka, acc.panelz) });
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
