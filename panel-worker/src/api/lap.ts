// Menu "Laporan Harian" â€” endpoint Worker.
// Fase A: kredensial (Setting) + Lap Motion + Lap Mozart (API JSON, jalan langsung
// di Worker). Lap Admin (scraper berat) menyusul lewat GitHub Actions.
import { requireSession } from "./auth";
import { logActivity } from "../lib/activity";
import { tsNow } from "../lib/time";
import { getTurso } from "../lib/turso"; // tabel lap_* ada di Turso, bukan D1
import {
	LapCreds,
	extractPureUsername,
	lapLoadCreds,
	lapLoadResults,
	lapLoadResultsModules,
	lapSaveCreds,
	lapSaveResults,
	num,
} from "../lib/lap";

const MOZART_PAGE_CAP = 18; // per list (depo/wd)

function credsForClient(c: LapCreds) {
	return {
		linkAdmin: c.linkAdmin,
		cookiesAdmin: c.cookieAdmin,
		linkMotion: c.linkMotion,
		tokenMotion: c.tokenMotion,
		vendorIdMotion: c.vendorIdMotion,
		linkMozart: c.linkMozart,
		tokenMozart: c.cookieMozart,
		mozartAccounts: c.mozartAccounts,
	};
}

export async function lapGetConfig(env: Env, token: string) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	// Konfigurasi dipisah dari hasil. Snapshot laporan bisa besar; jangan ikut
	// ditarik setiap kali operator membuka/pindah menu.
	const creds = await lapLoadCreds(env, s.username);
	return { success: true, config: credsForClient(creds) };
}

export async function lapGetResults(env: Env, token: string, modules: unknown) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	const wanted = Array.isArray(modules) ? modules.map(String) : [];
	return { success: true, results: await lapLoadResultsModules(env, s.username, wanted) };
}

export async function lapSaveConfig(env: Env, token: string, data: Record<string, unknown>) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	const c = await lapSaveCreds(env, s.username, {
		linkAdmin: str(data.linkAdmin),
		cookieAdmin: str(data.cookiesAdmin ?? data.cookieAdmin),
		linkMotion: str(data.linkMotion),
		tokenMotion: str(data.tokenMotion),
		vendorIdMotion: str(data.vendorIdMotion),
		linkMozart: str(data.linkMozart),
		cookieMozart: str(data.tokenMozart ?? data.cookieMozart),
		mozartAccounts: str(data.mozartAccounts),
	});
	await logActivity(env, s.username, "LAP SIMPAN SETTING", "Kredensial Laporan Harian diperbarui", "BERHASIL", "");
	return { success: true, message: "Konfigurasi Laporan Harian tersimpan.", config: credsForClient(c) };
}
const str = (v: unknown) => (v === undefined ? undefined : String(v ?? "").trim());

