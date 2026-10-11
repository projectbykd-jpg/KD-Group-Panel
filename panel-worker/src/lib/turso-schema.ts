// Pembantu skema Turso yang HEMAT subrequest. Worker paket gratis hanya boleh 50 subrequest per invocation dan tiap perintah Turso
// memakai satu (atau lebih) -- ALTER TABLE yang dijalankan satu-satu di setiap isolate dingin pernah menghabiskan batas itu
// ("Too many subrequests by single Worker invocation" di menu Auto Prediksi). Di sini: SATU query untuk membaca kolom yang ada,
// ALTER hanya untuk kolom yang benar-benar belum ada (hampir selalu nol).
interface Db {
	prepare(sql: string): { run(): Promise<unknown>; all<T = Record<string, unknown>>(): Promise<{ results: T[] }> };
}

/** spec: { namaTabel: [[kolom, definisi], ...] }. Nama tabel/kolom adalah konstanta kode (bukan input user). */
export async function ensureColumns(db: Db, spec: Record<string, [string, string][]>): Promise<void> {
	const tables = Object.keys(spec);
	if (!tables.length) return;
	const sql = tables.map((t) => `SELECT '${t}' AS t, name FROM pragma_table_info('${t}')`).join(" UNION ALL ");
	const r = await db.prepare(sql).all<{ t: string; name: string }>();
	const have = new Set((r.results ?? []).map((x) => `${x.t}.${x.name}`));
	for (const t of tables) {
		for (const [col, ddl] of spec[t]) {
			if (have.has(`${t}.${col}`)) continue;
			try {
				await db.prepare(`ALTER TABLE ${t} ADD COLUMN ${col} ${ddl}`).run();
			} catch (e) {
				if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) throw e; // isolate lain menambahkannya lebih dulu
			}
		}
	}
}
