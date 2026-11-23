@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ================================================
echo   Bionic Deck - local launcher
echo ================================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python was not found on PATH. Install Python 3.10+ and re-run.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found on PATH. Install Node.js 18+ and re-run.
  pause
  exit /b 1
)

echo [1/4] Checking backend dependencies...
python -c "import fastapi, uvicorn" >nul 2>nul
if errorlevel 1 (
  echo        Installing fastapi + uvicorn...
  python -m pip install -r backend\requirements.txt
)
if errorlevel 1 (
  echo [ERROR] Could not install backend dependencies.
  pause
  exit /b 1
)

echo [2/4] Freeing port 8000 (killing any stale API)...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8000" ^| findstr "LISTENING"') do (
  echo        Killing stale process %%p on :8000
  taskkill /F /PID %%p >nul 2>nul
)
timeout /t 1 /nobreak >nul

echo [3/4] Starting backend API on http://127.0.0.1:8000 ...
start "Bionic Deck API" cmd /k "python backend\app.py"

echo [4/4] Starting frontend UI on http://localhost:3000 ...
start "Bionic Deck UI" cmd /k "cd frontend && call npm start"

echo.
echo ================================================
echo   Done. Two new windows opened:
echo     - "Bionic Deck API"  (backend,  port 8000)
echo     - "Bionic Deck UI"   (frontend, port 3000)
echo.
echo   Wait for the UI to compile, then open:
echo     http://localhost:3000
echo.
echo   Close those two windows to stop everything.
echo ================================================
endlocal
