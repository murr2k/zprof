@echo off
rem zprof dashboard mockup (synthetic data) at http://127.0.0.1:8781
rem Port 8781 is allocated in ~/.claude/port-registry.md. Extra args go to vite.
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
