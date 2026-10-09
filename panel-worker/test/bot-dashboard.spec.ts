import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { botNewsSnapshot, ensureNewsCategoryColumns, resetNewsColumnsGuard } from "../src/lib/bot-news";
import { resetIntegrationsCache, loadIntegrations } from "../src/lib/integrations";
import { fakeEnv, fakeTurso } from "./helpers/fake-env";

const wib = (offsetDays = 0, time = "10:00:00") =>
	new Date(Date.now() + 7 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10) + " " + time;
let n = 0;
function add(o: { status?: string; posted_at?: string; site_posted_at?: string; fb?: string }) {
	n++;
	turso.current!.raw
		.prepare(`INSERT INTO news_article (id, url, url_hash, title, status, posted_at, site_posted_at, fb_direct_posted_at, found_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01 00:00:00')`)
		.run(n, `https://n.test/${n}`, `h${n}`, `J${n}`, o.status ?? "new", o.posted_at ?? "", o.site_posted_at ?? "", o.fb ?? "");
}

beforeEach(() => {
	turso.current = fakeTurso();
	resetIntegrationsCache();
	n = 0;
});

describe("Dashboard Bot: jalur punya hitungan harian yang setara", () => {
	it("Blogger, Situs Sendiri, Template FB, dan Channel Telegram masing-masing punya hari ini + total + tren 7 hari", async () => {
		add({ status: "posted", posted_at: wib(0) }); add({ status: "posted", posted_at: wib(0, "11:00:00") }); add({ status: "posted", posted_at: wib(-1) });
		add({ status: "site", site_posted_at: wib(0) }); add({ status: "site", site_posted_at: wib(0, "12:00:00") }); add({ status: "site", site_posted_at: wib(0, "13:00:00") }); add({ status: "site", site_posted_at: wib(-2) });
		add({ status: "new", fb: wib(0) }); add({ status: "new", fb: "error" }); add({ status: "new", fb: wib(-3) });
		add({ status: "new" }); add({ status: "error" });

		const env = fakeEnv().env;
		await loadIntegrations(env);
		const s = (await botNewsSnapshot(env)) as unknown as {
			postedToday: number; siteToday: number; siteTotal: number; fbDirectPostedToday: number; fbTotal: number; fbDirectQueue: number;
			byStatus: Record<string, number>; daily7: { date: string; blogger: number; site: number; fb: number; tg: number }[]; config: { site_url: string };
		};
		expect(s.postedToday).toBe(2);
		expect(s.siteToday).toBe(3);          // dulu TIDAK ADA -- hanya Blogger yang punya hitungan hari ini
		expect(s.siteTotal).toBe(4);
		expect(s.fbDirectPostedToday).toBe(1);
		expect(s.fbTotal).toBe(2);            // 'error' tidak dihitung
		expect(s.byStatus.posted).toBe(3);

		expect(s.daily7).toHaveLength(7);
		const today = s.daily7[6], yday = s.daily7[5];
		expect(today).toMatchObject({ blogger: 2, site: 3, fb: 1 });
		expect(yday).toMatchObject({ blogger: 1, site: 0, fb: 0 });
		expect(s.daily7[4].site).toBe(1);     // 2 hari lalu
		expect(s.daily7[3].fb).toBe(1);       // 3 hari lalu
		expect(s.daily7[0].date < s.daily7[6].date).toBe(true); // terlama dulu
		expect(s.config.site_url).toMatch(/^https:\/\//);       // alamat situs dari Admin > Integrasi
	});

	it("jalur Channel Telegram: hari ini, total, batas harian, tren 7 hari, dan riwayat (terbaru dulu)", async () => {
		resetNewsColumnsGuard();
		const env = fakeEnv().env;
		await ensureNewsCategoryColumns(env);
		const raw = turso.current!.raw;
		const ins = (id: number, tg: string, title: string) =>
			raw.prepare(`INSERT INTO news_article (id, url, url_hash, title, status, site_posted_at, tg_posted_at, found_at) VALUES (?, ?, ?, ?, 'posted', ?, ?, '2026-01-01 00:00:00')`).run(id, `https://t.test/${id}`, `t${id}`, title, wib(0), tg);
		ins(901, wib(0, "09:00:00"), "Tg hari ini 1"); ins(902, wib(0, "11:00:00"), "Tg hari ini 2"); ins(903, wib(-1, "10:00:00"), "Tg kemarin");
		ins(904, "error", "Tg gagal"); ins(905, "", "Belum dikirim");
		await loadIntegrations(env);
		const s = (await botNewsSnapshot(env)) as unknown as {
			tg: { postedToday: number; total: number; cap: number; gapMin: number; queue: number; lastAt: string };
			daily7: { tg: number }[]; tgHistory: { id: number; title: string }[]; config: { tg_channel_enabled: boolean };
		};
		expect(s.tg).toMatchObject({ postedToday: 2, total: 3, cap: 500, gapMin: 5 });
		expect(s.tg.queue).toBe(1); // hanya yang belum dikirim & masih dalam umur maksimum
		expect(s.tg.lastAt).toBe(wib(0, "11:00:00"));
		expect(s.daily7[6].tg).toBe(2);
		expect(s.daily7[5].tg).toBe(1);
		expect(s.tgHistory.map((h) => h.title)).toEqual(["Tg hari ini 2", "Tg hari ini 1", "Tg kemarin"]); // 'error' & belum dikirim tidak masuk riwayat
		expect(s.config.tg_channel_enabled).toBe(false);
	});
});
