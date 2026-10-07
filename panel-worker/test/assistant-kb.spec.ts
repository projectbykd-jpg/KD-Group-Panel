import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { adminSaveSystemSettings } from "../src/api/admin";
import { assistantAsk, cleanHistory } from "../src/api/assistant";
import { checkLogin } from "../src/api/auth";
import { ASSISTANT_KB_VERSION, KB_ADMIN_TABS, KB_ERRORS, KB_FAQ, KB_GENERAL, KB_GLOSSARY, KB_PAGES, buildKnowledgeText, selectKnowledge } from "../src/lib/assistant-kb";
import { hashPassword } from "../src/lib/crypto";
import { MENU_ITEMS } from "../src/lib/menus";
import { SYS_SETTINGS, resetSysCache } from "../src/lib/settings";
import { fakeEnv } from "./helpers/fake-env";

const html: string = String(readFileSync("ui-src/Index.html", "utf8"));

describe("basis pengetahuan Asisten KD wajib mengikuti fitur", () => {
	it("setiap menu di sidebar (nav-*) punya penjelasan", () => {
		const ids = [...html.matchAll(/id="nav-([a-z-]+)"/g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(15);
		const missing = ids.filter((id) => !KB_PAGES[id]);
		expect(missing, `Tambahkan penjelasan menu ini ke src/lib/assistant-kb.ts (KB_PAGES): ${missing.join(", ")}`).toEqual([]);
	});

	it("setiap tab menu Admin punya penjelasan", () => {
		const tabs = [...html.matchAll(/data-admin-tab="([a-z]+)"/g)].map((m) => m[1]);
		const missing = tabs.filter((t) => !KB_ADMIN_TABS[t]);
		expect(missing, `Tambahkan ke KB_ADMIN_TABS: ${missing.join(", ")}`).toEqual([]);
	});

	it("setiap menu hak-akses (MENU_ITEMS) disebut label-nya", () => {
		const kb = buildKnowledgeText().toLowerCase();
		const missing = MENU_ITEMS.filter((m) => !kb.includes(m.label.toLowerCase())).map((m) => m.label);
		expect(missing).toEqual([]);
	});

	it("setiap pengaturan sistem dijelaskan (label tersebut di KB admin 'lapops')", () => {
		const txt = KB_ADMIN_TABS.lapops.text.toLowerCase();
		// kelompok pengaturan harus tersebut dengan kata kuncinya
		for (const kw of ["log", "susulan", "salah password", "sesi", "invest", "asisten"]) expect(txt).toContain(kw);
		expect(SYS_SETTINGS.length).toBeGreaterThan(0);
	});

	it("versi KB terisi dan tidak ada rahasia tertulis", () => {
		expect(ASSISTANT_KB_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
		expect(buildKnowledgeText()).not.toMatch(/sk-[A-Za-z0-9]{10,}|gsk_[A-Za-z0-9]{10,}|bbd53ebb/);
		expect(KB_GENERAL.length).toBeGreaterThan(200);
	});
});

describe("pemilihan pengetahuan", () => {
	it("pertanyaan dipetakan ke bagian yang benar & hemat token", () => {
		const a = selectKnowledge("cara kirim result ke telegram dan linktree?");
		expect(a).toContain("## MENU Result");
		const b = selectKnowledge("kenapa PHPSESSID expired di auto prediksi");
		expect(b).toContain("## MENU Auto Prediksi");
		const c = selectKnowledge("gimana atur operator blazz di lap admin");
		expect(c).toContain("ADMIN › Pengaturan");
		expect(a.length).toBeLessThan(buildKnowledgeText().length * 0.75);
		expect(selectKnowledge("zzzz qqqq")).toContain("tidak ada yang cocok");
	});
	it("riwayat dibersihkan: role valid, maks 6, dipotong", () => {
		const h = cleanHistory(Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(2000) })).concat([{ role: "system", content: "bocor" } as never]));
		expect(h.length).toBeLessThanOrEqual(6);
		expect(h.every((m) => m.content.length <= 1200 && (m.role === "user" || m.role === "assistant"))).toBe(true);
	});
});

