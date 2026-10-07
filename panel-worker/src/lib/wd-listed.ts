// Menu "WD LISTED" -- checklist manual withdraw yang admin tandai dari daftar
// PGA Pending (lihat pga-pending.ts) untuk dilacak sampai statusnya jelas.
// BEDA dari PGA Pending: PERSISTEN (Turso, bukan KV ber-TTL) -- baris di sini
// harus tetap ada sampai admin sendiri yang hapus (tombol X), tidak boleh
// hilang sendiri.
//
// Terlihat LINTAS operator berdasarkan WEBSITE, bukan siapa yang menambahkan --
// operator A menambahkan baris utk HUGOTOGEL, operator B yang juga ngurus
// HUGOTOGEL (websites-nya di tabel users memuat HUGOTOGEL) otomatis ikut
// lihat baris yang sama. Operator yang websites-nya tidak cocok TIDAK melihat
// baris itu sama sekali.
import { getTurso } from "./turso";
import { tsNow } from "./time";

export interface WdListedRow {
	id: number;
	website: string;
	idTrans: string;
	tanggal: string;
	idUser: string;
	jumlah: number;
	statusText: string;
	pgaRefNo: string;
	vendorName: string;
	checkStatus: string;
	checkDate: string;
	addedBy: string;
	createdAt: string;
	updatedAt: string;
}

export interface WdListedInput {
	website: string;
	idTrans: string;
	tanggal: string;
	idUser: string;
	jumlah: number;
	statusText: string;
	pgaRefNo: string;
	vendorName: string;
}

let ensured = false;
async function ensureTable(env: Env): Promise<void> {
	if (ensured) return;
	await getTurso(env)
		.prepare(
			`CREATE TABLE IF NOT EXISTS wd_listed (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				website TEXT NOT NULL,
				id_trans TEXT,
				tanggal TEXT,
				id_user TEXT,
				jumlah REAL DEFAULT 0,
				status_text TEXT,
				pga_ref_no TEXT NOT NULL UNIQUE,
				vendor_name TEXT,
				check_status TEXT,
				check_date TEXT,
				added_by TEXT,
				created_at TEXT,
				updated_at TEXT
			)`,
		)
		.run();
	ensured = true;
}

function mapRow(row: Record<string, unknown>): WdListedRow {
	return {
		id: Number(row.id),
		website: String(row.website ?? ""),
		idTrans: String(row.id_trans ?? ""),
		tanggal: String(row.tanggal ?? ""),
		idUser: String(row.id_user ?? ""),
		jumlah: Number(row.jumlah) || 0,
		statusText: String(row.status_text ?? ""),
		pgaRefNo: String(row.pga_ref_no ?? ""),
		vendorName: String(row.vendor_name ?? ""),
		checkStatus: String(row.check_status ?? ""),
		checkDate: String(row.check_date ?? ""),
		addedBy: String(row.added_by ?? ""),
		createdAt: String(row.created_at ?? ""),
		updatedAt: String(row.updated_at ?? ""),
	};
}

const norm = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
// users.websites SENGAJA berisi KODE SINGKAT ("HUGO", "FOLA" -- convention yang
// sama dipakai di modul prediksi/kirim result, lihat src/lib/prediction.ts),
// BUKAN nama lengkap situs. Sementara "website" yang ke-scan dari Motion
// (kolom WEBSITE di WD Request) adalah nama lengkap aslinya ("HUGOTOGEL").
// Jadi dicocokkan via PREFIX ("HUGOTOGEL".startsWith("HUGO")), bukan sama
// persis -- kalau dipaksa sama persis, List akan SELALU kosong utk semua
// operator (ketahuan dari testing: akun dgn websites "HUGO,FOLA" sama sekali
// tidak melihat baris "HUGOTOGEL" yang dia sendiri baru tambahkan).
const hasWebsite = (websites: string[], website: string) => {
	const target = String(website ?? "").toUpperCase().trim();
	if (!target) return false;
	return websites.some((w) => {
		const code = String(w ?? "").toUpperCase().trim();
		return !!code && (target.startsWith(code) || code.startsWith(target));
	});
};

/**
 * `userWebsites`: website milik akun pemanggil. Baris untuk website yang BUKAN miliknya dibuang, dan baris yang sudah ada untuk
 * pga_ref_no yang sama tetapi milik website lain TIDAK boleh ditimpa (dulu operator website B bisa merebut baris website A
 * hanya dengan mengirim ulang ref_no-nya).
 */
