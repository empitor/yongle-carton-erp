@echo off
setlocal
cd /d "%~dp0"
call npm.cmd stop
set "ERP_STOP_EXIT=%ERRORLEVEL%"
pause
exit /b %ERP_STOP_EXIT%
