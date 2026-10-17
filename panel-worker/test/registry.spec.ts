import { describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { getRegistryEntry, resetRegistryGuards, upsertRegistry } from "../src/lib/registry";
import { fakeD1, fakeEnv } from "./helpers/fake-env";

describe("registry anti-duplikat kirim result", () => {
	it("tanda 'sudah terkirim' tidak bisa turun: kiriman kedua yang gagal tidak membuka jalan kirim ganda", async () => {
		turso.current = fakeD1([]);
		const env = fakeEnv().env;
		await upsertRegistry(env, "h1", "HUGO", "Ani", "HK", { telegram: true, linktree: false, panelz: true }, "isi");
		// operator kedua (klik ganda) -- Telegram-nya gagal, LinkTree berhasil
		await upsertRegistry(env, "h1", "HUGO", "Budi", "HK", { telegram: false, linktree: true, panelz: false }, "isi");
		const e = await getRegistryEntry(env, "HUGO", "h1");
		expect(e).toMatchObject({ telegram: true, linktree: true, panelz: true });
	});
});

describe("registry tetap jalan saat Turso diblokir (kuota habis) -- cermin D1", () => {
	const blocked = () => {
		const err = () => Promise.reject(new Error("BLOCKED: Operation was blocked: SQL read operations are forbidden (reads are blocked, do you need to upgrade your plan?)"));
		const stmt = { bind: () => stmt, first: err, all: err, run: err };
		return { prepare: () => stmt, batch: err };
	};

	it("Turso mati: baca/tulis lewat D1, kiriman tidak terblokir dan duplikat tetap tertahan", async () => {
		resetRegistryGuards();
		turso.current = { d1: blocked() };
		const env = fakeEnv().env;
		expect(await getRegistryEntry(env, "HUGO", "h2")).toBeNull(); // tidak melempar -> Kirim Semua tetap bisa mengirim
		await upsertRegistry(env, "h2", "HUGO", "Ani", "HK", { telegram: true, linktree: false, panelz: false }, "isi");
		expect(await getRegistryEntry(env, "HUGO", "h2")).toMatchObject({ telegram: true, username: "Ani" });
	});

	it("Turso pulih: catatan yang ditulis ke D1 selama Turso mati tetap memblokir kirim ganda", async () => {
		resetRegistryGuards();
		const env = fakeEnv().env;
		turso.current = { d1: blocked() };
		await upsertRegistry(env, "h3", "HUGO", "Ani", "HK", { telegram: true, linktree: false, panelz: true }, "isi");
		turso.current = fakeD1([]); // Turso kembali, tanpa catatan h3
		resetRegistryGuards();
		await upsertRegistry(env, "h3", "HUGO", "Budi", "HK", { telegram: false, linktree: true, panelz: false }, "isi");
		expect(await getRegistryEntry(env, "HUGO", "h3")).toMatchObject({ telegram: true, linktree: true, panelz: true });
	});

	it("Turso DAN D1 mati: tetap melempar (pengirim menolak kirim buta)", async () => {
		resetRegistryGuards();
		turso.current = { d1: blocked() };
		const env = { ...fakeEnv().env, DB: blocked() } as unknown as Env;
		await expect(getRegistryEntry(env, "HUGO", "h4")).rejects.toThrow(/BLOCKED/);
		await expect(upsertRegistry(env, "h4", "HUGO", "Ani", "HK", { telegram: true, linktree: false, panelz: false }, "x")).rejects.toThrow(/BLOCKED/);
	});
});
