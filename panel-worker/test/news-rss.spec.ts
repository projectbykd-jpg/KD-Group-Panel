import { beforeEach, describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown; raw: import("node:sqlite").DatabaseSync } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { publicNewsRssXml } from "../src/lib/bot-news";
import { resetIntegrationsCache, loadIntegrations } from "../src/lib/integrations";
import { fakeEnv, fakeTurso } from "./helpers/fake-env";

function add(id: number, o: { title: string; excerpt?: string; image?: string; cat?: string; site?: string; status?: string }) {
	turso.current!.raw
		.prepare(`INSERT INTO news_article (id, url, url_hash, title, excerpt, image_url, category, status, site_posted_at, found_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01 00:00:00')`)
		.run(id, `https://n.test/${id}`, `h${id}`, o.title, o.excerpt ?? "", o.image ?? "", o.cat ?? "", o.status ?? "site", o.site ?? "");
}

beforeEach(() => {
	turso.current = fakeTurso();
	resetIntegrationsCache();
});

describe("umpan RSS artikel situs sendiri (untuk RSS-ke-Facebook)", () => {
	it("hanya artikel yang tayang di situs, terbaru dulu, tautan ke web berita, XML aman", async () => {
		add(1, { title: "Lama", site: "2026-10-01 08:00:00", excerpt: "ringkas lama" });
		add(2, { title: 'Baru & "penting" <b>', site: "2026-10-07 09:30:00", excerpt: "isi <script>x</script>", image: "https://img.test/a.png", cat: "bola" });
		add(3, { title: "Belum tayang", site: "", status: "new" });
		const env = fakeEnv().env;
		await loadIntegrations(env);
		const xml = await publicNewsRssXml(env);

		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
		expect(xml).toContain('<rss version="2.0">');
		expect(xml).not.toContain("Belum tayang");
		expect(xml.indexOf("Baru")).toBeLessThan(xml.indexOf("Lama"));
		expect(xml).toContain("/berita/artikel/?id=2</link>");
		expect(xml).toContain("Baru &amp; &quot;penting&quot; &lt;b&gt;");   // karakter berbahaya di-escape
		expect(xml).not.toContain("<script>");
		expect(xml).toContain('<enclosure url="https://img.test/a.png" type="image/png" length="0"/>');
		expect(xml).toContain("<category>bola</category>");
		expect(xml).toContain("<pubDate>Wed, 07 Oct 2026 02:30:00 GMT</pubDate>"); // 09:30 WIB = 02:30 UTC
	});

	it("<description> berisi caption Facebook lengkap: judul, ringkasan, tautan, promosi web berita, hashtag (seperti Template FB)", async () => {
		add(7, { title: "Final Padel Putri", site: "2026-10-07 09:30:00", excerpt: "Ringkasan pertandingan final.", cat: "olahraga" });
		const env = fakeEnv().env;
		await loadIntegrations(env);
		const xml = await publicNewsRssXml(env);
		const desc = xml.match(/<description>(Final Padel Putri[^<]*)<\/description>/)?.[1] ?? "";
		expect(desc).toContain("Ringkasan pertandingan final.");
		expect(desc).toContain("🔗 Baca selengkapnya: https://");
		expect(desc).toContain("/berita/artikel/?id=7");
		expect(desc).toContain("📰 Kunjungi web berita kami:");
		expect(desc).toContain("#Olahraga");          // hashtag kategori
		expect(desc).toContain("#LapakStore88");      // hashtag tetap (Admin > Data Master)
		expect(desc.indexOf("Final Padel Putri")).toBe(0); // judul di baris pertama
	});

	it("tanpa artikel -> tetap RSS valid (kosong), tidak error", async () => {
		const env = fakeEnv().env;
		await loadIntegrations(env);
		const xml = await publicNewsRssXml(env);
		expect(xml).toContain("<channel>");
		expect(xml).not.toContain("<item>");
	});
});