// =========================================================================
// LAP MOTION -- impor dari browser (skrip Console, sama pola dengan Mozart)
// motionv2.com KADANG menantang/menolak trafik IP datacenter Worker (WAF
// adaptif -- kadang lolos, kadang balas kosong/di-challenge tanpa pesan error
// jelas, gejalanya "DP 0 WD 0 padahal ada data"). Server-side fetch langsung
// (lapRunMotion, versi lama) DIHAPUS -- pemilik minta ganti total ke pola
// Mozart: skrip di-generate, di-paste di Console tab Motion (browser asli,
// bukan IP datacenter), fetch same-origin (page-by-page sampai habis, TANPA
// batas subrequest Worker), lalu POST hasil mentah ke sini untuk diproses &
// disimpan. Ini juga otomatis menghilangkan masalah "data terpotong" pada
// periode besar (dulu dibatasi MOTION_FETCH_BUDGET=44 subrequest/invocation).
// =========================================================================
export async function lapMotionImport(
	env: Env,
	token: string,
	startDate: string,
	endDate: string,
	depoPaidRows: unknown,
	depoCreateRows: unknown,
	wdRows: unknown,
) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	const listPaid = (Array.isArray(depoPaidRows) ? depoPaidRows : []) as Rec[];
	const listCreate = (Array.isArray(depoCreateRows) ? depoCreateRows : []) as Rec[];
	const listWd = (Array.isArray(wdRows) ? wdRows : []) as Rec[];

	// ---- proses (port persis logika lama, minus jalur data_optional API yang
	// cuma tersedia lewat fetch server-side -- di sini semua total dihitung
	// manual dari baris yang dikirim skrip, sama seperti fallback lama) ----
	const motionDpPga: Rec[] = [];
	const pgaPendingError: Rec[] = [];
	const motionWdPga: Rec[] = [];

	// Rekonsiliasi CREATE vs PAID harus berdasarkan keberadaan REF di dataset
	// pasangannya, lalu status tanggal dibandingkan HANYA untuk transaksi yang
	// memang match. Baris "PGA PENDING / ERROR" tidak boleh diisi dengan semua
	// row yang kebetulan ada di luar rentang tanggal atau dengan status SUCCESS.
	const normRef = (item: Rec) => String(item.reference_no || item.invoice_no || "").trim();
	const createByRef = new Map<string, Rec[]>();
	for (const it of listCreate) {
		const k = normRef(it);
		if (!k) continue;
		const arr = createByRef.get(k) || [];
		arr.push(it);
		createByRef.set(k, arr);
	}

	const paidByRef = new Map<string, Rec[]>();
	for (const it of listPaid) {
		const k = normRef(it);
		if (!k) continue;
		const arr = paidByRef.get(k) || [];
		arr.push(it);
		paidByRef.set(k, arr);
	}

	let totalNominalPaidAt = 0;
	let totalTransaksiPaid = 0;
	let totalTransaksiCreate = 0;
	let totalNominalCreatedAt = 0;

	for (const item of listPaid) {
		const key = normRef(item);
		const createdAt = String(item.created_at || "");
		const paidAt = String(item.paid_at || "");
		const amount = num(item.amount || item.net_amount || 0);
		const fee = num(item.fee_total_with_service_fee || item.surcharge || 0);
		const statusDesc = String(item.paid_status_description || item.paid_status_desc || "SUCCESS").toUpperCase();
		const isSuccess = item.paid_status === 1 || statusDesc === "SUCCESS" || statusDesc === "PAID";
		const paidDay = paidAt.split(" ")[0] || "";
		const row: Rec = {
			createdAt,
			paidAt: paidAt || "-",
			refNo: item.reference_no || item.invoice_no || "-",
			game: item.game_name || "-",
			user: extractPureUsername(item),
			vendor: item.pga || "-",
			amount,
			fee,
			status: statusDesc,
		};

		// Hanya transaksi PAID sukses yang paid_at masuk periode laporan yang
		// masuk ke DP PGA.
		const paidInRange = isSuccess && paidDay >= startDate && paidDay <= endDate;
		if (!paidInRange) continue;

		motionDpPga.push(row);
		totalNominalPaidAt += amount;
		totalTransaksiPaid++;

		// Ada di PAID tapi ref tidak ditemukan di CREATE => pending/error.
		// Kalau ketemu di CREATE, baru tanggal CREATE dibandingkan dengan PAID.
		const creates = key ? (createByRef.get(key) || []) : [];
		if (!creates.length) {
			pgaPendingError.push({ ...row, status: "TIDAK ADA DI CREATE" });
			continue;
		}

		const sameDateCreate = creates.some(c => String(c.created_at || "").split(" ")[0] === paidDay);
		if (!sameDateCreate) {
			const dates = [...new Set(creates.map(c => String(c.created_at || "").split(" ")[0]).filter(Boolean))];
			const createDay = dates[0] || "-";
			pgaPendingError.push({ ...row, status: `BEDA TGL (CREATE: ${createDay})` });
		}
	}

	// CREATE di periode laporan yang tidak punya pasangan PAID masuk PENDING/ERROR.
	for (const item of listCreate) {
		const key = normRef(item);
		const createdDay = String(item.created_at || "").split(" ")[0] || "";
		if (createdDay < startDate || createdDay > endDate) continue;

		totalTransaksiCreate++;
		totalNominalCreatedAt += num(item.amount || item.net_amount || 0);

		const paid = key ? (paidByRef.get(key) || []) : [];
		const hasPaid = paid.some(p => {
			const statusDesc = String(p.paid_status_description || p.paid_status_desc || "").toUpperCase();
			const isSuccess = p.paid_status === 1 || statusDesc === "SUCCESS" || statusDesc === "PAID";
			return isSuccess && String(p.paid_at || "").trim() !== "";
		});
		if (!hasPaid) {
			pgaPendingError.push({
				createdAt: item.created_at || "",
				paidAt: "-",
				refNo: item.reference_no || item.invoice_no || "-",
				game: item.game_name || "-",
				user: extractPureUsername(item),
				vendor: item.pga || "-",
				amount: num(item.amount || item.net_amount || 0),
				fee: num(item.fee_total_with_service_fee || item.surcharge || 0),
				status: "TIDAK ADA DI PAID",
			});
		}
	}

	let totalWdAmount = 0;
	for (const item of listWd) {
		const cust = item.customer as Rec | undefined;
		const amount = num(item.amount || 0);
		totalWdAmount += amount;
		motionWdPga.push({
			createdAt: item.created_at || "",
			payoutAt: item.payout_at || item.paid_at || "-",
			refNo: item.reference_no || item.unique_id || "-",
			game: item.game_name || "-",
			user: extractPureUsername(item),
			bank: cust?.bank_name || "-",
			accountNumber: cust?.bank_account_number || "-",
			vendor: item.pga || "-",
			amount,
			fee: num(item.fee_total_with_service_fee || item.fee || 0),
			status: String(item.payout_status_description || item.payout_description || "SUCCESS").toUpperCase(),
			adminName: item.admin_name || "-",
		});
	}

	// Endpoint deposit motionv2.com cuma mau nyaut kalau skrip dijalankan dari
	// halaman RIWAYAT PGA, sementara endpoint withdraw cuma nyaut dari halaman
	// WD REQUEST -- ketahuan dari testing: deposit TIMEOUT total (semua strategi
	// auth) dari halaman WD Request, padahal withdraw sukses 200 OK persis di
	// halaman yang sama pakai token+cookie yang sama. Jadi deposit & withdraw
	// diimpor lewat 2 skrip Console TERPISAH (masing-masing dijalankan di
	// halamannya sendiri) -- lihat lapMotionConsoleScriptDeposit/Withdraw di
	// Scripts.html. Satu panggilan ke sini bisa cuma bawa salah satu (yang lain
	// dikosongkan -- BUKAN array kosong, tapi field tidak dikirim sama sekali
	// dari skrip, jadi `Array.isArray` di atas balas false = "tidak diimpor kali
	// ini", BUKAN "datanya kosong"). lapSaveResults meng-UPSERT PER MODUL (baris
	// terpisah di tabel lap_result), jadi modul yang tidak disertakan di sini
	// otomatis tidak tersentuh/tidak ketimpa kosong.
	const hasDepo = Array.isArray(depoPaidRows) || Array.isArray(depoCreateRows);
	const hasWd = Array.isArray(wdRows);
	const prevMeta = (((await lapLoadResults(env, s.username))._motionMeta as Rec[] | undefined)?.[0]?.summary as Rec | undefined) || {};
	const summary = {
		totalTransaksiPaid: hasDepo ? totalTransaksiPaid : Number(prevMeta.totalTransaksiPaid || 0),
		totalNominalPaidAt: hasDepo ? totalNominalPaidAt : Number(prevMeta.totalNominalPaidAt || 0),
		totalTransaksiCreate: hasDepo ? totalTransaksiCreate : Number(prevMeta.totalTransaksiCreate || 0),
		totalNominalCreatedAt: hasDepo ? totalNominalCreatedAt : Number(prevMeta.totalNominalCreatedAt || 0),
		totalPendingErrorCount: hasDepo ? pgaPendingError.length : Number(prevMeta.totalPendingErrorCount || 0),
		totalWdRecords: hasWd ? motionWdPga.length : Number(prevMeta.totalWdRecords || 0),
		totalWdAmount: hasWd ? totalWdAmount : Number(prevMeta.totalWdAmount || 0),
	};
	const toSave: Record<string, unknown[]> = { _motionMeta: [{ summary, source: "browser", at: startDate + "|" + endDate }] };
	if (hasDepo) {
		toSave.motionDpPga = motionDpPga;
		toSave.motionPendingError = pgaPendingError;
	}
	if (hasWd) toSave.motionWd = motionWdPga;
	await lapSaveResults(env, s.username, toSave);
	await logActivity(
		env,
		s.username,
		"LAP MOTION",
		`Impor browser ${startDate}..${endDate} — ` +
			(hasDepo ? `DP ${motionDpPga.length}, pending ${pgaPendingError.length}` : "(depo dilewati)") +
			", " +
			(hasWd ? `WD ${motionWdPga.length}` : "(wd dilewati)"),
		"BERHASIL",
		"",
	);
	return { success: true, summary, dp: motionDpPga.length, pending: pgaPendingError.length, wd: motionWdPga.length, hasDepo, hasWd };
}

