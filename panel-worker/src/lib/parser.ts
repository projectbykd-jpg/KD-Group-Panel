// Port processText_ / getShio_ / convertMarketToPanel_ dari Sending.gs — identik.

export interface Processed {
	market: string;
	status: string; // BENAR | SALAH
	shio: string;
	twoDigit: number | "";
	output: string;
	prize1: string;
	prize2: string;
	prize3: string;
}

function empty(): Processed {
	return { market: "UNKNOWN", status: "SALAH", shio: "", twoDigit: "", output: "", prize1: "", prize2: "", prize3: "" };
}

export const SHIO_ORDER = [
	"", // idx 0 tak dipakai
	"KUDA",
	"ULAR",
	"NAGA",
	"KELINCI",
	"HARIMAU",
	"KERBAU",
	"TIKUS",
	"BABI",
	"ANJING",
	"AYAM",
	"MONYET",
	"KAMBING",
];

/** Shio untuk angka 00 (bawaan KELINCI, bukan KAMBING -- sesuai map lama). Bisa diubah admin (Data Master). */
export const SHIO_CONFIG = { zero: "KELINCI" };

export function getShio(num: number): string {
	if (!Number.isFinite(num)) return "UNKNOWN";
	if (num === 0) return SHIO_CONFIG.zero;
	const r = num % 12;
	return SHIO_ORDER[r === 0 ? 12 : r] || "UNKNOWN";
}

export function processText(text: string): Processed {
	try {
		if (!text || text.length < 5) return empty();

		const marketMatch = text.match(/Pasaran\s+(.*)/i);
		const market = marketMatch ? marketMatch[1].trim() : "UNKNOWN";
		const prize1 = (text.match(/Prize\s*1[^0-9]*(\d{4})/i) || [])[1] || "";
		if (!prize1) {
			return { market, status: "SALAH", shio: "", twoDigit: "", output: "", prize1: "", prize2: "", prize3: "" };
		}

		const prize2 = (text.match(/Prize\s*2[^0-9]*(\d{4})/i) || [])[1] || "";
		const prize3 = (text.match(/Prize\s*3[^0-9]*(\d{4})/i) || [])[1] || "";
		const twoDigit = Number(prize1.slice(-2));
		const shio = getShio(twoDigit);
		const shioInput = ((text.match(/Shio\s*:\s*([A-Z]+)/i) || [])[1] || "").toUpperCase();
		const status = shioInput ? (shioInput === shio ? "BENAR" : "SALAH") : "BENAR";

		let output = text
			.trim()
			.replace(/Prize\s*1\s*:/gi, "Prize 1️⃣ :")
			.replace(/Prize\s*2\s*:/gi, "Prize 2️⃣ :")
			.replace(/Prize\s*3\s*:/gi, "Prize 3️⃣ :");
		if (/Shio\s*:/i.test(output)) {
			output = output.replace(/Shio\s*:.*$/im, "Shio : " + shio);
		} else {
			output += "\n\nShio : " + shio;
		}
		output = output.replace(
			/Selamat kepada para pemenang jackpot\s*\.?/i,
			"Selamat kepada para pemenang jackpot 🙏🏻",
		);

		return { market, status, shio, twoDigit, output, prize1, prize2, prize3 };
	} catch {
		return empty();
	}
}

export const MARKET_TO_PANEL: Record<string, string> = {
	ATHENS: "athens", AUSTRIA: "austria", BAHRAIN: "bahrain", BERLIN: "berlin", BULLSEYE: "bullseye",
	BUSAN: "busan", CAIRO: "cairo", CALIFORNIA: "california", CAROLINADAY: "carolina-day", CAROLINAEVE: "carolina-eve",
	COLORADO: "colorado", DALLAS: "dallas", FLORIDAEVE: "florida-eve", FLORIDAMID: "florida-mid", "HK SIANG": "hk-siang",
	HONGKONG: "hongkong", IDAHO: "idaho", "INDIA MORNING": "india-mor", INDIA: "india-night", KANSAS: "kansas",
	KENTUCKYEVE: "kentucky-eve", KENTUCKYMID: "kentucky-mid", "KHMER LOTTO": "khmer-lotto", "LAOS MALAM": "laos-malam",
	"LAOS SIANG": "laos-siang", LISBON: "lisbon-mor", "LISBON NIGHT": "lisbon-night", MALAYSIA: "malaysia",
	"NEW MEXICO": "mexico-day", MEXICO: "mexico-night", MICHIGAN: "michigan", MONTANA: "montana", NEBRASKA: "nebraska",
	NEWYORKEVE: "newyork-eve", NEWYORKMID: "newyork-mid", "NIPPON LOTTO": "nippon-lotto", OHIO: "ohio",
	OREGON12: "oregon12", OREGON03: "oregon3", OREGON06: "oregon6", OREGON09: "oregon9", OSAKA: "osaka",
	PANAMA: "panama", PARIS: "paris", PARMA: "parma", ROMA: "roma", RUSIA: "rusia", "SAPPORO EVE": "sapporo-eve",
	SAPPORO: "sapporo-mid", SINGAPORE: "singapore", SYDNEY: "sydney", "TAIPEI LOTTO": "taipei-lotto", THAILAND: "thailand",
	"TIONGKOK 4D": "tiongkok-4D", TURKEY: "turkey", "TOTOMACAU-13": "totomacau-13", "TOTOMACAU-16": "totomacau-16",
	"TOTOMACAU-19": "totomacau-19", "TOTOMACAU-22": "totomacau-22", "TOTOMACAU-23": "totomacau-23", "TOTOMACAU-00": "totomacau-00",
	"TOTOMACAU-15-5D": "totomacau-15-5d", "TOTOMACAU-21-5D": "totomacau-21-5d",
	"CANADA POOLS": "canada", "CANADA POOL": "canada", CANADA: "canada",
	"ARIZONA POOLS": "arizona", "ARIZONA POOL": "arizona", ARIZONA: "arizona",
	"BRAZIL LOTTO": "brazil", BRAZIL: "brazil", "JAKARTA LOTTO": "jakarta", JAKARTA: "jakarta",
	"MANILA LOTTO": "manila", MANILA: "manila", "BALI LOTTO": "bali", BALI: "bali",
};

export function convertMarketToPanel(market: string): string | null {
	return MARKET_TO_PANEL[String(market ?? "").toUpperCase()] || null;
}

/** Kunci dedup dari hasil terparse (Pasaran + Prize 1/2/3) — port dgCanonicalResultKey_. */
export function canonicalResultKey(text: string, processed?: Processed): string {
	const p = processed ?? processText(text);
	if (p && p.prize1) {
		return (
			"RESULT|" +
			String(p.market ?? "").trim().toUpperCase() +
			"|" +
			p.prize1 +
			"|" +
			(p.prize2 || "") +
			"|" +
			(p.prize3 || "")
		);
	}
	return String(text ?? "").trim();
}
