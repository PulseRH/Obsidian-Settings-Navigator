# PowerShell script to run npm from the correct project directory
$ProjectRoot = "C:\Code Projects\obsidian addons\Settings Back and fourth"
Set-Location $ProjectRoot

if (-not (Test-Path "package.json")) {
    Write-Host "Error: package.json not found in project directory: $ProjectRoot" -ForegroundColor Red
    exit 1
}

Write-Host "Running npm from: $ProjectRoot" -ForegroundColor Green
& npm $args