// =========================================================================
// LAP MOZART — via Apps Script.
// Cloudflare Mozart (limatogel.makintajir.com) memblokir SEMUA IP datacenter
// (Cloudflare Workers + GitHub Actions/Azure). IP Google Apps Script lolos,
// jadi scrape Mozart dijalankan di Apps Script kecil (daygroup-mozart), panel
// cukup memanggilnya sinkron.
// =========================================================================
export async function lapRunMozart(
	env: Env,
	token: string,
	startDate: string,
	endDate: string,
	_opts: { depo?: boolean; wd?: boolean; panelId?: number } = {},
) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	const c = await lapLoadCreds(env, s.username);
	if (!c.cookieMozart) return { success: false, message: "Cookie Mozart belum diisi di menu Setting!" };
	if (!env.MOZART_GAS_URL || !env.MOZART_GAS_KEY) {
		return { success: false, message: "Endpoint Mozart (Apps Script) belum dikonfigurasi. Hubungi admin." };
	}

	let j: {
		success?: boolean;
		message?: string;
		depositData?: Rec[];
		withdrawData?: Rec[];
		summary?: Rec;
	};
	try {
		const r = await fetch(env.MOZART_GAS_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				key: env.MOZART_GAS_KEY,
				cookie: c.cookieMozart,
				base: c.linkMozart || "https://limatogel.makintajir.com",
				startDate,
				endDate,
			}),
		});
		const text = await r.text();
		j = JSON.parse(text);
	} catch (e) {
		return { success: false, message: "Gagal menghubungi Apps Script Mozart: " + (e instanceof Error ? e.message : String(e)) };
	}
	if (!j.success) return { success: false, message: j.message || "Apps Script Mozart gagal." };

	const depositData = j.depositData ?? [];
	const withdrawData = j.withdrawData ?? [];
	const summary = j.summary ?? {};
	await lapSaveResults(env, s.username, {
		mozartDepo: depositData,
		mozartWd: withdrawData,
		_mozartMeta: [{ summary }],
	});
	await logActivity(
		env,
		s.username,
		"LAP MOZART",
		`${startDate}..${endDate} — DP ${depositData.length}, WD ${withdrawData.length}`,
		"BERHASIL",
		"",
	);
	return { success: true, depositData, withdrawData, summary };
}

