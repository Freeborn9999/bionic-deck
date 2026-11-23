import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import './MCPManager.css';

const TYPE_LABELS = {
  streamableHttp: 'URL (Streamable HTTP)',
  sse: 'URL (SSE)',
  stdio: 'Command (stdio)',
};

// Visible, ready-to-use presets. Clicking one loads it into the add form.
const PRESETS = [
  {
    name: 'Local Jumper MCP',
    type: 'streamableHttp',
    url: 'http://127.0.0.1:6699/mcp',
    token: '',
    description: 'Local MCP server (Jumper)',
  },
  {
    name: 'GitHub Copilot MCP',
    type: 'streamableHttp',
    url: 'https://api.githubcopilot.com/mcp/',
    token: '',
    description: 'GitHub Copilot MCP endpoint',
  },
];

const emptyForm = {
  name: '',
  type: 'streamableHttp',
  description: '',
  url: '',
  token: '',
  command: '',
  args: '',
  env: '',
};

const MCPManager = () => {
  const [servers, setServers] = useState([]);
  const [source, setSource] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null); // {type, text}
  const [testResults, setTestResults] = useState({}); // id -> {state, text}
  const [formTest, setFormTest] = useState(null); // {state, text} for test-before-add

  const loadServers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/mcp/servers');
      setServers(data.servers || []);
      setSource(data.source || '');
      setMessage(null);
    } catch (err) {
      setMessage({
        type: 'error',
        text: `Could not load MCP servers from the backend. ${err.message}. (Is the API running on port 8000?)`,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const isUrl = form.type === 'streamableHttp' || form.type === 'sse';

  // Is the form's target already present in the configured list?
  const alreadyConfigured = (() => {
    const target = isUrl ? form.url.trim() : (form.command.trim());
    if (!target) return false;
    return servers.some((s) => {
      const sTarget = s.type === 'stdio' ? (s.command || '') : (s.url || '');
      return sTarget && sTarget.trim() === target.trim();
    });
  })();

  const buildPayload = () => ({
    name: form.name.trim(),
    type: form.type,
    description: form.description.trim(),
    url: form.url.trim(),
    token: form.token.trim(),
    command: form.command.trim(),
    args: form.args
      .split(' ')
      .map((x) => x.trim())
      .filter(Boolean),
    env: Object.fromEntries(
      form.env
        .split(',')
        .map((x) => x.split('=').map((p) => p.trim()))
        .filter((pair) => pair.length === 2 && pair[0])
        .map(([k, v]) => [k, v])
    ),
  });

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setMessage({ type: 'error', text: 'Please enter a name.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await api('/mcp/add', { method: 'POST', body: JSON.stringify(buildPayload()) });
      setForm(emptyForm);
      await loadServers();
      setMessage({ type: 'success', text: 'Added. Restart Bionic to load it.' });
    } catch (err) {
      setMessage({ type: 'error', text: `Add failed: ${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (server) => {
    const id = server.id || server.name;
    setTestResults((t) => ({ ...t, [id]: { state: 'testing', text: '' } }));
    try {
      // Prefer testing by id so the backend uses the server's REAL stored
      // connection (including its token, which is hidden from the list view).
      const payload = server.id
        ? { id: server.id }
        : { type: server.type, url: server.url, command: server.command, args: server.args || [] };
      const res = await api('/mcp/test', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setTestResults((t) => ({
        ...t,
        [id]: { state: res.success ? 'ok' : 'fail', text: res.message || (res.success ? 'OK' : 'Failed') },
      }));
    } catch (err) {
      setTestResults((t) => ({ ...t, [id]: { state: 'fail', text: err.message } }));
    }
  };

  const handleTestForm = async (e) => {
    if (e) e.preventDefault();
    const draft = buildPayload();
    setFormTest({ state: 'testing', text: '' });
    try {
      const res = await api('/mcp/test', {
        method: 'POST',
        body: JSON.stringify(draft),
      });
      setFormTest({ state: res.success ? 'ok' : 'fail', text: res.message || (res.success ? 'OK' : 'Failed') });
    } catch (err) {
      setFormTest({ state: 'fail', text: err.message });
    }
  };

  const handleRemove = async (server) => {
    if (!window.confirm(`Remove "${server.name}"?`)) return;
    try {
      await api('/mcp/remove', { method: 'POST', body: JSON.stringify({ id: server.id }) });
      await loadServers();
    } catch (err) {
      setMessage({ type: 'error', text: `Remove failed: ${err.message}` });
    }
  };

  const loadPreset = (preset) => {
    setForm({
      name: preset.name,
      type: preset.type,
      description: preset.description || '',
      url: preset.url || '',
      token: preset.token || '',
      command: '',
      args: '',
      env: '',
    });
  };

  return (
    <div className="mcp-manager">
      <h2>MCP Manager</h2>
      <p className="page-sub">
        Add, test and remove MCP servers. They are written to Bionic&apos;s real MCP config so they
        appear in Bionic after a restart.
      </p>

      {message && <div className={`message ${message.type}`}>{message.text}</div>}

      <div className="card">
        <div className="row space">
          <h3>Configured servers</h3>
          <button className="btn" onClick={loadServers} disabled={loading}>
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>

        {loading ? (
          <p className="muted">Loading…</p>
        ) : servers.length === 0 ? (
          <p className="muted">
            No MCP servers configured yet. Add one below — it will be saved to Bionic.
          </p>
        ) : (
          <div style={{ marginTop: 12 }}>
            {servers.map((server) => {
              const id = server.id || server.name;
              const tr = testResults[id];
              const target = server.type === 'stdio' ? `${server.command} ${server.args || ''}`.trim() : server.url;
              return (
                <div className="card" key={id} style={{ marginBottom: 12 }}>
                  <div className="server-top">
                    <div className="server-name">{server.name}</div>
                    <div className="inline">
                      <span className="badge info">{TYPE_LABELS[server.type] || server.type || 'unknown'}</span>
                      {server.hasAuth && <span className="badge">Token auth</span>}
                      <span className={server.enabled === false ? 'badge fail' : 'badge ok'}>
                        {server.enabled === false ? 'Disabled' : 'Enabled'}
                      </span>
                    </div>
                  </div>

                  {target && <div className="server-target">{target}</div>}
                  {server.description && <p className="muted">{server.description}</p>}

                  <div className="row" style={{ marginTop: 12 }}>
                    <button
                      className="btn"
                      onClick={() => handleTest(server)}
                      disabled={tr && tr.state === 'testing'}
                    >
                      {tr && tr.state === 'testing' ? <span className="spin" /> : 'Test'}
                    </button>
                    <button className="btn btn-danger" onClick={() => handleRemove(server)}>
                      Remove
                    </button>
                  </div>

                  {tr && tr.state !== 'testing' && (
                    <div className={`test-result`} >
                      <span className={`badge ${tr.state === 'ok' ? 'ok' : 'fail'}`}>
                        {tr.state === 'ok' ? '✓ ' : '✕ '}
                        {tr.text}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {source && <p className="muted" style={{ marginTop: 8 }}>Source: {source}</p>}
      </div>

      <form className="card" onSubmit={handleAdd}>
        <h3>Add MCP server</h3>
        <p className="card-desc">
          Fields are shown only for the type you choose. URL servers need a URL (and optional token);
          command servers need a command (and optional args/env).
        </p>

        <div className="add-form-grid">
          <div className="field">
            <label>Name</label>
            <input value={form.name} onChange={set('name')} placeholder="e.g. GitHub" />
          </div>

          <div className="field">
            <label>Type</label>
            <select value={form.type} onChange={set('type')}>
              <option value="streamableHttp">URL (Streamable HTTP)</option>
              <option value="sse">URL (SSE)</option>
              <option value="stdio">Command (stdio)</option>
            </select>
          </div>

          <div className="field">
            <label>Description (optional)</label>
            <input value={form.description} onChange={set('description')} placeholder="What it does" />
          </div>
        </div>

        {isUrl ? (
          <div className="add-form-grid">
            <div className="field">
              <label>URL</label>
              <input
                value={form.url}
                onChange={set('url')}
                placeholder={form.type === 'sse' ? 'http://host/sse' : 'http://host/mcp'}
              />
            </div>
            <div className="field">
              <label>Token (optional)</label>
              <input value={form.token} onChange={set('token')} placeholder="Bearer token" />
            </div>
          </div>
        ) : (
          <div>
            <div className="add-form-grid">
              <div className="field">
                <label>Command</label>
                <input value={form.command} onChange={set('command')} placeholder="npx or python server" />
              </div>
              <div className="field">
                <label>Args (space-separated, optional)</label>
                <input value={form.args} onChange={set('args')} placeholder="--port 8080" />
              </div>
            </div>
            <div className="field">
              <label>Env (KEY=VALUE, comma-separated, optional)</label>
              <input value={form.env} onChange={set('env')} placeholder="API_KEY=abc" />
            </div>
          </div>
        )}

        <div className="row" style={{ marginTop: 14, justifyContent: 'space-between' }}>
          <span className={alreadyConfigured ? 'badge info' : 'muted'}>
            {alreadyConfigured ? '✓ Already configured — adding will create another copy' : ' '}
          </span>
          <div className="inline">
            <button
              className="btn"
              type="button"
              onClick={handleTestForm}
              disabled={formTest && formTest.state === 'testing'}
            >
              {formTest && formTest.state === 'testing' ? <span className="spin" /> : 'Test config'}
            </button>
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? <span className="spin" /> : 'Add server'}
            </button>
          </div>
        </div>

        {formTest && formTest.state !== 'testing' && (
          <div className="test-result" style={{ marginTop: 10 }}>
            <span className={`badge ${formTest.state === 'ok' ? 'ok' : 'fail'}`}>
              {formTest.state === 'ok' ? '✓ ' : '✕ '} {formTest.text}
            </span>
          </div>
        )}

        <div className="quick-add">
          {PRESETS.map((preset) => (
            <div className="qa-item" key={preset.name} onClick={() => loadPreset(preset)}>
              <strong>{preset.name}</strong>
              <span>{preset.url}</span>
            </div>
          ))}
        </div>
      </form>
    </div>
  );
};

export default MCPManager;
