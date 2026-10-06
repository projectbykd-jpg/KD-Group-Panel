// Mesin scan INVEST — port investPumpScans_ / investScanUser_ / investAggregateUser_.
// Dijalankan oleh Cron Trigger Worker (tiap menit). Tiap tick memproses semua user
// yang state-nya 'running' dengan anggaran waktu, menyimpan progres ke invest_state
// (kolom cursor), lalu tick berikutnya melanjutkan.
import { tsNow } from "./time";
import { logActivity } from "./activity";
import { getTurso } from "./turso";
import {
	INVEST_GAMES,
	INVEST_MAX_PAGES_PER_GAME,
	INVEST_PAGE_SIZE,
	INVEST_PASARAN,
	INVEST_PERIODE_LOOKBACK,
	InvestSessionExpired,
	InvestSiteDown,
	investFetch,
	investGetState,
	investLoadConfig,
	investRunningUsers,
	investSetState,
} from "./invest";

const OFFSET_MS = 7 * 60 * 60 * 1000;
// Anggaran pendek: pump sekarang dipanggil juga lewat ctx.waitUntil dari tiap
// polling investGetStatus (tiap ~4 dtk), yang punya batas wall-clock ~30 dtk.
// Scan maju sedikit-sedikit tapi terus-menerus selama halaman dibuka.
const USER_SLICE_MS = 22_000; // maks per user per tick
const PUMP_BUDGET_MS = 25_000; // total per tick
// Cloudflare membatasi 50 subrequest per invocation (plan Free) — fetch ke panel
// agen MAUPUN query Turso/D1 (investGetState/investSetState/flushRaw/dst) SAMA-SAMA
// terhitung. 42 kemarin nyaris pas 50 -> begitu 1 pasaran butuh banyak halaman
// (mis. SYDNEY), invocation KENA "Too many subrequests" -> exception platform yang
// TIDAK lewat try/catch kita -> tidak sempat cursor++/simpan state -> scan macet
// permanen di pasaran itu (bukan error yang kelihatan di UI). Turunkan jauh di bawah
// 50 supaya selalu ada sisa utk overhead Turso (~8-10 request/tick).
const FETCH_BUDGET_PER_TICK = 28;
const RAW_FLUSH_AT = 300;

const ROW_RE_SRC =
	">(?:2D|3D|4D)-(\\d+)</font></td>\\s*<td[^>]*><FONT[^>]*>(\\d{4}-\\d{2}-\\d{2}) \\d{2}:\\d{2}:\\d{2}</font></td>\\s*<td[^>]*><FONT[^>]*>([^<]*)</font></td>";

function dateKeyTZ(offsetDays = 0): string {
	return new Date(Date.now() + OFFSET_MS + offsetDays * 864e5).toISOString().slice(0, 10);
}

/**
 * Baca daftar pasaran dari <option> di dropdown "Pilih Pasar".
 *  - panel "ag":     <option value="p33190">ARIZONA</option>
 *  - panel "agwlXX": <option value="ARIZONA,p7023">ARIZONA</option>
 * Ambil kode pNNNN, buang opsi hidden / param teknis (pool- / param).
 */
