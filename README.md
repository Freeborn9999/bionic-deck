# Bionic Deck 🚀

**Bionic Deck** is a local control panel for [Bionic](https://lmstudio.ai/). It gives you a fast web UI to do the things that are otherwise buried in JSON config files — add and test MCP servers, toggle Bionic's non-GUI settings, manage Bionic's install location, and restart Bionic — all without hand-editing files.

Everything runs on your machine against Bionic's **real** config files, so changes you make here are the changes Bionic itself reads.

## ✨ What it does

- **MCP Manager** — add, remove, and **test** MCP servers. Supports URL servers (Streamable HTTP / SSE, optional bearer token) and command (stdio) servers with args/env. Pre-populated presets, an "already configured" indicator, and a **Test** action for both a server in the list and a draft in the add form (configure and test **before** adding).
- **MCP Sources** — pull a catalog of MCP servers from a built-in **Curated Essentials** catalog (10 trustworthy, offline-ready servers — the default source), the **official MCP Registry**, or **any custom JSON dump URL**. Browse the results with checkboxes, see which are already in Bionic, **test** any of them, then **bulk-add** the selection in one shot (deduped, with added/skipped/error reporting) and restart Bionic to load them.
- **Bionic Settings** — a curated set of Bionic-specific settings that are **not** exposed in Bionic's own GUI (developer, browser, appearance, mini-window, notifications, sessions, agent, updates, voice, etc.). Deliberately **no** model/LLM/hosting settings — those belong in LM Studio.
- **Config Manager** — see and edit Bionic's **install location** (auto-populated, with a folder browser for alternate installs), view the local API host/port/PID, and **restart Bionic** to pick up changes.
- **Home** — status at a glance plus a **Restart Bionic** action.

> Note: MCP servers and setting changes are written to disk immediately, but Bionic loads MCP servers at startup — use **Restart Bionic** to make a newly added MCP appear in Bionic.

## 📂 Project structure

```
BionicDeck/
├─ backend/
│  ├─ app.py            # FastAPI server: real file reads/writes + MCP test + restart
│  └─ requirements.txt  # fastapi, uvicorn
├─ frontend/
│  ├─ src/
│  │  ├─ App.jsx        # nav shell + shared component styles
│  │  ├─ api.js         # tiny fetch helper (base = http://localhost:8000)
│  │  └─ views/         # HomeView, MCPManager, SourcesView, SettingsView, ConfigManager
│  └─ package.json      # React (CRA)
├─ start.bat            # one-click Windows launcher (kills stale API, starts both)
├─ start.sh             # one-command Linux/macOS launcher (production :8000, or `dev` mode)
├─ .gitignore
└─ README.md
```

## 🚀 Getting started

**Prerequisites**
- Python 3.10+ (`python` / `python3` on PATH)
- Node.js 18+ with npm
- Bionic installed (default location is auto-detected)

There are two ways to run it:

- **Production mode (recommended for everyday use)** — one process serves both the UI and the API from a single port: **http://127.0.0.1:8000**. Nothing else to open.
- **Dev mode** — API on `:8000` plus a hot-reload dev UI on `:3000`. For working on the code.

### One click

**Windows** — `start.bat` (dev mode: API :8000 + UI :3000, two windows):
```bat
start.bat
```

**Linux / macOS** — `start.sh` (production mode by default: single port :8000):
```sh
./start.sh            # builds the UI once, then serves UI + API on http://127.0.0.1:8000
./start.sh dev        # or: API on :8000 + dev UI on :3000
```

The launcher installs backend deps if missing and frees port 8000 so a stale API can't shadow the real one. In production mode open **http://127.0.0.1:8000**; in dev mode open **http://localhost:3000**.

### Manual (two terminals)

**Backend** (port 8000):
```sh
cd backend
python -m pip install -r requirements.txt
python app.py          # Windows: python  ·  Linux/macOS: python3
```

**Frontend** (dev UI on port 3000) — *only needed in dev mode; in production the backend serves the built UI*:
```sh
cd frontend
npm install
npm start
```

Then open **http://localhost:3000**.

**Production mode** (single port 8000) — build the UI once, then just run the backend:
```sh
cd frontend && npm install && npm run build && cd ..
python backend/app.py   # serves UI + API on http://127.0.0.1:8000
```

> **Tip:** If a previous backend is still holding port 8000, it can shadow the current one. The launchers handle this for you; manually, kill whatever is listening on `:8000` before restarting.

## ⚙️ Where things are written

Bionic Deck reads and writes Bionic's real config under your user profile (`~/.lmstudio/apps/bionic/.internal/`):

| Purpose | File |
|---|---|
| MCP servers | `ng-mcp.json` |
| Non-GUI Bionic settings | `settings.json` |
| Install location / restart target | `app-install-location.json` |
| Local API host/port/PID | `http-server.json` |

The backend resolves these paths from your user home at runtime (nothing is hardcoded to a specific user), and the Config Manager lets you override the Bionic install path.

## 🔌 API (for reference)

| Method & path | Purpose |
|---|---|
| `GET /health` | liveness + resolved paths |
| `GET /bionic/paths` | resolved config paths + local API info |
| `GET/POST /bionic/install-location` | read / set Bionic install path |
| `GET /bionic/browse?path=` | list a directory (for the folder browser) |
| `POST /bionic/restart` | best-effort restart of Bionic |
| `GET/POST /bionic/settings` | read / update non-GUI Bionic settings |
| `GET /mcp/servers` | configured MCP servers |
| `POST /mcp/add` | add a server |
| `POST /mcp/remove` | remove a server by id |
| `POST /mcp/test` | connectivity test (by id, or from a draft) |
| `GET /mcp/sources` | list built-in (trusted) MCP catalog sources |
| `GET /mcp/sources/fetch?id=` / `?url=` | fetch + normalize a source into MCP server objects |
| `POST /mcp/bulk-add` | add many servers at once (deduped by url/command) |

## 📦 Publishing / notes

- **Two ways to run:** dev (API :8000 + UI :3000) or production (UI + API on :8000, single process). `start.bat` (Windows) and `start.sh` (Linux/macOS) are the supported launchers.
- **Production:** `npm run build` in `frontend/` produces `frontend/build/`; the backend auto-serves it at `/` when present (API routes always take priority over the static mount). This is how it ships.
- Bionic-specific settings are a curated subset of `settings.json`; extend the `NON_GUI_KEYS` list in `backend/app.py` to expose more.
- **MCP sources:** the built-in **Curated Essentials** catalog lives in `backend/app.py` (`CURATED_SERVERS`) and is served offline; add entries there to expand it.
