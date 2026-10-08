// ==UserScript==
// @name         DayLiveChat Auto-Reply Bot (Day-Group Panel)
// @namespace    daygroup-panel
// @version      2.3.0
// @description  Balas otomatis member yang spam/kasar di sesi chat yang DIPILIH lewat Day-Group Panel (Live Chat > Sesi Chat). Sesi yang tidak diaktifkan tetap 100% manual.
// @author       Day-Group Panel
// @match        https://daylivechat.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      workers.dev
// ==/UserScript==

// CATATAN ARSITEKTUR (penting, jangan diubah tanpa alasan kuat): DayLiveChat
// mengunci login akun CS ke IP tertentu (fitur keamanan resmi mereka -- login
// dari server/Cloudflare Worker TERBUKTI selalu ditolak 403 "IP tidak
// diizinkan untuk akun ini", walau kredensial benar, dan tidak ada akses
// admin DayLiveChat untuk melonggarkan itu). Karena itu bot ini HARUS jalan
// dari browser CS sendiri (IP-nya sudah diizinkan), TAPI tetap TIDAK
// menyimpan password sama sekali -- cukup pakai:
//   1. Token login ('lc_token') yang SUDAH ADA di localStorage begitu CS
//      login manual seperti biasa (lihat shared.js situsnya).
//   2. Client Socket.IO ASLI yang sudah dimuat halaman ini sendiri (window.io
//      dari /socket.io/socket.io.js) -- BUKAN implementasi protokol manual.
// Jadi TIDAK ADA kalibrasi/DOM-scraping sama sekali (beda dari versi lama) --
// semuanya lewat REST + Socket.IO resmi yang sudah dibongkar dari
// /js/cs-dashboard.js situsnya sendiri.
(function () {
	"use strict";

	const win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

	const CFG_KEY = "dgpanel_livechat_cfg_v2";
	const REPLIED_KEY = "dgpanel_livechat_replied_v2";

	function loadCfg() {
		let cfg = {};
		try {
			cfg = JSON.parse(GM_getValue(CFG_KEY, "{}")) || {};
		} catch (e) {
			cfg = {};
		}
		return Object.assign({ panelUrl: "https://panel-worker.projectbykd.workers.dev", botKey: "", masterOn: false }, cfg);
	}
	function saveCfg(cfg) {
		GM_setValue(CFG_KEY, JSON.stringify(cfg));
	}
	let CFG = loadCfg();

	function loadRepliedMap() {
		try {
			return JSON.parse(GM_getValue(REPLIED_KEY, "{}")) || {};
		} catch (e) {
			return {};
		}
	}
	function saveRepliedMap(m) {
		const keys = Object.keys(m);
		if (keys.length > 500) {
			keys
				.sort((a, b) => (m[a] || 0) - (m[b] || 0))
				.slice(0, keys.length - 500)
				.forEach((k) => delete m[k]);
		}
		GM_setValue(REPLIED_KEY, JSON.stringify(m));
	}
	let REPLIED = loadRepliedMap();

	// Toleransi sebelum membalas member yang BARU chat 1x (belum dianggap spam).
	const GRACE_MS = 30_000;
	// SATU balasan per burst: selama member masih spam (jeda antar pesan < BURST_RESET_MS) bot TIDAK membalas lagi.
	// Jeda tanpa pesan baru sebelum burst dianggap selesai (balasan berikutnya baru boleh).
	const BURST_RESET_MS = 90_000;

	function getToken() {
		try {
			return win.localStorage.getItem("lc_token") || "";
		} catch (e) {
			return "";
		}
	}

	function panelApi(action, body) {
		return fetch(CFG.panelUrl.replace(/\/+$/, "") + "/api", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(Object.assign({ action, key: CFG.botKey }, body || {})),
		})
			.then((r) => r.json())
			.catch((e) => {
				log("Panel error: " + (e && e.message ? e.message : e));
				return null;
			});
	}

	// ===================== Widget mengambang (UI ringkas -- cuma setting + status) =====================
	const style = document.createElement("style");
	style.textContent = `
		#dgb-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:56px;height:56px;border-radius:50%;
			background:linear-gradient(135deg,#22d3ee,#2563eb);display:flex;align-items:center;justify-content:center;
			box-shadow:0 6px 24px rgba(0,0,0,.35);cursor:pointer;font-size:24px;user-select:none;}
		#dgb-fab.on{background:linear-gradient(135deg,#34d399,#10b981);}
		#dgb-panel{position:fixed;right:18px;bottom:84px;z-index:2147483000;width:320px;max-height:70vh;overflow-y:auto;
			background:#0f172a;color:#e2e8f0;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:14px;
			font:12px/1.5 system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.5);display:none;}
		#dgb-panel.open{display:block;}
		#dgb-panel h4{margin:0 0 8px;font-size:13px;font-weight:800;color:#67e8f9;}
		#dgb-panel label{display:block;margin:8px 0 3px;font-size:10px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:.04em;}
		#dgb-panel input[type=text],#dgb-panel input[type=password]{width:100%;box-sizing:border-box;background:#1e293b;
			border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:7px 9px;color:#fff;font-size:12px;}
		#dgb-panel .row{display:flex;gap:6px;align-items:center;margin:4px 0;}
		#dgb-panel button{background:#1e293b;border:1px solid rgba(255,255,255,.1);color:#e2e8f0;border-radius:8px;
			padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer;}
		#dgb-panel button.primary{background:linear-gradient(135deg,#22d3ee,#2563eb);color:#04121f;border:none;width:100%;padding:9px;margin-top:10px;}
		#dgb-panel .dot{width:8px;height:8px;border-radius:50%;background:#64748b;display:inline-block;margin-right:5px;}
		#dgb-panel .dot.ok{background:#34d399;}
		#dgb-log{margin-top:8px;max-height:140px;overflow-y:auto;font-size:10px;color:#94a3b8;border-top:1px solid rgba(255,255,255,.08);padding-top:6px;}
		#dgb-log div{margin-bottom:3px;}
	`;
	document.documentElement.appendChild(style);

	const fab = document.createElement("div");
	fab.id = "dgb-fab";
	fab.title = "Auto-Reply Bot (Day-Group Panel)";
	fab.textContent = "🤖";
	document.documentElement.appendChild(fab);

	const panel = document.createElement("div");
	panel.id = "dgb-panel";
	panel.innerHTML = `
		<h4>🤖 Auto-Reply Bot</h4>
		<label>URL Panel</label>
		<input type="text" id="dgb-url" placeholder="https://panel-worker.projectbykd.workers.dev">
		<label>Kunci Bot (LIVECHAT_BOT_KEY)</label>
		<input type="password" id="dgb-key" placeholder="minta ke admin">
		<div class="row" style="margin-top:10px;">
			<span class="dot" id="dgb-dot-master"></span><b id="dgb-master-label">NONAKTIF</b>
			<button id="dgb-toggle-master" style="margin-left:auto;">Nyalakan</button>
		</div>
		<div class="row"><span class="dot" id="dgb-dot-login"></span>Login DayLiveChat</div>
		<button class="primary" id="dgb-save">Simpan Pengaturan</button>
		<div id="dgb-log"></div>
	`;
	document.documentElement.appendChild(panel);

	function log(msg) {
		const box = document.getElementById("dgb-log");
		if (!box) return;
		const line = document.createElement("div");
		line.textContent = "[" + new Date().toLocaleTimeString() + "] " + msg;
		box.prepend(line);
		while (box.children.length > 40) box.removeChild(box.lastChild);
	}

	function refreshPanelUI() {
		document.getElementById("dgb-url").value = CFG.panelUrl || "";
		document.getElementById("dgb-key").value = CFG.botKey || "";
		const masterDot = document.getElementById("dgb-dot-master");
		const masterLabel = document.getElementById("dgb-master-label");
		const masterBtn = document.getElementById("dgb-toggle-master");
		if (masterDot) masterDot.classList.toggle("ok", !!CFG.masterOn);
		if (masterLabel) masterLabel.textContent = CFG.masterOn ? "AKTIF" : "NONAKTIF";
		if (masterBtn) masterBtn.textContent = CFG.masterOn ? "Matikan" : "Nyalakan";
		fab.classList.toggle("on", !!CFG.masterOn);
		const loginDot = document.getElementById("dgb-dot-login");
		if (loginDot) loginDot.classList.toggle("ok", !!getToken());
	}

	fab.addEventListener("click", () => {
		panel.classList.toggle("open");
		if (panel.classList.contains("open")) refreshPanelUI();
	});

	document.getElementById("dgb-save").addEventListener("click", () => {
		CFG.panelUrl = document.getElementById("dgb-url").value.trim() || CFG.panelUrl;
		CFG.botKey = document.getElementById("dgb-key").value.trim();
		saveCfg(CFG);
		refreshPanelUI();
		log("Pengaturan disimpan.");
	});

	document.getElementById("dgb-toggle-master").addEventListener("click", () => {
		if (!CFG.botKey) {
			log("Isi Kunci Bot dulu sebelum menyalakan.");
			return;
		}
		CFG.masterOn = !CFG.masterOn;
		saveCfg(CFG);
		refreshPanelUI();
		log(CFG.masterOn ? "Bot dinyalakan." : "Bot dimatikan.");
	});

	// ===================== Data chat (REST resmi DayLiveChat, dari browser CS sendiri) =====================
	const inboxCache = new Map();

	async function refreshInbox() {
		const token = getToken();
		if (!token) return;
		try {
			const res = await fetch(location.origin + "/api/chats/inbox", { headers: { Authorization: "Bearer " + token } });
			if (!res.ok) return;
			const rows = await res.json();
			if (!Array.isArray(rows)) return;
			const syncRows = [];
			for (const r of rows) {
				inboxCache.set(String(r.id), r);
				syncRows.push({
					sessionKey: String(r.id),
					queueCode: r.queue_code || "",
					customerName: r.visitor_display_name || r.queue_code || "",
					divisi: r.division_name || "",
				});
			}
			// Kirim daftar ini APA ADANYA (termasuk kalau kosong) -- panel memakai
			// daftar ini sbg sumber kebenaran Kotak Masuk saat ini utk membuang
			// sesi manual yang sudah ditutup/diarsipkan, bukan cuma buat nambah.
			await panelApi("livechatBotSync", { rows: syncRows });
		} catch (e) {
			log("Sync inbox gagal: " + (e && e.message ? e.message : e));
		}
	}

	let enabledKeys = [];
	let templates = [];
	async function pullPanel() {
		const r = await panelApi("livechatBotPull", {});
		if (r && r.success) {
			enabledKeys = r.enabledKeys || [];
			templates = r.templates || [];
			catchUpNewlyEnabled();
		}
	}

	// excludeId = id template yang TERAKHIR dipakai buat chat ini -- dibuang dulu
	// dari kandidat acak (kalau masih ada pilihan lain) supaya tidak kebetulan
	// kepilih 2x berturut-turut ke member yang sama.
	function pickTemplate(excludeId) {
		if (!templates.length) return null;
		const pool = templates.length > 1 && excludeId != null ? templates.filter((t) => t.id !== excludeId) : templates;
		const from = pool.length ? pool : templates;
		return from[Math.floor(Math.random() * from.length)];
	}
	function hashText(s) {
		let h = 0;
		s = String(s || "");
		for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
		return String(h);
	}

	// ===================== Socket.IO ASLI milik halaman ini (bukan implementasi manual) =====================
	let socket = null;
	function ensureSocket() {
		if (socket) return;
		const token = getToken();
		if (!token || typeof win.io !== "function") return;
		socket = win.io(location.origin, { auth: { token: token } });
		socket.on("connect", () => log("Socket.IO terhubung."));
		socket.on("disconnect", () => log("Socket.IO terputus, mencoba sambung ulang..."));
		socket.on("chat:new_message", (msg) => onNewMessage(msg));
	}

	function sendReply(chatId, text) {
		return new Promise((resolve) => {
			if (!socket) {
				resolve(null);
				return;
			}
			socket.emit("cs:message", { chat_id: Number(chatId), content: text }, (ack) => resolve(ack));
			setTimeout(() => resolve(null), 8000);
		});
	}

	// Burst state per chat -- direset tiap kali bot berhasil balas (burstCount
	// dihitung SEJAK balasan terakhir, bukan akumulasi selamanya). lastTemplateId
	// dipakai supaya pickTemplate() tidak pernah pilih kalimat yang sama 2x
	// berturut-turut ke member yang sama.
	const burst = new Map(); // chatId -> { count, lastMsgAt, lastReplyAt, lastTemplateId }
	function getBurst(chatId) {
		return burst.get(chatId) || { count: 0, lastMsgAt: 0, lastReplyAt: 0, lastTemplateId: null, replied: false };
	}

	async function tryReply(chatId) {
		if (!CFG.masterOn) return;
		if (!enabledKeys.includes(String(chatId))) return;
		const b = getBurst(chatId);
		// Guard WAJIB: kalau pesan terakhir member sudah pernah dibalas (mis.
		// panggilan ini datang dari timer grace 30-detik yang jadi basi karena
		// burst-nya sudah keburu dibalas duluan lewat jalur spam 15-detik),
		// jangan kirim balasan kedua yang tidak perlu ke chat yang sudah sepi.
		if (!b.lastMsgAt || b.lastMsgAt <= b.lastReplyAt) return;
		// Sudah dibalas di burst ini -> diam, seberapa pun member spam (cukup 1 balasan per burst).
		if (b.replied) return;
		if (b.count < 1) return;
		const tpl = pickTemplate(b.lastTemplateId);
		if (!tpl) {
			log("Tidak ada template balasan aktif -- lewati sesi " + chatId);
			return;
		}
		const ack = await sendReply(chatId, tpl.reply_text);
		if (ack && ack.error) {
			log("Gagal kirim balasan ke " + chatId + ": " + ack.error);
			return;
		}
		b.lastReplyAt = Date.now();
		b.lastTemplateId = tpl.id;
		b.replied = true;
		burst.set(chatId, b);
		log("Auto-balas terkirim ke sesi " + chatId + ".");
		panelApi("livechatBotReport", {
			sessionKey: String(chatId),
			customerMessage: "",
			matchedTemplateId: tpl.id || null,
			replyText: tpl.reply_text,
		});
	}

	// Inti logika hitung burst -- dipakai baik oleh event real-time
	// ('chat:new_message') MAUPUN oleh "cek pesan terakhir" saat sesi baru
	// di-ON-kan operator (lihat catchUpNewlyEnabled), supaya keduanya
	// konsisten persis.
	function handleMemberMessage(chatId, content, msgKeyHint) {
		if (!CFG.masterOn || !enabledKeys.includes(chatId)) return;
		const msgHash = chatId + "::" + (msgKeyHint != null ? msgKeyHint : hashText(content));
		if (REPLIED[msgHash]) return;
		REPLIED[msgHash] = Date.now();
		saveRepliedMap(REPLIED);

		const now = Date.now();
		const b = getBurst(chatId);
		if (b.lastMsgAt && now - b.lastMsgAt > BURST_RESET_MS) {
			b.count = 0;
			b.replied = false; // burst baru -> boleh dibalas 1x lagi
		}
		b.count += 1;
		b.lastMsgAt = now;
		burst.set(chatId, b);

		if (b.count === 1) {
			setTimeout(() => tryReply(chatId), GRACE_MS);
		} else {
			tryReply(chatId);
		}
	}

	function onNewMessage(msg) {
		if (!msg || msg.sender_type !== "member" || msg.chat_id == null) return;
		handleMemberMessage(String(msg.chat_id), msg.content);
	}

	// Sesi yang BARU SAJA diaktifkan operator (baru muncul di enabledKeys sejak
	// pullPanel() terakhir) belum tentu pesan member-nya "baru" -- kalau member
	// sudah kirim pesan SEBELUM di-ON-kan, event socket real-time itu sudah
	// lewat & tidak pernah kepakai (bot belum aktif waktu itu). Di sini kita
	// cek riwayat chat itu langsung begitu diaktifkan: kalau pesan PALING
	// BAWAH ternyata dari member (belum dibalas CS/bot sama sekali), anggap
	// sebagai pesan baru supaya operator tidak perlu nunggu member kirim lagi.
	const previouslyEnabled = new Set();
	async function catchUpNewlyEnabled() {
		const token = getToken();
		if (!token) return;
		for (const chatId of enabledKeys) {
			if (previouslyEnabled.has(chatId)) continue;
			previouslyEnabled.add(chatId);
			const row = inboxCache.get(chatId);
			const queueCode = row && row.queue_code;
			if (!queueCode) continue;
			try {
				const res = await fetch(location.origin + "/api/chats/" + encodeURIComponent(queueCode) + "/messages", {
					headers: { Authorization: "Bearer " + token },
				});
				if (!res.ok) continue;
				const data = await res.json();
				const messages = (data && data.messages) || [];
				const last = messages[messages.length - 1];
				if (last && last.sender_type === "member") {
					handleMemberMessage(chatId, last.content, "catchup:" + (last.id != null ? last.id : hashText(last.content)));
				}
			} catch (e) {
				log("Cek riwayat sesi " + chatId + " gagal: " + (e && e.message ? e.message : e));
			}
		}
		// Sesi yang dimatikan lagi harus dilupakan supaya kalau dinyalakan ULANG
		// nanti, pesan terakhirnya dicek lagi dari awal (bukan dianggap "sudah
		// pernah dicek" selamanya).
		for (const chatId of Array.from(previouslyEnabled)) {
			if (!enabledKeys.includes(chatId)) previouslyEnabled.delete(chatId);
		}
	}

	// ===================== Loop utama =====================
	function waitForReady(cb) {
		const t = setInterval(() => {
			if (getToken() && typeof win.io === "function") {
				clearInterval(t);
				cb();
			}
		}, 1000);
	}

	refreshPanelUI();
	waitForReady(() => {
		ensureSocket();
		refreshInbox();
		pullPanel();
	});
	setInterval(() => {
		if (!getToken()) return;
		ensureSocket();
	}, 5000);
	setInterval(refreshInbox, 5000);
	setInterval(pullPanel, 5000);
})();
