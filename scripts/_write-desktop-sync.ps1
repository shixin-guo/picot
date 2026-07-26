$ErrorActionPreference = "Stop"
$desk = [Environment]::GetFolderPath("Desktop")
$ps1Src = "D:\Program_and_website_development\PI-AGENT\PICOT\src\picot\scripts\sync-custom-provider-to-install.ps1"
$ps1Desk = Join-Path $desk "Sync-Picot-Custom-Provider.ps1"
$batDesk = Join-Path $desk "Sync-Picot-Custom-Provider.bat"
$ps1DeskCn = Join-Path $desk "同步Picot自定义供应商.ps1"
$batDeskCn = Join-Path $desk "同步Picot自定义供应商.bat"
$batScripts = "D:\Program_and_website_development\PI-AGENT\PICOT\src\picot\scripts\sync-custom-provider-to-install.bat"

if (-not (Test-Path $ps1Src)) { throw "Missing $ps1Src" }

$utf8Bom = New-Object System.Text.UTF8Encoding $true
$ps1Text = [System.IO.File]::ReadAllText($ps1Src)
[System.IO.File]::WriteAllText($ps1Desk, $ps1Text, $utf8Bom)
[System.IO.File]::WriteAllText($ps1DeskCn, $ps1Text, $utf8Bom)

# Use single-quoted lines so PowerShell does not expand %~dp0
$batLines = @(
  '@echo off',
  'chcp 65001 >nul',
  'title Picot Custom Provider Sync',
  'cd /d "%~dp0"',
  '',
  'echo.',
  'echo Sync custom provider files into installed Picot.',
  'echo Quit Picot completely first, including tray icon.',
  'echo.',
  '',
  'if not exist "%~dp0Sync-Picot-Custom-Provider.ps1" (',
  '  echo [ERR] Missing Sync-Picot-Custom-Provider.ps1 on Desktop',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Sync-Picot-Custom-Provider.ps1"',
  'set ERR=%ERRORLEVEL%',
  'if not "%ERR%"=="0" (',
  '  echo.',
  '  echo Sync failed, exit code %ERR%',
  '  pause',
  ')',
  'exit /b %ERR%'
)
$bat = ($batLines -join "`r`n") + "`r`n"
[System.IO.File]::WriteAllText($batDesk, $bat, [System.Text.Encoding]::ASCII)
[System.IO.File]::WriteAllText($batDeskCn, $bat, [System.Text.Encoding]::ASCII)

$bat2Lines = @(
  '@echo off',
  'chcp 65001 >nul',
  'title Picot Custom Provider Sync',
  'cd /d "%~dp0"',
  '',
  'echo.',
  'echo Sync custom provider files into installed Picot.',
  'echo Quit Picot completely first, including tray icon.',
  'echo.',
  '',
  'if not exist "%~dp0sync-custom-provider-to-install.ps1" (',
  '  echo [ERR] Missing sync-custom-provider-to-install.ps1',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-custom-provider-to-install.ps1"',
  'set ERR=%ERRORLEVEL%',
  'if not "%ERR%"=="0" (',
  '  echo.',
  '  echo Sync failed, exit code %ERR%',
  '  pause',
  ')',
  'exit /b %ERR%'
)
$bat2 = ($bat2Lines -join "`r`n") + "`r`n"
[System.IO.File]::WriteAllText($batScripts, $bat2, [System.Text.Encoding]::ASCII)
[System.IO.File]::WriteAllText($ps1Src, $ps1Text, $utf8Bom)

Write-Host "WROTE $batDesk"
Write-Host "WROTE $ps1Desk"
Write-Host "WROTE $batDeskCn"
Write-Host "WROTE $ps1DeskCn"
$bytes = [System.IO.File]::ReadAllBytes($batDesk)
$sample = ($bytes[0..([Math]::Min(50, $bytes.Length-1))] | ForEach-Object { $_.ToString("X2") }) -join "-"
Write-Host "BAT_BYTES=$sample"
$hasCr = $false
foreach ($b in $bytes) { if ($b -eq 13) { $hasCr = $true; break } }
if ($hasCr) { Write-Host "CRLF_OK" } else { Write-Host "LF_ONLY" }
