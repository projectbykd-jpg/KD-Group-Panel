import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminGetIntegrations, adminSaveIntegrations, adminTestIntegrations } from "../src/api/master-data";
import { checkLogin } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { resetSysCache } from "../src/lib/settings";
import { INT_DEFS, ghRepo, ghToken, intVal, linktreeCfg, loadIntegrations, newsTurboRepo, publicUrl, resetIntegrationsCache, adminDomain } from "../src/lib/integrations";
import { resetMasterCache, loadMasterData } from "../src/lib/master-data";
import { SITE_HOST } from "../src/lib/auto-input";
import { fakeEnv } from "./helpers/fake-env";

let ctx: ReturnType<typeof fakeEnv>;
async function addUser(username: string, password: string, role: string) {
	ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status) VALUES (?, ?, ?, ?, 'AKTIF')`)
		.run(username, username.toLowerCase(), await hashPassword(password), role);
}
const tok = async (u: string, p: string) => ((await checkLogin(ctx.env, u, p, "")) as { sessionToken: string }).sessionToken;
type View = { key: string; value: string; mask: string; secret: boolean; source: string };
const items = (r: unknown) => (r as { items: View[] }).items;
const SECRET = "github_pat_SANGAT_RAHASIA_1234567890abcd";

beforeEach(async () => {
	ctx = fakeEnv();
	resetSysCache(); resetMasterCache(); resetIntegrationsCache();
	await addUser("Boss", "pw-boss", "ADMIN");
	await addUser("Opr", "pw-opr", "OPERATOR");
	await loadMasterData(ctx.env);
});
afterEach(async () => {
	vi.unstubAllGlobals();
	const c = fakeEnv(); resetIntegrationsCache(); resetMasterCache(); await loadMasterData(c.env);
});

describe("integrasi -- bawaan", () => {
	it("semua nilai bawaan lolos validasinya sendiri", () => {
		for (const d of INT_DEFS) if (!d.secret || d.def) expect(d.check(d.def), d.key).toBe("");
	});
	it("tanpa isian admin: perilaku sama seperti sebelumnya (kode / variabel Cloudflare)", () => {
		expect(ghRepo(ctx.env)).toBe("projectbykd-jpg/KD-scraper");
		expect(newsTurboRepo(ctx.env)).toBe("projectbykd-jpg/KD-Group-Panel");
		expect(publicUrl(ctx.env)).toMatch(/^https:\/\//);
		expect(linktreeCfg().loginUrl).toContain(":8069/index");
		expect(adminDomain()).toBe("suksesbogil.com");
		expect(ghToken({ ...ctx.env, GH_TOKEN: "dari-cloudflare-token-0123456789" } as never)).toBe("dari-cloudflare-token-0123456789");
	});
});

describe("integrasi -- simpan & rahasia", () => {
	it("hanya ADMIN", async () => {
		const opr = await tok("Opr", "pw-opr");
		await expect(adminGetIntegrations(ctx.env, opr)).rejects.toThrow();
		await expect(adminSaveIntegrations(ctx.env, opr, { int_gh_token: SECRET })).rejects.toThrow();
	});

	it("token disimpan & dipakai, tetapi TIDAK PERNAH muncul di respons maupun log aktivitas (hanya 4 karakter terakhir)", async () => {
		const boss = await tok("Boss", "pw-boss");
		const r = await adminSaveIntegrations(ctx.env, boss, { int_gh_token: SECRET, int_gh_repo: "akun/repo-baru" });
		expect((r as { success: boolean }).success).toBe(true);
		expect(ghToken(ctx.env)).toBe(SECRET);
		expect(ghRepo(ctx.env)).toBe("akun/repo-baru");
		expect(JSON.stringify(r)).not.toContain(SECRET);
		expect(JSON.stringify(await adminGetIntegrations(ctx.env, boss))).not.toContain(SECRET);
		const t = items(await adminGetIntegrations(ctx.env, boss)).find((x) => x.key === "int_gh_token")!;
		expect(t.value).toBe("");
		expect(t.mask).toBe("••••abcd");
		expect(t.source).toBe("admin");
		const logs = JSON.stringify(ctx.db.prepare(`SELECT * FROM activity_log`).all());
		expect(logs).not.toContain(SECRET);
		expect(logs).toContain("INTEGRASI");
	});

	it("kolom rahasia dikosongkan = tidak diubah; null = kembali ke bawaan", async () => {
		const boss = await tok("Boss", "pw-boss");
		await adminSaveIntegrations(ctx.env, boss, { int_gh_token: SECRET, int_news_site_url: "https://berita.example.com/" });
		await adminSaveIntegrations(ctx.env, boss, { int_gh_token: "" });
		expect(ghToken(ctx.env)).toBe(SECRET);
		expect(intVal("int_news_site_url")).toBe("https://berita.example.com/");
		await adminSaveIntegrations(ctx.env, boss, { int_gh_token: null, int_news_site_url: null });
		expect(ghToken(ctx.env)).toBe("");
		expect(intVal("int_news_site_url")).toBe("https://lokalstore88.online");
	});

	it("validasi menolak isian ngawur dengan pesan jelas dan tidak menyimpan apa pun", async () => {
		const boss = await tok("Boss", "pw-boss");
		const bad = async (v: Record<string, unknown>, re: RegExp) => {
			const r = (await adminSaveIntegrations(ctx.env, boss, v)) as { success: boolean; message: string };
			expect(r.success).toBe(false); expect(r.message).toMatch(re);
		};
		await bad({ int_gh_repo: "bukan repo" }, /pemilik\/nama-repo/);
		await bad({ int_public_url: "http://tidak-aman.example.com" }, /https/);
		await bad({ int_admin_domain: "https://x.com/" }, /nama domain/);
		await bad({ int_gh_token: "pendek" }, /20-300/);
		await bad({ int_struk_base_url: "https://x.example.com/struk" }, /garis miring/);
		expect(ghRepo(ctx.env)).toBe("projectbykd-jpg/KD-scraper");
	});

	it("nilai rusak langsung di database diabaikan (bawaan dipakai)", async () => {
		ctx.db.prepare(`INSERT INTO settings (key, value) VALUES ('int_gh_repo', 'ngawur banget')`).run();
		resetIntegrationsCache(); await loadIntegrations(ctx.env);
		expect(ghRepo(ctx.env)).toBe("projectbykd-jpg/KD-scraper");
	});

	it("domain admin Auto Input & peta server website ikut diatur admin", async () => {
		const boss = await tok("Boss", "pw-boss");
		await adminSaveIntegrations(ctx.env, boss, { int_admin_domain: "contoh.id" });
		expect(adminDomain()).toBe("contoh.id");
		const { adminSaveMasterData } = await import("../src/api/master-data");
		const r = (await adminSaveMasterData(ctx.env, boss, "md_site_host", { "ag.contoh.id": ["hugo", "axis"] })) as { success: boolean };
		expect(r.success).toBe(true);
		expect(SITE_HOST.HUGO).toBe("ag.contoh.id");
		expect(SITE_HOST.LIMA).toBeUndefined();
		const bad = (await adminSaveMasterData(ctx.env, boss, "md_site_host", { "a.b.id": ["HUGO"], "c.d.id": ["HUGO"] })) as { success: boolean; message: string };
		expect(bad.success).toBe(false); expect(bad.message).toMatch(/dua host/);
		await adminSaveMasterData(ctx.env, boss, "md_site_host", null);
		expect(SITE_HOST.LIMA).toBe("agwl5.suksesbogil.com");
	});
});

describe("tes koneksi GitHub", () => {
	it("memberi diagnosa per repo (token tidak mencakup satu repo -> 404 dengan petunjuk), tanpa membocorkan token", async () => {
		const boss = await tok("Boss", "pw-boss");
		expect(((await adminTestIntegrations(ctx.env, boss)) as { success: boolean }).success).toBe(false); // belum ada token
		await adminSaveIntegrations(ctx.env, boss, { int_gh_token: SECRET });
		const calls: string[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			calls.push(url);
			expect((init.headers as Record<string, string>).Authorization).toBe("Bearer " + SECRET);
			return new Response("{}", { status: url.includes("KD-scraper") ? 200 : 404 });
		});
		const r = (await adminTestIntegrations(ctx.env, boss)) as { allOk: boolean; checks: { ok: boolean; status: number; message: string }[] };
		expect(calls.sort()).toEqual([
			"https://api.github.com/repos/projectbykd-jpg/KD-Group-Panel/actions/workflows/invest-turbo.yml",
			"https://api.github.com/repos/projectbykd-jpg/KD-Group-Panel/actions/workflows/news-turbo.yml",
			"https://api.github.com/repos/projectbykd-jpg/KD-scraper/actions/workflows/scrape.yml",
		]);
		expect(r.allOk).toBe(false);
		expect(r.checks.filter((c) => c.ok)).toHaveLength(1);
		expect(r.checks.find((c) => !c.ok)!.message).toMatch(/tidak mencakup repo ini|tidak ditemukan/);
		expect(JSON.stringify(r)).not.toContain(SECRET);
	});
});
