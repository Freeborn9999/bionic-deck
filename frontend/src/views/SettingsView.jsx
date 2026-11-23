import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import './SettingsView.css';

// Bionic-specific, non-GUI, non-model settings.
// (Nothing here touches model hosting, context length, temperature, or LM Studio.)
const GROUPS = [
  {
    title: 'Developer',
    description: 'Experimental and developer-facing flags.',
    items: [
      { key: 'developer.betaDangerouslyEnableAgentControlAPI', label: 'Agent Control API (beta)', type: 'bool', help: 'Exposes the experimental Agent Control API. Only enable if you know you need it.' },
      { key: 'developer.orchestratorPresentationMode', label: 'Orchestrator presentation mode', type: 'select', options: ['floating', 'docked'], help: 'How the agent orchestrator panel is presented.' },
      { key: 'developer.runtimeLogVerbosityLevel', label: 'Runtime log verbosity (0–5)', type: 'number', help: 'Higher is more detailed. 3 is the default.' },
      { key: 'developer.windowsPreferPowerShell', label: 'Prefer PowerShell on Windows', type: 'bool', help: 'Run shell commands in PowerShell instead of bash/cmd.' },
      { key: 'developer.topicsEnabled', label: 'Enable topics', type: 'bool', help: 'Turn the topics feature on or off.' },
    ],
  },
  {
    title: 'In-App Browser',
    description: 'Controls for the embedded browser used for links and previews.',
    items: [
      { key: 'browser.storageMode', label: 'Browser storage mode', type: 'select', options: ['persistent', 'session', 'none'], help: 'Whether the in-app browser keeps cookies/storage between sessions.' },
      { key: 'browser.preferredLinkOpenTarget', label: 'Where links open', type: 'select', options: ['appBrowser', 'external'], help: 'Open clicked links in the in-app browser or your external browser.' },
      { key: 'browser.allowedOrigins', label: 'Allowed origins', type: 'list', help: 'Extra origins allowed in the in-app browser (comma-separated).' },
    ],
  },
  {
    title: 'Appearance',
    description: 'Visual behavior not exposed in the main settings.',
    items: [
      { key: 'appearance.inlineDiffMode', label: 'Inline diff mode', type: 'select', options: ['unified', 'split'], help: 'How file diffs are shown inline.' },
      { key: 'appearance.sidebarBackgroundMode', label: 'Sidebar background', type: 'select', options: ['solid', 'translucent'], help: 'Solid or translucent sidebar background.' },
    ],
  },
  {
    title: 'Mini Window',
    description: '',
    items: [
      { key: 'miniWindow.showInEveryWorkspace', label: 'Show mini window in every workspace', type: 'bool', help: 'Always show the mini assistant window.' },
      { key: 'miniWindow.followFocusedInput', label: 'Follow focused input', type: 'bool', help: 'Move the mini window to the focused input.' },
    ],
  },
  {
    title: 'Notifications',
    description: '',
    items: [
      { key: 'notifications.sessionCompletedEnabled', label: 'Notify when a session completes', type: 'bool', help: 'Show a notification when an agent session finishes.' },
    ],
  },
  {
    title: 'Agent Behavior',
    description: 'Non-model agent behaviors.',
    items: [
      { key: 'agent.explorationSubagentEnabled', label: 'Exploration subagent', type: 'bool', help: 'Allow the agent to spawn exploration subagents.' },
      { key: 'agent.widgetsEnabled', label: 'Widgets', type: 'bool', help: 'Enable agent widgets.' },
      { key: 'agent.widgetFollowUpActionsEnabled', label: 'Widget follow-up actions', type: 'bool', help: 'Enable follow-up actions on widgets.' },
      { key: 'agent.webSearchEnabled', label: 'Web search', type: 'bool', help: 'Allow the agent to use web search.' },
    ],
  },
  {
    title: 'Session Behavior',
    description: '',
    items: [
      { key: 'sessions.historyRecallEnabled', label: 'History recall', type: 'bool', help: 'Recall prior conversation context.' },
      { key: 'sessions.queueSendsWhileRunning', label: 'Queue sends while running', type: 'bool', help: 'Queue new messages while a run is in progress.' },
      { key: 'sessions.renameAfterFork', label: 'Rename after fork', type: 'bool', help: 'Rename a session after forking it.' },
      { key: 'sessions.browserControlEnabled', label: 'Browser control', type: 'bool', help: 'Allow the agent to control the browser.' },
      { key: 'sessions.arrowUpEditsLatestMessage', label: 'Arrow-up edits last message', type: 'bool', help: 'Pressing up-arrow edits your latest message.' },
      { key: 'sessions.latestMessageUsesEditAction', label: 'Latest message uses edit action', type: 'bool', help: 'Re-send uses an explicit edit action.' },
    ],
  },
  {
    title: 'App',
    description: '',
    items: [
      { key: 'updates.automaticDownloadsEnabled', label: 'Automatic update downloads', type: 'bool', help: 'Download Bionic updates automatically.' },
      { key: 'voice.voiceKeyboardStopOnEnter', label: 'Voice: stop on Enter', type: 'bool', help: 'Enter key stops the voice keyboard.' },
    ],
  },
];

