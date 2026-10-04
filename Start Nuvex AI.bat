@echo off
setlocal
set "HTML_UI_PORT=3010"
cd /d "%~dp0"
title Nuvex AI 3.0

echo.
echo ==========================================
echo            Nuvex AI 3.0
echo ==========================================
echo.

if not exist "server.js" (
  echo ERROR: server.js was not found in:
  echo %CD%
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  if exist "node\node.exe" (
    set "NODE=%CD%\node\node.exe"
  ) else if exist "node-runtime\node.exe" (
    set "NODE=%CD%\node-runtime\node.exe"
  ) else (
    echo ERROR: Node.js was not found.
    echo Install Node.js or use the included portable runtime if present.
    echo.
    pause
    exit /b 1
  )
) else (
  set "NODE=node"
)

if not exist "node_modules" (
  echo Installing required packages...
  where npm >nul 2>nul
  if not errorlevel 1 (
    call npm install --omit=dev
    if errorlevel 1 (
      echo ERROR: npm install failed.
      pause
      exit /b 1
    )
  )
)

echo Starting Nuvex AI 3.0...
start "" http://localhost:3010/
"%NODE%" server.js

echo.
echo Nuvex AI 3.0 stopped.
pause
