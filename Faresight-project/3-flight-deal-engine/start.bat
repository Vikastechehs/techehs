@echo off
cd /d "%~dp0"
echo Starting the flight deal engine. Keep this window open; close it (or press Ctrl+C) to stop.
start "" http://localhost:3000
node src/main.ts
pause
