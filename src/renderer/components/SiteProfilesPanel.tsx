import type { AppState, SiteProfileSummary } from '../../shared/types.js';
import { bridge, type Act } from '../bridge.js';

// Site profiles (plan §2) and the settings that go with running them unattended (plan §6/§7). Everything shown is
// derived from AppState; text fields are uncontrolled and keyed by the stored value (no mirrored copies).

const HEALTH_TEXT: Record<SiteProfileSummary['health'], string> = { ok: 'Working', degraded: 'Needs a look', broken: 'Broken' };

function Profile({ profile, host, running, act }: { profile: SiteProfileSummary; host: string; running: boolean; act: Act }) {
  // Start on the current page when it is this site's; otherwise on the list it was taught on.
  const here = host === profile.domain;
  return (
    <li className={`profile ${profile.health}`} aria-label={`Site profile ${profile.domain}`}>
      <div className="profile-head">
        <strong>{profile.domain}</strong>
        <span className={`health ${profile.health}`}>{HEALTH_TEXT[profile.health]}</span>
      </div>
      <small>
        {profile.workflowName ?? 'Workflow missing'}
        {profile.lastVerifiedAt ? ` · last worked ${new Date(profile.lastVerifiedAt).toLocaleString()}` : ' · not run yet'}
      </small>
      {profile.health === 'broken' && profile.brokenStepId && profile.workflowId && (
        <p className="step-message">"{profile.brokenStepLabel}" failed.
          {' '}<button disabled={running} onClick={() => act(() => bridge().reteachStep(profile.workflowId!, profile.brokenStepId!))}>↻ Re-teach this step</button>
        </p>
      )}
      <div className="profile-actions">
        <button className="primary" disabled={running || (!here && !profile.listUrl)}
          title={here ? 'Run on the current page' : `Run on ${profile.listUrl}`}
          onClick={() => act(() => bridge().startProfile(here ? null : profile.listUrl))}>▶ Start{here ? '' : ' on the taught list'}</button>
        <button onClick={() => act(() => bridge().deleteProfile(profile.id))}>Forget</button>
      </div>
    </li>
  );
}

function Settings({ state, act }: { state: AppState; act: Act }) {
  const { safety, tray, adblock } = state.settings;
  const lists = state.adblock;
  const allowlist = safety.allowlist.join(', ');
  const saveList = (text: string) => {
    const list = text.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean);
    if (list.join(', ') !== allowlist) act(() => bridge().setSafety({ ...safety, allowlist: list }));
  };
  return (
    <details className="settings">
      <summary>Safety, ads and tray</summary>
      <label className="setting">
        <span>Allowed sites (empty: any)</span>
        <input key={allowlist} defaultValue={allowlist} aria-label="Allowed sites" placeholder="example.com, *.files.example"
          onKeyDown={event => { if (event.key === 'Enter') saveList(event.currentTarget.value); }} onBlur={event => saveList(event.currentTarget.value)} />
      </label>
      <label className="setting-check">
        <input type="checkbox" checked={safety.confirmRisky} onChange={event => act(() => bridge().setSafety({ ...safety, confirmRisky: event.target.checked }))} />
        Ask before clicks that look like buying, paying or deleting
      </label>
      <label className="setting-check">
        <input type="checkbox" checked={tray.minimizeToTray} onChange={event => act(() => bridge().setTray({ minimizeToTray: event.target.checked }))} />
        Minimizing while working hides Vestigium in the tray
      </label>
      <label className="setting-check">
        <input type="checkbox" checked={adblock.enabled} onChange={event => act(() => bridge().setAdBlock({ enabled: event.target.checked }))} />
        Block ads and trackers in browser tabs
      </label>
      {/* A snapshot: the count is as of the last state push, which is frequent enough for a settings line. */}
      <p className="setting-note" aria-label="Ad blocking status">
        {lists.filters === 0 ? 'No filter lists are loaded.'
          : `${lists.filters.toLocaleString()} filters, lists from ${lists.listsUpdated?.slice(0, 10) ?? 'unknown'}; ${lists.blocked.toLocaleString()} blocked since start.`}
      </p>
    </details>
  );
}

export function SiteProfilesPanel({ state, act }: { state: AppState | null; act: Act }) {
  if (!state) return null;
  const active = state.tabs.find(tab => tab.id === state.activeTabId);
  let host = '';
  try {
    host = active?.url ? new URL(active.url).host : '';
  } catch { /* not a web page */ }
  const running = state.run?.status === 'running' || state.run?.status === 'paused' || state.recording.active;
  return (
    <section aria-label="Site profiles" className="profiles-panel">
      <h2>Site profiles</h2>
      {state.profiles.length === 0
        ? <p>Teach one item on a list (● Teach, open one item, download it, Stop). Vestigium saves what it learned for that site; next time open a list there and press ▶ Start.</p>
        : <ul className="profiles">{state.profiles.map(profile => <Profile key={profile.id} profile={profile} host={host} running={running} act={act} />)}</ul>}
      <Settings state={state} act={act} />
    </section>
  );
}
