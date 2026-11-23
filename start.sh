#!/usr/bin/env bash
# ============================================================
#  Bionic Deck — one-command launcher (Linux / macOS)
#
#  Default: production mode — builds the UI once, then serves the
#           whole app (UI + API) from a single port: :8000
#  Dev mode: `./start.sh dev` — API on :8000 + dev UI on :3000
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

API_PORT=8000
MODE="${1:-prod}"

echo "======================================"
echo "  Bionic Deck — launcher"
echo "======================================"

# --- dependency checks ---------------------------------------------------
command -v python3 >/dev/null 2>&1 || { echo "[ERROR] python3 not found. Install Python 3.10+ and re-run."; exit 1; }
command -v node    >/dev/null 2>&1 || { echo "[ERROR] node not found. Install Node.js 18+ and re-run."; exit 1; }
command -v npm     >/dev/null 2>&1 || { echo "[ERROR] npm not found."; exit 1; }

# --- install backend deps if missing -------------------------------------
if ! python3 -c "import fastapi, uvicorn" >/dev/null 2>&1; then
  echo "[deps] installing backend dependencies..."
  python3 -m pip install -r backend/requirements.txt
fi

# --- install frontend deps if missing ------------------------------------
if [ ! -d frontend/node_modules ]; then
  echo "[deps] installing frontend dependencies (first run)..."
  ( cd frontend && npm install )
fi

# --- free the API port (kill any stale instance) --------------------------
PID=""
if command -v lsof >/dev/null 2>&1; then
  PID="$(lsof -ti tcp:${API_PORT} 2>/dev/null || true)"
elif command -v fuser >/dev/null 2>&1; then
  PID="$(fuser ${API_PORT}/tcp 2>/dev/null | tr -d ' ' || true)"
fi
if [ -n "${PID:-}" ]; then
  echo "[port] killing stale process ${PID} on :${API_PORT}"
  # shellcheck disable=SC2086
  kill -9 ${PID} 2>/dev/null || true
  sleep 1
fi

# --- dev mode -------------------------------------------------------------
if [ "$MODE" = "dev" ]; then
  echo "[dev] starting backend on :${API_PORT} and dev UI on :3000 ..."
  python3 backend/app.py &
  BACK_PID=$!
  ( cd frontend && npm start ) &
  FRONT_PID=$!
  trap 'kill ${BACK_PID} ${FRONT_PID} 2>/dev/null || true' INT TERM
  echo "======================================"
  echo "  API : http://localhost:${API_PORT}"
  echo "  UI  : http://localhost:3000"
  echo "  (Ctrl+C to stop both)"
  echo "======================================"
  wait
  exit 0
fi

# --- production mode (default) --------------------------------------------
if [ ! -f frontend/build/index.html ]; then
  echo "[build] building frontend (first run)..."
  ( cd frontend && npm run build )
fi

echo "======================================"
echo "  Starting Bionic Deck..."
echo "  Open:  http://localhost:${API_PORT}"
echo "  Stop : Ctrl+C"
echo "======================================"
exec python3 backend/app.py
