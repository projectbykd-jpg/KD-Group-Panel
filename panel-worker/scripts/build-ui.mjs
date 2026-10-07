// Build panel-worker/public/index.html from the legacy Apps Script HTML files.
// - Index.html  : page shell, contains <?!= include('Styles') ?> and <?!= include('Scripts') ?>
// - Styles.html : <style>...</style>
// - Scripts.html: <script>...</script>  (uses google.script.run)
//
// We inline Styles + Scripts and prepend a google.script.run -> fetch('/api') shim.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = (name) => readFileSync(resolve(root, "ui-src", name), "utf8");

const indexHtml = src("Index.html");
const stylesHtml = src("Styles.html");
const scriptsHtml = src("Scripts.html");
const fixesHtml = src("Fixes.html");
const liveResultFixHtml = src("LiveResultFix.html");
const redesignCss = src("Redesign.css");

// Positional-arg -> /api body-field mapping, keyed by function name.
const ARG_MAP = {
	checkLogin: ["username", "password"],
	resumeSession: ["token"],
	logout: ["token"],
	logoutSession: ["token"],
	getBootstrapData: ["token"],
	getDashboardData: ["token", "options"],
	getLivePanelData: ["token", "opts"],
	getCurrentUserProfile: ["token"],
	logClientActivity: ["token", "act", "detail", "status", "content"],
	smartAutoSendFast: ["rawText", "token"],
	retryFailedSystem: ["rawText", "token", "systemName", "website"],
	sendToPanelZOnly: ["market", "angka", "token"],
	adminListUsers: ["token"],
	adminSaveUser: ["token", "data"],
	adminDeleteUser: ["token", "targetUsername"],
	adminResetUserLock: ["token", "targetUsername"],
	adminListActiveSessions: ["token"],
	setMaintenance: ["token", "enabled", "message"],
	adminListSites: ["token"],
	adminSaveSite: ["token", "data"],
	adminDeleteSite: ["token", "website"],
	autoInputGetState: ["token"],
	autoInputSetEnabled: ["token", "enabled"],
	autoInputSaveSession: ["token", "data"],
	autoInputDeleteSession: ["token", "website"],
	autoInputClearJob: ["token", "jobId"],
	autoInputTest: ["token", "website", "market"],
	autoInputRun: ["token", "jobId"],
	getPredictionStatusData: ["token"],
	generateClosingPredictionCopy: ["token", "slot"],
	sendClosingPredictionAuto: ["token", "websites", "slot"],
	generatePredictionCopyBundle: ["index", "token"],
	sendPredictionAuto: ["index", "token", "websites"],
	adminRunActivityBackup: ["token"],
	setupAutoPostTriggers: ["token"],
	adminGetAutoPostWebhook: ["token"],
	adminSetAutoPost: ["token", "enabled"],
	adminRunAutoPostNow: ["token"],
	investGetConfig: ["token"],
	investSaveConfig: ["token", "payload"],
	investTestSession: ["token"],
	investStartScan: ["token"],
	investContinueScan: ["token"],
	investResetScan: ["token"],
	investGetStatus: ["token"],
	investGetWarnings: ["token"],
	pgaPendingSync: ["token", "rows"],
	pgaPendingStatus: ["token"],
	wdListedSync: ["token", "rows"],
	wdListedGetList: ["token"],
	wdListedCheck: ["token", "id"],
	wdListedRemove: ["token", "id"],
	lapGetConfig: ["token"],
	lapSaveConfig: ["token", "data"],
	adminGetSystemSettings: ["token"],
	adminSaveSystemSettings: ["token", "values"],
	assistantGetConfig: ["token"],
	assistantClearGaps: ["token"],
	assistantSaveConfig: ["token", "dedicated"],
	assistantModels: ["token", "base_url", "key"],
	assistantTest: ["token"],
	assistantStatus: ["token"],
	assistantAsk: ["token", "message", "history", "image"],
	lapGetSpecialOps: ["token"],
	lapSaveSpecialOps: ["token", "operators"],
	lapRunAdmin: ["token", "startDate", "endDate"],
	lapMotionImport: ["token", "startDate", "endDate", "depoPaidRows", "depoCreateRows", "wdRows"],
	lapMozartImport: ["token", "startDate", "endDate", "depositRows", "withdrawRows", "accountsRaw", "panelsRaw"],
	lapAdminStatus: ["token", "jobId"],
	lapJobs: ["token"],
	lapGetResults: ["token", "modules"],
	botNewsStatus: ["token"],
	botNewsSaveConfig: ["token", "data"],
	botNewsAddSource: ["token", "data"],
	botNewsToggleSource: ["token", "data"],
	botNewsDeleteSource: ["token", "data"],
	botNewsRunNow: ["token", "count"],
	botNewsRunSiteNow: ["token", "count"],
	botNewsRunViaGithub: ["token", "count", "target"],
	botNewsGithubRunStatus: ["token"],
	botFbRunNow: ["token"],
	botFbTemplateGenerate: ["token"],
	botNewsSkip: ["token", "data"],
	botBloggerAuthUrl: ["token"],
	botBloggerConnect: ["token", "data"],
	botBloggerTest: ["token"],
	botAiList: ["token"],
	botAiSave: ["token", "data"],
	botAiDelete: ["token", "data"],
	botAiReorder: ["token", "data"],
	botAiTopUp: ["token", "data"],
	botAiTest: ["token", "data"],
	botAiModels: ["token", "data"],
	livechatListSessions: ["token"],
	livechatGetBotKey: ["token"],
	livechatResetBotKey: ["token"],
	livechatSetBotEnabled: ["token", "sessionKey", "enabled"],
	livechatListTemplates: ["token"],
	livechatSaveTemplate: ["token", "data"],
	livechatDeleteTemplate: ["token", "id"],
	livechatRecentLogs: ["token"],
};

