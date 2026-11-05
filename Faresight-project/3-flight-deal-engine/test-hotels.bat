@echo off
cd /d "%~dp0"
echo Running 5 real hotel searches through Scrape.do (about 50 credits)...
node src/cli.ts hotels-once 5
pause