const Switch = ({ on, onChange }) => (
  <button type="button" className={`switch ${on ? 'on' : ''}`} onClick={onChange} aria-pressed={on}>
    <span className="knob" />
  </button>
);

function coerce(item, raw) {
  if (raw === null || raw === undefined) return null;
  if (item.type === 'bool') return Boolean(raw);
  if (item.type === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? null : n;
  }
  if (item.type === 'list') {
    if (Array.isArray(raw)) return raw.join(', ');
    return String(raw);
  }
  return String(raw);
}

const SettingsView = () => {
  const [values, setValues] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/bionic/settings');
      const v = {};
      GROUPS.forEach((g) =>
        g.items.forEach((item) => {
          v[item.key] = coerce(item, data.settings ? data.settings[item.key] : undefined);
        })
      );
      setValues(v);
      setLoaded(true);
      setMessage(null);
    } catch (err) {
      setMessage({ type: 'error', text: `Could not load settings. ${err.message}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setItem = (item, value) => setValues((v) => ({ ...v, [item.key]: value }));

  const buildPayload = () => {
    const out = {};
    GROUPS.forEach((g) =>
      g.items.forEach((item) => {
        const raw = values[item.key];
        if (raw === null || raw === undefined || raw === '') return;
        if (item.type === 'bool') out[item.key] = Boolean(raw);
        else if (item.type === 'number') {
          const n = Number(raw);
          if (!Number.isNaN(n)) out[item.key] = n;
        } else if (item.type === 'list') {
          out[item.key] = String(raw)
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
        } else {
          out[item.key] = String(raw);
        }
      })
    );
    return out;
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await api('/bionic/settings', {
        method: 'POST',
        body: JSON.stringify({ settings: buildPayload() }),
      });
      setMessage({ type: 'success', text: `Saved. Restart Bionic to apply (${(res.applied || []).length} keys).` });
    } catch (err) {
      setMessage({ type: 'error', text: `Save failed: ${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-view">
      <div className="row space">
        <div>
          <h2>Advanced Settings</h2>
          <p className="page-sub">
            Bionic-specific options that are not exposed in Bionic&apos;s settings UI. These are saved
            directly to Bionic&apos;s settings file. No model or LM Studio settings are included here.
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={load} disabled={loading}>
            {loading ? <span className="spin" /> : 'Reload'}
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || !loaded}>
            {saving ? <span className="spin" /> : 'Save changes'}
          </button>
        </div>
      </div>

      {message && <div className={`message ${message.type}`}>{message.text}</div>}

      {loading ? (
        <p className="muted">Loading settings…</p>
      ) : (
        GROUPS.map((group) => (
          <div className="card" key={group.title}>
            <h3>{group.title}</h3>
            {group.description && <p className="card-desc">{group.description}</p>}
            <div>
              {group.items.map((item) => {
                const value = values[item.key];
                return (
                  <div className="setting-row" key={item.key}>
                    <div className="sr-left">
                      <div className="sr-label">{item.label}</div>
                      {item.help && <div className="sr-help">{item.help}</div>}
                    </div>
                    <div className="sr-control">
                      {item.type === 'bool' && (
                        <Switch
                          on={Boolean(value)}
                          onChange={() => setItem(item, !value)}
                        />
                      )}
                      {item.type === 'select' && (
                        <select value={value ?? ''} onChange={(e) => setItem(item, e.target.value)}>
                          {value === null || value === undefined ? <option value="">— unset —</option> : null}
                          {item.options.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      )}
                      {item.type === 'number' && (
                        <input
                          type="number"
                          value={value ?? ''}
                          onChange={(e) => setItem(item, e.target.value)}
                          style={{ width: 110 }}
                        />
                      )}
                      {item.type === 'list' && (
                        <input
                          type="text"
                          value={value ?? ''}
                          onChange={(e) => setItem(item, e.target.value)}
                          placeholder="comma, separated, values"
                          style={{ width: 260 }}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
};

export default SettingsView;