// --- Impor Mozart dari browser user (bookmarklet) ------------------------
// Cloudflare Mozart blok SEMUA IP non-residensial (Worker/GitHub/Apps Script).
// Jalan terakhir: user jalankan bookmarklet di tab Mozart mereka -> fetch API
// same-origin (punya cf_clearance) -> kirim baris mentah ke sini.
// Ubah ISO UTC -> tanggal & jam WIB (GMT+7).
function wib(iso: unknown): { date: string; time: string } {
	const s = String(iso || "");
	const t = Date.parse(s);
	if (!s || Number.isNaN(t)) return { date: "-", time: "" };
	const d = new Date(t + 7 * 3600 * 1000);
	const p = (n: number) => String(n).padStart(2, "0");
	return {
		date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
		time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
	};
}

// Peta baris mentah API Mozart -> baris yang dipakai panel.
// Field asli (dari _mozartRawSample):
//   deposit: date, amount(str), name, app(bank), account_number(rek bank situs),
//            username, status("done"/"pending"/...), done_by("BOT"/"USER"/"WDBOT")
//   withdraw: CreatedAt(ISO), amount(num), rekening_name, rekening, bank_name,
//            username, status("done"/"timeout"/...), approved_at, is_overridden
function mozMap(rows: Rec[], kind: "depo" | "wd"): Rec[] {
	return (Array.isArray(rows) ? rows : []).map((r) => {
		if (kind === "depo") {
			const st = String(r.status || "").toLowerCase().trim();
			const doneBy = String(r.done_by || "").toUpperCase().trim();
			const status =
				st === "done" ? (doneBy ? "DONE BY " + doneBy : "DONE") : st.toUpperCase().replace(/_/g, " ") || "-";
			const w = wib(r.CreatedAt);
			return {
				date: String(r.date || w.date || "-"),
				time: w.time,
				username: String(r.username || "-"),
				name: String(r.name || "-"),
				amount: num(r.amount),
				bank: String(r.app || r.bank_name || "-").toUpperCase(),
				accountNumber: String(r.account_number || "-"),
				status,
				statusRaw: st,
				doneBy,
				panelId: String(
				r._panelId != null && String(r._panelId) !== "0" ? r._panelId : r.panel_id ?? r._panelId ?? r.panel ?? "",
			),
			};
		}
		const st = String(r.status || "").toLowerCase().trim();
		const approved = st === "done" || !!r.approved_at;
		const overridden = !!r.is_overridden;
		const w = wib(r.CreatedAt);
		return {
			date: String(r.date || w.date || "-"),
			time: w.time,
			username: String(r.username || "-"),
			name: String(r.rekening_name || r.name || "-"),
			amount: num(r.amount),
			bank: String(r.bank_name || r.destination || "-").toUpperCase(),
			accountNumber: String(r.rekening || "-"),
			status: approved ? (overridden ? "OVERRIDE SELESAI" : "SELESAI") : st.toUpperCase().replace(/_/g, " ") || "-",
			statusRaw: st,
			approved,
			overridden,
			panelId: String(
				r._panelId != null && String(r._panelId) !== "0" ? r._panelId : r.panel_id ?? r._panelId ?? r.panel ?? "",
			),
		};
	});
}

