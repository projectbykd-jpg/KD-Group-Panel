@echo off
cd /d "%~dp0"
if not exist node_modules call npm install --omit=dev
:loop
node agent.mjs
echo Agent berhenti. Mulai ulang dalam 10 detik... (tutup jendela ini untuk berhenti)
timeout /t 10 /nobreak >nul
goto loop
