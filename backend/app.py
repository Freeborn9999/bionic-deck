"""
Bionic Deck backend.

Reads/writes the *real* Bionic config files so that changes actually show up in
Bionic (MCP servers, non-GUI settings, install path) and can restart the app.

Endpoints
---------
GET  /health                          -> backend liveness + resolved paths
GET  /bionic/paths                    -> resolved Bionic file paths + local API
GET  /bionic/install-location         -> current install location
POST /bionic/install-location         -> update install location {path}
GET  /bionic/browse?path=<dir>        -> list subfolders for the browse picker
POST /bionic/restart                  -> best-effort restart of Bionic
GET  /bionic/settings                 -> non-GUI Bionic settings (no model/LLM)
POST /bionic/settings                 -> update non-GUI settings {settings:{}}
GET  /mcp/servers                     -> real configured MCP servers (ng-mcp.json)
POST /mcp/add                         -> add a server to ng-mcp.json
POST /mcp/remove                      -> remove a server by id
POST /mcp/test                        -> real reachability/connectivity test
GET  /mcp/sources                     -> built-in trusted MCP catalog sources
GET  /mcp/sources/fetch               -> fetch + normalize a catalog (id or url)
POST /mcp/bulk-add                    -> bulk-add servers to ng-mcp.json (deduped)
"""

import json
import os
import platform
import signal
import subprocess
import urllib.request
import urllib.error
import urllib.parse
import uuid

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Bionic Deck API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Resolving real Bionic file locations (configurable, never hardcoded per-user)
# --------------------------------------------------------------------------- #
def _lm_home() -> str:
    return os.path.join(os.path.expanduser("~"), ".lmstudio")


def _bionic_internal() -> str:
    return os.path.join(_lm_home(), "apps", "bionic", ".internal")


def resolved_paths() -> dict:
    lm_home = _lm_home()
    internal = _bionic_internal()
    return {
        "lm_home": lm_home,
        "bionic_dir": os.path.join(lm_home, "apps", "bionic"),
        "internal_dir": internal,
        "ng_mcp_path": os.path.join(internal, "ng-mcp.json"),
        "mcp_json_path": os.path.join(lm_home, "mcp.json"),
        "settings_path": os.path.join(internal, "settings.json"),
        "install_location_path": os.path.join(internal, "app-install-location.json"),
        "http_server_path": os.path.join(internal, "http-server.json"),
    }


P = resolved_paths()