function parsePasaranOptions(html: string): [string, string][] {
	const out: [string, string][] = [];
	const seen = new Set<string>();
	// Terima <option ...>Teks</option> ATAU <option ...>Teks (tanpa penutup).
	const re = /<option\b([^>]*)>([^<]*)/gi;
	let mm: RegExpExecArray | null;
	while ((mm = re.exec(html))) {
		const attrs = mm[1] || "";
		const label = (mm[2] || "").replace(/\s+/g, " ").trim();
		if (/display\s*:\s*none/i.test(attrs)) continue;
		const vm = attrs.match(/value=["']([^"']*)["']/i);
		const val = vm ? vm[1].trim() : "";
		if (!val || !label || /^pilih/i.test(label)) continue;
		if (/^pool-|^param|^\d+$/i.test(val)) continue;
		const cm = val.match(/(?:^|,)\s*(p\d+)\s*$/i);
		if (!cm || seen.has(cm[1])) continue;
		seen.add(cm[1]);
		out.push([cm[1], label]);
	}
	return out;
}
function parsePeriode(html: string): number | null {
	// Format panel "ag": <input name=periode value="2266">
	let m = html.match(/name=["']?periode["']?[^>]*value=["'](\d+)["']/i);
	// Format panel "agwlXX": judul "... Periode : 36 - ARIZONA"
	if (!m) m = html.match(/Periode\s*:\s*(\d+)\s*-/i);
	if (!m) m = html.match(/periode[^0-9<]{0,15}value\s*=\s*["'](\d+)["']/i);
	return m ? parseInt(m[1], 10) : null;
}
function parseTotals(html: string): Record<string, number> {
	const t: Record<string, number> = { "2D": 0, "3D": 0, "4D": 0 };
	for (const g of ["2D", "3D", "4D"]) {
		// Format panel "ag": value ="2D">&nbsp;:&nbsp;N
		let m = html.match(new RegExp('value ="' + g + '">&nbsp;:&nbsp;(\\d+)'));
		// Format panel "agwlXX": <...>2D</...> : N  (kotak berlabel)
		if (!m) m = html.match(new RegExp('(?:^|>)\\s*' + g + '\\s*<\\/[a-zA-Z]+>\\s*:?\\s*(?:<[^>]*>\\s*)?(\\d[\\d.,]*)', "i"));
		if (!m) m = html.match(new RegExp('\\b' + g + '\\b[^0-9:]{0,25}:\\s*(?:<[^>]*>\\s*)?(\\d[\\d.,]*)', "i"));
		if (m) t[g] = parseInt(m[1].replace(/[.,]/g, ""), 10) || 0;
	}
	return t;
}
function maxGame(t: Record<string, number>): string {
	let g = "2D";
	if (t["3D"] > t[g]) g = "3D";
	if (t["4D"] > t[g]) g = "4D";
	return g;
}
function framePath(per: number, game: string, start: number, size: number): string {
	return (
		"admin_invoice_frame.php?tombol=" + game + "&start=" + start + "&end=" + (start + size) +
		"&s_user=&s_nomor=&s_periode=" + per + "&pos2d=&dist=invoice"
	);
}
function firstDate(html: string): string | null {
	const m = new RegExp(ROW_RE_SRC, "g").exec(html);
	return m ? m[2] : null;
}
/** Hitung baris BARU (belum pernah dilihat) di 1 halaman, akumulasi ke seen/users. */
function eatRows(html: string, seen: Record<string, number>, users: Record<string, number>): number {
	const re = new RegExp(ROW_RE_SRC, "g");
	let mm: RegExpExecArray | null;
	let got = 0;
	while ((mm = re.exec(html)) !== null) {
		const id = mm[1];
		const user = (mm[3] || "").trim();
		if (seen[id]) continue;
		seen[id] = 1;
		users[user] = (users[user] || 0) + 1;
		got++;
	}
	return got;
}

interface RawRow {
	tanggal: string;
	bettor: string;
	pasaran: string;
	periode: string;
	game: string;
	line: number;
	limitVal: number;
}

async function flushRaw(env: Env, owner: string, buffer: RawRow[]): Promise<void> {
	if (!buffer.length) return;
	const rows = buffer.splice(0, buffer.length);
	const stmts = rows.map((r) =>
		getTurso(env).prepare(
			`INSERT OR IGNORE INTO invest_raw (owner, tanggal, bettor, pasaran, periode, game, line, limit_val)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(owner, r.tanggal, r.bettor, r.pasaran, r.periode, r.game, r.line, r.limitVal),
	);
	for (let i = 0; i < stmts.length; i += 50) await getTurso(env).batch(stmts.slice(i, i + 50));
}

// ---------------------------------------------------------------------------
// Scan 1 user dari cursor sampai selesai / deadline / sesi mati.
// ---------------------------------------------------------------------------
export async function investScanUser(env: Env, user: string, deadlineMs: number, maxFetches = FETCH_BUDGET_PER_TICK): Promise<void> {
	let st = await investGetState(env, user);
	if (st.state !== "running") return;

	const cfg = await investLoadConfig(env, user);
	// Tiap instalasi panel agen (ag / agwl12 / dst) punya ID pasaran (pNNNN)
	// SENDIRI. List hardcoded INVEST_PASARAN hanya cocok utk ag.suksesbogil.com —
	// panel lain balikin halaman "pilih pasaran" krn kode tidak dikenal.
	// Jadi: coba baca daftar pasaran langsung dari <select> di admin_invoice13.php.
	let pas: [string, string][] = INVEST_PASARAN;
	let pasSrc = "default";
	const discDiag: string[] = [];
	// 1) Daftar pasaran TERSIMPAN (di-set manual dari Setting utk panel yg dropdown-
	//    nya di-render JS spt agwlXX). Prioritas tertinggi.
	if (cfg.PASARAN_JSON) {
		try {
			const arr = JSON.parse(cfg.PASARAN_JSON);
			if (Array.isArray(arr) && arr.length >= 5) {
				pas = arr.filter((x) => Array.isArray(x) && x[0] && x[1]).map((x) => [String(x[0]), String(x[1])] as [string, string]);
				pasSrc = "tersimpan(" + pas.length + ")";
			}
		} catch {
			/* JSON rusak -> lanjut auto-discovery */
		}
	}
	// 2) Auto-discovery dari <select> di halaman panel (kalau belum ada list tersimpan).
	//    Dropdown bisa ada di beberapa halaman tergantung varian panel.
	if (pasSrc === "default") {
		// agent_bt.php = frame menu semua panel suksesbogil; di situ <select>
		// "Pilih Pasar" (format value="NAMA,pXXXX"). Kode pXXXX BEDA tiap panel
		// DAN kadang beda tiap agen — INVEST_PASARAN hardcoded sudah usang
		// (ARIZONA p33190 -> sekarang p33182 di ag). Jadi agent_bt.php PALING utama.
		for (const cand of [
			"agent_bt.php", "admin_invoice13.php", "agentoverview.php", "index.php",
			"menu.php", "home.php", "main.php", "left.php", "menu_kiri.php", "admin_invoice.php",
		]) {
			try {
				const html = await investFetch(cfg, cand);
				const disc = parsePasaranOptions(html);
				discDiag.push(cand.replace(".php", "") + ":" + html.length + "b/" + disc.length + "opt");
				if (disc.length >= 20) {
					pas = disc;
					pasSrc = cand.replace(".php", "") + "(" + disc.length + ")";
					break;
				}
			} catch (e) {
				discDiag.push(cand.replace(".php", "") + ":ERR");
			}
		}
		// PENTING: simpan hasil discovery ke invest_config supaya tick BERIKUTNYA
		// langsung pakai jalur "tersimpan" (0 fetch tambahan) alih-alih mengulang
		// sampai 10 fetch discovery TIAP tick -> itu yang bikin scan seret/macet
		// (anggaran wall-clock habis buat discovery, market tidak sempat diproses).
		if (pasSrc !== "default") {
			try {
				await getTurso(env)
					.prepare(`UPDATE invest_config SET pasaran_json = ? WHERE username = ?`)
					.bind(JSON.stringify(pas), user)
					.run();
			} catch {
				/* gagal simpan -> tidak fatal, discovery diulang tick berikutnya */
			}
		}
	}
	let cursor = Number(st.cursor || 0);

	const today = dateKeyTZ(0);
	const yesterday = dateKeyTZ(-1);
	const wanted: Record<string, boolean> = { [today]: true, [yesterday]: true };
	const limits: Record<string, number> = { "2D": cfg.LIMIT_2D, "3D": cfg.LIMIT_3D, "4D": cfg.LIMIT_4D };
	const buffer: RawRow[] = [];

	if (cursor === 0) {
		await getTurso(env).prepare(`DELETE FROM invest_raw WHERE owner = ?`).bind(user).run();
		await investSetState(env, user, { state: "running", cursor, total: pas.length, message: "Scan berjalan…" });
	}

	// Wrapper penghitung subrequest.
	let fetches = 0;
	const doFetch = (path: string): Promise<string> => {
		fetches++;
		return investFetch(cfg, path);
	};
	const budgetLeft = () => Date.now() < deadlineMs && fetches < maxFetches;

	const pauseAndReturn = async () => {
		await flushRaw(env, user, buffer);
		await investSetState(env, user, {
			state: "running",
			cursor,
			message: `Scan berjalan — pasaran ${cursor}/${pas.length}…`,
		});
	};

	let scannedThisTick = 0;
	let probeSnippet = "";
	// Diagnostik ringkas — kenapa 0 data?
	const diag = { periods: 0, withTotals: 0, pages: 0, dateSkip: 0, overLimit: 0 };
	for (; cursor < pas.length; cursor++) {
		if (!budgetLeft()) {
			await pauseAndReturn();
			return;
		}

		const [kode, nama] = pas[cursor];
		// Update progres yang kelihatan (nama pasaran + posisi) setiap 3 pasaran,
		// supaya user lihat scan benar-benar bergerak.
		if (scannedThisTick % 3 === 0) {
			await investSetState(env, user, {
				state: "running",
				cursor,
				message: `Scan pasaran ${cursor + 1}/${pas.length} — ${nama}…`,
			});
		}
		scannedThisTick++;
		const marketBuffer: RawRow[] = [];
		let aborted = false;
		try {
			let head0 = await doFetch("admin_invoice13.php?psr=" + encodeURIComponent(kode));
			let open = parsePeriode(head0);
			// agwlXX di belakang Cloudflare kadang balas template TANPA periode di
			// percobaan pertama. Coba ulang 1x (jeda kecil) sebelum menyerah.
			if (!open && budgetLeft()) {
				await new Promise((r) => setTimeout(r, 600));
				head0 = await doFetch("admin_invoice13.php?psr=" + encodeURIComponent(kode));
				open = parsePeriode(head0);
			}
			// Diagnostik: kalau pasaran pertama tidak menghasilkan periode sama sekali,
			// simpan cuplikan body-nya supaya ketahuan situs balikin apa (login page
			// tak dikenal? "Information"? kosong?). Dipakai di pesan akhir bila 0 data.
			if (!open && probeSnippet.split(" || ").length < 2) {
				const flat = String(head0 || "").replace(/\s+/g, " ").trim();
				// Fokus ke area input periode + status, bukan cuma awal <style>.
				const around = flat.match(/.{0,40}periode.{0,120}/i);
				probeSnippet += (probeSnippet ? " || " : "") +
					nama + `(len${flat.length}):` + (around ? around[0] : flat.slice(0, 200));
			}
			if (open) diag.periods++;
			if (open) {
				for (let i = 0; i < INVEST_PERIODE_LOOKBACK; i++) {
					if (!budgetLeft()) {
						aborted = true;
						break;
					}
					const per = open - i;
					const head = i === 0 ? head0 : await doFetch("admin_invoice13.php?psr=" + encodeURIComponent(kode) + "&periode=" + per + "&tombol=2D");
					const totals = parseTotals(head);
					const maxG = maxGame(totals);
					if (totals[maxG] === 0) continue;
					diag.withTotals++;

					const page1 = await doFetch(framePath(per, maxG, 0, INVEST_PAGE_SIZE));
					diag.pages++;
					const pdate = firstDate(page1);
					if (pdate) {
						if (pdate < yesterday) break;
						if (!wanted[pdate]) { diag.dateSkip++; continue; }
					}

					for (const g of INVEST_GAMES) {
						if (totals[g] <= limits[g]) continue;
						// Paginasi sadar-dedup: berhenti begitu 1 halaman tidak menambah
						// baris baru (server agen sering mengabaikan start/end).
						const seen: Record<string, number> = {};
						const counts: Record<string, number> = {};
						let start = 0;
						let pageNo = 0;
						for (;;) {
							if (pageNo >= INVEST_MAX_PAGES_PER_GAME || !budgetLeft()) {
								aborted = !budgetLeft();
								break;
							}
							const html =
								pageNo === 0 && g === maxG ? page1 : await doFetch(framePath(per, g, start, INVEST_PAGE_SIZE));
							if (!(pageNo === 0 && g === maxG)) diag.pages++;
							pageNo++;
							const got = eatRows(html, seen, counts);
							if (got === 0) break;
							start += INVEST_PAGE_SIZE;
							if (start > totals[g]) break;
						}
						for (const uu of Object.keys(counts)) {
							if (counts[uu] > limits[g]) {
								diag.overLimit++;
								marketBuffer.push({
									tanggal: pdate || today,
									bettor: uu,
									pasaran: nama,
									periode: String(per),
									game: g,
									line: counts[uu],
									limitVal: limits[g],
								});
							}
						}
						if (aborted) break;
					}
					if (aborted) break;
				}
			}
		} catch (e) {
			if (e instanceof InvestSessionExpired) {
				await flushRaw(env, user, buffer);
				await investSetState(env, user, {
					state: "session_expired",
					cursor,
					message: `SESSION EXPIRED di ${nama}. Tempel PHPSESSID baru, SIMPAN, lalu klik LANJUTKAN SCAN.`,
				});
				return;
			}
			if (e instanceof InvestSiteDown) {
				// Situs agen down / maintenance -> tidak ada gunanya lanjut 63 pasaran.
				await flushRaw(env, user, buffer);
				await investSetState(env, user, {
					state: "paused",
					cursor,
					message: `${e.message} Klik LANJUTKAN SCAN saat situs sudah normal.`,
				});
				return;
			}
			marketBuffer.length = 0;
			marketBuffer.push({
				tanggal: today,
				bettor: "(ERROR)",
				pasaran: nama,
				periode: "-",
				game: String((e instanceof Error ? e.message : String(e)) || "error").slice(0, 120),
				line: 0,
				limitVal: 0,
			});
			aborted = false;
		}

		buffer.push(...marketBuffer);
		if (buffer.length >= RAW_FLUSH_AT) await flushRaw(env, user, buffer);
		if (aborted) {
			// Anggaran tick habis di tengah pasaran ini. TIDAK ada checkpoint di dalam
			// pasaran, jadi kalau tidak maju cursor-nya, tick berikutnya mengulang
			// pasaran yang sama dari awal -> kalau agen lambat, scan stuck di 0/63
			// selamanya. Jadi: simpan yang sudah didapat (parsial) lalu MAJU.
			cursor++;
			await pauseAndReturn();
			return;
		}
	}

	await flushRaw(env, user, buffer);
	const n = await investAggregateUser(env, user);

	// 0 hasil + invest_raw benar-benar kosong = situs tidak mengembalikan data
	// invoice apa pun (bukan "memang tidak ada yang lewat batas"). Beri pesan jelas.
	let message = `Scan selesai — ${n} user lewat batas.`;
	if (n === 0) {
		const raw = await getTurso(env)
			.prepare(`SELECT COUNT(*) AS c FROM invest_raw WHERE owner = ?`)
			.bind(user)
			.first<{ c: number }>();
		if (!Number(raw?.c || 0)) {
			message =
				"Scan selesai tapi TIDAK ADA data invoice dari situs agen (0 pasaran mengembalikan data). " +
				"Kemungkinan: sesi PHPSESSID kedaluwarsa, atau situs agen sedang maintenance/error. " +
				"Perbarui PHPSESSID di Setting lalu scan ulang." +
				` [Diag: list=${pasSrc} (${discDiag.join(" ")}), ${diag.periods}/${pas.length} pasaran ada periode, ${diag.withTotals} periode ada total, ${diag.pages} halaman diambil, ${diag.dateSkip} di-skip tanggal, ${diag.overLimit} lewat batas]` +
				(diag.periods < pas.length && probeSnippet ? ` situs balikin: "${probeSnippet}"` : "");
		}
	}

	await investSetState(env, user, {
		state: "done",
		cursor: pas.length,
		finishedAt: tsNow(),
		message,
		warningCount: n,
	});
	try {
		await logActivity(env, user, "INVEST SCAN SELESAI", message, n === 0 ? "INFO" : "BERHASIL", "");
	} catch {
		/* abaikan */
	}
}

// ---------------------------------------------------------------------------
// Agregasi invest_raw -> invest_result (1 baris per bettor)
// ---------------------------------------------------------------------------
export async function investAggregateUser(env: Env, owner: string): Promise<number> {
	const res = await getTurso(env).prepare(
		`SELECT tanggal, bettor, pasaran, periode, game, line, limit_val FROM invest_raw WHERE owner = ?`,
	)
		.bind(owner)
		.all<Record<string, unknown>>();
	const rows = res.results ?? [];

	interface Hit {
		tanggal: string;
		pasaran: string;
		periode?: number | string;
		game?: string;
		line?: number;
		limit?: number;
		over?: number;
		error?: string;
	}
	// DEDUP: kalau pump sempat jalan dobel (KV lock gagal / cron + poll barengan),
	// invest_raw bisa punya baris kembar -> hit & excess ke-hitung berkali-kali
	// ("+520 line lewat batas" dari 1 hit yang sama diulang 25x). Kunci unik hit
	// = bettor|pasaran|periode|game; ambil `line` terbesar.
	const byUser: Record<string, { tgl: Set<string>; pas: Set<string>; hitMap: Map<string, Hit>; errs: Hit[] }> = {};
	for (const r of rows) {
		const tgl = String(r.tanggal ?? "");
		const bettor = String(r.bettor ?? "");
		const pasaran = String(r.pasaran ?? "");
		const per = r.periode;
		const game = String(r.game ?? "");
		const line = Number(r.line) || 0;
		const lim = Number(r.limit_val) || 0;
		if (!byUser[bettor]) byUser[bettor] = { tgl: new Set(), pas: new Set(), hitMap: new Map(), errs: [] };
		const u = byUser[bettor];
		u.tgl.add(tgl);
		if (bettor === "(ERROR)") {
			const ek = pasaran + "|" + (game || "error");
			if (!u.hitMap.has("__e__" + ek)) {
				u.hitMap.set("__e__" + ek, { tanggal: tgl, pasaran, error: game || "error" });
			}
			continue;
		}
		u.pas.add(pasaran);
		const over = line - lim;
		const key = pasaran + "|" + String(per ?? "") + "|" + game;
		const prev = u.hitMap.get(key);
		if (!prev || line > (prev.line || 0)) {
			u.hitMap.set(key, { tanggal: tgl, pasaran, periode: per as string, game, line, limit: lim, over });
		}
	}

	const list = Object.keys(byUser)
		.map((bettor) => {
			const u = byUser[bettor];
			const hits = [...u.hitMap.values()];
			const excess = hits.reduce((s, h) => s + (h.over || 0), 0);
			return {
				user: bettor,
				dates: [...u.tgl].sort(),
				markets: [...u.pas].sort(),
				excess,
				hits: hits.sort((a, b) => {
					const d = a.tanggal < b.tanggal ? -1 : a.tanggal > b.tanggal ? 1 : 0;
					return d !== 0 ? d : (b.over || 0) - (a.over || 0);
				}),
			};
		})
		.sort((a, b) => b.excess - a.excess);

	await getTurso(env).prepare(`DELETE FROM invest_result WHERE owner = ?`).bind(owner).run();
	if (list.length) {
		const now = tsNow();
		const stmts = list.map((x) =>
			getTurso(env).prepare(
				`INSERT INTO invest_result (owner, bettor, dates, markets, excess, hits, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).bind(owner, x.user, x.dates.join(", "), x.markets.join(", "), x.excess, JSON.stringify(x.hits), now),
		);
		for (let i = 0; i < stmts.length; i += 50) await getTurso(env).batch(stmts.slice(i, i + 50));
	}
	return list.length;
}

// ---------------------------------------------------------------------------
// Pump PER USER — lock per-user, jadi scan tiap user JALAN SENDIRI-SENDIRI
// (user B tidak perlu menunggu scan user A selesai). Dipicu dari:
//  - ctx.waitUntil tiap polling investGetStatus milik user itu
//  - cron (investPump) untuk semua user 'running' — mis. saat halaman ditutup
// ---------------------------------------------------------------------------
export async function investPumpUser(env: Env, user: string, sliceMs = USER_SLICE_MS, maxFetches = FETCH_BUDGET_PER_TICK): Promise<void> {
	if (!user) return;
	const st = await investGetState(env, user);
	if (st.state !== "running") return;

	const lock = "invest:pump:" + user;
	try {
		if (await env.SESS.get(lock)) return; // pump user ini masih jalan
	} catch {
		/* lanjut tanpa lock */
	}
	try {
		await env.SESS.put(lock, "1", { expirationTtl: 60 });
	} catch {
		/* kuota KV -> lanjut */
	}
	try {
		await investScanUser(env, user, Date.now() + sliceMs, maxFetches);
	} catch (e) {
		await investSetState(env, user, {
			state: "paused",
			message: "Sempat error (" + (e instanceof Error ? e.message : String(e)) + "). Klik LANJUTKAN SCAN.",
		});
	} finally {
		try {
			await env.SESS.delete(lock);
		} catch {
			/* abaikan */
		}
	}
}

// Dipanggil cron (halaman user ditutup): pump SEMUA user 'running', BERURUTAN,
// slice kecil per user + batas subrequest total (limit CF Free 50/invocation).
// Kalau user sedang aktif membuka halaman, lock per-user milik polling-nya yang
// menang -> cron skip user itu.
export async function investPump(env: Env): Promise<void> {
	const users = await investRunningUsers(env);
	if (!users.length) return;
	const deadline = Date.now() + PUMP_BUDGET_MS;
	const perUserFetch = Math.max(8, Math.floor(FETCH_BUDGET_PER_TICK / users.length));
	const perUserMs = Math.max(6_000, Math.floor(PUMP_BUDGET_MS / users.length));
	for (const u of users) {
		if (Date.now() >= deadline) break;
		await investPumpUser(env, u, Math.min(perUserMs, deadline - Date.now()), perUserFetch);
	}
}
