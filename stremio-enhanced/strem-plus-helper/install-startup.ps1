# Strem+ helper installer.
#
# Right-click this file > "Run with PowerShell". Run it once: from then on the helper starts by
# itself every time you log in to Windows (and restarts itself if it ever crashes).
#
# To remove it again, run in PowerShell:
#   powershell -ExecutionPolicy Bypass -File install-startup.ps1 -Remove
param([switch]$Remove)

$dir = $PSScriptRoot
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Strem+ Helper.lnk'

function Stop-Helper {
    # The starter (start-hidden.vbs) restarts the helper if it stops, so stop the starter first.
    $here = [regex]::Escape($dir)
    Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" | Where-Object { $_.CommandLine -match $here } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'scrape-helper' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Done($msg) { Write-Host ""; Write-Host $msg; Write-Host ""; Read-Host "Press Enter to close" | Out-Null; exit }

Write-Host "Strem+ helper"
Write-Host "-------------"

if ($Remove) {
    Remove-Item $lnk -ErrorAction SilentlyContinue
    Stop-Helper
    Done "Removed. The helper is stopped and won't start with Windows any more. You can delete this folder."
}

# 1. Node.js is needed to run the helper.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Done "Node.js isn't installed. Install it from https://nodejs.org (the LTS version), then run this again."
}
Write-Host "Node.js found: $(node --version)"

# 2. Files downloaded from the internet are marked as untrusted; unmark the helper's files.
Get-ChildItem $dir -File | Unblock-File -ErrorAction SilentlyContinue

# 3. Start with Windows.
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = "$env:WINDIR\System32\wscript.exe"
$s.Arguments = "`"$dir\start-hidden.vbs`""
$s.WorkingDirectory = $dir
$s.Description = 'Strem+ helper for Stremio Enhanced (downloads and torrent stats)'
$s.Save()
Write-Host "Set to start with Windows."

# 4. Start it now, so there's no need to log out.
Stop-Helper
Start-Process wscript.exe -ArgumentList "`"$dir\start-hidden.vbs`""
Start-Sleep 3
try {
    Invoke-WebRequest http://127.0.0.1:48760/health -UseBasicParsing -TimeoutSec 5 | Out-Null
    Done "All set. The helper is running. Restart Stremio Enhanced if it's open."
} catch {
    Done "The helper didn't start. Check helper.log in this folder, or run 'node scrape-helper.mjs' here to see the error."
}
