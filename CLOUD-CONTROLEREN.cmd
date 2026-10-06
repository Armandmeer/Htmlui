@echo off
cd /d "%~dp0"
set "NUVEX_DIAG_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "node\node.exe" (
    set "NUVEX_DIAG_NODE=%~dp0node\node.exe"
  ) else if exist "node-runtime\node.exe" (
    set "NUVEX_DIAG_NODE=%~dp0node-runtime\node.exe"
  ) else (
    echo Node.js ontbreekt. Gebruik eerst de normale Nuvex-startprocedure.
    pause
    exit /b 1
  )
)
"%NUVEX_DIAG_NODE%" "%~dp0cloud-diagnose.js"
pause