// Dari daftar rekening Mozart (accountsRaw), bangun indeks: nilai identifier
// apa pun -> { name, bank }. Dipakai untuk melabeli transaksi dengan nama
// pemilik rekening (mis. "BCA PENI PEBRIANI").
function buildAccIndex(accountsRaw: unknown): Record<string, { name: string; bank: string }> {
	const idx: Record<string, { name: string; bank: string }> = {};
	const idKeys = [
		"account_number", "rekening", "number", "no_rek", "phone", "phone_number", "msisdn",
		"login", "username", "user", "id", "ID", "mbanking_id", "account_id", "assigned_to", "code",
	];
	const nameKeys = ["name", "account_name", "holder_name", "holder", "owner", "owner_name", "nama", "rekening_name", "label"];
	const bankKeys = ["bank_name", "bank", "app", "bank_code", "type"];
	const walk = (v: unknown) => {
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (!v || typeof v !== "object") return;
		const o = v as Rec;
		const name = String(nameKeys.map((k) => o[k]).find((x) => x != null && String(x).trim() !== "") || "").trim();
		const bank = String(bankKeys.map((k) => o[k]).find((x) => x != null && String(x).trim() !== "") || "").trim().toUpperCase();
		if (name) {
			for (const k of idKeys) {
				const val = o[k];
				if (val != null && String(val).trim() !== "") idx[String(val).trim()] = { name, bank };
			}
		}
		// telusuri nested
		for (const k of Object.keys(o)) {
			const c = o[k];
			if (c && typeof c === "object") walk(c);
		}
	};
	walk(accountsRaw);
	return idx;
}

// Dari daftar panel Mozart (panelsRaw) -> { panel_id: "NAMA PANEL" }.
function buildPanelIndex(panelsRaw: unknown): Record<string, string> {
	const idx: Record<string, string> = {};
	const idKeys = ["id", "ID", "panel_id", "panelId"];
	const nameKeys = ["name", "panel_name", "panelName", "label", "title", "domain", "nama"];
	const walk = (v: unknown) => {
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (!v || typeof v !== "object") return;
		const o = v as Rec;
		const id = idKeys.map((k) => o[k]).find((x) => x != null && String(x).trim() !== "");
		const name = String(nameKeys.map((k) => o[k]).find((x) => x != null && String(x).trim() !== "") || "").trim();
		if (id != null && name) idx[String(id).trim()] = name.toUpperCase();
		for (const k of Object.keys(o)) {
			const c = o[k];
			if (c && typeof c === "object") walk(c);
		}
	};
	walk(panelsRaw);
	return idx;
}

