@echo off
rem SPDX-License-Identifier: Apache-2.0
rem zprof dashboard at http://127.0.0.1:8781 (live views need the bridge, python -m zprof_bridge serve)
rem Port 8781 is fixed (vite.config.ts). Extra args go to vite.
setlocal
set "ROOT=%~dp0"
if not exist "%ROOT%web\node_modules\.bin\vite.cmd" (
  echo web\node_modules is missing. First-time setup:
  echo   cd /d "%ROOT%web" ^&^& npm install
  pause
  exit /b 1
)
cd /d "%ROOT%web"
call node_modules\.bin\vite.cmd --open %*
if errorlevel 1 (
  echo.
  echo Dev server failed. Is port 8781 already in use? Sferic source must be at ..\lightning\src.
  pause
)
