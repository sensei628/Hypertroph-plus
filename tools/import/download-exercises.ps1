<#
Downloads the Free Exercise DB catalogue (public domain / The Unlicense).
No API key required. Writes tools/import/.cache/exercises.json (git-ignored),
which tools/import/import-exercises.mjs turns into db/exercises.sql.

Run: powershell -ExecutionPolicy Bypass -File tools/import/download-exercises.ps1
#>
param(
  [string]$OutFile = (Join-Path $PSScriptRoot ".cache\exercises.json")
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
$url = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json"
Write-Host "Downloading Free Exercise DB ..."
Invoke-WebRequest -Uri $url -OutFile $OutFile -UseBasicParsing
Write-Host "  -> $OutFile"
Write-Host "Done. Now run: node tools/import/import-exercises.mjs"