export async function lapMozartImport(
	env: Env,
	token: string,
	startDate: string,
	endDate: string,
	depositRows: unknown,
	withdrawRows: unknown,
	accountsRaw?: unknown,
	panelsRaw?: unknown,
) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	const dRaw = Array.isArray(depositRows) ? (depositRows as Rec[]) : [];
	const wRaw = Array.isArray(withdrawRows) ? (withdrawRows as Rec[]) : [];
	const accIdx = buildAccIndex(accountsRaw);
	const panelIdx = buildPanelIndex(panelsRaw);
	// Pemetaan manual dari Setting ("<id> = <Nama>") menimpa hasil auto.
	const creds = await lapLoadCreds(env, s.username);
	for (const line of String(creds.mozartAccounts || "").split(/\r?\n/)) {
		const m = line.match(/^\s*([^=]+?)\s*=\s*(.+?)\s*$/);
		if (!m) continue;
		// baris "panel:<id> = NAMA" -> peta panel; selain itu peta rekening
		const pm = m[1].trim().match(/^panel\s*[:=]?\s*(.+)$/i);
		if (pm) panelIdx[pm[1].trim()] = m[2].trim().toUpperCase();
		else accIdx[m[1].trim()] = { name: m[2].trim(), bank: "" };
	}
	const panelName = (id: unknown) => {
		const k = String(id ?? "").trim();
		return k ? panelIdx[k] || "PANEL " + k : "-";
	};
	const accLabel = (...cands: unknown[]): { name: string; bank: string } => {
		for (const c of cands) {
			const key = c == null ? "" : String(c).trim();
			if (key && accIdx[key]) return accIdx[key];
		}
		return { name: "", bank: "" };
	};
	const depositData = mozMap(dRaw, "depo").map((r, i) => {
		const acctNo = String((dRaw[i] || {}).account_number || "");
		const a = accLabel(acctNo);
		return {
			...r,
			accName: a.name || `${r.bank} ${r.accountNumber}`.trim(),
			accKey: acctNo || r.accountNumber,
			panel: panelName(r.panelId),
		};
	});
	const withdrawData = mozMap(wRaw, "wd").map((r, i) => {
		const raw = (wRaw[i] || {}) as Rec;
		const a = accLabel(raw.assigned_to, raw.bank_source, raw.account_number);
		const fallback = String(raw.assigned_to || raw.bank_source || "-").toUpperCase();
		return {
			...r,
			accName: a.name || fallback,
			accKey: String(raw.assigned_to || raw.bank_source || "-"),
			panel: panelName(r.panelId),
		};
	});
	const sum = (a: Rec[]) => a.reduce((n, x) => n + (num(x.amount) || 0), 0);
	const summary = {
		totalDepoRecords: depositData.length,
		totalDepoAmount: sum(depositData),
		totalWdRecords: withdrawData.length,
		totalWdAmount: sum(withdrawData),
		netAmount: sum(depositData) - sum(withdrawData),
	};
	await lapSaveResults(env, s.username, {
		mozartDepo: depositData,
		mozartWd: withdrawData,
		_mozartMeta: [{ summary, source: "browser", at: `${startDate}|${endDate}`, accounts: Object.keys(accIdx).length, panels: panelIdx }],
		_mozartRawSample: [{ depo: dRaw.slice(0, 3), wd: wRaw.slice(0, 3), accountsRaw: (accountsRaw ?? []) as unknown, panelsRaw: (panelsRaw ?? []) as unknown, accIdx, panelIdx }],
	});
	await logActivity(
		env,
		s.username,
		"LAP MOZART",
		`Impor browser ${startDate}..${endDate} — DP ${depositData.length}, WD ${withdrawData.length}`,
		"BERHASIL",
		"",
	);
	return { success: true, summary, deposit: depositData.length, withdraw: withdrawData.length };
}

// =========================================================================
// LAP ADMIN â€” via GitHub Actions (scraper berat)
// =========================================================================
const GH_API = "https://api.github.com";

