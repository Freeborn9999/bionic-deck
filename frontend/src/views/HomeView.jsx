import React, { useState, useEffect, useCallback } from 'react';
import { api, API } from '../api';
import './HomeView.css';

const HomeView = ({ onNavigate }) => {
  const [backend, setBackend] = useState(null);
  const [servers, setServers] = useState([]);
  const [install, setInstall] = useState({ path: '' });
  const [restarting, setRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [health, serversData, inst] = await Promise.all([
        api('/health'),
        api('/mcp/servers'),
        api('/bionic/install-location'),
      ]);
      setBackend(health);
      setServers(serversData.servers || []);
      setInstall(inst);
    } catch (err) {
      setBackend(null);
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRestart = async () => {
    if (!window.confirm('Restart Bionic now? It will briefly close and reopen so new settings and MCP servers load.')) {
      return;
    }
    setRestarting(true);
    setRestartResult(null);
    try {
      const res = await api('/bionic/restart', { method: 'POST' });
      setRestartResult(res);
    } catch (err) {
      setRestartResult({ relaunched: false, killed: false, details: [err.message] });
    } finally {
      setRestarting(false);
    }
  };

  const enabledCount = servers.filter((s) => s.enabled !== false).length;

  return (
    <div className="home-view">
      <div className="hero">
        <div>
          <h2>Bionic Deck</h2>
          <p>Manage MCP servers, advanced settings, and Bionic itself — all from one local panel.</p>
        </div>
        <button className="btn-hero" onClick={handleRestart} disabled={restarting}>
          {restarting ? 'Restarting…' : '↻ Restart Bionic'}
        </button>
      </div>

      {error && (
        <div className="message error">
          Backend not reachable at {API}. Start it with{' '}
          <code>python backend/app.py</code>, then click Refresh.
        </div>
      )}

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

      <div className="status-grid">
        <div className="status-card">
          <div className="label">MCP servers</div>
          <div className="value">
            {servers.length} total · {enabledCount} enabled
          </div>
        </div>
        <div className="status-card">
          <div className="label">Bionic install</div>
          <div className="value">{install.path || '—'}</div>
        </div>
        <div className="status-card">
          <div className="label">Backend API</div>
          <div className="value">{backend ? 'Connected' : 'Offline'}</div>
        </div>
        <div className="status-card">
          <div className="label">Bionic dir</div>
          <div className="value">{backend && backend.paths ? backend.paths.bionic_dir : '—'}</div>
        </div>
      </div>

      <div className="features">
        <button className="feature-card" onClick={() => onNavigate && onNavigate('mcp')}>
          <h3>MCP Manager</h3>
          <p>Add, test and remove MCP servers. Persisted to Bionic.</p>
        </button>
        <button className="feature-card" onClick={() => onNavigate && onNavigate('sources')}>
          <h3>MCP Sources</h3>
          <p>Bulk-add servers from a trusted registry or any custom catalog URL.</p>
        </button>
        <button className="feature-card" onClick={() => onNavigate && onNavigate('settings')}>
          <h3>Advanced Settings</h3>
          <p>Bionic-specific options not in the settings UI.</p>
        </button>
        <button className="feature-card" onClick={() => onNavigate && onNavigate('config')}>
          <h3>Config Manager</h3>
          <p>Install path, local API, and restart controls.</p>
        </button>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" onClick={load}>
          Refresh status
        </button>
      </div>
    </div>
  );
};

export default HomeView;
