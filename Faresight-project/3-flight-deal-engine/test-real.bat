@echo off
cd /d "%~dp0"
echo Running 50 real searches through Scrape.do (about 500 credits)...
node src/cli.ts sweep-once 50
pause
