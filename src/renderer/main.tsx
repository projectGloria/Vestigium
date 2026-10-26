import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { LAYOUT } from '../shared/ipc.js';
import { bridge, useAppState } from './bridge.js';
import { Toolbar } from './components/Toolbar.js';
import { WorkflowPanel } from './components/WorkflowPanel.js';
import { ActivityPanel } from './components/ActivityPanel.js';
import { SiteProfilesPanel } from './components/SiteProfilesPanel.js';

// Native browser views are positioned from the same LAYOUT numbers, so the CSS grid and the views always agree.
for (const [key, value] of Object.entries(LAYOUT)) document.documentElement.style.setProperty(`--${key}`, `${value}px`);

function App() {
  const { state, error, pending, act } = useAppState();
  // Theme lives on <html> (outside React's tree), so this is a genuine side effect, not derived state.
  useEffect(() => {
    document.documentElement.dataset.theme = state?.settings.theme ?? 'dark';
  }, [state?.settings.theme]);

  return (
    <div className="app">
      <Toolbar state={state} act={act} pending={pending} />
      <aside className="sidebar">
        <WorkflowPanel state={state} act={act} />
        <SiteProfilesPanel state={state} act={act} />
      </aside>
      <main className="browser-area" aria-label="Browser pane">
        <div className="tab-strip" role="tablist" aria-label="Browser tabs">
          {state?.tabs.map(tab => (
            <div className={`browser-tab ${tab.id === state.activeTabId ? 'selected' : ''}`} key={tab.id}>
              <button role="tab" aria-selected={tab.id === state.activeTabId} title={tab.url} onClick={() => act(() => bridge().selectTab(tab.id))}>
                {tab.loading ? '◌ ' : '○ '}{tab.title}
              </button>
              <button aria-label={`Close ${tab.title}`} onClick={() => act(() => bridge().closeTab(tab.id))}>×</button>
            </div>
          ))}
          <button aria-label="New tab" onClick={() => act(() => bridge().newTab())}>+</button>
          {/* Plan §6: a link found on the clipboard is offered once, here where tabs open (the toolbar is full). */}
          {state?.clipboardUrl && (
            <span className="copied-link">
              <button title={state.clipboardUrl} aria-label={`Open copied link ${state.clipboardUrl}`} onClick={() => act(() => bridge().navigate(state.clipboardUrl!))}>
                Open copied link: {state.clipboardUrl.replace(/^https?:\/\//, '').slice(0, 48)}
              </button>
              <button aria-label="Dismiss copied link" onClick={() => act(() => bridge().dismissClipboard())}>×</button>
            </span>
          )}
        </div>
        <div className="browser-space" />
      </main>
      <ActivityPanel state={state} error={error} act={act} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
