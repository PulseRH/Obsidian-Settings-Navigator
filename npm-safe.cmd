@echo off
cd /d "C:\Code Projects\obsidian addons\Settings Back and fourth"
if not exist package.json (
    echo Error: package.json not found in project directory
    exit /b 1
)
echo Running npm from: %CD%
call npm %*


