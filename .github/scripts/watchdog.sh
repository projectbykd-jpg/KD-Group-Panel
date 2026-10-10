#!/usr/bin/env bash
# Penjaga panel KD-Group -- dijalankan .github/workflows/watchdog.yml tiap 5 menit, DI LUAR Cloudflare.
# Worker tidak bisa melaporkan kematiannya sendiri; skrip ini memeriksa dari luar lalu mengirim Telegram.
#
# Masukan (env): BASE, RAW_TG_TOKEN, RAW_TG_CHAT, CF_TOKEN, CF_ACCOUNT, EVENT, KIRIM_TES, RUN_NUMBER,
#                PREV (kesimpulan run terjadwal sebelumnya: success/failure/""), batas kuota CF_LIMIT_* + CF_WARN_PCT.
# Keluaran: exit 1 bila ada masalah (run merah -> email GitHub), exit 0 bila sehat.
set -u
TG_TOKEN=$(printf '%s' "${RAW_TG_TOKEN:-}" | tr -d ' \r\n\t')
TG_CHAT=$(printf '%s' "${RAW_TG_CHAT:-}" | tr -d ' \r\n\t')
CF_TOKEN=$(printf '%s' "${CF_TOKEN:-}" | tr -d ' \r\n\t')
TMP=$(mktemp -d)
TG_API=${TG_API:-https://api.telegram.org}
CF_API=${CF_API:-https://api.cloudflare.com/client/v4}
problems=()   # mematikan panel
warnings=()   # panel hidup tapi ada fitur yang berhenti / kuota menipis

tg() { # tg "teks" -> kirim; kembalikan jawaban Telegram di $TG_RESP
  TG_RESP=""
  [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ] || { echo "Secret Telegram belum diisi -> hanya run merah/email."; return 0; }
  TG_RESP=$(curl -sS -m 20 "$TG_API/bot${TG_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TG_CHAT}" --data-urlencode "text=$1" --data-urlencode "disable_web_page_preview=true" || true)
}

# ---- 1) kesehatan dalam: D1, KV, Turso, detak cron (+ peringatan fitur) -- 2 percobaan supaya kedip sesaat tidak dianggap mati
code=000
for i in 1 2; do
  code=$(curl -sS -m 20 -o "$TMP/h.json" -w '%{http_code}' "$BASE/health?deep=1" 2>/dev/null || echo 000)
  if [ "$code" = "200" ] && jq -e '.ok == true' "$TMP/h.json" >/dev/null 2>&1; then break; fi
  [ "$i" = 1 ] && sleep "${RETRY_SLEEP:-8}"
done
if jq -e '.checks' "$TMP/h.json" >/dev/null 2>&1; then
  while IFS= read -r line; do [ -n "$line" ] && problems+=("$line"); done < <(jq -r '.checks | to_entries[] | select(.value.ok != true) | "\(.key): \(.value.error // "gagal")"' "$TMP/h.json")
  while IFS= read -r line; do [ -n "$line" ] && warnings+=("$line"); done < <(jq -r '(.warnings // [])[]' "$TMP/h.json")
else
  problems+=("/health?deep=1 tidak menjawab normal (HTTP $code): $(head -c 200 "$TMP/h.json" 2>/dev/null | tr -d '\n')")
fi

# ---- 2) jalur /api (dipakai semua menu): aksi palsu HARUS dijawab JSON "Aksi tidak dikenal"
body=$(curl -sS -m 20 -X POST -H 'content-type: application/json' -d '{"action":"__watchdog__"}' "$BASE/api" 2>/dev/null || true)
if ! printf '%s' "$body" | grep -q 'Aksi tidak dikenal'; then
  problems+=("/api tidak menjawab normal: $(printf '%s' "$body" | head -c 200 | tr -d '\n')")
fi

# ---- 3) kuota harian Cloudflare (paket gratis; reset 00:00 UTC = 07:00 WIB). Best-effort: tanpa izin analytics cukup notice.
#      Diperingatkan: request Worker & D1 (habis = panel mati). KV hanya dicatat (habis = panel tetap jalan lewat D1).
if [ -n "$CF_TOKEN" ]; then
  acct=$(printf '%s' "${CF_ACCOUNT:-}" | tr -d ' \r\n\t')
  if [ -z "$acct" ]; then
    acct=$(curl -sS -m 20 -H "Authorization: Bearer $CF_TOKEN" "$CF_API/accounts?per_page=5" 2>/dev/null | jq -r '.result[0].id // empty' 2>/dev/null)
  fi
  if [ -z "$acct" ]; then
    echo "::notice::Kuota Cloudflare tidak dicek: Account ID tidak terbaca. Isi variabel repo CF_ACCOUNT_ID atau beri token izin 'Account Settings: Read'."
  else
    day=$(date -u +%Y-%m-%d); since="${day}T00:00:00Z"; until=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    gql() { # gql "query" -> JSON di stdout
      jq -n --arg q "$1" --arg a "$acct" --arg s "$since" --arg u "$until" --arg d "$day" \
        '{query:$q, variables:{a:$a, s:$s, u:$u, d:$d}}' \
      | curl -sS -m 25 -H "Authorization: Bearer $CF_TOKEN" -H 'content-type: application/json' --data @- "$CF_API/graphql" 2>/dev/null
    }
    pct=${CF_WARN_PCT:-80}
    usage=()
    check_quota() { # label pemakaian batas [info]
      # "info" = hanya dicatat di log: kode panel sudah tahan bila kuota itu habis (KV gagal tulis -> sesi & kunci jatuh ke D1),
      # jadi memperingatkannya tiap hari hanya membuat alarm palsu yang lama-lama diabaikan.
      local label=$1 used=$2 limit=$3 mode=${4:-warn}
      { [ -z "$used" ] || [ "$used" = "null" ]; } && return 0
      local p=$(( used * 100 / limit ))
      usage+=("$label ${used}/${limit} (${p}%)")
      if [ "$mode" = "warn" ] && [ "$p" -ge "$pct" ]; then
        warnings+=("Kuota Cloudflare $label sudah ${p}% (${used} dari ${limit}) hari ini — bila habis panel berhenti sampai 07:00 WIB")
      fi
      return 0
    }
    w=$(gql 'query($a:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:$s,datetime_leq:$u}){sum{requests errors}}}}}')
    if printf '%s' "$w" | jq -e '.data.viewer.accounts[0]' >/dev/null 2>&1; then
      req=$(printf '%s' "$w" | jq '[.data.viewer.accounts[0].workersInvocationsAdaptive[].sum.requests] | add // 0')
      check_quota "request Worker" "$req" "${CF_LIMIT_REQ:-100000}"
      d=$(gql 'query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){d1AnalyticsAdaptiveGroups(limit:1000,filter:{date_geq:$d,date_leq:$d}){sum{rowsRead rowsWritten}}}}}')
      check_quota "D1 baris dibaca" "$(printf '%s' "$d" | jq '[.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups[]?.sum.rowsRead] | add' 2>/dev/null)" "${CF_LIMIT_D1_READ:-5000000}"
      check_quota "D1 baris ditulis" "$(printf '%s' "$d" | jq '[.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups[]?.sum.rowsWritten] | add' 2>/dev/null)" "${CF_LIMIT_D1_WRITE:-100000}"
      k=$(gql 'query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){kvOperationsAdaptiveGroups(limit:1000,filter:{date_geq:$d,date_leq:$d}){sum{requests} dimensions{actionType}}}}}')
      check_quota "KV baca" "$(printf '%s' "$k" | jq '[.data.viewer.accounts[0].kvOperationsAdaptiveGroups[]? | select(.dimensions.actionType=="read") | .sum.requests] | add' 2>/dev/null)" "${CF_LIMIT_KV_READ:-100000}" info
      check_quota "KV tulis" "$(printf '%s' "$k" | jq '[.data.viewer.accounts[0].kvOperationsAdaptiveGroups[]? | select(.dimensions.actionType=="write") | .sum.requests] | add' 2>/dev/null)" "${CF_LIMIT_KV_WRITE:-1000}" info
      echo "Pemakaian hari ini (UTC): ${usage[*]:-tidak terbaca}"
    else
      echo "::notice::Kuota Cloudflare tidak dicek: token tidak punya izin 'Account Analytics: Read' ($(printf '%s' "$w" | jq -r '.errors[0].message // "tanpa data"' 2>/dev/null | head -c 120))."
    fi
  fi
else
  echo "::notice::Kuota Cloudflare tidak dicek: secret CF_ANALYTICS_TOKEN / CLOUDFLARE_API_TOKEN kosong."
fi

# ---- 4) laporan
summary=""
for p in "${problems[@]+"${problems[@]}"}"; do summary+="❌ $p"$'\n'; done
for w_ in "${warnings[@]+"${warnings[@]}"}"; do summary+="⚠️ $w_"$'\n'; done
echo "Hasil: ${summary:-sehat}"
bad=0; [ ${#problems[@]} -gt 0 ] || [ ${#warnings[@]} -gt 0 ] && bad=1

if [ "${EVENT:-}" = "workflow_dispatch" ] && [ "${KIRIM_TES:-false}" = "true" ]; then
  [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ] || { echo "::error::Secret TG_ALERT_TOKEN / TG_ALERT_CHAT belum terbaca."; exit 1; }
  tg "✅ Penjaga KD-Group Panel aktif. Status sekarang:
${summary:-semua sehat}"
  if ! printf '%s' "$TG_RESP" | jq -e '.ok == true' >/dev/null 2>&1; then
    echo "::error::Telegram menolak: $(printf '%s' "$TG_RESP" | head -c 200)"
    me=$(curl -sS -m 15 "$TG_API/bot${TG_TOKEN}/getMe" || true)
    echo "::error::Token ini milik bot: @$(printf '%s' "$me" | jq -r '.result.username // "?"' 2>/dev/null) (harus bot yang ada di grup). Chat ID terbaca: ${TG_CHAT:0:6}... panjang ${#TG_CHAT} karakter (supergroup = 14, mis. -1003723948512)."
    exit 1
  fi
  echo "Pesan uji terkirim."
elif [ "$bad" = 1 ]; then
  # anti-banjir: kirim saat baru bermasalah, lalu pengingat tiap ±1 jam (tiap 12 run)
  if [ "${PREV:-}" != "failure" ] || [ $(( ${RUN_NUMBER:-1} % 12 )) -eq 0 ]; then
    tg "🔴 KD-Group Panel BERMASALAH
${summary}
Cek: $BASE/health?deep=1
(Kuota Cloudflare harian reset 07:00 WIB. Detail: Cloudflare Dashboard › Workers › panel-worker.)"
  fi
elif [ "${PREV:-}" = "failure" ]; then
  tg "🟢 KD-Group Panel normal kembali — semua pemeriksaan sehat."
fi

if [ "$bad" = 1 ]; then
  echo "::error::Panel bermasalah: $(printf '%s' "$summary" | tr '\n' ' ')"
  exit 1
fi
exit 0
