@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" copy /Y ".env.example" ".env" >nul
start "" notepad.exe ".env"
exit /b 0
