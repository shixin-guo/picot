@echo off
chcp 65001 >nul
title Picot custom provider install sync
cd /d "%~dp0"

echo.
echo  Sync: source custom provider hotpatch -^> installed Picot
echo  Quit Picot completely first (including tray icon).
echo.

REM Prefer same-folder Chinese/English named ps1, then scripts sibling name.
set "PS1="
if exist "%~dp0Sync-Picot-Custom-Provider.ps1" set "PS1=%~dp0Sync-Picot-Custom-Provider.ps1"
if exist "%~dp0同步Picot自定义供应商.ps1" set "PS1=%~dp0同步Picot自定义供应商.ps1"
if exist "%~dp0sync-custom-provider-to-install.ps1" set "PS1=%~dp0sync-custom-provider-to-install.ps1"

if "%PS1%"=="" (
  echo [ERR] Cannot find sync PowerShell script next to this bat.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo Sync failed, exit code %ERR%
  pause
)
exit /b %ERR%
