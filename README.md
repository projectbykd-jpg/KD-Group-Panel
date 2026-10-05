# Day-Group Panel

Panel manajemen result & prediksi togel untuk operator CS Day-Group.

## Struktur

| Path | Isi |
|---|---|
| `panel-worker/` | **Aplikasi aktif** — Cloudflare Worker (TypeScript) + D1 + KV. Ini yang di-deploy. |
| `migration/` | Skema & migrasi database D1 (`day_database`). |
| `.github/workflows/` | Deploy otomatis (`deploy.yml`), cek PR (`check.yml`), cron cadangan & turbo. |

## Deploy

Deploy otomatis lewat GitHub Actions (`deploy.yml`) setiap ada perubahan
`panel-worker/` yang masuk ke `main`. Sebelum deploy, workflow menjalankan
typecheck + unit test; kalau ada yang gagal, deploy dibatalkan.

Manual dari laptop:

```bash
cd panel-worker
npm ci                # pasang PERSIS versi di package-lock.json
npm run check         # typecheck + unit test + build UI
npm run deploy        # build UI + wrangler deploy
```

Repository secret yang dibutuhkan (Settings → Secrets and variables → Actions):

| Secret | Dipakai untuk |
|---|---|
| `CLOUDFLARE_API_TOKEN` | `wrangler deploy` |
| `CRON_KEY` | Kunci `/__cron`. `deploy.yml` mengunggahnya ke Worker sebagai secret; deploy **gagal** kalau kosong. |
| `TURSO_URL`, `TURSO_TOKEN` | `news-turbo.yml` |

URL produksi: https://panel-worker.projectbykd.workers.dev

### Penjadwalan (auto-post prediksi + pump scan INVEST)

Cron Trigger bawaan Cloudflare **tidak jalan** di akun Free ini, jadi dipakai
**cron eksternal** yang memanggil endpoint HTTP:

```
GET /__cron?key=<CRON_KEY>&job=autopost   # router auto-post prediksi + kata penutup
GET /__cron?key=<CRON_KEY>&job=invest     # pump scan INVEST (resume via cursor)
GET /__cron?key=<CRON_KEY>&job=all        # keduanya
```

`CRON_KEY` **tidak** ditulis di repo. Nilainya disimpan sebagai repository
secret `CRON_KEY` dan dipasang ke Worker sebagai secret saat deploy. Untuk
mengganti kunci: ubah secret di GitHub, jalankan workflow *Deploy* (tombol
"Run workflow"), lalu ganti `key=` di semua URL cron-job.org.

**Setup di [cron-job.org](https://cron-job.org) (gratis, tiap 1 menit):**
1. Buat 2 cronjob, interval *every 1 minute*:
   - `https://panel-worker.projectbykd.workers.dev/__cron?key=<CRON_KEY>&job=autopost`
   - `https://panel-worker.projectbykd.workers.dev/__cron?key=<CRON_KEY>&job=invest`

Cadangan: GitHub Actions `.github/workflows/cron.yml` (tiap 5 menit) — memakai
repo secret `CRON_KEY` yang sama. Cron Trigger Cloudflare tetap didaftarkan kalau nanti aktif.

> Auto-post prediksi hanya jalan kalau **minimal 1 operator sedang login**.

### Bindings (lihat `panel-worker/wrangler.jsonc`)
- `DB` → D1 `day_database`
- `SESS` → KV (sesi login + guard)
- `ASSETS` → static `panel-worker/public/` (di-generate dari `ui-src/`)

## Migrasi DB

```bash
cd panel-worker
npx wrangler d1 execute day_database --remote --file ../migration/001_init.sql
npx wrangler d1 execute day_database --remote --file ../migration/002_invest_raw.sql
```

`006_perf_indexes.sql` dan `007_login_throttle.sql` tidak wajib dijalankan
manual: Worker membuatnya sendiri (`CREATE ... IF NOT EXISTS`).

## Tes

```bash
cd panel-worker
npm test              # unit test (Node, tanpa akun Cloudflare)
```

Tes login/sesi memakai D1 tiruan di atas `node:sqlite` yang dibangun dari
file migrasi asli (`test/helpers/fake-env.ts`), jadi skemanya sama dengan
produksi.
