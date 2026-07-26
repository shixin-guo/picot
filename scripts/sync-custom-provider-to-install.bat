@echo off
chcp 65001 >nul
title Picot Custom Provider Sync
cd /d "%~dp0"

echo.
echo Sync custom provider files into installed Picot.
echo Quit Picot completely first, including tray icon.
echo.

if not exist "%~dp0sync-custom-provider-to-install.ps1" (
  echo [ERR] Missing sync-custom-provider-to-install.ps1
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-custom-provider-to-install.ps1"
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo Sync failed, exit code %ERR%
  pause
)
exit /b %ERR%
