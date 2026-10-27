@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS, then try again.
  pause
  exit /b 1
)
call node "%~dp0scripts\start-system.mjs"
set "ERP_START_EXIT=%ERRORLEVEL%"
if not "%ERP_START_EXIT%"=="0" (
  echo Startup failed. See the error above. No data has been reset.
  pause
)
exit /b %ERP_START_EXIT%
