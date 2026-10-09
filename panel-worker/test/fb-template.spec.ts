import { describe, expect, it } from "vitest";
import { parseFbTemplateReply, stripEchoedPlaceholders } from "../src/lib/bot-news";

describe("Template FB: placeholder prompt tidak ikut ke caption", () => {
	it("membuang baris <caption> yang disalin AI (kasus nyata)", () => {
		const r = parseFbTemplateReply("<caption>\nSiapa sangka, jejak sejarah tersimpan. 🤔\n===HASHTAG===\n#Sejarah #Belanda");
		expect(r.text).toBe("Siapa sangka, jejak sejarah tersimpan. 🤔");
		expect(r.hashtags).toEqual(["#Sejarah", "#Belanda"]);
	});
	it("variasi: </caption>, [caption], 'Caption:' dan tanda kutip", () => {
		for (const raw of ["<caption>Halo dunia</caption>", "[caption]\nHalo dunia", "**Caption:** Halo dunia", "Caption: Halo dunia", '"Halo dunia"', "<CAPTION> Halo dunia"]) {
			expect(stripEchoedPlaceholders(raw), raw).toBe("Halo dunia");
		}
	});
	it("caption normal tidak berubah, kata 'caption' di tengah kalimat tetap aman", () => {
		expect(stripEchoedPlaceholders("Ini caption yang bagus untuk berita hari ini")).toBe("Ini caption yang bagus untuk berita hari ini");
	});
	it("balasan hanya placeholder -> ditolak (jatuh ke judul)", () => {
		expect(() => parseFbTemplateReply("<caption>\n===HASHTAG===\n#a")).toThrow();
	});
});
