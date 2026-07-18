@echo off
:: Removes the PitWall Agent login startup entry.
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "PitWallAgent" /f
echo PitWall Agent startup entry removed.
pause
