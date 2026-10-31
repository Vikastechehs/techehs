@echo off
cd /d "%~dp0"
echo Installing packages...
call npm install --omit=dev
if errorlevel 1 (echo npm install failed & pause & exit /b 1)
node src/cli.ts setup
echo.
echo Setup finished. Next: double-click test-real.bat for a 50-search real test, or start.bat to run everything.
pause
