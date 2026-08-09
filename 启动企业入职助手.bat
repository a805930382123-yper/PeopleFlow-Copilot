@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" copy /Y ".env.example" ".env" >nul
if exist "runtime\node.exe" goto bundled_node
where node.exe >nul 2>nul
if errorlevel 1 goto no_node
set "NODE_BIN=node.exe"
goto launch
:bundled_node
set "NODE_BIN=%~dp0runtime\node.exe"
:launch
if "%PEOPLEFLOW_CHECK_ONLY%"=="1" goto check_only
if not defined AUTO_OPEN set "AUTO_OPEN=1"
start "" /min "%NODE_BIN%" --env-file-if-exists=.env scripts\launcher.mjs
exit /b 0
:check_only
"%NODE_BIN%" --version
exit /b %errorlevel%
:no_node
echo Node.js runtime was not found.
pause
exit /b 1
