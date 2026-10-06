<#

.SYNOPSIS
  Runs pbir-a11y against every *.Report folder under a directory.

.DESCRIPTION
  Recursively finds every folder whose name ends in ".Report" and contains
  a "definition" file (any extension, e.g. definition.pbir), runs
  `pbir-a11y check` on each, and writes into a new timestamped
  "outputs_<yyyy-MM-dd_HHmmss>" folder so repeated runs never collide:
    <ReportName>.txt   human-readable findings
    <ReportName>.json  machine-readable findings
    summary_<yyyy-MM-dd_HHmmss>.csv   one row per report: name, path, score, counts, status

.PARAMETER Root
  Folder to search. Defaults to the current directory.

.PARAMETER OutputDir
  Where results go. Defaults to "<Root>\outputs_<yyyy-MM-dd_HHmmss>".

.EXAMPLE
  .\scripts\check-all.ps1 -Root "C:\PowerBI\Reports"

.SETUP
    npm install
    npm run build
    npm link
    to run against 1 report.... "pbir-a11y check C:\path\to\MyReport"
    for all.... "PS $usr\source\github\UCLA-ORIS\pbir-a11y> pbir-a11y check "C:\Users\GabrielHall\source\github\UCLA-ORIS\ORIS.PowerBI.Reports.AVC\"   "

  #>
