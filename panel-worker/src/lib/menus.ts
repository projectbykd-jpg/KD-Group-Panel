// Hak akses menu per user, diatur ADMIN dari menu Admin -> Users.
//
// Kolom users.menus:
//   ''              -> default: SEMUA menu yang diizinkan role-nya (akun lama
//                      tidak berubah apa-apa sesudah fitur ini dipasang)
//   '["result",..]' -> HANYA menu yang tercantum (Dashboard selalu ada)
//
// ADMIN selalu bebas semua menu; BOT tetap terkunci ke menu BOT (lihat
// requireSession). Pengecekan dilakukan di SERVER (requireSession opts.menu),
// bukan cuma menyembunyikan tombol -- user tidak bisa memanggil API menu yang
// tidak diizinkan walau tahu nama aksinya.

export const MENU_ITEMS = [
	{ key: "result", label: "Result", group: "Utama" },
	{ key: "prediction", label: "Prediksi", group: "Utama" },
	{ key: "invest", label: "AutoCheck Invest", group: "Utama" },
	{ key: "lap-admin", label: "Lap Admin", group: "Laporan Harian" },
	{ key: "lap-motion", label: "Lap Motion", group: "Laporan Harian" },
	{ key: "pga-pending", label: "PGA Pending", group: "Laporan Harian" },
	{ key: "lap-mozart", label: "Lap Mozart", group: "Laporan Harian" },
	{ key: "activity", label: "Aktivitas", group: "Lainnya" },
	{ key: "livechat-sessions", label: "Sesi Chat", group: "Live Chat" },
	{ key: "livechat-templates", label: "Template Balasan", group: "Live Chat" },
] as const;

export type MenuKey = (typeof MENU_ITEMS)[number]["key"];
export const MENU_KEYS: readonly MenuKey[] = MENU_ITEMS.map((m) => m.key);
// Setting Laporan Harian berisi kredensial MILIK user itu sendiri yang
// dibutuhkan semua menu laporan, jadi ikut terbuka kalau salah satunya boleh.
export const LAP_MENU_KEYS: readonly MenuKey[] = ["lap-admin", "lap-motion", "lap-mozart"];

const LABEL: Record<string, string> = Object.fromEntries(MENU_ITEMS.map((m) => [m.key, m.label]));

/** null = default (semua menu role-nya). Nilai tak dikenal dibuang. */
export function parseMenus(raw: unknown): MenuKey[] | null {
	const s = String(raw ?? "").trim();
	if (!s) return null;
	let arr: unknown;
	try {
		arr = JSON.parse(s);
	} catch {
		arr = s.split(",");
	}
	if (!Array.isArray(arr)) return null;
	const wanted = new Set(arr.map((x) => String(x).trim()));
	return MENU_KEYS.filter((k) => wanted.has(k));
}

/** Nilai yang disimpan ke kolom users.menus dari input form admin. */
export function serializeMenus(input: unknown): string {
	if (input === null || input === undefined || input === "" || input === "all") return "";
	const list = Array.isArray(input) ? input : String(input).split(",");
	const wanted = new Set(list.map((x) => String(x).trim()));
	const keys = MENU_KEYS.filter((k) => wanted.has(k));
	// Semua dicentang = sama dengan default; simpan '' supaya menu baru yang
	// ditambahkan nanti otomatis ikut terbuka untuk user ini.
	if (keys.length === MENU_KEYS.length) return "";
	return JSON.stringify(keys);
}

export function hasMenu(profile: { role: string; menus: MenuKey[] | null }, need: MenuKey | readonly MenuKey[]): boolean {
	if (profile.role === "ADMIN") return true;
	if (!profile.menus) return true;
	const list = Array.isArray(need) ? need : [need as MenuKey];
	return list.some((k) => profile.menus!.includes(k));
}

export function menuLabel(need: MenuKey | readonly MenuKey[]): string {
	const list = Array.isArray(need) ? need : [need as MenuKey];
	return list.map((k) => LABEL[k] || k).join(" / ");
}
