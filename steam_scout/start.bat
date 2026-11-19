@echo off
cd /d "%~dp0"
echo [SteamScout] checking port (auto-clean stale process)...
powershell -NoProfile -Command "$p=8792; if (Test-Path '.env') { $m = Select-String -Path '.env' -Pattern '^PORT=' | Select-Object -First 1; if ($m) { $v=($m.Line -split '=')[1].Trim(); if ($v -match '^\d+$') { $p=[int]$v } } }; $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; if ($c) { $pid0 = $c | Select-Object -First 1 -ExpandProperty OwningProcess; Write-Host ('[SteamScout] stopping stale process PID ' + $pid0 + ' ...'); $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 2; Write-Host ('[SteamScout] starting on port ' + $p + ' ...') } else { Write-Host ('[SteamScout] port ' + $p + ' free, starting ...') }"
echo ==============================================
echo   SteamScout  -  http://127.0.0.1:8792
echo ==============================================
node server.mjs
pause
