// Cek nama tak terdefinisi di JavaScript panel (public/index.html hasil build).
//
// Panel ini satu file HTML besar tanpa bundler, jadi fungsi yang terhapus /
// salah ketik baru ketahuan saat operator mengklik menunya ("X is not
// defined"). Skrip ini memakai TypeScript (checkJs) untuk membaca SEMUA
// <script> inline + nama fungsi di atribut on*="..." HTML, lalu GAGAL kalau
// ada nama yang tidak pernah didefinisikan (TS2304 / TS2552). Error tipe lain
// (properti DOM dsb) sengaja diabaikan -- yang dicari hanya nama yang hilang.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "public", "index.html"), "utf8");

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
// Handler inline: onclick="foo(...)" -- baik di HTML statis MAUPUN di HTML
// yang dirakit di dalam string JS (template literal / 'onclick="' + ...).
// Isi string tidak dibaca TypeScript, jadi nama-namanya diperiksa terpisah.
const handlerNames = new Set();
const KEYWORDS = new Set(["this", "event", "if", "return", "void", "typeof", "new"]);
// Baris komentar penuh (// ...) dibuang dulu supaya contoh di komentar tidak ikut.
const scanText = html.replace(/^\s*\/\/.*$/gm, "");
for (const m of scanText.matchAll(/\bon(?:click|change|input|submit|keydown|keyup|keypress|mousedown|focus|blur)=\\?["']\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
	if (!KEYWORDS.has(m[1])) handlerNames.add(m[1]);
}
const probe = [...handlerNames].map((n) => `void ${n};`).join("\n");

const code = scripts.join("\n;\n") + "\n;\n" + probe;
const FILE = "panel-inline.js";
// Fungsi yang dipasang lewat `window.nama = ...` juga dihitung terdefinisi.
const windowDefs = new Set([...code.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map((m) => m[1]));
const LIBS =
	"declare const anime: any; declare const flatpickr: any; declare const google: any;\n" +
	[...windowDefs].map((n) => `declare var ${n}: any;`).join("\n");

const options = { allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ["lib.dom.d.ts", "lib.dom.iterable.d.ts", "lib.es2022.d.ts"], types: [], skipLibCheck: true };
const host = ts.createCompilerHost(options);
const origGet = host.getSourceFile.bind(host);
host.getSourceFile = (name, lang, onError, create) => {
	if (name === FILE) return ts.createSourceFile(name, code, lang, true, ts.ScriptKind.JS);
	if (name === "panel-globals.d.ts") return ts.createSourceFile(name, LIBS, lang, true, ts.ScriptKind.TS);
	return origGet(name, lang, onError, create);
};
const origExists = host.fileExists.bind(host);
host.fileExists = (name) => name === FILE || name === "panel-globals.d.ts" || origExists(name);

const program = ts.createProgram([FILE, "panel-globals.d.ts"], options, host);
const missing = ts
	.getPreEmitDiagnostics(program)
	.filter((d) => d.file && d.file.fileName === FILE && (d.code === 2304 || d.code === 2552));

if (missing.length) {
	console.error(`ERROR: ${missing.length} nama tidak terdefinisi di JavaScript panel:`);
	for (const d of missing.slice(0, 20)) {
		const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
		const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
		const src = code.split("\n")[line] || "";
		console.error(`  - ${text}\n      ${src.trim().slice(0, 140)}`);
	}
	process.exit(1);
}
console.log(`OK -> tidak ada nama tak terdefinisi (${scripts.length} script inline, ${handlerNames.size} handler HTML).`);
