// Port loginAWSInternal_ + sendToAWSInternal_ (LinkTree / AWS notif).
import type { LinktreeCfg } from "../lib/site";
import type { Processed } from "../lib/parser";
import { linktreeCfg } from "../lib/integrations";


async function loginLinktree(cfg: LinktreeCfg): Promise<string> {
	const res = await fetch(linktreeCfg().loginUrl, {
		method: "POST",
		redirect: "manual",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ email: cfg.email, password: cfg.pass }),
	});
	const many = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
	if (many.length) return many.map((c) => c.split(";")[0]).join("; ");
	const single = res.headers.get("set-cookie");
	if (!single) return "Error: Cookie tidak ditemukan";
	return single.split(";")[0];
}

export async function sendLinktree(cfg: LinktreeCfg, processed: Processed): Promise<string> {
	try {
		if (!cfg.email || !cfg.pass) return "Error: Kredensial LinkTree kosong";
		const cookie = await loginLinktree(cfg);
		if (cookie.startsWith("Error:")) return cookie;

		const marketName = processed.market && processed.market !== "UNKNOWN" ? processed.market : "LAOS SIANG";
		const title = `Hasil Pengeluaran Pasaran ${marketName}`;
		let body = `🅿️1️⃣ : ${processed.prize1 || "8145"}`;
		if (processed.prize2) body += `  🅿️2️⃣ : ${processed.prize2}`;
		if (processed.prize3) body += `  🅿️3️⃣ : ${processed.prize3}`;

		const res = await fetch(linktreeCfg().postUrl, {
			method: "POST",
			redirect: "manual",
			headers: { "content-type": "application/x-www-form-urlencoded", Cookie: cookie },
			body: new URLSearchParams({ apikey: linktreeCfg().apiKey, title, body }),
		});
		const respBody = await res.text();
		if (respBody.includes("LinkTree System")) return "Session Login Gagal";
		if (res.status === 200 || res.status === 302) return "Terkirim";
		return "Gagal (" + res.status + ")";
	} catch (e) {
		return "Error: " + (e instanceof Error ? e.message : String(e));
	}
}
