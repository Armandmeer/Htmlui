@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js is niet gevonden. Gebruik de volledige HTMLUI3.1 zip of installeer Node.js.
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)
if not exist "%~dp0node_modules" (
  echo Benodigde modules ontbreken.
  echo Installeer Node.js met npm en voer daarna in deze map uit: npm install --omit=dev
  pause
  exit /b 1
)
echo HTML UI start op http://localhost:3010/
echo Laat dit venster open. Stop de server met Ctrl+C.
start "" "http://localhost:3010/"
"%NODE_EXE%" server.js
echo.
echo De HTML UI-server is gestopt.
pause
