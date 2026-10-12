import { describe, expect, it } from "vitest";
import { captionRejectReason, clipCaption, fallbackCaption, parseFbTemplateReply, stripEchoedPlaceholders } from "../src/lib/bot-news";

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

describe("Template FB: jawaban AI rusak ditolak (provider berikutnya dicoba)", () => {
	const good = "63.789 orang kena PHK sepanjang tahun ini, dan satu provinsi menyumbang paling banyak. Kira-kira provinsi mana? 👇";
	it("kasus nyata: potongan rencana model penalaran ditolak", () => {
		const raw = "tight and snappy:\n1. Kementerian Ketenagakerjaan baru saja merilis";
		expect(() => parseFbTemplateReply(raw)).toThrow(/ditolak/);
	});
	it("menolak: terpotong, daftar draf, catatan bahasa Inggris, label berakhiran titik dua, think tak tertutup", () => {
		for (const raw of [
			"Kementerian Ketenagakerjaan baru saja merilis data PHK terbaru yang cukup mengejutkan dan",
			"Berikut captionnya:\nKementerian Ketenagakerjaan merilis data PHK terbaru tahun ini.",
			"- Kementerian merilis data PHK terbaru tahun ini.\n- Provinsi terbanyak ada di Jawa.",
			"Here's a caption for the news about layoffs in Indonesia today.",
			"<think>Pengguna minta caption singkat, aku akan menulis",
		]) {
			expect(captionRejectReason(stripEchoedPlaceholders(raw)), raw).not.toBe("");
		}
	});
	it("caption layak diterima; blok <think> dibuang; hashtag tetap terbaca", () => {
		const r = parseFbTemplateReply(`<think>rencana panjang...</think>\n${good}\n===HASHTAG===\n#PHK #Kemnaker #BeritaTerkini`);
		expect(r.text).toBe(good);
		expect(r.hashtags).toEqual(["#PHK", "#Kemnaker", "#BeritaTerkini"]);
		for (const ok of ["Harga emas naik lagi hari ini, sudah cek tabunganmu belum?", "Timnas menang 2-0! Siapa yang nonton semalam? ⚽🔥", 'Kata menteri soal harga BBM: "kita siap."']) {
			expect(captionRejectReason(ok), ok).toBe("");
		}
	});
	it("penanda ===HASHTAG=== hilang tapi hashtag ada di baris akhir -> tetap dipakai", () => {
		const r = parseFbTemplateReply(`${good}\n#PHK #Kemnaker`);
		expect(r.text).toBe(good);
		expect(r.hashtags).toEqual(["#PHK", "#Kemnaker"]);
	});
	it("caption panjang dipotong di akhir kalimat, bukan di tengah kata", () => {
		const long = "Kalimat pembuka yang cukup panjang untuk caption. ".repeat(15).trim();
		const c = clipCaption(long, 500);
		expect(c.length).toBeLessThanOrEqual(500);
		expect(c.endsWith(".")).toBe(true);
	});
	it("cadangan tanpa AI: judul + kalimat pertama ringkasan", () => {
		expect(fallbackCaption({ title: "63.789 Orang Jadi Korban PHK", excerpt: "Data PHK terbaru dirilis Kemnaker. Jawa Barat tertinggi." })).toBe(
			"63.789 Orang Jadi Korban PHK\n\nData PHK terbaru dirilis Kemnaker.",
		);
		expect(fallbackCaption({ title: "Judul saja", excerpt: "" })).toBe("Judul saja");
	});
});
