import { describe, expect, it, vi } from "vitest";

const turso = vi.hoisted(() => ({ current: null as null | { d1: unknown } }));
vi.mock("../src/lib/turso", () => ({ getTurso: () => turso.current!.d1 }));

import { getRegistryEntry, upsertRegistry } from "../src/lib/registry";
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
