@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0runtime\node\node.exe" set "PATH=%~dp0runtime\node;%PATH%"
call npm.cmd stop
set "ERP_STOP_EXIT=%ERRORLEVEL%"
pause
exit /b %ERP_STOP_EXIT%
