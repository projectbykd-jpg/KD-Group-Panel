// Pembuatan skema "sekali per isolate" yang dibagi antar-request TANPA risiko menggantung bersama.
//
// Dulu (auto-input, livechat-bot): satu janji `ensuring` global ditunggu SEMUA request di isolate. Bila request yang memulainya
// terputus / I/O-nya macet (Turso cadangan lambat), janji itu tidak pernah selesai -> setiap request berikutnya ikut menunggu
// selamanya: menu Auto Prediksi kosong, kartu Omset hilang, autoInputAlerts "menggantung > 100 dtk" (18 Okt 2026).
// Pola yang sama sudah pernah membuat seluruh panel "Memuat…" tanpa akhir (lihat MASTER_LOAD_TIMEOUT_MS di master-data.ts).
//
// Aturan sekarang: yang MEMULAI menunggu janjinya sendiri (I/O miliknya). Yang hanya IKUT menunggu dibatasi `joinWaitMs`;
// lewat batas -> janji lama dilepas dan request ini menjalankan pembuatan skemanya sendiri (idempoten: CREATE IF NOT EXISTS,
// ALTER yang sudah ada diabaikan). Pemanggilan paralel di request yang sama tetap berbagi satu janji (hemat subrequest).
export interface SharedOnce {
	(env: Env): Promise<void>;
	/** Hanya untuk test (tiap test memakai database baru). */
	reset(): void;
}

// `gen` = generasi database (turso.ts tursoGeneration): panel pindah utama <-> cadangan -> skema disiapkan ulang di database
// yang baru, jadi kedua database selalu punya tabel/kolom yang sama dan perilaku panel tidak berbeda.
export function sharedOnce(run: (env: Env) => Promise<void>, joinWaitMs: number, gen: () => number = () => 0): SharedOnce {
	let doneGen = -1;
	let inflight: Promise<void> | null = null;
	const start = (env: Env): Promise<void> => {
		const g = gen();
		const p: Promise<void> = run(env).then(
			() => {
				doneGen = g;
				if (inflight === p) inflight = null;
			},
			(e) => {
				if (inflight === p) inflight = null; // gagal -> request berikutnya boleh mencoba lagi
				throw e;
			},
		);
		inflight = p;
		return p;
	};
	const fn = (async (env: Env): Promise<void> => {
		if (doneGen === gen()) return;
		const joined = inflight;
		if (!joined) return start(env);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = await Promise.race([
			joined.then(() => false),
			new Promise<boolean>((res) => {
				timer = setTimeout(() => res(true), joinWaitMs);
			}),
		]).finally(() => timer && clearTimeout(timer));
		if (doneGen === gen()) return;
		if (!timedOut) return start(env); // janji lama untuk database sebelumnya -> siapkan di database yang aktif sekarang
		if (inflight === joined) inflight = null;
		console.error(`sharedOnce: menunggu pembuatan skema request lain > ${joinWaitMs} ms, jalankan sendiri`);
		const g = gen();
		await run(env); // milik request ini, tidak dibagi -> tidak bisa tersangkut janji request lain
		doneGen = g;
	}) as SharedOnce;
	fn.reset = () => {
		doneGen = -1;
		inflight = null;
	};
	return fn;
}