function queueKeyFor(kind: "admin" | "mozart", sourceUrl: string): string {
	const raw = String(sourceUrl || "").trim();
	const m = raw.match(/^https?:\/\/([^/\s?#]+)/i);
	const host = (m ? m[1] : raw).toLowerCase();
	return (kind + "-" + host).replace(/[^a-z0-9_.-]+/g, "-").slice(0, 120) || kind;
}

async function dispatchScrapeJob(
	env: Env,
	username: string,
	kind: "admin" | "mozart",
	startDate: string,
	endDate: string,
	sourceUrl: string,
) {
	if (!env.GH_TOKEN || !env.GH_REPO) {
		return { success: false as const, message: "GitHub Actions belum dikonfigurasi (GH_TOKEN/GH_REPO). Hubungi admin." };
	}
	const running = await getTurso(env).prepare(
		`SELECT id FROM lap_job WHERE username = ? AND kind = ? AND status IN ('pending','running')
		 AND created_at > datetime('now','+7 hours','-30 minutes') LIMIT 1`,
	)
		.bind(username, kind)
		.first<{ id: string }>();
	if (running) return { success: true as const, jobId: running.id, message: "Proses sebelumnya masih berjalan.", reused: true };

	const jobId = crypto.randomUUID().replace(/-/g, "");
	const key = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
	const params = JSON.stringify({ kind, startDate, endDate, key });
	await getTurso(env).prepare(
		`INSERT INTO lap_job (id, username, kind, status, params, message, created_at, updated_at)
		 VALUES (?, ?, ?, 'pending', ?, 'Menunggu GitHub Actions...', ?, ?)`,
	)
		.bind(jobId, username, kind, params, tsNow(), tsNow())
		.run();

	const callback = env.PUBLIC_URL || "https://panel-worker.projectbykd.workers.dev";
	const resp = await fetch(`${GH_API}/repos/${env.GH_REPO}/actions/workflows/scrape.yml/dispatches`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.GH_TOKEN}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "daygroup-panel",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		body: JSON.stringify({
			ref: "main",
			inputs: {
				job_id: jobId,
				callback,
				key,
				kind,
				queue_key: queueKeyFor(kind, sourceUrl),
			},
		}),
	});
	if (resp.status !== 204) {
		const body = await resp.text();
		let hint = "";
		if (resp.status === 404) hint = " â€” workflow scrape.yml belum ada. Push repo daygroup-scraper dulu.";
		else if (resp.status === 403) hint = " â€” token GitHub kurang izin (butuh Actions: Read and write) atau belum akses repo daygroup-scraper.";
		else if (resp.status === 422) hint = " â€” branch 'main' belum ada di repo (repo masih kosong).";
		let detail = "";
		try {
			detail = " [" + (JSON.parse(body).message || "") + "]";
		} catch {
			/* ignore */
		}
		await getTurso(env).prepare(`UPDATE lap_job SET status='error', message=?, updated_at=? WHERE id=?`)
			.bind("GitHub " + resp.status + detail, tsNow(), jobId)
			.run();
		return { success: false as const, message: "Gagal memicu GitHub Actions (" + resp.status + ")" + detail + hint };
	}
	return { success: true as const, jobId, message: "Dijalankan di GitHub Actions â€” ~1-3 menit." };
}

export async function lapRunAdmin(env: Env, token: string, startDate: string, endDate: string) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	const c = await lapLoadCreds(env, s.username);
	if (!c.linkAdmin || !c.cookieAdmin) return { success: false, message: "Link & Cookie Admin belum diisi di menu Setting!" };
	const r = await dispatchScrapeJob(env, s.username, "admin", startDate, endDate, c.linkAdmin);
	if (r.success && !("reused" in r)) {
		await logActivity(env, s.username, "LAP ADMIN", `Scan ${startDate}..${endDate} dipicu`, "INFO", "");
	}
	return r;
}

export async function lapAdminStatus(env: Env, token: string, jobId: string) {
	const s = await requireSession(env, token, { ignoreMaintenance: true });
	const row = await getTurso(env).prepare(`SELECT * FROM lap_job WHERE id = ? AND username = ?`)
		.bind(jobId, s.username)
		.first<Record<string, string>>();
	if (!row) return { success: false, message: "Job tidak ditemukan." };
	const out: Record<string, unknown> = {
		success: true,
		status: row.status,
		message: row.message,
		updatedAt: row.updated_at,
	};
	if (row.status === "done") out.results = await lapLoadResults(env, s.username);
	return out;
}

