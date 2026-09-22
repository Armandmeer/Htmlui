@echo off
title Smart Home KNX Dashboard
cd /d "%~dp0"
echo ========================================
echo       KNX DASHBOARD - Html ui
echo ========================================
echo.
where node >nul 2>nul
if errorlevel 1 (
 echo Node.js is niet geinstalleerd.
 echo Installeer Node.js 18 of nieuwer.
 pause
 exit /b 1
)
if not exist node_modules (
 echo Dependencies installeren...
 call npm install
 if errorlevel 1 (
  echo npm install mislukt.
  pause
  exit /b 1
 )
) else if not exist node_modules\ffmpeg-static (
 echo ffmpeg-static ontbreekt. Dependencies opnieuw installeren...
 call npm install
 if errorlevel 1 (
  echo npm install mislukt.
  pause
  exit /b 1
 )
)
echo.
echo Backend starten...
echo Laat dit venster open.
echo Dashboard: http://smarthome.local:3010
echo Fallback : http://^<server-ip^>:3010
echo.
echo mDNS hostname: smarthome.local
echo.
node server.js
pause
