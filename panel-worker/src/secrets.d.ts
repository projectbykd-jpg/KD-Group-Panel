// Secret yang di-set via `wrangler secret put` (tidak muncul di wrangler.jsonc,
// jadi tidak ikut ter-generate oleh `wrangler types`).
interface Env {
	/** Kunci endpoint /__cron. Diisi dari GitHub secret CRON_KEY saat deploy
	 *  (deploy.yml -> wrangler deploy --secrets-file). Kosong = /__cron menolak semua. */
	CRON_KEY?: string;
	/** Fine-grained GitHub PAT, akses repo KD-scraper, Actions: read/write. */
	GH_TOKEN?: string;
	/** URL database Turso (libSQL) — tabel berat Laporan Harian + Invest. */
	TURSO_URL?: string;
	/** Auth token Turso (read & write). */
	TURSO_TOKEN?: string;
	/** Kunci bersama utk userscript daylivechat-autobot.user.js (Live Chat Auto-Reply) --
	 *  DayLiveChat mengunci login CS ke IP tertentu, jadi bot-nya HARUS jalan dari
	 *  browser CS sendiri (userscript), bukan dari server -- lihat livechat-bot.ts. */
	LIVECHAT_BOT_KEY?: string;
}