const shim = `<script>
/* ==== google.script.run -> fetch('/api') shim (panel-worker) ==== */
(function () {
  var API = "/api";
  var ARG_MAP = ${JSON.stringify(ARG_MAP)};
  var SESSION_EXEMPT = { checkLogin: 1, resumeSession: 1, getBootstrapData: 1, logout: 1, logoutSession: 1 };
  function call(fn, args, onOk, onErr) {
    var body = { action: fn };
    var names = ARG_MAP[fn];
    if (names) {
      for (var i = 0; i < names.length; i++) body[names[i]] = args[i];
    } else {
      body._args = Array.prototype.slice.call(args);
    }
    // Batas waktu: tanpa ini request yang menggantung (jaringan HP putus di
    // tengah jalan) membuat tombol "MENYIMPAN..." berputar selamanya.
    // 180 dtk sengaja longgar -- tarik laporan / proses BOT bisa puluhan detik.
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 180000) : null;
    fetch(API, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        if (timer) clearTimeout(timer);
        var data;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = t; }
        // Sesi ditolak server -> beri tahu panel sekali (lihat listener
        // 'kd:session-expired' di Scripts.html). Endpoint login/bootstrap
        // punya penanganan sendiri, jadi dikecualikan.
        if (data && data.success === false && !SESSION_EXEMPT[fn] &&
            /sesi tidak valid|telah berakhir|akun tidak ditemukan|akun sedang|akun terkunci/i.test(String(data.message || ""))) {
          try { window.dispatchEvent(new CustomEvent("kd:session-expired", { detail: String(data.message) })); } catch (e) {}
        }
        (onOk || function () {})(data);
      })
      .catch(function (e) {
        if (timer) clearTimeout(timer);
        var msg = e && e.name === "AbortError"
          ? "Server tidak merespons (lebih dari 3 menit). Coba lagi."
          : (navigator.onLine === false ? "Tidak ada koneksi internet." : "Tidak dapat menghubungi server. Periksa koneksi lalu coba lagi.");
        (onErr || function () {})(new Error(msg));
      });
  }
  function makeRunner(onOk, onErr) {
    return new Proxy(Object.create(null), {
      get: function (_t, prop) {
        if (prop === "withSuccessHandler") return function (cb) { return makeRunner(cb, onErr); };
        if (prop === "withFailureHandler") return function (cb) { return makeRunner(onOk, cb); };
        if (prop === "withUserObject") return function () { return makeRunner(onOk, onErr); };
        return function () { call(String(prop), arguments, onOk, onErr); };
      },
    });
  }
  var noop = function () {};
  window.google = window.google || {};
  window.google.script = {
    run: makeRunner(null, null),
    history: { push: noop, replace: noop, setChangeHandler: noop },
    host: { close: noop, setHeight: noop, origin: "", editor: { focus: noop } },
    url: { getLocation: function (cb) { cb && cb({ parameter: {}, parameters: {}, hash: "" }); } },
  };
})();
</script>`;

function buildTailwind() {
	const cli = resolve(root, "node_modules", "tailwindcss", "lib", "cli.js");
	if (!existsSync(cli)) {
		// Dulu jatuh diam-diam ke Tailwind Play CDN (compiler runtime di browser
		// -> panel berat). Sekarang build GAGAL supaya itu tidak pernah ter-deploy.
		console.error("ERROR: tailwindcss belum ter-install. Jalankan `npm ci` dulu.");
		process.exit(1);
	}
	const outCss = resolve(root, "public", "_tw.css");
	mkdirSync(dirname(outCss), { recursive: true });
	execFileSync(
		process.execPath,
		[cli, "-c", resolve(root, "tailwind.config.js"), "-i", resolve(root, "ui-src", "tw.css"), "-o", outCss, "--minify"],
		{ cwd: root, stdio: ["ignore", "ignore", "inherit"] },
	);
	return readFileSync(outCss, "utf8");
}
const tailwindCss = buildTailwind();

