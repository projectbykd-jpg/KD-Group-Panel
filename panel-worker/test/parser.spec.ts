import { describe, expect, it } from "vitest";
import { canonicalResultKey, convertMarketToPanel, getShio, processText } from "../src/lib/parser";

const SAMPLE = `Pasaran SYDNEY
Prize 1 : 4821
Prize 2 : 1290
Prize 3 : 7765
Shio : KERBAU
Selamat kepada para pemenang jackpot.`;

describe("getShio", () => {
	it("memetakan 2 digit ke shio sesuai tabel lama", () => {
		expect(getShio(1)).toBe("KUDA");
		expect(getShio(12)).toBe("KAMBING");
		expect(getShio(13)).toBe("KUDA");
		expect(getShio(0)).toBe("KELINCI"); // kasus khusus warisan Apps Script
		expect(getShio(Number.NaN)).toBe("UNKNOWN");
	});
});

describe("processText", () => {
	it("mengurai pasaran, prize dan shio", () => {
		const p = processText(SAMPLE);
		expect(p.market).toBe("SYDNEY");
		expect([p.prize1, p.prize2, p.prize3]).toEqual(["4821", "1290", "7765"]);
		expect(p.twoDigit).toBe(21);
		expect(p.shio).toBe(getShio(21));
	});

	it("menandai SALAH kalau shio yang ditulis tidak cocok, dan membetulkan teksnya", () => {
		const p = processText(SAMPLE);
		expect(p.status).toBe(p.shio === "KERBAU" ? "BENAR" : "SALAH");
		expect(p.output).toContain("Shio : " + p.shio);
		expect(p.output).toContain("Prize 1️⃣ :");
		expect(p.output).toContain("Selamat kepada para pemenang jackpot 🙏🏻");
	});

	it("menambahkan baris shio kalau belum ada", () => {
		const p = processText("Pasaran OSAKA\nPrize 1 : 1234");
		expect(p.status).toBe("BENAR");
		expect(p.output.endsWith("Shio : " + getShio(34))).toBe(true);
	});

	it("menolak teks tanpa Prize 1", () => {
		expect(processText("Pasaran OSAKA\nbelum keluar").status).toBe("SALAH");
		expect(processText("").market).toBe("UNKNOWN");
	});
});

describe("convertMarketToPanel / canonicalResultKey", () => {
	it("memetakan nama pasaran ke slug Panel-Z (tidak peka huruf besar/kecil)", () => {
		expect(convertMarketToPanel("sydney")).toBe("sydney");
		expect(convertMarketToPanel("HK SIANG")).toBe("hk-siang");
		expect(convertMarketToPanel("TIDAK ADA")).toBeNull();
	});

	it("kunci dedup sama untuk teks yang beda format tapi angkanya sama", () => {
		const a = canonicalResultKey(SAMPLE);
		const b = canonicalResultKey(SAMPLE.replace(/\n/g, "\n\n").replace("Shio : KERBAU", ""));
		expect(a).toBe("RESULT|SYDNEY|4821|1290|7765");
		expect(b).toBe(a);
	});
});