/** Dipanggil oleh GitHub Actions (auth: job key, bukan sesi). */
export async function lapJobStart(env: Env, jobId: string, key: string) {
	const row = await getTurso(env).prepare(`SELECT username, status, params FROM lap_job WHERE id = ?`)
		.bind(jobId)
		.first<{ username: string; status: string; params: string }>();
	if (!row) return { success: false, message: "job tidak ada" };
	let p: { kind?: string; startDate?: string; endDate?: string; key?: string } = {};
	try {
		p = JSON.parse(row.params || "{}");
	} catch {
		/* ignore */
	}
	if (!p.key || p.key !== key) return { success: false, message: "key salah" };
	await getTurso(env).prepare(`UPDATE lap_job SET status='running', message='Scraping...', updated_at=? WHERE id=?`)
		.bind(tsNow(), jobId)
		.run();
	const c = await lapLoadCreds(env, row.username);
	const kind = p.kind || "admin";
	return {
		success: true,
		creds:
			kind === "mozart"
				? { linkMozart: c.linkMozart, cookieMozart: c.cookieMozart }
				: { linkAdmin: c.linkAdmin, cookieAdmin: c.cookieAdmin },
		params: { kind, startDate: p.startDate, endDate: p.endDate },
	};
}

/** Dipanggil oleh GitHub Actions setelah scrape selesai. */
export async function lapJobResult(
	env: Env,
	jobId: string,
	key: string,
	ok: boolean,
	data: Record<string, unknown[]>,
	errors: Record<string, string>,
) {
	const row = await getTurso(env).prepare(`SELECT username, params FROM lap_job WHERE id = ?`)
		.bind(jobId)
		.first<{ username: string; params: string }>();
	if (!row) return { success: false, message: "job tidak ada" };
	let p: { key?: string } = {};
	try {
		p = JSON.parse(row.params || "{}");
	} catch {
		/* ignore */
	}
	if (!p.key || p.key !== key) return { success: false, message: "key salah" };

	if (ok && data && typeof data === "object") {
		const save: Record<string, unknown[]> = {};
		for (const k of Object.keys(data)) if (Array.isArray(data[k])) save[k] = data[k];
		if (Object.keys(save).length) await lapSaveResults(env, row.username, save);
	}
	const errMsg = errors && Object.keys(errors).length ? " | error: " + Object.values(errors).join("; ") : "";
	await getTurso(env).prepare(`UPDATE lap_job SET status=?, message=?, updated_at=? WHERE id=?`)
		.bind(ok ? "done" : "error", (ok ? "Selesai." : "Gagal.") + errMsg, tsNow(), jobId)
		.run();
	await logActivity(
		env,
		row.username,
		"LAP ADMIN",
		"Hasil scan diterima" + errMsg,
		ok ? "BERHASIL" : "GAGAL",
		"",
	);
	return { success: true };
}

// -------------------------------------------------------------------------
type Rec = Record<string, unknown> & {
	success?: unknown;
	error?: unknown;
	msg?: unknown;
	message?: unknown;
	data?: unknown;
	data_optional?: unknown;
	total_records?: unknown;
	total_sum?: unknown;
	total_amount?: unknown;
};
function mozartFindRows(json: unknown): Rec[] {
	if (Array.isArray(json)) return json as Rec[];
	let best: Rec[] = [];
	for (const k of Object.keys((json as Rec) || {})) {
		const v = (json as Rec)[k];
		if (Array.isArray(v) && v.length >= best.length && (v.length === 0 || typeof v[0] === "object")) {
			best = v as Rec[];
		} else if (v && typeof v === "object" && !Array.isArray(v)) {
			const nested = mozartFindRows(v);
			if (nested.length > best.length) best = nested;
		}
	}
	return best;
}
function pick(obj: Rec, keys: string[], fallback: unknown): unknown {
	for (const k of keys) {
		const v = obj[k];
		if (v !== undefined && v !== null && String(v).trim() !== "") return v;
	}
	return fallback;
}
