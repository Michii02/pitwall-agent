@echo off
:: Run the PitWall telemetry agent in this terminal window.
:: Double-click, or run from any terminal: pitwall-agent\run-agent.bat
:: Ctrl+C to stop. Logs also always write to %APPDATA%\PitWall Agent\logs\agent.log
cd /d "%~dp0"

:: Stop any already-running agent instance first (avoids two overlapping
:: processes both connecting to the server / racing for the UDP port).
echo Checking for an existing agent instance...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'pitwall-agent' } | ForEach-Object { Write-Host ('Stopping existing agent process ' + $_.ProcessId + '...'); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

:: Force the UDP port + relay target explicitly (dotenv won't override these),
:: so the agent always binds 20779 and relays to Moza regardless of how its
:: config folder resolves.
set UDP_PORT=20779
set FORWARD_TARGETS=127.0.0.1:20777

echo Starting PitWall Agent...
node_modules\.bin\tsx src\index.ts
pause
