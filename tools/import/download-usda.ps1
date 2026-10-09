<#
Downloads the official USDA FoodData Central bulk datasets used by hypertroph+.
No API key required. Files land in tools/import/.cache/usda (git-ignored).

Run: powershell -ExecutionPolicy Bypass -File tools/import/download-usda.ps1
#>
param(
  [string]$OutDir = (Join-Path $PSScriptRoot ".cache\usda")
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$datasets = @(
  @{ name = "foundation"; url = "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2026-04-30.zip" },
  @{ name = "sr_legacy";  url = "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip" },
  @{ name = "fndds";      url = "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_2024-10-31.zip" }
)

foreach ($d in $datasets) {
  $zip = Join-Path $OutDir "$($d.name).zip"
  $dir = Join-Path $OutDir $d.name
  Write-Host "Downloading $($d.name) ..."
  Invoke-WebRequest -Uri $d.url -OutFile $zip -UseBasicParsing
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
  Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
  Write-Host "  -> $dir"
}
Write-Host "Done. Datasets in $OutDir"
