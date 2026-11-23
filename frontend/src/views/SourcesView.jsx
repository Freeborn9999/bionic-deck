import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import './SourcesView.css';

const TYPE_LABELS = {
  streamableHttp: 'Streamable HTTP',
  sse: 'SSE',
  stdio: 'stdio',
};

const CUSTOM_KEY = 'bionicdeck.customSources';

function loadCustom() {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x.url === 'string' && x.url) : [];
  } catch {
    return [];
  }
}

function saveCustom(list) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch {
    /* ignore quota/privacy errors — custom sources are a convenience */
  }
}

function targetOf(s) {
  return (s.type === 'stdio' ? s.command : s.url) || '';
}

const SourcesView = () => {
  const [sources, setSources] = useState([]); // built-in trusted sources
  const [custom, setCustom] = useState(loadCustom);
  const [customUrl, setCustomUrl] = useState('');

  const [active, setActive] = useState(null); // {id?, url, name}
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [servers, setServers] = useState([]);

  const [configured, setConfigured] = useState([]);
  const [selected, setSelected] = useState({}); // row index -> bool
  const [testResults, setTestResults] = useState({}); // row index -> {state, text}
  const [bulk, setBulk] = useState(null); // {added, skipped, errors}
  const [adding, setAdding] = useState(false);
  const [restartMsg, setRestartMsg] = useState('');

  const configuredTargets = useCallback(() => {
    const set = new Set();
    (configured || []).forEach((s) => {
      const t = (s.type === 'stdio' ? s.command : s.url) || '';
      if (t) set.add(t.trim().toLowerCase());
    });
    return set;
  }, [configured]);

  const loadConfigured = useCallback(async () => {
    try {
      const data = await api('/mcp/servers');
      setConfigured(data.servers || []);
    } catch {
      /* configured badges are optional — ignore */
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const data = await api('/mcp/sources');
        setSources(data.sources || []);
      } catch {
        setSources([]);
      }
      loadConfigured();
    })();
  }, [loadConfigured]);

  const isConfigured = (s) => {
    const t = targetOf(s);
    if (!t) return false;
    return configuredTargets().has(t.trim().toLowerCase());
  };

  const fetchSource = async (src) => {
    setActive(src);
    setFetchError('');
    setFetching(true);
    setServers([]);
    setSelected({});
    setBulk(null);
    setTestResults({});
    setRestartMsg('');
    try {
      const q = src.id ? `id=${encodeURIComponent(src.id)}` : `url=${encodeURIComponent(src.url)}`;
      const data = await api(`/mcp/sources/fetch?${q}`);
      setServers(data.servers || []);
      if ((data.servers || []).length === 0) {
        setFetchError('That source returned no usable MCP servers. It may not be a valid MCP catalog URL.');
      }
    } catch (err) {
      setFetchError(err.message || 'Failed to fetch that source.');
    } finally {
      setFetching(false);
    }
  };

  const addCustom = (e) => {
    e.preventDefault();
    const url = customUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      setFetchError('Enter a full URL starting with http:// or https://');
      return;
    }
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      /* keep raw */
    }
    const entry = { url, name: `Custom · ${host}` };
    const next = [...custom.filter((c) => c.url !== url), entry];
    setCustom(next);
    saveCustom(next);
    setCustomUrl('');
    fetchSource(entry);
  };

  const removeCustom = (url) => {
    const next = custom.filter((c) => c.url !== url);
    setCustom(next);
    saveCustom(next);
    if (active && active.url === url) {
      setActive(null);
      setServers([]);
    }
  };

  const selectableIdx = servers.map((s, i) => (targetOf(s) ? i : -1)).filter((i) => i >= 0);
  const selectedIdx = selectableIdx.filter((i) => selected[i]);
  const allSelected = selectableIdx.length > 0 && selectableIdx.every((i) => selected[i]);

  const toggleRow = (i) => setSelected((s) => ({ ...s, [i]: !s[i] }));
  const toggleAll = () => {
    if (allSelected) {
      setSelected({});
    } else {
      const next = {};
      selectableIdx.forEach((i) => {
        next[i] = true;
      });
      setSelected(next);
    }
  };

  const testRow = async (s, i) => {
    setTestResults((t) => ({ ...t, [i]: { state: 'testing', text: '' } }));
    try {
      const res = await api('/mcp/test', {
        method: 'POST',
        body: JSON.stringify({
          type: s.type,
          url: s.url,
          token: s.token || '',
          command: s.command,
          args: s.args || [],
        }),
      });
      setTestResults((t) => ({
        ...t,
        [i]: { state: res.success ? 'ok' : 'fail', text: res.message || (res.success ? 'OK' : 'Failed') },
      }));
    } catch (err) {
      setTestResults((t) => ({ ...t, [i]: { state: 'fail', text: err.message } }));
    }
  };

  const doBulkAdd = async () => {
    const chosen = servers.filter((s, i) => selected[i] && targetOf(s));
    if (chosen.length === 0) return;
    setAdding(true);
    setBulk(null);
    setRestartMsg('');
    try {
      const res = await api('/mcp/bulk-add', { method: 'POST', body: JSON.stringify({ servers: chosen }) });
      setBulk(res);
      setSelected({});
      await loadConfigured();
    } catch (err) {
      setBulk({ added: [], skipped: [], errors: [{ name: 'bulk add', error: err.message }] });
    } finally {
      setAdding(false);
    }
  };

  const doRestart = async () => {
    setRestartMsg('');
    try {
      const res = await api('/bionic/restart', { method: 'POST' });
      setRestartMsg(
        res && res.relaunched
          ? 'Bionic restarted — the new servers should now be available in Bionic.'
          : `Restart attempted: ${(res && res.details ? res.details.join(', ') : 'no details')}`
      );
    } catch (err) {
      setRestartMsg(err.message || 'Failed to restart Bionic.');
    }
  };

  return (
    <div className="sources-view">
      <h2>MCP Sources</h2>
      <p className="page-sub">
        Pull a catalog of MCP servers from a trusted registry or any custom JSON dump URL, review
        them, then bulk-add the ones you want to Bionic.
      </p>

      <div className="card">
        <div className="row space">
          <h3>Catalog sources</h3>
          <span className="muted">Trusted registries + your own dump URLs</span>
        </div>

        <div className="source-list">
          {sources.map((s) => (
            <button
              key={s.id}
              className={`src-item ${active && active.id === s.id ? 'active' : ''}`}
              onClick={() => fetchSource(s)}
              disabled={fetching}
            >
              <span className="src-name">
                {s.name}
                {s.trusted ? <span className="badge info" style={{ marginLeft: 8 }}>trusted</span> : null}
              {s.builtin ? <span className="badge info" style={{ marginLeft: 8 }}>built-in</span> : null}
              </span>
              <span className="src-url">{s.url}</span>
            </button>
          ))}

          {custom.map((c) => (
            <div
              key={c.url}
              className={`src-item ${active && active.url === c.url ? 'active' : ''}`}
            >
              <button className="src-item-btn" onClick={() => fetchSource(c)} disabled={fetching}>
                <span className="src-name">{c.name}</span>
                <span className="src-url">{c.url}</span>
              </button>
              <button className="btn btn-danger src-remove" onClick={() => removeCustom(c.url)} title="Remove source">
                ✕
              </button>
            </div>
          ))}

          {sources.length === 0 && custom.length === 0 && (
            <p className="muted">No sources yet. Add a custom catalog URL below.</p>
          )}
        </div>

        <form className="row" onSubmit={addCustom} style={{ marginTop: 12 }}>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <input
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder="Paste a custom MCP catalog URL (https://…/servers.json)"
            />
          </div>
          <button className="btn" type="submit" disabled={fetching}>
            {fetching ? <span className="spin" /> : 'Add & fetch'}
          </button>
        </form>
      </div>

      {fetchError && <div className="message error">{fetchError}</div>}

      {active && (
        <div className="card">
          <div className="row space">
            <div>
              <h3>{active.name}</h3>
              <p className="card-desc">
                {fetching ? 'Loading…' : `${servers.length} server(s) found.`}
              </p>
            </div>
            <div className="inline">
              {selectableIdx.length > 0 && (
                <label className="inline" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} />{' '}
                  <span className="muted">Select all</span>
                </label>
              )}
              <button
                className="btn btn-primary"
                onClick={doBulkAdd}
                disabled={adding || selectedIdx.length === 0}
              >
                {adding ? (
                  <span className="spin" />
                ) : selectedIdx.length > 0 ? (
                  `Add ${selectedIdx.length} selected`
                ) : (
                  'Add selected'
                )}
              </button>
            </div>
          </div>

          {fetching && <p className="muted" style={{ marginTop: 12 }}>Fetching and normalizing…</p>}

          {!fetching && servers.length > 0 && (
            <div className="src-rows">
              {servers.map((s, i) => {
                const t = testResults[i];
                const target = targetOf(s);
                const configured = isConfigured(s);
                const disabled = !target;
                return (
                  <div className={`src-row ${disabled ? 'disabled' : ''}`} key={i}>
                    <input
                      type="checkbox"
                      checked={!!selected[i]}
                      disabled={disabled}
                      onChange={() => toggleRow(i)}
                    />
                    <div className="src-row-main">
                      <div className="src-row-title">
                        <span className="src-name">{s.name}</span>
                        <span className="badge info">{TYPE_LABELS[s.type] || s.type || 'unknown'}</span>
                        {configured && <span className="badge ok">✓ already in Bionic</span>}
                        {!target && <span className="badge">no target</span>}
                        {s.homepage && (
                          <a
                            className="src-home"
                            href={s.homepage}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            link ↗
                          </a>
                        )}
                      </div>
                      {target && <div className="src-target">{target}</div>}
                      {s.description && <p className="muted">{s.description}</p>}
                      {t && t.state !== 'testing' && (
                        <div className="test-result">
                          <span className={`badge ${t.state === 'ok' ? 'ok' : 'fail'}`}>
                            {t.state === 'ok' ? '✓ ' : '✕ '} {t.text}
                          </span>
                        </div>
                      )}
                    </div>
                    <button
                      className="btn"
                      onClick={() => testRow(s, i)}
                      disabled={disabled || (t && t.state === 'testing')}
                    >
                      {t && t.state === 'testing' ? <span className="spin" /> : 'Test'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {bulk && (
        <div className="card">
          <h3>Result</h3>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="badge ok">{(bulk.added || []).length} added</span>
            <span className="badge info">{(bulk.skipped || []).length} already present</span>
            {(bulk.errors || []).length > 0 && (
              <span className="badge fail">{bulk.errors.length} failed</span>
            )}
          </div>
          {(bulk.added || []).length > 0 && (
            <p className="muted">
              Added: {(bulk.added || []).join(', ')}
            </p>
          )}
          {(bulk.skipped || []).length > 0 && (
            <p className="muted">
              Skipped (already in Bionic): {(bulk.skipped || []).join(', ')}
            </p>
          )}
          {(bulk.errors || []).length > 0 && (
            <ul>
              {bulk.errors.map((e, i) => (
                <li key={i}>
                  {e.name}: {e.error}
                </li>
              ))}
            </ul>
          )}

          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn btn-success" onClick={doRestart}>
              ↻ Restart Bionic to load them
            </button>
            {(bulk.added || []).length > 0 ? (
              <span className="muted">Servers are saved to Bionic — restart to activate.</span>
            ) : (
              <span className="muted">Nothing new was added.</span>
            )}
          </div>
          {restartMsg && <div className="message info" style={{ marginTop: 12 }}>{restartMsg}</div>}
        </div>
      )}
    </div>
  );
};

export default SourcesView;
