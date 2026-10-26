import { useState } from 'react';
import type { AppState, BrowserTab, RunMode } from '../../shared/types.js';
import { bridge, type Act } from '../bridge.js';

// Remounted (via `key`) whenever the active tab or its URL changes, so the draft resets without an effect.
function AddressBar({ tab, act }: { tab: BrowserTab | undefined; act: Act }) {
  const [draft, setDraft] = useState(tab?.url === 'about:blank' ? '' : tab?.url ?? '');
  return (
    <form className="address" onSubmit={event => {
      event.preventDefault();
      const input = draft.trim();
      // "example.com" and "localhost:4173/x" get https:// added; anything with a scheme is sent as typed.
      const url = input.includes(':') && !/^[^/]+:\d+(\/|$)/.test(input) ? input : `https://${input}`;
      act(() => bridge().navigate(url));
    }}>
      <input aria-label="URL" placeholder="Enter a website URL" value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} />
      <button type="submit" className="primary">Go</button>
    </form>
  );
}

const MODES: { value: RunMode; label: string }[] = [
  { value: 'run', label: 'Run' }, { value: 'step', label: 'Step by step' }, { value: 'dry', label: 'Dry run (highlight only)' },
];

export function Toolbar({ state, act, pending }: { state: AppState | null; act: Act; pending: boolean }) {
  const active = state?.tabs.find(tab => tab.id === state.activeTabId);
  const recording = state?.recording.active ?? false;
  const status = state?.run?.status;
  const running = status === 'running' || status === 'paused';
  const selected = state?.selectedWorkflow ?? null;
  // Start (plan §6) runs the site profile of the current page: a URL and one click, no teaching.
  const host = (() => {
    try {
      return active?.url ? new URL(active.url).host : '';
    } catch {
      return '';
    }
  })();
  const profile = state?.profiles.find(candidate => candidate.domain === host) ?? null;
  // A UI preference for the next run, not app data: local state is the right home for it.
  const [mode, setMode] = useState<RunMode>('run');
  return (
    <header className="toolbar">
      <div className="brand"><b>V /</b><span>VESTIGIUM<small>WORKFLOW BROWSER</small></span></div>
      <div className="navigation">
        <button aria-label="Back" disabled={!active?.canGoBack} onClick={() => act(() => bridge().back())}>←</button>
        <button aria-label="Forward" disabled={!active?.canGoForward} onClick={() => act(() => bridge().forward())}>→</button>
        <button aria-label="Reload" disabled={!active} onClick={() => act(() => bridge().reload())}>↻</button>
      </div>
      <AddressBar key={`${active?.id}:${active?.url}`} tab={active} act={act} />
      <div className="run-controls">
        {recording
          ? <button className="recording" disabled={pending} onClick={() => act(() => bridge().recordStop())}>■ Stop recording · {state?.recording.events}</button>
          : <button disabled={pending || running} title="Record what you do in the current tab" onClick={() => act(() => bridge().recordStart())}>● Teach</button>}
        {!running && !recording && (
          <button className="primary" disabled={pending || !profile}
            title={profile ? `Run the ${profile.domain} profile on this page` : 'No site profile for this page yet: teach one item first'}
            onClick={() => act(() => bridge().startProfile(null))}>▶ Start</button>
        )}
        {running
          ? <>
            {status === 'paused'
              ? <>
                <button className="primary" onClick={() => act(() => bridge().resumeRun())}>▶ Resume</button>
                <button onClick={() => act(() => bridge().nextStep())}>⏭ Next step</button>
              </>
              : <button onClick={() => act(() => bridge().pauseRun())}>❚❚ Pause</button>}
            <button className="recording" onClick={() => act(() => bridge().stopRun())}>■ Stop run</button>
          </>
          : <>
            <select aria-label="Run mode" value={mode} disabled={recording} onChange={event => setMode(event.target.value as RunMode)}>
              {MODES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <button className="primary" disabled={pending || recording || !selected} title={selected ? `Run "${selected.name}" in the current tab` : 'Record or select a workflow first'}
              onClick={() => selected && act(() => bridge().runWorkflow(selected.id, mode))}>▶ Run</button>
          </>}
      </div>
 <button title={state?.downloads.directory} onClick={() => act(() => bridge().openDownloadFolder())}>Open folder</button>
      <button aria-label="Toggle theme" onClick={() => act(() => bridge().setTheme(state?.settings.theme === 'dark' ? 'light' : 'dark'))}>
        {state?.settings.theme === 'dark' ? 'Light' : 'Dark'}
      </button>
    </header>
  );
}
