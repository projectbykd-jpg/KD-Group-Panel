import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

// 17 Okt 2026: Turso memblokir SEMUA baca ("reads are blocked, do you need to upgrade your plan?") karena kuota baca bulanan
// paket gratis (500 juta baris) habis. Turso menghitung setiap baris yang DIPINDAI, bukan yang dikembalikan. Tes ini
// mengunci jalur yang berjalan berulang-ulang (cron, polling halaman, situs berita publik): query-nya harus memakai
// pencarian index/rowid (SEARCH), bukan memindai seluruh tabel yang terus tumbuh (SCAN).

type Rec = { d1: unknown; raw: DatabaseSync; sqls: string[] };
const turso = vi.hoisted(() => ({ current: null as null | Rec }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { botCfgSet, ensureNewsCategoryColumns, publicNewsList, publicNewsRandom, resetNewsColumnsGuard, resetNewsCountCache } from "../src/lib/bot-news";
import { tgChannelRun } from "../src/lib/tg-channel";
import { pendingTotoAlerts, resetTotoTablesFlag } from "../src/lib/toto-macau";
import { scanFinalFailures, resetNotifyScanGuard } from "../src/lib/admin-notify";
import { dueRetryJobs, ensureAutoInputTables, pendingFailureAlerts, resetAutoInputTablesFlag } from "../src/lib/auto-input";
import { pullEnabledSessions, resetLivechatTablesFlag, syncSessionsFromScript } from "../src/lib/livechat-bot";
import { resetWdListedTableFlag, wdListedAdd, wdListedDelete, wdListedRev } from "../src/lib/wd-listed";
import { wdListedGetList } from "../src/api/wd-listed";
import { checkLogin } from "../src/api/auth";
import { hashPassword } from "../src/lib/crypto";
import { resetIntegrationsCache, saveIntegrations } from "../src/lib/integrations";
import { resetSysCache } from "../src/lib/settings";
import { fakeEnv, fakeTurso } from "./helpers/fake-env";

const GROWING = /^SCAN (news_article|toto_macau_log|toto_macau_event|auto_input_job|livechat_session|livechat_template|livechat_log|wd_listed|sent_registry)\b/;

function recording(): Rec {
	const t = fakeTurso();
	const sqls: string[] = [];
	const base = t.d1 as { prepare: (s: string) => unknown; batch: unknown; exec: unknown };
	return { d1: { ...base, prepare: (sql: string) => (sqls.push(sql), base.prepare(sql)) }, raw: t.raw, sqls };
}
/** Query baca/ubah yang dijalankan sejak `from`, beserta rencana eksekusi SQLite-nya. */
function plans(from = 0): { sql: string; plan: string[] }[] {
	const r = turso.current!;
	return [...new Set(r.sqls.slice(from))]
		.filter((q) => !/^\s*(CREATE|ALTER|INSERT|PRAGMA)/i.test(q))
		.map((sql) => {
			const n = (sql.match(/\?(?!\d)/g) ?? []).length + (sql.includes("?1") ? 1 : 0);
			const plan = (r.raw.prepare("EXPLAIN QUERY PLAN " + sql).all(...Array(n).fill(null)) as { detail: string }[]).map((p) => p.detail);
			return { sql: sql.replace(/\s+/g, " ").trim(), plan };
		});
}
const fullScans = (from = 0) => plans(from).filter((p) => p.plan.some((d) => GROWING.test(d)));

let ctx: ReturnType<typeof fakeEnv>;
beforeEach(async () => {
	turso.current = recording();
	ctx = fakeEnv();
	Object.assign(ctx.env, { TURSO_URL: "libsql://fake", TURSO_TOKEN: "x" });
	resetSysCache();
	resetIntegrationsCache();
	resetNewsColumnsGuard();
	resetNewsCountCache();
	resetTotoTablesFlag();
	resetNotifyScanGuard();
	resetAutoInputTablesFlag();
	resetLivechatTablesFlag();
	resetWdListedTableFlag();
	await ensureNewsCategoryColumns(ctx.env);
	vi.stubGlobal("fetch", async () => new Response('{"ok":true}', { status: 200 }));
});
afterEach(() => vi.unstubAllGlobals());

const wib = (minAgo = 0) => new Date(Date.now() + 7 * 3600_000 - minAgo * 60_000).toISOString().slice(0, 19).replace("T", " ");
function seedArticles(n: number) {
	const ins = turso.current!.raw.prepare(
		`INSERT INTO news_article (id, source, title, url, url_hash, excerpt, image_url, status, found_at, category, site_posted_at, tg_posted_at, posted_at) VALUES (?, 's', ?, ?, ?, 'r', 'https://img.test/a.jpg', ?, '2026-10-01 00:00:00', ?, ?, ?, ?)`,
	);
	for (let i = 1; i <= n; i++) {
		const site = i % 3 !== 0; // 2/3 tayang di situs, 1/3 Blogger
		ins.run(i, `Judul ${i}`, `https://src.test/${i}`, `h${i}`, site ? "site" : "posted", i % 2 ? "bola" : "nasional", site ? wib(n - i) : "", i % 5 === 0 ? wib(n - i) : "", site ? "" : wib(n - i));
	}
}

describe("jalur berulang tidak memindai seluruh tabel (hemat kuota baca Turso)", () => {
	it("channel Telegram (cron tiap 5 menit): jeda & batas harian dihitung lewat rentang index", async () => {
		seedArticles(300);
		turso.current!.raw.prepare(`UPDATE news_article SET tg_posted_at = ? WHERE tg_posted_at != ''`).run(wib(180)); // lewat jeda antar posting
		await saveIntegrations(ctx.env, { int_tgch_token: "123456789:AAEhBOweik6ad9r_QXMENQjcrEZhGbbpR_H" });
		resetIntegrationsCache();
		await botCfgSet(ctx.env, { tg_channel_enabled: "1", tg_channel_id: "-1003703936630" });
		const from = turso.current!.sqls.length;
		await tgChannelRun(ctx.env, { force: false });
		const ran = plans(from).map((p) => p.sql).join("\n");
		expect(ran).toContain("tg_posted_at >= '20' AND tg_posted_at < '21'");
		expect(ran).toContain("tg_posted_at >= ? AND tg_posted_at < ?");
		expect(fullScans(from)).toEqual([]);
	});

	it("peringatan Toto & Auto Prediksi (dipoll tiap 20 dtk per operator) + pindai notifikasi admin (tiap 5 menit) + percobaan ulang (tiap menit)", async () => {
		await ensureAutoInputTables(ctx.env);
		await pendingTotoAlerts(ctx.env, ["HUGO", "FOLA"]); // membuat tabel Toto
		const from = turso.current!.sqls.length;
		await pendingTotoAlerts(ctx.env, ["HUGO", "FOLA"]);
		await pendingFailureAlerts(ctx.env, "op", 2);
		await dueRetryJobs(ctx.env, 2, 2, 3);
		await scanFinalFailures(ctx.env);
		const ran = plans(from);
		expect(ran.some((p) => p.sql.includes("FROM toto_macau_log") && p.sql.includes("tg_sent = 0"))).toBe(true); // pindai notifikasi benar-benar jalan
		expect(fullScans(from)).toEqual([]);
		for (const p of ran.filter((x) => /FROM (toto_macau_log|auto_input_job)/.test(x.sql))) expect(p.plan.join(" ")).toMatch(/SEARCH .* USING INDEX/);
	});

	it("situs berita publik: daftar + jumlah + arsip acak tidak memindai seluruh artikel; jumlah disimpan 5 menit", async () => {
		seedArticles(600);
		const from = turso.current!.sqls.length;
		const a = await publicNewsList(ctx.env, "", 1, 6);
		const r1 = await publicNewsRandom(ctx.env, "", 6);
		const r2 = await publicNewsRandom(ctx.env, "bola", 6);
		expect(a.total).toBe(400);
		expect(r1.articles.length).toBeGreaterThan(0);
		expect(new Set(r1.articles.map((x) => x.id)).size).toBe(r1.articles.length); // tanpa duplikat
		// hanya artikel yang tayang di situs (kelipatan 3 = Blogger saja), dan kategori dihormati
		expect(r1.articles.every((x) => Number(x.id) % 3 !== 0)).toBe(true);
		expect(r2.articles.length).toBeGreaterThan(0);
		expect(r2.articles.every((x) => x.category === "bola" && Number(x.id) % 3 !== 0)).toBe(true);
		// daftar halaman = index berurutan + LIMIT (berhenti setelah N baris); COUNT pagination memang menghitung, tapi disimpan 5 menit (lihat bawah)
		const scans = fullScans(from).filter((p) => !/ORDER BY site_posted_at DESC, id DESC LIMIT/.test(p.sql) && !/^SELECT COUNT\(\*\)/.test(p.sql));
		expect(scans).toEqual([]);
		expect(plans(from).some((p) => /ORDER BY RANDOM\(\)/.test(p.sql))).toBe(false);
		// jumlah kedua kali tidak menghitung ulang
		const before = turso.current!.sqls.length;
		const b = await publicNewsList(ctx.env, "", 2, 6);
		expect(b.total).toBe(400);
		expect(turso.current!.sqls.slice(before).some((q) => /COUNT\(\*\)/.test(q))).toBe(false);
	});

	it("Live Chat bot (tarik + sinkron tiap 5 dtk): per pemilik lewat index", async () => {
		await syncSessionsFromScript(ctx.env, "op", [{ sessionKey: "1" }, { sessionKey: "2" }]);
		const from = turso.current!.sqls.length;
		await syncSessionsFromScript(ctx.env, "op", [{ sessionKey: "1" }]);
		await pullEnabledSessions(ctx.env, "op");
		expect(fullScans(from)).toEqual([]);
	});

	it("WD Listed (dipoll tiap 8 dtk): tidak berubah -> hanya membaca 1 baris revisi; tambah/hapus menaikkan revisi", async () => {
		ctx.db.prepare(`INSERT INTO users (username, username_lc, password_hash, role, status, websites) VALUES ('Bos','bos',?,'ADMIN','AKTIF','["HUGO"]')`).run(await hashPassword("pw"));
		const token = ((await checkLogin(ctx.env, "Bos", "pw", "")) as { sessionToken: string }).sessionToken;
		const row = { website: "HUGO", idTrans: "T1", tanggal: "x", idUser: "u", jumlah: 1, statusText: "Pending", pgaRefNo: "REF1", vendorName: "v" };
		await wdListedAdd(ctx.env, "Bos", [row], ["HUGO"]);
		const first = (await wdListedGetList(ctx.env, token)) as { rows: unknown[]; rev: number };
		expect(first.rows.length).toBe(1);
		const from = turso.current!.sqls.length;
		const again = (await wdListedGetList(ctx.env, token, first.rev)) as { unchanged?: boolean };
		expect(again.unchanged).toBe(true);
		expect(turso.current!.sqls.slice(from).some((q) => /FROM wd_listed\b/.test(q))).toBe(false); // daftar tidak dibaca
		await wdListedAdd(ctx.env, "Bos", [{ ...row, pgaRefNo: "REF2", idTrans: "T2" }], ["HUGO"]);
		const changed = (await wdListedGetList(ctx.env, token, first.rev)) as { rows: unknown[]; rev: number; unchanged?: boolean };
		expect(changed.unchanged).toBeUndefined();
		expect(changed.rows.length).toBe(2);
		await wdListedDelete(ctx.env, 1, ["HUGO"]);
		expect(await wdListedRev(ctx.env)).toBeGreaterThan(changed.rev);
	});
});
