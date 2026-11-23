import React, { useState } from 'react';
import HomeView from './views/HomeView';
import MCPManager from './views/MCPManager';
import SourcesView from './views/SourcesView';
import SettingsView from './views/SettingsView';
import ConfigManager from './views/ConfigManager';
// Imported last so the shared component kit in App.css wins on any class conflict.
import './App.css';

const NAV_ITEMS = [
  { id: 'home', label: 'Home' },
  { id: 'mcp', label: 'MCP Manager' },
  { id: 'sources', label: 'MCP Sources' },
  { id: 'settings', label: 'Advanced Settings' },
  { id: 'config', label: 'Config Manager' },
];

function App() {
  const [activeView, setActiveView] = useState('home');

  const renderView = () => {
    switch (activeView) {
      case 'mcp':
        return <MCPManager />;
      case 'sources':
        return <SourcesView />;
      case 'settings':
        return <SettingsView />;
      case 'config':
        return <ConfigManager />;
      case 'home':
      default:
        return <HomeView onNavigate={setActiveView} />;
    }
  };

  return (
    <div className="App">
      <nav>
        <div className="nav-title">Bionic Deck</div>
        {NAV_ITEMS.map((item) => (
          <div
            key={item.id}
            className={`sidebar-item ${activeView === item.id ? 'active' : ''}`}
            onClick={() => setActiveView(item.id)}
          >
            {item.label}
          </div>
        ))}
        <div className="nav-footer">
          <span className="muted">Local control panel for Bionic</span>
        </div>
      </nav>
      <main className="main-content">{renderView()}</main>
    </div>
  );
}

export default App;
