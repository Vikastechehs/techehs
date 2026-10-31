@echo off
cd /d "%~dp0"
rem Demo with simulated fares in a separate database (data\demo), so it never mixes with real data
set FARE_SOURCE=mock
set LOCAL_DB_DIR=%~dp0data\demo
node src/cli.ts demo
echo Opening the demo site. Admin: http://localhost:3000/admin (password in .env)
start "" http://localhost:3000/admin
node src/main.ts
pause
