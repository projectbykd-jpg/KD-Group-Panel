import { describe, expect, it } from "vitest";
import { constEq, hashPassword, isHashed, sha256Hex, verifyPassword } from "../src/lib/crypto";

describe("password hash", () => {
	it("hash baru bisa diverifikasi dan menolak password salah", async () => {
		const h = await hashPassword("rahasia-123");
		expect(isHashed(h)).toBe(true);
		expect(h.split("$")).toHaveLength(4);
		expect(await verifyPassword(h, "rahasia-123")).toBe(true);
		expect(await verifyPassword(h, "rahasia-124")).toBe(false);
	});

	it("salt acak: dua hash dari password sama berbeda", async () => {
		expect(await hashPassword("x")).not.toBe(await hashPassword("x"));
	});

	it("masih menerima password plaintext lama (dimigrasi otomatis saat login)", async () => {
		expect(await verifyPassword("plain", "plain")).toBe(true);
		expect(await verifyPassword("plain", "Plain")).toBe(false);
	});

	it("hash rusak ditolak", async () => {
		expect(await verifyPassword("pbkdf2-sha256$2000$salt", "x")).toBe(false);
	});
});

describe("constEq / sha256Hex", () => {
	it("membandingkan string dengan benar", () => {
		expect(constEq("abc", "abc")).toBe(true);
		expect(constEq("abc", "abd")).toBe(false);
		expect(constEq("abc", "abcd")).toBe(false);
		expect(constEq("", "")).toBe(true);
	});

	it("sha256Hex men-trim input", async () => {
		expect(await sha256Hex("  a ")).toBe(await sha256Hex("a"));
		expect(await sha256Hex("a")).toMatch(/^[0-9a-f]{64}$/);
	});
});