export async function wdListedAdd(env: Env, addedBy: string, rows: WdListedInput[], userWebsites?: string[]): Promise<number> {
	await ensureTable(env);
	const db = getTurso(env);
	let added = 0;
	let todo = rows.slice(0, 100);
	if (userWebsites) todo = todo.filter((r) => hasWebsite(userWebsites, r.website));
	// pemilik baris yang sudah ada (satu query, bukan satu per baris)
	const owner = new Map<string, string>();
	const refs = [...new Set(todo.map((r) => norm(r.pgaRefNo, 80)).filter(Boolean))];
	if (userWebsites && refs.length) {
		const ex = await db.prepare(`SELECT pga_ref_no, website FROM wd_listed WHERE pga_ref_no IN (${refs.map(() => "?").join(",")})`).bind(...refs).all<{ pga_ref_no: string; website: string }>();
		for (const e of ex.results ?? []) owner.set(String(e.pga_ref_no), String(e.website ?? ""));
	}
	for (const r of todo) {
		const refNo = norm(r.pgaRefNo, 80);
		if (!refNo) continue; // tanpa ref no tidak bisa di-CHECK STATUS nanti, jangan disimpan
		if (userWebsites && owner.has(refNo) && !hasWebsite(userWebsites, owner.get(refNo) || "")) continue; // milik website lain
		const now = tsNow();
		const res = await db
			.prepare(
				// ON CONFLICT nyegarkan (bukan skip) -- kalau operator centang+COPY
				// baris yang REF-nya sudah ada (mis. tersimpan dgn data rusak dari
				// bug scan sebelumnya, atau field lain berubah), datanya ketimpa yang
				// terbaru. check_status/check_date SENGAJA tidak disentuh di sini
				// (biarkan hasil CEK terakhir, bukan direset kosong tiap re-add).
				`INSERT INTO wd_listed (website, id_trans, tanggal, id_user, jumlah, status_text, pga_ref_no, vendor_name, added_by, created_at, updated_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?)
				 ON CONFLICT(pga_ref_no) DO UPDATE SET
				   website = excluded.website, id_trans = excluded.id_trans, tanggal = excluded.tanggal,
				   id_user = excluded.id_user, jumlah = excluded.jumlah, status_text = excluded.status_text,
				   vendor_name = excluded.vendor_name, updated_at = excluded.updated_at`,
			)
			.bind(
				norm(r.website, 60).toUpperCase(),
				norm(r.idTrans, 60),
				norm(r.tanggal, 40),
				norm(r.idUser, 60),
				Number(r.jumlah) || 0,
				norm(r.statusText, 160),
				refNo,
				norm(r.vendorName, 60),
				norm(addedBy, 60),
				now,
				now,
			)
			.run();
		if (res.meta.changes > 0) added++;
	}
	return added;
}

export async function wdListedList(env: Env, websites: string[]): Promise<WdListedRow[]> {
	await ensureTable(env);
	const codes = Array.from(new Set(websites.map((w) => String(w || "").toUpperCase().trim()).filter(Boolean)));
	if (!codes.length) return [];
	// Difilter di sisi aplikasi (bukan SQL WHERE website IN (...)) karena
	// cocoknya PREFIX (lihat hasWebsite di atas), bukan sama persis -- SQL
	// exact-match akan selalu kosong utk kode singkat spt "HUGO" vs
	// "HUGOTOGEL". Diambil dulu yang terbaru secukupnya lalu disaring.
	const res = await getTurso(env)
		.prepare(`SELECT * FROM wd_listed ORDER BY id DESC LIMIT 1000`)
		.all<Record<string, unknown>>();
	return (res.results ?? []).map(mapRow).filter((r) => hasWebsite(codes, r.website));
}

// Parsing struk https://dbb2b.q2checkout.com/struk/disbursement/<ref> -- HTML
// statis apa adanya (bukan halaman ber-JS/WAF berat spt Motion), field Status
// & Date masing-masing dirender sbg <div>NILAI</div> diikuti teks label polos
// lalu </div> penutup -- lihat contoh nyata yang sudah dites:
//   <div ...>Failed</div>\n Status\n </div>
//   <div ...>09 Mar 2026 13:02:36</div>\n Date\n </div>
const STRUK_BASE = "https://dbb2b.q2checkout.com/struk/disbursement/";
function parseStrukField(html: string, label: string): string {
	const re = new RegExp("<div[^>]*>([^<]*)<\\/div>\\s*" + label + "\\s*<\\/div>", "i");
	const m = html.match(re);
	return m ? m[1].trim() : "";
}

export async function wdListedCheckStatus(env: Env, id: number, websites: string[]): Promise<WdListedRow> {
	await ensureTable(env);
	const db = getTurso(env);
	const row = await db.prepare(`SELECT * FROM wd_listed WHERE id = ?`).bind(id).first<Record<string, unknown>>();
	if (!row) throw new Error("Baris tidak ditemukan (mungkin sudah dihapus).");
	const website = String(row.website ?? "");
	if (!hasWebsite(websites, website)) throw new Error("Kamu tidak punya akses ke website " + website + ".");
	const refNo = String(row.pga_ref_no ?? "");
	if (!refNo) throw new Error("PGA Ref No kosong, tidak bisa dicek.");
	const resp = await fetch(STRUK_BASE + encodeURIComponent(refNo), { headers: { "user-agent": "Mozilla/5.0" } });
	if (!resp.ok) throw new Error("Gagal ambil struk dari q2checkout (HTTP " + resp.status + ").");
	const html = await resp.text();
	const status = parseStrukField(html, "Status");
	const date = parseStrukField(html, "Date");
	if (!status) throw new Error("Struk tidak dikenali (mungkin ref salah, atau format halaman berubah).");
	const now = tsNow();
	await db.prepare(`UPDATE wd_listed SET check_status = ?, check_date = ?, updated_at = ? WHERE id = ?`).bind(status, date, now, id).run();
	return mapRow({ ...row, check_status: status, check_date: date, updated_at: now });
}

export async function wdListedDelete(env: Env, id: number, websites: string[]): Promise<void> {
	await ensureTable(env);
	const db = getTurso(env);
	const row = await db.prepare(`SELECT website FROM wd_listed WHERE id = ?`).bind(id).first<{ website: string }>();
	if (!row) return; // sudah terhapus -- anggap sukses
	if (!hasWebsite(websites, String(row.website ?? ""))) throw new Error("Kamu tidak punya akses ke website " + row.website + ".");
	await db.prepare(`DELETE FROM wd_listed WHERE id = ?`).bind(id).run();
}