// Partial yang di-inline (Styles/Fixes/LiveResultFix/Scripts) hanya boleh berisi
// blok <style>/<script> + komentar HTML. Teks lain di luar tag itu -- mis. CSS
// yang tertulis sesudah </style> -- tampil mentah di halaman. Pernah terjadi
// (header "V5") dan dulu "diperbaiki" dengan JS yang menghapus teksnya.
for (const [name, html] of [["Styles.html", stylesHtml], ["Fixes.html", fixesHtml], ["LiveResultFix.html", liveResultFixHtml], ["Scripts.html", scriptsHtml]]) {
	const stray = html
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.trim();
	if (stray) {
		console.error(`ERROR: ui-src/${name} punya teks di luar <style>/<script> (akan tampil mentah di halaman):\n  ${stray.slice(0, 160)}`);
		process.exit(1);
	}
}

let out = indexHtml;
// Tailwind di-inline SESUDAH Styles.html: kalau sebelum, CSS custom menang atas
// utility Tailwind dan layout (mis. header) berantakan.
out = out.replace(
	/<\?!?=?\s*include\(\s*['"]Styles['"]\s*\)\s*;?\s*\?>/,
	() => stylesHtml + `\n<style id="tw-base">\n${tailwindCss}\n</style>\n<style id="kd-professional-redesign">\n${redesignCss}\n</style>`,
);
out = out.replace(/<\?!?=?\s*include\(\s*['"]Scripts['"]\s*\)\s*;?\s*\?>/, () => shim + "\n" + scriptsHtml + "\n" + fixesHtml + "\n" + liveResultFixHtml);
out = out.replace(/<\?!?=?[\s\S]*?\?>/g, "");

if (/<\?/.test(out) || /include\(/.test(out)) {
	console.error("ERROR: sisa scriptlet Apps Script masih ada di output.");
	process.exit(1);
}

// Cek sintaks SEMUA <script> inline sebelum ditulis: satu koma/kurung yang
// salah di Scripts.html dulu baru ketahuan sesudah deploy (panel blank).
// Sekarang build langsung gagal dan menyebut baris yang rusak.
let scriptNo = 0;
for (const m of out.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
	scriptNo++;
	try {
		new vm.Script(m[1], { filename: `inline-script-${scriptNo}.js` });
	} catch (e) {
		const line = out.slice(0, m.index).split("\n").length;
		console.error(`ERROR: sintaks JS rusak di <script> inline #${scriptNo} (public/index.html sekitar baris ${line}): ${e.message}`);
		console.error(String(e.stack || "").split("\n").slice(0, 4).join("\n"));
		process.exit(1);
	}
}

const outDir = resolve(root, "public");
mkdirSync(outDir, { recursive: true });
// Aset gambar milik panel (logo, favicon) disimpan di ui-src/ (public/ di-ignore
// karena hasil build) lalu disalin ke sini -- tidak lagi bergantung ke i.ibb.co.
for (const f of ["logo.png", "favicon.png"]) copyFileSync(resolve(root, "ui-src", f), resolve(outDir, f));
// Logo website (HUGO.svg, FOLA.svg, ...) & emblem role BOT (BOT.svg): nama KODE huruf besar + .svg. File PNG asli tetap
// disimpan di ui-src/ (tidak pernah hilang) tetapi TIDAK disalin ke produksi karena tidak dirujuk UI mana pun.
for (const f of readdirSync(resolve(root, "ui-src"))) {
	if (/^[A-Z]{2,8}\.svg$/.test(f)) copyFileSync(resolve(root, "ui-src", f), resolve(outDir, f));
}
// Cache aset statis (dulu: validasi ulang tiap kunjungan). Logo/ikon jarang berubah -> 1 hari; skrip bot Live Chat selalu segar.
writeFileSync(
	resolve(outDir, "_headers"),
	["/*.svg", "  Cache-Control: public, max-age=86400", "/logo.png", "  Cache-Control: public, max-age=86400", "/favicon.png", "  Cache-Control: public, max-age=86400", "/daylivechat-autobot.js", "  Cache-Control: no-cache", ""].join("\n"),
	"utf8",
);
// Bot Live Chat untuk BOOKMARKLET (tanpa Tampermonkey, tanpa file di laptop): kode yang sama dengan userscript,
// dilengkapi shim GM_getValue/GM_setValue berbasis localStorage & penjaga agar tidak dimuat dua kali.
{
	const shim = `if(typeof window.GM_getValue==="undefined"){window.GM_getValue=function(k,d){try{var v=localStorage.getItem("gm_"+k);return v===null?d:v}catch(e){return d}};window.GM_setValue=function(k,v){try{localStorage.setItem("gm_"+k,v)}catch(e){}};}`;
	const body = readFileSync(resolve(root, "userscripts", "daylivechat-autobot.user.js"), "utf8");
	// Dimuat lagi (bookmark diklik ulang) -> cukup buka/tutup panel kecil bot, jangan jalankan dua bot.
	const wrapped = `(function(){var f=document.getElementById("dgb-fab");if(window.__dgbLoaded||f){if(f)f.click();return;}window.__dgbLoaded=1;\n${shim}\n${body}\n})();`;
	writeFileSync(resolve(outDir, "daylivechat-autobot.js"), wrapped, "utf8");
}
writeFileSync(resolve(outDir, "index.html"), out, "utf8");
console.log("OK -> public/index.html (" + out.length + " bytes)");