# --------------------------------------------------------------------------- #
# JSON helpers
# --------------------------------------------------------------------------- #
def _load_json(path: str, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _save_json(path: str, data) -> None:
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _get_nested(d, dotted: str):
    cur = d
    for key in dotted.split("."):
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    return cur


def _set_nested(d, dotted: str, value) -> None:
    keys = dotted.split(".")
    cur = d
    for key in keys[:-1]:
        nxt = cur.get(key)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[key] = nxt
        cur = nxt
    cur[keys[-1]] = value


# --------------------------------------------------------------------------- #
# Health / paths
# --------------------------------------------------------------------------- #
@app.get("/health")
async def health():
    return {
        "ok": True,
        "platform": platform.system(),
        "paths": P,
    }


@app.get("/bionic/paths")
async def get_paths():
    local_api = _load_json(P["http_server_path"], {}) or {}
    return {**P, "local_api": local_api}


# --------------------------------------------------------------------------- #
# Install location + browse
# --------------------------------------------------------------------------- #
@app.get("/bionic/install-location")
async def get_install_location():
    data = _load_json(P["install_location_path"], {}) or {}
    return {
        "path": data.get("path"),
        "argv": data.get("argv"),
        "cwd": data.get("cwd"),
    }


@app.post("/bionic/install-location")
async def set_install_location(payload: dict):
    path = (payload.get("path") or "").strip()
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    _save_json(
        P["install_location_path"],
        {"path": path, "argv": [path], "cwd": os.path.dirname(path)},
    )
    return {"status": "success", "path": path}


@app.get("/bionic/browse")
async def browse(path: str = Query(default=None)):
    base = path or os.path.expanduser("~")
    try:
        entries = os.listdir(base)
    except OSError:
        raise HTTPException(status_code=404, detail=f"cannot list: {base}")
    dirs = []
    for name in sorted(entries, key=str.lower):
        full = os.path.join(base, name)
        try:
            if os.path.isdir(full):
                dirs.append({"name": name, "path": full})
        except OSError:
            continue
    parent = os.path.dirname(base.rstrip("/\\"))
    return {
        "current": base,
        "parent": parent if parent and parent != base else None,
        "dirs": dirs,
    }


# --------------------------------------------------------------------------- #
# Restart Bionic (best-effort)
# --------------------------------------------------------------------------- #
@app.post("/bionic/restart")
async def restart_bionic():
    is_win = platform.system() == "Windows"
    install = _load_json(P["install_location_path"], {}) or {}
    exe = install.get("path")
    local_api = _load_json(P["http_server_path"], {}) or {}
    pid = local_api.get("pid")

    result = {"killed": False, "relaunched": False, "details": []}

    if is_win:
        if pid:
            try:
                subprocess.run(
                    ["taskkill", "/F", "/PID", str(pid)],
                    capture_output=True, text=True, timeout=10,
                )
                result["killed"] = True
                result["details"].append(f"Killed running Bionic (pid {pid})")
            except Exception as e:  # noqa: BLE001
                result["details"].append(f"Kill by pid failed: {e}")
        if not result["killed"]:
            try:
                subprocess.run(
                    ["taskkill", "/F", "/IM", "Bionic.exe"],
                    capture_output=True, text=True, timeout=10,
                )
                result["killed"] = True
                result["details"].append("Killed Bionic.exe (image name)")
            except Exception as e:  # noqa: BLE001
                result["details"].append(f"Kill by image name failed: {e}")

        if exe and os.path.exists(exe):
            flags = 0
            if hasattr(subprocess, "DETACHED_PROCESS"):
                flags |= subprocess.DETACHED_PROCESS
            if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
                flags |= subprocess.CREATE_NEW_PROCESS_GROUP
            subprocess.Popen(
                [exe],
                cwd=install.get("cwd") or os.path.dirname(exe),
                creationflags=flags,
            )
            result["relaunched"] = True
            result["details"].append(f"Relaunched {exe}")
        else:
            result["details"].append("Bionic executable not found; not relaunched.")
    else:
        if pid:
            try:
                os.kill(int(pid), signal.SIGTERM)
                result["killed"] = True
                result["details"].append(f"Sent SIGTERM to pid {pid}")
            except Exception as e:  # noqa: BLE001
                result["details"].append(f"Kill failed: {e}")
        if exe and os.path.exists(exe):
            subprocess.Popen([exe], start_new_session=True)
            result["relaunched"] = True
            result["details"].append(f"Relaunched {exe}")
        else:
            result["details"].append("Bionic executable not found; not relaunched.")

    return result


# --------------------------------------------------------------------------- #
# Non-GUI Bionic settings (explicitly NO model / LLM / LM-Studio settings)
# --------------------------------------------------------------------------- #
NON_GUI_KEYS = {
    # Developer
    "developer.betaDangerouslyEnableAgentControlAPI",
    "developer.orchestratorPresentationMode",
    "developer.runtimeLogVerbosityLevel",
    "developer.windowsPreferPowerShell",
    "developer.topicsEnabled",
    # In-app browser
    "browser.storageMode",
    "browser.preferredLinkOpenTarget",
    "browser.allowedOrigins",
    # Appearance
    "appearance.inlineDiffMode",
    "appearance.sidebarBackgroundMode",
    # Mini window
    "miniWindow.showInEveryWorkspace",
    "miniWindow.followFocusedInput",
    # Notifications
    "notifications.sessionCompletedEnabled",
    # Agent behavior (non-model)
    "agent.explorationSubagentEnabled",
    "agent.widgetsEnabled",
    "agent.widgetFollowUpActionsEnabled",
    "agent.webSearchEnabled",
    # Session behavior
    "sessions.historyRecallEnabled",
    "sessions.queueSendsWhileRunning",
    "sessions.renameAfterFork",
    "sessions.browserControlEnabled",
    "sessions.arrowUpEditsLatestMessage",
    "sessions.latestMessageUsesEditAction",
    # App
    "updates.automaticDownloadsEnabled",
    "voice.voiceKeyboardStopOnEnter",
}


@app.get("/bionic/settings")
async def get_bionic_settings():
    settings = _load_json(P["settings_path"], {}) or {}
    out = {}
    for key in NON_GUI_KEYS:
        out[key] = _get_nested(settings, key)
    return {"settings": out}


@app.post("/bionic/settings")
async def update_bionic_settings(payload: dict):
    updates = payload.get("settings", {})
    if not isinstance(updates, dict):
        raise HTTPException(status_code=400, detail="settings object required")
    settings = _load_json(P["settings_path"], {}) or {}
    applied = []
    for key, value in updates.items():
        if key in NON_GUI_KEYS:
            _set_nested(settings, key, value)
            applied.append(key)
    _save_json(P["settings_path"], settings)
    return {"status": "success", "applied": applied}


# --------------------------------------------------------------------------- #
# MCP servers (real ng-mcp.json `servers` array)
# --------------------------------------------------------------------------- #
def _normalize_server(s: dict) -> dict:
    conn = s.get("connection") or {}
    auth = conn.get("auth") or {}
    return {
        "id": s.get("id"),
        "name": s.get("name") or "Unnamed",
        "description": s.get("description") or "",
        "enabled": s.get("enabled", True),
        "type": conn.get("type"),
        "url": conn.get("url"),
        "command": conn.get("command"),
        "args": conn.get("args") or [],
        "env": conn.get("env") or {},
        "headers": conn.get("headers") or {},
        "hasAuth": bool(auth.get("token")),
    }


@app.get("/mcp/servers")
async def get_mcp_servers():
    data = _load_json(P["ng_mcp_path"], {}) or {}
    servers = [_normalize_server(s) for s in data.get("servers", [])]
    return {"servers": servers, "source": P["ng_mcp_path"]}


def _build_entry(name, stype, description, url, token, command, args, env, headers=None) -> dict:
    """Build one Bionic ng-mcp.json entry in the exact shape Bionic expects."""
    if stype in ("streamableHttp", "sse"):
        url = (url or "").strip()
        if not url:
            raise HTTPException(status_code=400, detail="url is required")
        connection = {"type": stype, "url": url, "headers": headers or {}}
        token = (token or "").strip()
        if token:
            connection["auth"] = {"type": "bearerToken", "token": token}
    elif stype == "stdio":
        command = (command or "").strip()
        if not command:
            raise HTTPException(status_code=400, detail="command is required")
        clean_env = {k: v for k, v in (env or {}).items() if v not in (None, "")}
        connection = {
            "type": "stdio",
            "command": command,
            "args": args or [],
            "env": clean_env,
        }
    else:
        raise HTTPException(status_code=400, detail=f"unsupported type: {stype}")

    return {
        "id": str(uuid.uuid4()),
        "name": (name or "").strip(),
        "description": (description or "").strip(),
        "enabled": True,
        "connection": connection,
    }


@app.post("/mcp/add")
async def add_mcp_server(payload: dict):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    stype = payload.get("type") or "streamableHttp"
    entry = _build_entry(
        name,
        stype,
        payload.get("description"),
        payload.get("url"),
        payload.get("token"),
        payload.get("command"),
        payload.get("args"),
        payload.get("env"),
        payload.get("headers"),
    )
    data = _load_json(P["ng_mcp_path"], {}) or {}
    servers = data.get("servers", []) or []
    servers.append(entry)
    data["servers"] = servers
    _save_json(P["ng_mcp_path"], data)
    return {"status": "success", "id": entry["id"]}


@app.post("/mcp/remove")
async def remove_mcp_server(payload: dict):
    sid = payload.get("id")
    if not sid:
        raise HTTPException(status_code=400, detail="id is required")
    data = _load_json(P["ng_mcp_path"], {}) or {}
    servers = data.get("servers", []) or []
    new_servers = [s for s in servers if s.get("id") != sid]
    if len(new_servers) == len(servers):
        raise HTTPException(status_code=404, detail="server not found")
    data["servers"] = new_servers
    _save_json(P["ng_mcp_path"], data)
    return {"status": "success"}


# --------------------------------------------------------------------------- #
# MCP catalog sources + bulk add
# --------------------------------------------------------------------------- #
# A hand-picked set of the most popular, trustworthy MCP servers. Served locally
# (no network needed) so there is always a useful, reliable default source.
CURATED_SERVERS = [
    {
        "name": "Fetch",
        "description": "Fetch and parse web pages into clean, LLM-friendly Markdown.",
        "type": "stdio",
        "url": "",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-fetch"],
        "env": {},
        "token": "",
        "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    },
    {
        "name": "Memory",
        "description": "Persistent knowledge-graph memory for structured recall.",
        "type": "stdio",
        "url": "",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-memory"],
        "env": {},
        "token": "",
        "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    },
    {
        "name": "Sequential Thinking",
        "description": "Step-by-step, revisable chain of thought for complex problems.",
        "type": "stdio",
        "url": "",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        "env": {},
        "token": "",
        "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    },
    {
        "name": "Time",
        "description": "Current time and timezone conversion utilities.",
        "type": "stdio",
        "url": "",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-time"],
        "env": {},
        "token": "",
        "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    },
    {
        "name": "Everything",
        "description": "Reference server exercising all MCP features — great for testing.",
        "type": "stdio",
        "url": "",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-everything"],
        "env": {},
        "token": "",
        "homepage": "https://github.com/modelcontextprotocol/servers/tree/main/src/everything",
    },
    {
        "name": "GitHub",
        "description": "Repositories, issues, pull requests, and code (add your GitHub auth if needed).",
        "type": "streamableHttp",
        "url": "https://api.githubcopilot.com/mcp/",
        "command": "",
        "args": [],
        "env": {},
        "token": "",
        "homepage": "https://github.com",
    },
    {
        "name": "Sentry",
        "description": "Errors, releases, and performance from your Sentry org.",
        "type": "streamableHttp",
        "url": "https://mcp.sentry.dev/mcp",
        "command": "",
        "args": [],
        "env": {},
        "token": "",
        "homepage": "https://sentry.io",
    },
    {
        "name": "Notion",
        "description": "Read and write Notion pages and databases.",
        "type": "streamableHttp",
        "url": "https://mcp.notion.com/mcp",
        "command": "",
        "args": [],
        "env": {},
        "token": "",
        "homepage": "https://notion.com",
    },
    {
        "name": "Slack",
        "description": "Search and post to Slack channels and DMs.",
        "type": "streamableHttp",
        "url": "https://mcp.slack.com",
        "command": "",
        "args": [],
        "env": {},
        "token": "",
        "homepage": "https://slack.com",
    },
    {
        "name": "DeepWiki",
        "description": "Ask questions about any public GitHub repository's code.",
        "type": "streamableHttp",
        "url": "https://mcp.deepwiki.com/mcp",
        "command": "",
        "args": [],
        "env": {},
        "token": "",
        "homepage": "https://deepwiki.com",
    },
]


SOURCES = [
    {
        "id": "curated",
        "name": "Curated Essentials",
        "builtin": True,
        "url": "Built-in catalog · works offline",
        "description": "A hand-picked set of the most popular, trustworthy MCP servers. Always available — no network needed.",
        "trusted": True,
        "servers": CURATED_SERVERS,
    },
    {
        "id": "official",
        "name": "Official MCP Registry",
        "url": "https://registry.modelcontextprotocol.io/v0/servers",
        "description": "Canonical registry published by the MCP project (modelcontextprotocol.io).",
        "trusted": True,
    },
]


def _map_type(raw) -> str:
    r = (raw or "").lower().replace("_", "-").replace(" ", "-")
    if r in ("streamable-http", "streamablehttp", "http", "streamable"):
        return "streamableHttp"
    if r == "sse":
        return "sse"
    if r in ("stdio", "local", "command", "process"):
        return "stdio"
    return None


def _extract_server_list(data):
    """Find the list of server items inside an arbitrary catalog payload."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        ms = data.get("mcpServers") or data.get("mcp_servers")
        if isinstance(ms, dict):
            return [{"name": k, **v} for k, v in ms.items() if isinstance(v, dict)]
        for key in ("servers", "data", "results", "items", "mcp", "list"):
            v = data.get(key)
            if isinstance(v, list) and v:
                return v
        for v in data.values():
            if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
                return v
    return []


def _package_args(pkg) -> list:
    """Extract CLI arguments from a registry package definition."""
    args = []
    raw = pkg.get("packageArguments")
    if isinstance(raw, list):
        for a in raw:
            if isinstance(a, dict) and "value" in a:
                args.append(str(a["value"]))
            elif isinstance(a, str):
                args.append(a)
    return args


def _env_options(pkg) -> list:
    """Structured env-var config options the user may need to fill in."""
    opts = []
    raw = pkg.get("environmentVariables")
    if isinstance(raw, list):
        for v in raw:
            if isinstance(v, dict) and v.get("name"):
                opts.append(
                    {
                        "name": str(v["name"]),
                        "description": v.get("description") or "",
                        "required": bool(v.get("isRequired")),
                        "secret": bool(v.get("isSecret")),
                    }
                )
    return opts


def _stdio_from_package(pkg):
    """Turn a registry `packages[]` entry into a runnable stdio command. None if unsupported."""
    reg = (pkg.get("registryType") or "").lower()
    ident = pkg.get("identifier")
    if not isinstance(ident, str) or not ident:
        return None
    pkgargs = _package_args(pkg)
    if reg == "npm":
        command, base = "npx", ["-y", ident]
    elif reg == "pypi":
        command, base = "uvx", [ident]
    elif reg == "oci":
        command, base = "docker", ["run", "-i", "--rm", ident]
    elif reg == "pipx":
        command, base = "pipx", ["run", ident]
    else:  # mcpb or anything else — best effort
        command, base = (reg or "stdio"), [ident]
    return {
        "type": "stdio",
        "command": command,
        "args": base + pkgargs,
        "env": {o["name"]: "" for o in _env_options(pkg)},
        "config": _env_options(pkg),
    }


def _pick_remote(remotes):
    """Pick the best remote endpoint (prefer streamable-http, then http, then sse)."""
    order = {"streamable-http": 0, "http": 1, "sse": 2}
    best = None
    best_rank = 99
    for r in remotes:
        if not isinstance(r, dict):
            continue
        u = r.get("url") or r.get("endpoint")
        if not u:
            continue
        rank = order.get((r.get("type") or "").lower(), 3)
        if rank < best_rank:
            best_rank = rank
            best = (u, r.get("type"))
    return best


def _normalize_source_item(item) -> dict:
    """Map a catalog item (many shapes) to the app's canonical server shape."""
    if not isinstance(item, dict):
        return None
    inner = item.get("server") if isinstance(item.get("server"), dict) else item

    # A stable slug (the registry "name") lets us collapse duplicate versions of one server.
    slug = inner.get("slug")
    if not isinstance(slug, str) or not slug:
        slug = inner.get("name") if isinstance(inner.get("name"), str) else ""

    name = inner.get("title") or inner.get("name") or slug or inner.get("id")
    if not isinstance(name, str) or not name:
        name = slug or "MCP server"

    description = inner.get("description") or ""

    # Version + latest flag. The registry nests this at the ITEM level under a
    # namespaced key, e.g. item._meta["io.modelcontextprotocol.registry/official"]["isLatest"].
    version = inner.get("version")
    if not isinstance(version, str):
        version = ""
    is_latest = False
    meta = item.get("_meta") if isinstance(item.get("_meta"), dict) else (inner.get("_meta") if isinstance(inner.get("_meta"), dict) else {})
    if isinstance(meta, dict):
        off = None
        for val in meta.values():
            if isinstance(val, dict) and "isLatest" in val:
                off = val
                break
        if off is None and isinstance(meta.get("official"), dict):
            off = meta.get("official")
        if isinstance(off, dict):
            is_latest = bool(off.get("isLatest"))

    # Repository + website, for richer links.
    repository = ""
    repo = inner.get("repository")
    if isinstance(repo, dict):
        repository = repo.get("url") or ""
    elif isinstance(repo, str):
        repository = repo
    website = inner.get("websiteUrl") or inner.get("homepage") or inner.get("website") or ""

    raw_token = inner.get("token")
    if not raw_token and isinstance(inner.get("auth"), dict):
        raw_token = inner["auth"].get("token")
    if not raw_token:
        raw_token = inner.get("apiKey")
    token = (raw_token or "").strip() if isinstance(raw_token, str) else ""

    common = {
        "name": name,
        "slug": slug or "",
        "description": description,
        "version": version,
        "is_latest": is_latest,
        "repository": repository,
        "homepage": website or repository or "",
        "token": token,
    }

    # 1) Remote (URL) servers — easiest to bulk-add (no local tooling needed).
    remotes = inner.get("remotes")
    endpoints = []
    if isinstance(remotes, list):
        for r in remotes:
            if isinstance(r, dict) and (r.get("url") or r.get("endpoint")):
                endpoints.append(
                    {
                        "type": (r.get("type") or "").lower() or "http",
                        "url": r.get("url") or r.get("endpoint"),
                    }
                )
    primary = _pick_remote(remotes) if isinstance(remotes, list) else None
    if primary:
        url, rtype = primary
        stype = _map_type(rtype) or ("sse" if "/sse" in url.lower() else "streamableHttp")
        return {
            **common,
            "type": stype,
            "url": url,
            "command": "",
            "args": [],
            "env": {},
            "config": [],
            "endpoints": endpoints,
        }

    # 2) stdio servers shipped as installable packages (npm / pypi / docker / mcpb).
    packages = inner.get("packages")
    if isinstance(packages, list) and packages:
        for p in packages:
            if not isinstance(p, dict):
                continue
            stdio = _stdio_from_package(p)
            if stdio:
                return {**common, **stdio, "url": "", "endpoints": []}

    # 3) Explicit stdio command (common in custom JSON dumps).
    command = inner.get("command") or inner.get("cmd")
    if command:
        return {
            **common,
            "type": "stdio",
            "url": "",
            "command": command,
            "args": list(inner.get("args") or inner.get("arguments") or []),
            "env": inner.get("env") or {},
            "config": [],
            "endpoints": [],
        }

    # 4) Bare URL (custom dumps that just list a url field).
    url = inner.get("url") or inner.get("endpoint") or inner.get("sseUrl")
    if url:
        stype = "sse" if (inner.get("sseUrl") or "/sse" in str(url).lower()) else "streamableHttp"
        return {
            **common,
            "type": stype,
            "url": url,
            "command": "",
            "args": [],
            "env": {},
            "config": [],
            "endpoints": [],
        }

    return None


def _fetch_url(url: str, timeout: int = 20) -> str:
    req = urllib.request.Request(
        url, headers={"User-Agent": "BionicDeck/0.1", "Accept": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


@app.get("/mcp/sources")
async def get_sources():
    return {"sources": SOURCES}


# The official registry caps a page at 100 items (larger values return HTTP 422).
REGISTRY_PAGE_LIMIT = 100


def _dedupe_by_name(servers: list) -> list:
    """Collapse duplicate slugs, keeping the best (latest) version of each server."""
    groups = {}
    order = []
    for s in servers:
        key = (s.get("slug") or s.get("name") or "").strip().lower()
        if not key:
            key = (s.get("url") or s.get("command") or "").strip().lower()
        if not key:
            key = f"__noidx_{id(s)}"
        if key not in groups:
            groups[key] = s
            order.append(key)
            continue
        cur = groups[key]
        # Prefer an explicitly-latest entry, then a higher version, then a remote form.
        if bool(s.get("is_latest")) and not bool(cur.get("is_latest")):
            groups[key] = s
        elif s.get("is_latest") == cur.get("is_latest") and (s.get("version") or "") > (cur.get("version") or ""):
            groups[key] = s
        elif (
            s.get("is_latest") == cur.get("is_latest")
            and s.get("type") == "streamableHttp"
            and cur.get("type") != "streamableHttp"
        ):
            groups[key] = s
    return [groups[k] for k in order]


def _filter_by_search(servers: list, term: str) -> list:
    q = (term or "").strip().lower()
    if not q:
        return servers
    out = []
    for s in servers:
        parts = [
            s.get("name"),
            s.get("slug"),
            s.get("description"),
            s.get("url"),
            s.get("homepage"),
            s.get("repository"),
            s.get("command"),
        ]
        if isinstance(s.get("args"), list):
            parts.extend(s["args"])
        if isinstance(s.get("config"), list):
            parts.extend(c.get("name") for c in s["config"] if isinstance(c, dict))
        hay = " ".join(str(p).lower() for p in parts if p is not None)
        if q in hay:
            out.append(s)
    return out


@app.get("/mcp/sources/fetch")
async def fetch_source(
    id: str = Query(default=None),
    url: str = Query(default=None),
    search: str = Query(default=None),
    cursor: str = Query(default=None),
):
    target = None
    source_name = "custom source"
    builtin_items = None
    is_registry = False
    if id:
        for s in SOURCES:
            if s["id"] == id:
                source_name = s["name"]
                target = s.get("url")
                is_registry = s.get("id") == "official"
                if s.get("builtin"):
                    builtin_items = s.get("servers", [])
                break
    elif url:
        target = url.strip()

    # Built-in sources are served locally — no network fetch required.
    if builtin_items is not None:
        servers = _filter_by_search(list(builtin_items), search)
        return {
            "source": source_name,
            "url": target or "",
            "count": len(servers),
            "servers": servers,
            "next_cursor": None,
        }
    if not target:
        raise HTTPException(status_code=400, detail="Provide id or url")

    # For the official registry, ask the server for a full page + optional search.
    fetch_url = target
    if is_registry:
        parts = [f"limit={REGISTRY_PAGE_LIMIT}"]
        if (search or "").strip():
            parts.append("search=" + urllib.parse.quote(search.strip()))
        if (cursor or "").strip():
            parts.append("cursor=" + urllib.parse.quote(cursor.strip()))
        sep = "&" if "?" in target else "?"
        fetch_url = target + sep + "&".join(parts)

    try:
        raw = _fetch_url(fetch_url)
        data = json.loads(raw)
    except urllib.error.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Source returned HTTP {e.code}")
    except urllib.error.URLError as e:
        raise HTTPException(status_code=502, detail=f"Could not reach source: {e.reason}")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Failed to read/parse source: {e}")

    items = _extract_server_list(data)
    servers = []
    for it in items:
        norm = _normalize_source_item(it)
        if norm:
            servers.append(norm)
    servers = _dedupe_by_name(servers)

    next_cursor = None
    if isinstance(data, dict):
        meta = data.get("metadata")
        if isinstance(meta, dict) and meta.get("nextCursor"):
            next_cursor = meta.get("nextCursor")

    return {
        "source": source_name,
        "url": target,
        "count": len(servers),
        "servers": servers,
        "next_cursor": next_cursor,
    }


def _entry_key(entry) -> str:
    c = entry.get("connection") or {}
    return (c.get("url") or "").strip().lower() or (c.get("command") or "").strip().lower()


@app.post("/mcp/bulk-add")
async def bulk_add(payload: dict):
    servers = payload.get("servers") or []
    if not isinstance(servers, list) or not servers:
        raise HTTPException(status_code=400, detail="servers list is required")

    data = _load_json(P["ng_mcp_path"], {}) or {}
    existing = data.get("servers", []) or []
    existing_keys = {_entry_key(s) for s in existing}
    existing_keys.discard("")

    added = []
    skipped = []
    errors = []
    for s in servers:
        if not isinstance(s, dict):
            continue
        name = (s.get("name") or "Unnamed").strip()
        stype = s.get("type") or "streamableHttp"
        try:
            entry = _build_entry(
                name,
                stype,
                s.get("description"),
                s.get("url"),
                s.get("token"),
                s.get("command"),
                s.get("args"),
                s.get("env"),
            )
        except HTTPException as e:
            errors.append({"name": name, "error": e.detail})
            continue
        key = _entry_key(entry)
        if key and key in existing_keys:
            skipped.append(name)
            continue
        existing.append(entry)
        if key:
            existing_keys.add(key)
        added.append(name)

    data["servers"] = existing
    _save_json(P["ng_mcp_path"], data)
    return {"added": added, "skipped": skipped, "errors": errors}


def _run_mcp_test(stype, url, token, command, args, env):
    """Real connectivity test. Returns {success, message}."""
    if stype in ("streamableHttp", "sse"):
        if not url:
            raise HTTPException(status_code=400, detail="url is required")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "bionic-deck", "version": "0.1.0"},
                },
            }
        ).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                return {"success": True, "message": f"Reachable (HTTP {resp.status})"}
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                return {"success": False, "message": f"Server is up but needs a token (HTTP {e.code})"}
            if e.code in (404, 405):
                return {"success": False, "message": f"Server is up but {e.code} — check the URL/path"}
            return {"success": True, "message": f"Server responded (HTTP {e.code})"}
        except Exception as e:  # noqa: BLE001
            return {"success": False, "message": f"Unreachable: {e}"}

    if stype == "stdio":
        if not command:
            raise HTTPException(status_code=400, detail="command is required")
        try:
            proc = subprocess.Popen(
                [command, *list(args)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={**os.environ, **(env or {})},
            )
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            proc.kill()
            return {"success": True, "message": f"Command started: {command}"}
        except FileNotFoundError:
            return {"success": False, "message": f"Command not found: {command}"}
        except Exception as e:  # noqa: BLE001
            return {"success": False, "message": f"Failed to start: {e}"}

    return {"success": False, "message": f"Unsupported type: {stype}"}


@app.post("/mcp/test")
async def test_mcp_server(payload: dict):
    # If a configured server id is provided, test using its REAL stored
    # connection (including the token that is hidden from the list view).
    sid = payload.get("id")
    if sid:
        data = _load_json(P["ng_mcp_path"], {}) or {}
        for s in data.get("servers", []):
            if s.get("id") == sid:
                conn = s.get("connection") or {}
                auth = conn.get("auth") or {}
                return _run_mcp_test(
                    conn.get("type") or "streamableHttp",
                    conn.get("url"),
                    auth.get("token"),
                    conn.get("command"),
                    conn.get("args") or [],
                    conn.get("env") or {},
                )
        raise HTTPException(status_code=404, detail="server not found")

    # Otherwise test the provided (draft) configuration.
    return _run_mcp_test(
        payload.get("type") or "streamableHttp",
        (payload.get("url") or "").strip() or None,
        (payload.get("token") or "").strip() or None,
        (payload.get("command") or "").strip() or None,
        payload.get("args") or [],
        payload.get("env") or {},
    )


# --------------------------------------------------------------------------- #
# Production mode: serve the built frontend (frontend/build) from this same
# server, so a single `python backend/app.py` runs the whole app on
# http://localhost:8000. All /mcp/* and /bionic/* routes above are registered
# first, so they take priority over the static mount.
# --------------------------------------------------------------------------- #
_FRONTEND_BUILD = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend", "build")
)
if os.path.isdir(_FRONTEND_BUILD):
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=_FRONTEND_BUILD, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
