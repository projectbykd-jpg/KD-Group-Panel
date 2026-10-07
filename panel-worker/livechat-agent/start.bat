@echo off
cd /d "%~dp0"
if not exist node_modules call npm install --omit=dev
rem Jalankan terus; bila agent berhenti, mulai lagi setelah 10 detik. Tutup jendela ini untuk berhenti.
for /l %%i in (1,1,1000000) do (
  node agent.mjs
  echo Agent berhenti. Mulai ulang dalam 10 detik...
  timeout /t 10 /nobreak >nul
)