param(
    [string]$Root = (Get-Location).Path,
    [string]$OutputDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = (Resolve-Path $Root).Path
$stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
if (-not $OutputDir) {
    $OutputDir = Join-Path $Root "outputs_$stamp"
}

$cli = Join-Path $PSScriptRoot "..\dist\cli.js"
if (-not (Test-Path $cli)) {
    throw "Could not find $cli. Run 'npm install' and 'npm run build' in the pbir-a11y folder first."
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$outputFull = (Resolve-Path $OutputDir).Path

# A report folder is "<some name>.Report" -- case-sensitive, with at least
# one character before ".Report".
$reportPattern = '^.+\.Report$'

# Folders that never contain reports, plus previous outputs_* runs.
$skipNames   = @("node_modules", ".git")
$skipPattern = '^outputs(_\d{4}-\d{2}-\d{2}_\d{6})?$'

$totalTimer = [System.Diagnostics.Stopwatch]::StartNew()
Write-Host "Searching for report folders under $Root ..."

# Walk the tree ourselves so we can show progress, skip junk folders, and
# avoid descending into a report once we've found it.
$reports = New-Object System.Collections.Generic.List[System.IO.DirectoryInfo]
$pending = New-Object System.Collections.Generic.Stack[System.IO.DirectoryInfo]
$pending.Push([System.IO.DirectoryInfo]::new($Root))
$scanned = 0
$skippedNoDef = 0

while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    $scanned++
    if ($scanned % 200 -eq 0) {
        Write-Progress -Activity "Searching for report folders" `
            -Status "$scanned folders checked, $($reports.Count) report(s) found" `
            -CurrentOperation $current.FullName
    }

    try {
        $children = $current.GetDirectories()
    } catch {
        Write-Host "  skipped (can't open): $($current.FullName)" -ForegroundColor DarkYellow
        continue
    }

    foreach ($child in $children) {
        if ($child.FullName -eq $outputFull) { continue }
        if ($skipNames -contains $child.Name -or $child.Name -cmatch $skipPattern) { continue }
        if ($child.LinkTarget) { continue }   # symlink/junction: avoid loops

        if ($child.Name -cmatch $reportPattern) {
            # A real report has a "definition" file directly inside it (e.g.
            # definition.pbir); without one it's a leftover from an old branch.
            $hasDefinition = @($child.GetFiles("definition.*")).Count -gt 0
            if ($hasDefinition) {
                $reports.Add($child)
                Write-Host "  found: $($child.FullName)"
            } else {
                $skippedNoDef++
                Write-Host "  skipped (no definition file): $($child.FullName)" -ForegroundColor DarkYellow
            }
        } else {
            $pending.Push($child)
        }
    }
}
Write-Progress -Activity "Searching for report folders" -Completed

$reports = @($reports | Sort-Object FullName)
if ($reports.Count -eq 0) {
    Write-Host "No *.Report folders found under $Root ($scanned folders checked, $skippedNoDef skipped with no definition file)"
    Remove-Item $OutputDir -ErrorAction SilentlyContinue
    exit 0
}

Write-Host ("Found {0} report(s) in {1} folders ({2:N1}s)" -f $reports.Count, $scanned, $totalTimer.Elapsed.TotalSeconds)
if ($skippedNoDef -gt 0) {
    Write-Host "Skipped $skippedNoDef *.Report folder(s) with no definition file"
}
Write-Host ""

# Repository = the nearest parent folder containing ".git" (a folder, or a
# file for worktrees/submodules). Blank if the report isn't in a repo.
$repoCache = @{}
function Get-RepoName([System.IO.DirectoryInfo]$dir) {
    $d = $dir
    $visited = @()
    while ($d) {
        if ($repoCache.ContainsKey($d.FullName)) { $name = $repoCache[$d.FullName]; break }
        $visited += $d.FullName
        if (Test-Path -LiteralPath (Join-Path $d.FullName ".git")) { $name = $d.Name; break }
        $d = $d.Parent
    }
    if (-not $d) { $name = "" }
    foreach ($v in $visited) { $repoCache[$v] = $name }
    return $name
}

$summary = @()
$usedNames = @{}
$i = 0

foreach ($dir in $reports) {
    $i++
    $reportName = $dir.Name -creplace '\.Report$', ''

    # Two reports can share a name in different folders; suffix _2, _3, ...
    $fileBase = $reportName
    $n = 1
    while ($usedNames.ContainsKey($fileBase.ToLower())) { $n++; $fileBase = "${reportName}_$n" }
    $usedNames[$fileBase.ToLower()] = $true

    $txtPath  = Join-Path $OutputDir "$fileBase.txt"
    $jsonPath = Join-Path $OutputDir "$fileBase.json"

    Write-Host "[$i/$($reports.Count)] $reportName" -ForegroundColor Cyan
    Write-Host "  reading:   $($dir.FullName)"
    Write-Host "  analyzing..." -NoNewline
    $timer = [System.Diagnostics.Stopwatch]::StartNew()

    # One run writes both outputs: readable text on stdout (stderr included
    # so load errors land in the file) and JSON via --json-out. Exit code 1
    # just means issues were found; 2 means the report couldn't be loaded.
    & node $cli check $dir.FullName --json-out $jsonPath 2>&1 | ForEach-Object { "$_" } |
        Set-Content -Path $txtPath -Encoding utf8
    $exit = $LASTEXITCODE
    $secs = "{0:N1}s" -f $timer.Elapsed.TotalSeconds

    $row = [ordered]@{
        ReportName = $reportName
        Repository = Get-RepoName $dir
        ReportPath = $dir.FullName
        Score      = ""
        Pages      = ""
        Visuals    = ""
        Issues     = ""
        Status     = ""
        OutputFile = $txtPath
    }

    if ($exit -eq 2 -or -not (Test-Path $jsonPath)) {
        $row.Status = "Error (see output file)"
        $firstLine = Get-Content $txtPath -TotalCount 1
        Write-Host " error ($secs)" -ForegroundColor Red
        if ($firstLine) { Write-Host "  $firstLine" -ForegroundColor Red }
    } else {
        $s = (Get-Content $jsonPath -Raw | ConvertFrom-Json).summary
        $row.Score   = $s.overallScore
        $row.Pages   = $s.pageCount
        $row.Visuals = $s.visualCount
        $row.Issues  = $s.issueCount
        $row.Status  = if ($exit -eq 1) { "Has failures" } else { "OK" }
        Write-Host " done ($secs)" -ForegroundColor Green
        Write-Host "  result:    score $($s.overallScore)/100, $($s.pageCount) page(s), $($s.issueCount) issue(s)"
    }

    $summary += [pscustomobject]$row
}

$csvPath = Join-Path $OutputDir "summary_$stamp.csv"
$summary | Export-Csv -Path $csvPath -NoTypeInformation -Encoding utf8

Write-Host ("`nDone in {0:N1}s. Results in $OutputDir" -f $totalTimer.Elapsed.TotalSeconds)
Write-Host "Summary: $csvPath"
exit 0
