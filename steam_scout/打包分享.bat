@echo off
chcp 65001 >nul
cd /d %~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\pack_share.ps1"
pause
