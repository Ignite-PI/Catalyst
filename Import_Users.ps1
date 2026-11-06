# ============================================================
#  CATALYST - One-time User Migration Script
#
#  Reads the ORBIT Leadership roster and writes users.js —
#  the seed file for CATALYST's internal user store.
#
#  After this initial migration, users are maintained inside
#  CATALYST (User Management page). ORBIT is NOT required again.
#
#  Re-run only if you intentionally want to RESET the seed.
# ============================================================

$ErrorActionPreference = "Stop"

$dashDir   = $PSScriptRoot
$orbitFile = Join-Path (Split-Path $dashDir -Parent) "..\ORBIT\ORBIT_Leadership.xlsx"
# Fallback: allow explicit path via -OrbitPath parameter / env
if (!(Test-Path $orbitFile)) {
    $orbitFile = "C:\Users\AL70683\OneDrive - Elevance Health\IGNITE PROJECTS\ORBIT\ORBIT_Leadership.xlsx"
}
$outFile   = Join-Path $dashDir "users.js"

Write-Host ""
Write-Host "  =========================================" -ForegroundColor Cyan
Write-Host "   CATALYST User Migration (ORBIT -> users.js)" -ForegroundColor White
Write-Host "  =========================================" -ForegroundColor Cyan
Write-Host ""

if (!(Test-Path $orbitFile)) {
    Write-Host "  ERROR: ORBIT_Leadership.xlsx not found." -ForegroundColor Red
    Write-Host "  Looked at: $orbitFile" -ForegroundColor Yellow
    try { Read-Host "  Press Enter to exit" | Out-Null } catch {}
    exit 1
}

Stop-Process -Name EXCEL -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

$excel = New-Object -ComObject Excel.Application
$excel.Visible       = $false
$excel.DisplayAlerts = $false

$users = [System.Collections.Generic.List[string]]::new()

try {
    $wb = $excel.Workbooks.Open($orbitFile, 0, $true)   # read-only
    $ws = $wb.Sheets.Item(1)
    $nRows = $ws.UsedRange.Rows.Count

    # Columns: 1=Associate Name, 2=Domain ID, 3=Manager, 4=Function(role), 5=Email
    for ($r = 2; $r -le $nRows; $r++) {
        $name   = "$($ws.Cells.Item($r,1).Value2)".Trim()
        $domId  = "$($ws.Cells.Item($r,2).Value2)".Trim()
        $mgr    = "$($ws.Cells.Item($r,3).Value2)".Trim()
        $func   = "$($ws.Cells.Item($r,4).Value2)".Trim()
        $email  = "$($ws.Cells.Item($r,5).Value2)".Trim()

        if ($domId -eq '' -or $name -eq '') { continue }

        # Map ORBIT Function -> CATALYST role
        $role = switch -Regex ($func.ToUpper()) {
            'ADMIN'  { 'Admin';      break }
            'MANAGER'{ 'Manager';    break }
            default  { 'Leadership'; break }
        }

        $esc = { param($s) ($s -replace '\\','\\' -replace '"','\"') }

        $entry = '{"DomainId":"' + (& $esc $domId) +
                 '","Name":"'         + (& $esc $name)  +
                 '","Manager":"'      + (& $esc $mgr)   +
                 '","Role":"'         + $role           +
                 '","Email":"'        + (& $esc $email) +
                 '","Active":true,"CreatedBy":"ORBIT_IMPORT","CreatedAt":"' +
                 (Get-Date -Format "yyyy-MM-ddTHH:mm:ss") + '"}'
        $users.Add($entry)
    }

    $wb.Close($false)
}
finally {
    try { $excel.Quit() } catch {}
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null } catch {}
}

$usersJson = '[' + ($users -join ',') + ']'

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add('/* ============================================================')
$lines.Add('   CATALYST - User Seed Data')
$lines.Add('   Source    : ORBIT_Leadership.xlsx (one-time migration)')
$lines.Add('   Generated : ' + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))
$lines.Add('   Users     : ' + $users.Count)
$lines.Add('')
$lines.Add('   After first load, CATALYST persists user changes in')
$lines.Add('   localStorage (key: catalyst_users_v1). This seed is only')
$lines.Add('   the starting population — do not edit by hand.')
$lines.Add('   ============================================================ */')
$lines.Add('')
$lines.Add('window.CATALYST_USERS_SEED = {')
$lines.Add('  users: ' + $usersJson)
$lines.Add('};')

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($outFile, ($lines -join "`r`n"), $utf8NoBom)

Write-Host "  Imported $($users.Count) users -> users.js" -ForegroundColor Green
Write-Host ""
try { Read-Host "  Press Enter to exit" | Out-Null } catch {}
