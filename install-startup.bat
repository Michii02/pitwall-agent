@echo off
:: Registers the PitWall Agent to start automatically at Windows login
:: (current user only — no admin needed). Run once. Undo: uninstall-startup.bat
set SCRIPT=%~dp0start-agent.vbs
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "PitWallAgent" /t REG_SZ /d "wscript.exe \"%SCRIPT%\"" /f
if %errorlevel%==0 (
  echo PitWall Agent registered to start at login.
  echo Starting it now...
  wscript.exe "%SCRIPT%"
) else (
  echo Failed to register startup entry.
)
pause
