// Port dari V6Core.gs dgPbkdf2Sha256_ / dgVerifyPassword_ / dgHashPassword_.
// Format hash lama: "pbkdf2-sha256$2000$<salt>$<base64url-no-pad>"
// base64url dari 32 byte pertama PBKDF2-HMAC-SHA256 (1 blok) -> identik dengan
// crypto.subtle.deriveBits(PBKDF2, 256 bit).

const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 2000;

function b64urlNoPad(buf: ArrayBuffer): string {
	let bin = "";
	const bytes = new Uint8Array(buf);
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Perbandingan string waktu-konstan -- dipakai utk password & kunci rahasia
 *  (CRON_KEY, kunci userscript, kunci job) supaya tidak bisa ditebak lewat timing. */
export function constEq(a: string, b: string): boolean {
	a = a ?? "";
	b = b ?? "";
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
}

export async function pbkdf2Sha256(password: string, salt: string, iterations: number): Promise<string> {
	const key = await crypto.subtle.importKey("raw", enc.encode(password ?? ""), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt: enc.encode(salt ?? ""), iterations, hash: "SHA-256" },
		key,
		256,
	);
	return b64urlNoPad(bits);
}

export function isHashed(stored: string): boolean {
	return String(stored ?? "").startsWith("pbkdf2-sha256$");
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
	stored = String(stored ?? "");
	if (!stored.startsWith("pbkdf2-sha256$")) return constEq(stored, String(password ?? ""));
	const parts = stored.split("$");
	if (parts.length !== 4) return false;
	const iter = Math.max(1, Number(parts[1]) || PBKDF2_ITERATIONS);
	const actual = await pbkdf2Sha256(String(password ?? ""), parts[2], iter);
	return constEq(actual, parts[3]);
}

export async function hashPassword(password: string): Promise<string> {
	const salt =
		crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
	const hash = await pbkdf2Sha256(String(password ?? ""), salt, PBKDF2_ITERATIONS);
	return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

/** SHA-256 hex dari string yang di-trim — port contentHash_ di PanelCore.gs. */
export async function sha256Hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", enc.encode(String(input ?? "").trim()));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
