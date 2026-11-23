import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import './ConfigManager.css';

const ConfigManager = () => {
  const [paths, setPaths] = useState(null);
  const [install, setInstall] = useState({ path: '', argv: [], cwd: '' });
  const [localApi, setLocalApi] = useState({});
  const [editPath, setEditPath] = useState('');
  const [showBrowse, setShowBrowse] = useState(false);
  const [browseState, setBrowseState] = useState(null); // {current, parent, dirs}
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [message, setMessage] = useState(null);
  const [restartResult, setRestartResult] = useState(null);

  const load = useCallback(async () => {
    try {
      const [p, inst] = await Promise.all([api('/bionic/paths'), api('/bionic/install-location')]);
      setPaths(p);
      setLocalApi(p.local_api || {});
      const path = inst.path || (p && p.ng_mcp_path ? '' : '');
      setInstall(inst || { path: '', argv: [], cwd: '' });
      setEditPath(inst.path || '');
    } catch (err) {
      setMessage({ type: 'error', text: `Could not load paths. ${err.message}` });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openBrowse = async (startDir) => {
    setShowBrowse(true);
    setBrowseState(null);
    try {
      const res = await api(`/bionic/browse?path=${encodeURIComponent(startDir || '')}`);
      setBrowseState(res);
    } catch (err) {
      setBrowseState({ current: startDir || '', parent: null, dirs: [], error: err.message });
    }
  };

  const pickPath = (dirPath) => {
    setEditPath(dirPath);
    // If it's a folder, keep browsing into it.
    if (dirPath) openBrowse(dirPath);
  };

  const handleSavePath = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const res = await api('/bionic/install-location', {
        method: 'POST',
        body: JSON.stringify({ path: editPath.trim() }),
      });
      setInstall((i) => ({ ...i, path: res.path }));
      setMessage({ type: 'success', text: `Install path saved: ${res.path}` });
    } catch (err) {
      setMessage({ type: 'error', text: `Save failed: ${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  const handleRestart = async () => {
    if (!window.confirm('Restart Bionic now? Open sessions are kept on disk but the app will briefly close.')) {
      return;
    }
    setRestarting(true);
    setRestartResult(null);
    setMessage(null);
    try {
      const res = await api('/bionic/restart', { method: 'POST' });
      setRestartResult(res);
      setMessage({
        type: res.relaunched ? 'success' : 'info',
        text: res.relaunched ? 'Bionic was restarted.' : 'Restart attempted — see details below.',
      });
    } catch (err) {
      setMessage({ type: 'error', text: `Restart failed: ${err.message}` });
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="config-manager">
      <h2>Config Manager</h2>
      <p className="page-sub">
        Where Bionic is installed, its local API, and the app lifecycle. The path is auto-populated
        from Bionic&apos;s install record — browse to change it if needed.
      </p>

      {message && <div className={`message ${message.type}`}>{message.text}</div>}

      <div className="card">
        <h3>Bionic install path</h3>
        <p className="card-desc">
          Used by the Restart action to find and relaunch the Bionic executable.
        </p>

        <form onSubmit={handleSavePath}>
          <div className="field">
            <label>Executable path</label>
            <div className="row">
              <input
                type="text"
                value={editPath}
                onChange={(e) => setEditPath(e.target.value)}
                placeholder="C:\Program Files\Bionic\Bionic.exe"
                style={{ flex: 1 }}
              />
              <button type="button" className="btn" onClick={() => openBrowse(editPath || (paths && paths.bionic_dir))}>
                Browse…
              </button>
            </div>
          </div>

          {showBrowse && (
            <div className="browse-ui">
              <div className="bc">{(browseState && browseState.current) || '…'}</div>
              <div className="bl">
                <div onClick={() => (browseState && browseState.parent ? openBrowse(browseState.parent) : openBrowse((browseState && browseState.current) || ''))}>
                  ⬆ Parent folder
                </div>
                {(browseState && browseState.dirs || []).map((d) => (
                  <div key={d.path} onClick={() => pickPath(d.path)}>
                    📁 {d.name}
                  </div>
                ))}
                {(browseState && browseState.error) && (
                  <div>⚠ {browseState.error}</div>
                )}
                {browseState && browseState.current && (
                  <div
                    style={{ color: '#007bff' }}
                    onClick={() => {
                      setEditPath(browseState.current);
                      setShowBrowse(false);
                    }}
                  >
                    ✓ Use this folder
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" type="submit" disabled={saving || !editPath.trim()}>
              {saving ? <span className="spin" /> : 'Save path'}
            </button>
          </div>
        </form>

        {install.cwd && <p className="muted" style={{ marginTop: 10 }}>Current working dir: {install.cwd}</p>}
      </div>

      <div className="card">
        <div className="row space">
          <div>
            <h3>Bionic local API</h3>
            <p className="card-desc">Read from Bionic&apos;s local API record.</p>
          </div>
          <button className="btn" onClick={handleRestart} disabled={restarting}>
            {restarting ? <span className="spin" /> : 'Restart Bionic'}
          </button>
        </div>

        <div className="status-grid">
          <div className="status-card">
            <div className="label">Host</div>
            <div className="value">{(localApi && localApi.host) || '—'}</div>
          </div>
          <div className="status-card">
            <div className="label">Port</div>
            <div className="value">{(localApi && localApi.port) || '—'}</div>
          </div>
          <div className="status-card">
            <div className="label">PID</div>
            <div className="value">{(localApi && localApi.pid) || '—'}</div>
          </div>
        </div>

        {restartResult && (
          <div className={`message ${restartResult.relaunched ? 'success' : 'info'}`}>
            <div>
              Killed: {restartResult.killed ? 'yes' : 'no'} · Relaunched:{' '}
              {restartResult.relaunched ? 'yes' : 'no'}
            </div>
            {(restartResult.details || []).length > 0 && (
              <ul>
                {restartResult.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {paths && (
        <div className="card">
          <h3>Resolved config locations</h3>
          <p className="card-desc">Where this tool reads and writes Bionic data.</p>
          <div className="status-grid">
            <div className="status-card">
              <div className="label">MCP config</div>
              <div className="value">{paths.ng_mcp_path}</div>
            </div>
            <div className="status-card">
              <div className="label">Settings</div>
              <div className="value">{paths.settings_path}</div>
            </div>
            <div className="status-card">
              <div className="label">Bionic dir</div>
              <div className="value">{paths.bionic_dir}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ConfigManager;
