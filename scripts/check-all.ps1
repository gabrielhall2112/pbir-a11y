<#

.SYNOPSIS
  Runs pbir-a11y against every *.Report folder under a directory.

.DESCRIPTION
  Recursively finds every folder whose name ends in ".Report", runs
  `pbir-a11y check` on each, and writes into a new timestamped
  "outputs_<yyyy-MM-dd_HHmmss>" folder so repeated runs never collide:
    <ReportName>.txt   human-readable findings
    <ReportName>.json  machine-readable findings
    summary.csv        one row per report: name, path, score, counts, status

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
    then run the script like so "pbir-a11y check C:\path\to\MyReport"

  #>
param(
    [string]$Root = (Get-Location).Path,
    [string]$OutputDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = (Resolve-Path $Root).Path
if (-not $OutputDir) {
    $stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
    $OutputDir = Join-Path $Root "outputs_$stamp"
}

$cli = Join-Path $PSScriptRoot "..\dist\cli.js"
if (-not (Test-Path $cli)) {
    throw "Could not find $cli. Run 'npm install' and 'npm run build' in the pbir-a11y folder first."
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$outputFull = (Resolve-Path $OutputDir).Path

# Skip the outputs folder itself and folders that never contain reports.
$skip = @("node_modules", ".git")
$reports = Get-ChildItem -Path $Root -Directory -Recurse -Filter "*.Report" -ErrorAction SilentlyContinue |
    Where-Object {
        $p = $_.FullName
        -not $p.StartsWith($outputFull, [System.StringComparison]::OrdinalIgnoreCase) -and
        -not ($skip | Where-Object { $p -match "[\\/]$([regex]::Escape($_))([\\/]|$)" })
    } |
    Sort-Object FullName

if (-not $reports) {
    Write-Host "No *.Report folders found under $Root"
    return
}

Write-Host "Found $($reports.Count) report(s) under $Root`n"

$summary = @()
$usedNames = @{}
$i = 0

foreach ($dir in $reports) {
    $i++
    $reportName = $dir.Name -replace '\.Report$', ''

    # Two reports can share a name in different folders; suffix _2, _3, ...
    $fileBase = $reportName
    $n = 1
    while ($usedNames.ContainsKey($fileBase.ToLower())) { $n++; $fileBase = "${reportName}_$n" }
    $usedNames[$fileBase.ToLower()] = $true

    $txtPath  = Join-Path $OutputDir "$fileBase.txt"
    $jsonPath = Join-Path $OutputDir "$fileBase.json"

    Write-Host "[$i/$($reports.Count)] $reportName" -NoNewline

    # Readable output (stderr included so load errors show up in the file).
    & node $cli check $dir.FullName 2>&1 | ForEach-Object { "$_" } |
        Set-Content -Path $txtPath -Encoding utf8

    # JSON output, used for the score. Exit code 1 just means issues were
    # found; 2 means the report couldn't be loaded.
    $json = & node $cli check $dir.FullName --json 2>$null
    $exit = $LASTEXITCODE

    $row = [ordered]@{
        ReportName = $reportName
        ReportPath = $dir.FullName
        Score      = ""
        Pages      = ""
        Visuals    = ""
        Issues     = ""
        Status     = ""
        OutputFile = $txtPath
    }

    if ($exit -eq 2 -or -not $json) {
        $row.Status = "Error (see output file)"
        if (Test-Path $jsonPath) { Remove-Item $jsonPath }
        Write-Host "  -> error" -ForegroundColor Red
    } else {
        $json | Set-Content -Path $jsonPath -Encoding utf8
        $s = ($json | Out-String | ConvertFrom-Json).summary
        $row.Score   = $s.overallScore
        $row.Pages   = $s.pageCount
        $row.Visuals = $s.visualCount
        $row.Issues  = $s.issueCount
        $row.Status  = if ($exit -eq 1) { "Has failures" } else { "OK" }
        Write-Host "  -> score $($s.overallScore)/100, $($s.issueCount) issue(s)"
    }

    $summary += [pscustomobject]$row
}

$csvPath = Join-Path $OutputDir "summary.csv"
$summary | Export-Csv -Path $csvPath -NoTypeInformation -Encoding utf8

Write-Host "`nDone. Results in $OutputDir"
Write-Host "Summary: $csvPath"
exit 0
