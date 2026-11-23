import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import './SourcesView.css';

const TYPE_LABELS = {
  streamableHttp: 'Streamable HTTP',
  sse: 'SSE',
  stdio: 'stdio',
};

const CUSTOM_KEY = 'bionicdeck.customSources';

// Safety cap for "Load all": the official registry runs to ~1900+ servers across
// ~60+ pages. Paging is sequential and live; 80 pages is more than enough in practice.
const LOAD_ALL_MAX_PAGES = 80;

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
  if (!s) return '';
  if (s.type === 'stdio') {
    const args = Array.isArray(s.args) ? s.args : [];
    return [s.command, ...args].filter(Boolean).join(' ');
  }
  return s.url || '';
}

function stdioSignature(s) {
  if (!s || !s.command) return '';
  const args = Array.isArray(s.args) ? s.args : [];
  return [s.command, ...args].filter(Boolean).join(' ').trim().toLowerCase();
}

function nameKey(s) {
  return ((s && (s.slug || s.name)) || '').trim().toLowerCase();
}

const SourcesView = () => {
  const [sources, setSources] = useState([]); // built-in trusted sources
  const [custom, setCustom] = useState(loadCustom);
  const [customUrl, setCustomUrl] = useState('');

  const [active, setActive] = useState(null); // {id?, url, name, builtin?}
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [servers, setServers] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [loadAllMsg, setLoadAllMsg] = useState('');
  const [searchText, setSearchText] = useState('');
  const [activeSearch, setActiveSearch] = useState(''); // term actually applied to the server

  const [configured, setConfigured] = useState([]);
  const [selected, setSelected] = useState({}); // row index -> bool
  const [testResults, setTestResults] = useState({}); // row index -> {state, text}
  const [bulk, setBulk] = useState(null);
  const [adding, setAdding] = useState(false);
  const [restartMsg, setRestartMsg] = useState('');

  const reqRef = useRef(0); // guard against out-of-order responses
  const searchTimer = useRef(null); // debounce handle for the search box

  const configuredTargets = useCallback(() => {
    const set = new Set();
    (configured || []).forEach((s) => {
      if (s.url) set.add(s.url.trim().toLowerCase());
      if (s.command) {
        set.add(s.command.trim().toLowerCase());
        const full = stdioSignature(s);
        if (full) set.add(full);
      }
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
    if (!s) return false;
    const set = configuredTargets();
    const cands = [];
    if (s.url) cands.push(s.url.trim().toLowerCase());
    if (s.command) {
      cands.push(s.command.trim().toLowerCase());
      const full = stdioSignature(s);
      if (full) cands.push(full);
    }
    return cands.some((c) => set.has(c));
  };

  // Search box + "Load more" only make sense for sources that support them.
  const supportsSearch = !!(active && (active.builtin || active.id === 'official'));
  const canLoadMore = !!(active && active.id === 'official' && nextCursor);

  const fetchPage = async (src, search = '', cursor = null) => {
    const params = new URLSearchParams();
    if (src.id) params.set('id', src.id);
    else params.set('url', src.url);
    if (search) params.set('search', search);
    if (cursor) params.set('cursor', cursor);
    return api(`/mcp/sources/fetch?${params.toString()}`);
  };

  const resetResults = () => {
    setServers([]);
    setSelected({});
    setBulk(null);
    setTestResults({});
    setRestartMsg('');
    setNextCursor(null);
    setLoadAllMsg('');
    setFetchError('');
  };

  const loadSource = async (src, search = '') => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const reqId = ++reqRef.current;
    setActive(src);
    setSearchText(search);
    setActiveSearch(search);
    resetResults();
    setFetching(true);
    try {
      const data = await fetchPage(src, search, null);
      if (reqId !== reqRef.current) return; // superseded by a newer request
      setServers(data.servers || []);
      setNextCursor(data.next_cursor || null);
      if ((data.servers || []).length === 0) {
        setFetchError(
          search
            ? `No servers matched “${search}”.`
            : 'That source returned no usable MCP servers. It may not be a valid MCP catalog URL.'
        );
      }
    } catch (err) {
      if (reqId !== reqRef.current) return;
      setFetchError(err.message || 'Failed to fetch that source.');
    } finally {
      if (reqId === reqRef.current) setFetching(false);
    }
  };

  const loadMore = async () => {
    if (!active || !nextCursor || loadingMore) return;
    const reqId = ++reqRef.current;
    setLoadingMore(true);
    try {
      const data = await fetchPage(active, activeSearch.trim(), nextCursor);
      if (reqId !== reqRef.current) return;
      const existing = new Set(servers.map(nameKey).filter(Boolean));
      const fresh = (data.servers || []).filter((s) => {
        const k = nameKey(s);
        return !k || !existing.has(k);
      });
      setServers((prev) => [...prev, ...fresh]);
      setNextCursor(data.next_cursor || null);
    } catch (err) {
      if (reqId === reqRef.current) setFetchError(err.message || 'Failed to load more.');
    } finally {
      if (reqId === reqRef.current) setLoadingMore(false);
    }
  };

  // Page through the registry sequentially (reusing the cursor endpoint), appending
  // new servers as each page arrives with live progress. For a *specific* server,
  // the search box is much faster than paging through the whole registry.
  const loadAll = async () => {
    if (!active || !nextCursor || loadingAll || loadingMore) return;
    const reqId = ++reqRef.current;
    setLoadingAll(true);
    setLoadAllMsg('');
    const seen = new Set(servers.map(nameKey).filter(Boolean));
    let cursor = nextCursor;
    let pages = 0;
    let total = 0;
    try {
      while (cursor && pages < LOAD_ALL_MAX_PAGES) {
        if (reqId !== reqRef.current) return; // user searched or switched source
        setLoadAllMsg(`Loading page ${pages + 1}…`);
        const data = await fetchPage(active, activeSearch.trim(), cursor);
        if (reqId !== reqRef.current) return;
        const fresh = (data.servers || []).filter((s) => {
          const k = nameKey(s);
          if (!k || seen.has(k)) return false;
          if (k) seen.add(k);
          return true;
        });
        total += fresh.length;
        if (fresh.length > 0) {
          setServers((prev) => {
            const keys = new Set(prev.map(nameKey).filter(Boolean));
            const add = fresh.filter((s) => {
              const k = nameKey(s);
              if (!k || keys.has(k)) return false;
              if (k) keys.add(k);
              return true;
            });
            return [...prev, ...add];
          });
        }
        cursor = data.next_cursor || null;
        pages += 1;
        if (reqId === reqRef.current) {
          setLoadAllMsg(`Loaded ${total} more servers (page ${pages}${cursor ? '' : ' — end of registry'})…`);
        }
      }
      if (reqId !== reqRef.current) return;
      setNextCursor(cursor);
      setLoadAllMsg(
        cursor
          ? `Stopped at the ${LOAD_ALL_MAX_PAGES}-page safety cap after ${total} more servers. Search above to find a specific one, or keep using Load more.`
          : `Done — loaded ${total} more servers. The whole registry is now listed above.`
      );
    } catch (err) {
      if (reqId === reqRef.current) {
        setLoadAllMsg(`Load all stopped: ${err.message || 'fetch failed'}`);
      }
    } finally {
      setLoadingAll(false);
    }
  };

  const onSearchChange = (val) => {
    setSearchText(val);
    if (!active || !supportsSearch) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      loadSource(active, val.trim());
    }, 350);
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
    loadSource(entry, '');
  };

  const removeCustom = (url) => {
    const next = custom.filter((c) => c.url !== url);
    setCustom(next);
    saveCustom(next);
    if (active && active.url === url) {
      reqRef.current += 1; // cancel any in-flight fetch / load-all for this source
      setActive(null);
      resetResults();
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
          env: s.env || {},
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

  const plural = servers.length === 1 ? 'server' : 'servers';
  const countText = fetching
    ? 'Loading…'
    : `${servers.length} ${plural}${activeSearch ? ` matching “${activeSearch}”` : ''}.`;

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
              onClick={() => loadSource(s, '')}
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
              <button className="src-item-btn" onClick={() => loadSource(c, '')} disabled={fetching}>
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
              <p className="card-desc">{countText}</p>
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

          {supportsSearch && (
            <div className="field" style={{ margin: '12px 0' }}>
              <input
                value={searchText}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search servers by name, description, or package…"
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </div>
          )}

          {fetching && <p className="muted" style={{ marginTop: 12 }}>Fetching and normalizing…</p>}

          {!fetching && servers.length > 0 && (
            <>
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
                          {s.is_latest && <span className="badge ok">latest</span>}
                          {s.version && !s.is_latest && <span className="badge">v{s.version}</span>}
                          {configured && <span className="badge ok">✓ already in Bionic</span>}
                          {!target && <span className="badge">no target</span>}
                          {s.repository && (
                            <a
                              className="src-home"
                              href={s.repository}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                            >
                              source ↗
                            </a>
                          )}
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
                        {s.type === 'stdio' && Array.isArray(s.config) && s.config.length > 0 && (
                          <div className="muted" style={{ fontSize: 12 }}>
                            Needs {s.config.length} env var{s.config.length > 1 ? 's' : ''}:{' '}
                            {s.config.map((c) => (
                              <span key={c.name} title={c.description} style={{ marginRight: 6 }}>
                                {c.name}{c.required ? '*' : ''}
                              </span>
                            ))}
                          </div>
                        )}
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

              {canLoadMore && (
                <div className="row" style={{ marginTop: 12, alignItems: 'center' }}>
                  <button className="btn" onClick={loadMore} disabled={loadingMore || loadingAll}>
                    {loadingMore ? <span className="spin" /> : 'Load more…'}
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={loadAll}
                    disabled={loadingAll || loadingMore}
                    title="Page through the entire registry (1900+ servers) with live progress"
                  >
                    {loadingAll ? <span className="spin" /> : 'Load all…'}
                  </button>
                  <span className="muted" style={{ marginLeft: 8 }}>
                    {loadAllMsg ||
                      'This is page 1 of a registry with 1900+ servers — search above to find one, or load more/all.'}
                  </span>
                </div>
              )}
              {!canLoadMore && loadAllMsg && (
                <p className="muted" style={{ marginTop: 8 }}>{loadAllMsg}</p>
              )}
            </>
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
