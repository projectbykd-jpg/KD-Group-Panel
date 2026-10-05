import { defineConfig } from "vitest/config";

// Unit test murni (Node), tanpa runtime Cloudflare: logika yang diuji (parser,
// hash password, login/sesi) cuma butuh Web Crypto + D1/KV tiruan di
// test/helpers/fake-env.ts. Jauh lebih cepat & tidak butuh akun Cloudflare,
// jadi bisa jalan di CI sebelum deploy.
export default defineConfig({
	test: {
		include: ["test/**/*.spec.ts"],
		environment: "node",
	},
});