describe("API asisten", () => {
	let ctx: ReturnType<typeof fakeEnv>;
	const add = async (u: string, p: string, role: string) =>
		ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES (?, ?, ?, ?, 'AKTIF')`).run(u, u.toLowerCase(), await hashPassword(p), role);
	const tok = async (u: string, p: string) => ((await checkLogin(ctx.env, u, p, "")) as { sessionToken: string }).sessionToken;
	beforeEach(async () => {
		ctx = fakeEnv();
		resetSysCache();
		await add("Boss", "pw-boss", "ADMIN");
		await add("Opr", "pw-opr", "OPERATOR");
		await add("Botx", "pw-bot", "BOT");
	});

	it("menolak pertanyaan kosong/terlalu panjang; semua role (termasuk BOT) boleh bertanya; pesan jelas bila belum ada AI Provider", async () => {
		const opr = await tok("Opr", "pw-opr");
		await expect(assistantAsk(ctx.env, opr, "  ", [])).rejects.toThrow(/kosong/);
		await expect(assistantAsk(ctx.env, opr, "a".repeat(601), [])).rejects.toThrow(/terlalu panjang/);
		await expect(assistantAsk(ctx.env, await tok("Botx", "pw-bot"), "halo", [])).rejects.toThrow(/AI Provider|sibuk/); // BOT juga boleh bertanya
		await expect(assistantAsk(ctx.env, opr, "cara kirim result?", [])).rejects.toThrow(/AI Provider|sibuk/);
	});

	it("admin bisa mematikan asisten & membatasi pertanyaan per jam", async () => {
		const boss = await tok("Boss", "pw-boss");
		const opr = await tok("Opr", "pw-opr");
		await adminSaveSystemSettings(ctx.env, boss, { sys_assistant_per_hour: 5 });
		for (let i = 0; i < 5; i++) await assistantAsk(ctx.env, opr, "halo", []).catch(() => {});
		await expect(assistantAsk(ctx.env, opr, "halo lagi", [])).rejects.toThrow(/Batas pertanyaan/);
		await adminSaveSystemSettings(ctx.env, boss, { sys_assistant_enabled: 0 });
		await expect(assistantAsk(ctx.env, opr, "halo", [])).rejects.toThrow(/dimatikan/);
	});

	it("pertanyaan cara pasang bot Live Chat (Console / Kunci Bot / bookmark) memuat bagian Sesi Chat", () => {
		for (const q of ["cara pasang bot livechat lewat console", "kunci bot saya dimana", "kenapa bookmark tidak jalan", "f12 apa yang harus ditempel"]) {
			const kb = selectKnowledge(q, []);
			expect(kb, q).toContain("SALIN KODE CONSOLE");
			expect(kb, q).toContain("KUNCI BOT KAMU");
		}
	});

	it("pertanyaan mengatur jadwal prediksi / shio / pasaran memuat tab Data Master", () => {
		for (const q of ["cara ubah jadwal prediksi", "shio salah gimana ubah peta shio", "tambah pasaran baru panelz", "gimana ganti jam penutup prediksi", "tambah sesi prediksi baru"]) {
			expect(selectKnowledge(q, []), q).toContain("Data Master");
		}
	});
});

// --- GERBANG KELENGKAPAN: judul/label di layar yang belum dijelaskan menggagalkan CI ---
const strip = (t: string) => t.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
// Judul sambutan/transien yang memang bukan fitur.
const UI_IGNORE = new Set(["selamat datang di kd-group"]);
describe("gerbang kelengkapan: setiap judul & kolom di layar dijelaskan", () => {
	it("semua h2/h3/h4/summary/label/judul kartu di Index.html tercakup di pengetahuan asisten", () => {
		const kb = buildKnowledgeText().toLowerCase();
		const texts = new Set<string>();
		for (const m of html.matchAll(/<(h[1-4]|label|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)) texts.add(strip(m[2]));
		for (const m of html.matchAll(/class="panel-section-title"[^>]*>([\s\S]*?)<\/div>/g)) texts.add(strip(m[1]));
		const covered = (raw: string) => {
			const t = raw.toLowerCase().replace(/\(.*?\)/g, "").trim();
			if (t.length < 4 || UI_IGNORE.has(t) || t.length > 70) return true;
			if (kb.includes(t)) return true;
			const ws = t.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
			return ws.length === 0 || ws.every((w) => kb.includes(w));
		};
		const missing = [...texts].filter((t) => !covered(t));
		expect(missing, `Jelaskan di src/lib/assistant-kb.ts (KB_PAGES / KB_GLOSSARY / KB_FAQ): ${missing.join(" | ")}`).toEqual([]);
	});

	it("entri KB_ERRORS memang masih ada di kode (tidak usang); kecuali pesan dari scraper", () => {
		const src = ["src/api", "src/lib", "src/senders"].flatMap((d) => (require("node:fs") as typeof import("node:fs")).readdirSync(d).filter((f: string) => f.endsWith(".ts")).map((f: string) => readFileSync(`${d}/${f}`, "utf8"))).join("\n").toLowerCase();
		const FROM_SCRAPER = new Set(["job dihentikan sebelum selesai", "melebihi batas waktu", "cookie admin kedaluwarsa", "session expired", "http 403 forbidden", "terlalu besar"]);
		const stale = KB_ERRORS.filter((e) => !FROM_SCRAPER.has(e.m) && !src.includes(e.m)).map((e) => e.m);
		expect(stale, `Pesan galat ini tidak ada lagi di kode: ${stale.join(" | ")}`).toEqual([]);
	});

	it("tiap entri FAQ/galat/glosarium berisi jawaban bermakna dan id unik", () => {
		expect(new Set(KB_FAQ.map((f) => f.id)).size).toBe(KB_FAQ.length);
		for (const f of KB_FAQ) {
			expect(f.k.length, f.id).toBeGreaterThan(8);
			expect(f.a.length, f.id).toBeGreaterThan(60);
			expect(f.a.length, `${f.id} terlalu panjang (boros token)`).toBeLessThan(900);
		}
		for (const e of KB_ERRORS) expect(e.a.length, e.m).toBeGreaterThan(20);
		for (const [l, a] of Object.entries(KB_GLOSSARY)) expect(a.length, l).toBeGreaterThan(25);
	});
});

describe("keluhan umum dijawab dari panduan", () => {
	const cases: [string, string][] = [
		["saya lupa password gimana", "Admin › Users"],
		["akun saya terkunci terus", "ikon kunci"],
		["kok menu live chat tidak muncul di akun saya", "akses menu"],
		["panel lemot banget dan layar gelap", "Ctrl+F5"],
		["status salah terus waktu tempel hasil", "Prize 1/2/3"],
		["kirim telegram gagal kenapa", "token/chat ID"],
		["ini sudah dikirim tapi saya mau kirim lagi", "SUDAH DIKIRIM"],
		["phpsessid habis di auto prediksi", "PHPSESSID"],
		["prediksi otomatis tidak terkirim", "Telegram PREDIKSI"],
		["scan invest 0 data session expired", "Cek koneksi/session"],
		["tarik data lap admin lama sekali cookie kedaluwarsa", "GitHub Actions"],
		["total deposit tidak sesuai dengan blazz", "operator khusus"],
		["pga pending tidak update", "tab Motion TETAP TERBUKA"],
		["bot livechat tidak membalas padahal aktif", "template balasan AKTIF"],
		["tombol robot tidak muncul di daylivechat", "SALIN KODE CONSOLE"],
		["kunci userscript tidak valid", "KUNCI BOT KAMU"],
		["asisten sibuk api key bermasalah", "TES KONEKSI"],
		["gimana cara tambah user baru", "TAMBAH USER"],
		["blogger belum terhubung", "In production"],
		["Pengecekan anti-duplikat (database) tidak tersedia", "SENGAJA ditahan"],
	];
	for (const [q, must] of cases) {
		it(`"${q}" -> memuat "${must}"`, () => {
			expect(selectKnowledge(q)).toContain(must);
		});
	}
	it("kolom yang sebelumnya tak terjelaskan dikenali lewat labelnya", () => {
		expect(selectKnowledge("apa itu Paragraf minimal dan Paragraf maksimal")).toContain("12–18 paragraf");
		expect(selectKnowledge("fungsi Catatan Admin di user")).toContain("Tidak tampil ke pengguna");
	});
});
