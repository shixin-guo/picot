#Requires -Version 5.1
<#
.SYNOPSIS
  Sync custom relay provider hotpatch from source tree to installed Picot.

.DESCRIPTION
  - Refuse if Picot is still running
  - Optionally rebuild extensions with bun
  - Backup files that will be overwritten
  - Copy embedded-server.mjs + related public files
  - Validate presence and settings-custom-provider marker
#>

$ErrorActionPreference = "Stop"
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}
function Write-Ok([string]$msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err([string]$msg) { Write-Host "  [ERR] $msg" -ForegroundColor Red }
function Pause-Exit([int]$code = 0) {
  Write-Host ""
  Write-Host "Press any key to close..." -ForegroundColor DarkGray
  try {
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
  } catch {
    Read-Host "Press Enter to close"
  }
  exit $code
}

# Resolve source root.
# Priority: env PICOT_SRC_ROOT → sibling scripts/ layout → known workspace path.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidateRoots = @()
if ($env:PICOT_SRC_ROOT) { $candidateRoots += $env:PICOT_SRC_ROOT }
# When script lives in src/picot/scripts/, parent is the source root.
$candidateRoots += (Split-Path -Parent $ScriptDir)
# Known PICOT workspace (this machine).
$candidateRoots += "D:\Program_and_website_development\PI-AGENT\PICOT\src\picot"
# Desktop copy: also look for a marker file next to common clones.
$candidateRoots += (Join-Path $env:USERPROFILE "PICOT\src\picot")

$SrcRoot = $null
foreach ($cand in $candidateRoots) {
  if (-not $cand) { continue }
  $marker = Join-Path $cand "extensions\embedded-server.ts"
  $dist = Join-Path $cand "extensions\dist\embedded-server.mjs"
  $publicIdx = Join-Path $cand "public\index.html"
  if ((Test-Path $marker) -or ((Test-Path $dist) -and (Test-Path $publicIdx))) {
    $SrcRoot = $cand
    break
  }
}
if (-not $SrcRoot) {
  # Fall back to known path even if marker missing (clearer error later)
  $SrcRoot = "D:\Program_and_website_development\PI-AGENT\PICOT\src\picot"
}

$InstallRoot = if ($env:PICOT_INSTALL_ROOT) { $env:PICOT_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA "Picot" }
$Ts = Get-Date -Format "yyyyMMdd_HHmmss"
$PublicFiles = @(
  "index.html",
  "style.css",
  "settings\editors.js",
  "i18n\en.js",
  "i18n\zh.js"
)

Write-Host "====================================================" -ForegroundColor White
Write-Host " Picot custom provider install sync" -ForegroundColor White
Write-Host " timestamp: $Ts" -ForegroundColor DarkGray
Write-Host "====================================================" -ForegroundColor White
Write-Host "Source : $SrcRoot"
Write-Host "Install: $InstallRoot"

Write-Step "Check paths"
if (-not (Test-Path $SrcRoot)) {
  Write-Err "Source not found: $SrcRoot"
  Pause-Exit 1
}
if (-not (Test-Path $InstallRoot)) {
  Write-Err "Install not found: $InstallRoot"
  Pause-Exit 1
}
Write-Ok "Source and install roots exist"

Write-Step "Check Picot process"
$procs = @(Get-Process -Name "picot" -ErrorAction SilentlyContinue)
if ($procs.Count -gt 0) {
  Write-Err ("Picot is still running (PID: {0})" -f ($procs.Id -join ", "))
  Write-Host "Quit Picot completely (including tray), then re-run this script." -ForegroundColor Yellow
  Pause-Exit 2
}
Write-Ok "No picot process"

Write-Step "Rebuild extensions (bun run build:extensions)"
$bun = Get-Command bun -ErrorAction SilentlyContinue
$distServer = Join-Path $SrcRoot "extensions\dist\embedded-server.mjs"
if ($bun) {
  Push-Location $SrcRoot
  try {
    & bun run build:extensions
    if ($LASTEXITCODE -ne 0) { throw "build:extensions exit $LASTEXITCODE" }
    Write-Ok "build:extensions finished"
  } catch {
    Write-Err "build:extensions failed: $_"
    Write-Warn "Will use existing dist if present"
  } finally {
    Pop-Location
  }
} else {
  Write-Warn "bun not on PATH; skip rebuild, use existing dist"
}

if (-not (Test-Path $distServer)) {
  Write-Err "Missing: $distServer"
  Write-Host "Run in source: bun run build:extensions" -ForegroundColor Yellow
  Pause-Exit 3
}
Write-Ok ("dist embedded-server.mjs ({0} bytes)" -f (Get-Item $distServer).Length)

Write-Step "Backup files to be replaced"
$bakPublic = Join-Path $InstallRoot ("public\_backup_custom_provider_{0}" -f $Ts)
New-Item -ItemType Directory -Path $bakPublic -Force | Out-Null
foreach ($rel in $PublicFiles) {
  $from = Join-Path $InstallRoot "public\$rel"
  $to = Join-Path $bakPublic $rel
  $parent = Split-Path $to -Parent
  if (-not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  if (Test-Path $from) {
    Copy-Item -LiteralPath $from -Destination $to -Force
    Write-Ok "backup public\$rel"
  } else {
    Write-Warn "install missing (will create): public\$rel"
  }
}

$instExt = Join-Path $InstallRoot "extensions\embedded-server.mjs"
$bakExt = Join-Path $InstallRoot ("extensions\_backup_embedded_server_{0}.mjs" -f $Ts)
if (Test-Path $instExt) {
  Copy-Item -LiteralPath $instExt -Destination $bakExt -Force
  Write-Ok ("backup extensions\embedded-server.mjs -> {0}" -f (Split-Path $bakExt -Leaf))
} else {
  Write-Warn "install has no embedded-server.mjs yet"
}

Write-Step "Copy into install tree"
$extDir = Join-Path $InstallRoot "extensions"
if (-not (Test-Path $extDir)) {
  New-Item -ItemType Directory -Path $extDir -Force | Out-Null
}
Copy-Item -LiteralPath $distServer -Destination $instExt -Force
Write-Ok "extensions\embedded-server.mjs"

foreach ($rel in $PublicFiles) {
  $from = Join-Path $SrcRoot "public\$rel"
  $to = Join-Path $InstallRoot "public\$rel"
  if (-not (Test-Path $from)) {
    Write-Err "Source missing: $from"
    Pause-Exit 4
  }
  $parent = Split-Path $to -Parent
  if (-not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  Copy-Item -LiteralPath $from -Destination $to -Force
  Write-Ok "public\$rel"
}

Write-Step "Validate"
$missing = @()
foreach ($p in @(
  (Join-Path $InstallRoot "extensions\embedded-server.mjs"),
  (Join-Path $InstallRoot "public\index.html"),
  (Join-Path $InstallRoot "public\style.css"),
  (Join-Path $InstallRoot "public\settings\editors.js"),
  (Join-Path $InstallRoot "public\i18n\en.js"),
  (Join-Path $InstallRoot "public\i18n\zh.js")
)) {
  if (-not (Test-Path $p)) { $missing += $p }
}
if ($missing.Count -gt 0) {
  Write-Err "Still missing after copy:"
  $missing | ForEach-Object { Write-Host "    $_" }
  Pause-Exit 5
}
Write-Ok "All target files present"

$idx = Get-Content -LiteralPath (Join-Path $InstallRoot "public\index.html") -Raw -Encoding UTF8
if ($idx -notmatch "settings-custom-provider") {
  Write-Err "install index.html lacks #settings-custom-provider"
  Pause-Exit 6
}
Write-Ok "index.html contains settings-custom-provider"

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $checkJs = @'
const fs = require("fs");
const path = require("path");
const install = path.join(process.env.LOCALAPPDATA, "Picot", "public");
const appPath = path.join(install, "app.js");
if (!fs.existsSync(appPath)) {
  console.log("APP_JS_MISSING");
  process.exit(0);
}
const app = fs.readFileSync(appPath, "utf8");
const re = /from\s+['"](\.\/?[^'"]+)['"]/g;
const missing = [];
let m;
while ((m = re.exec(app))) {
  const rel = m[1].split("?")[0];
  const abs = path.normalize(path.join(install, rel));
  if (!fs.existsSync(abs)) missing.push(rel);
}
if (missing.length) {
  console.log("IMPORTS_MISSING " + missing.join(", "));
  process.exit(1);
}
console.log("ALL_IMPORTS_OK");
'@
  $tmp = Join-Path $env:TEMP ("picot-import-check-{0}.js" -f $Ts)
  Set-Content -LiteralPath $tmp -Value $checkJs -Encoding UTF8
  try {
    $out = (& node $tmp 2>&1 | Out-String).Trim()
    if ($out -match "ALL_IMPORTS_OK") {
      Write-Ok $out
    } elseif ($out -match "APP_JS_MISSING") {
      Write-Warn $out
    } else {
      Write-Err $out
      Write-Warn "app.js import gaps found; this sync does not overwrite app.js"
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
} else {
  Write-Warn "node not found; skip app.js import check"
}

Write-Host ""
Write-Host "====================================================" -ForegroundColor Green
Write-Host " Sync complete" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Green
Write-Host "Backup public : $bakPublic"
Write-Host "Backup ext    : $bakExt"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Fully start Picot"
Write-Host "  2. Settings -> Configuration -> Authentication"
Write-Host "  3. See Custom provider (relay) form"
Write-Host "  4. Base URL + API key -> Detect -> Test -> Save"
Write-Host ""
Write-Host "Rollback: copy files back from the backup paths above" -ForegroundColor DarkGray
Pause-Exit 0
