import type { DownloadRow, DownloadsState, DownloadSettings, MetadataSettings } from '../../shared/types.js';
import { bridge, type Act } from '../bridge.js';

// The download queue table (plan §6): title, status, progress, speed, ETA and per-row actions, plus "for all" controls.
// Everything is derived from the AppState snapshot; main computes speed and ETA, the panel only formats them.

const STATUS_TEXT: Record<DownloadRow['status'], string> = {
  queued: 'Queued', running: 'Downloading', paused: 'Paused', verifying: 'Verifying', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
};

export function bytes(value: number | null): string {
  if (value === null) return '?';
  if (value >= 1 << 30) return `${(value / (1 << 30)).toFixed(1)} GB`;
  if (value >= 1 << 20) return `${(value / (1 << 20)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

function eta(seconds: number | null): string {
  if (seconds === null) return '';
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

const percent = (received: number, total: number | null) => (total ? Math.min(100, Math.floor((received / total) * 100)) : null);

function Row({ row, act }: { row: DownloadRow; act: Act }) {
  const share = row.status === 'done' ? 100 : percent(row.receivedBytes, row.totalBytes);
  const name = row.filename || row.title;
  const control = (action: 'pause' | 'resume' | 'cancel' | 'retry', label: string) => (
    <button aria-label={`${label} ${name}`} onClick={() => act(() => bridge().controlDownloads(action, row.id))}>{label}</button>
  );
  const active = row.status === 'running' || row.status === 'queued';
  return (
    <tr className={row.status} aria-label={name}>
      <td className="download-name">
        <strong title={row.url}>{name}</strong>
        {row.title && row.title !== name && <small>{row.title}</small>}
        {row.error && <small className="error">{row.error}</small>}
        {row.duplicateOf && <small>Identical to a file already saved; not stored twice.</small>}
        {row.details.length > 1 && <small>Details: {row.details.filter(label => label !== 'Title').join(', ')}</small>}
        {row.extractNote && <small className={row.extractedTo ? '' : 'error'}>{row.extractNote}</small>}
      </td>
      <td>{STATUS_TEXT[row.status]}{row.attempts > 1 && row.status !== 'done' ? ` · try ${row.attempts}` : ''}</td>
      <td>
        <div className="progress" role="progressbar" aria-label={`Progress of ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share ?? undefined}>
          <span style={{ width: `${share ?? 0}%` }} />
        </div>
        <small>{bytes(row.receivedBytes)} / {bytes(row.totalBytes)}</small>
      </td>
      <td>{row.status === 'running' && row.bytesPerSecond !== null ? `${bytes(row.bytesPerSecond)}/s` : ''}</td>
      <td>{row.status === 'running' ? eta(row.etaSeconds) : ''}</td>
      <td className="download-actions">
        {active && control('pause', 'Pause')}
        {row.status === 'paused' && control('resume', 'Resume')}
        {(active || row.status === 'paused') && control('cancel', 'Cancel')}
        {(row.status === 'failed' || row.status === 'cancelled') && control('retry', 'Retry')}
        {row.status === 'done' && row.finalPath && (
          <button aria-label={`Show ${name} in folder`} onClick={() => act(() => bridge().showDownload(row.id))}>Show</button>
        )}
      </td>
    </tr>
  );
}

// Text settings are uncontrolled inputs keyed by the stored value: when main's value changes, React remounts the input
// with it, so there is no second copy of the setting to keep in sync. Saved on Enter or when the field loses focus.
function SettingField({ label, value, onSave, help }: { label: string; value: string; onSave: (value: string) => void; help: string }) {
  const save = (input: HTMLInputElement) => { if (input.value.trim() && input.value !== value) onSave(input.value.trim()); };
  return (
    <label className="queue-setting">
      <span>{label}</span>
      <input key={value} defaultValue={value} aria-label={label} title={help}
        onKeyDown={event => { if (event.key === 'Enter') save(event.currentTarget); }} onBlur={event => save(event.currentTarget)} />
    </label>
  );
}

function Options({ options, metadata, act }: { options: DownloadSettings; metadata: MetadataSettings; act: Act }) {
  const set = (change: Partial<Omit<DownloadSettings, 'directory'>>) => {
    const { directory: _directory, ...rest } = options;
    act(() => bridge().setDownloadOptions({ ...rest, ...change }));
  };
  return (
    <details className="queue-options">
      <summary>Download options</summary>
      <SettingField label="File names" value={options.template} onSave={template => set({ template })}
        help="Folders and name for each file: {site} {title} {tag} {date} {name} {ext} {filename}, or any detail label such as {author}." />
      <SettingField label="Details to capture" value={metadata.labels.join(', ')}
        onSave={text => act(() => bridge().setMetadataLabels(text.split(',').map(label => label.trim()).filter(Boolean)))}
        help="Labels on item pages whose values are saved with the file, comma-separated (Password, Author, Model …)." />
      <label className="queue-option">
        <input type="checkbox" checked={options.sidecar} onChange={event => set({ sidecar: event.target.checked })} /> Save details in a _info.txt file
      </label>
      <label className="queue-option">
        Archives
        <select aria-label="Unpack archives" value={options.extract} onChange={event => set({ extract: event.target.value as DownloadSettings['extract'] })}>
          <option value="off">Keep as downloaded</option>
          <option value="keep">Unpack, keep the archive</option>
          <option value="delete">Unpack, then delete the archive</option>
        </select>
      </label>
    </details>
  );
}

export function QueuePanel({ downloads, options, metadata, act }: { downloads: DownloadsState; options: DownloadSettings; metadata: MetadataSettings; act: Act }) {
  const { counts, rows } = downloads;
  const overall = percent(downloads.receivedBytes, downloads.totalBytes);
  const working = counts.running + counts.queued;
  // The folder is not part of the options sent back; main keeps it and only the native dialog changes it.
  const set = (change: Partial<Omit<DownloadSettings, 'directory'>>) => {
    const { directory: _directory, ...rest } = options;
    act(() => bridge().setDownloadOptions({ ...rest, ...change }));
  };
  return (
    <div className="queue">
      <div className="queue-bar">
        <span className="queue-summary" aria-label="Queue summary">
          {working ? `${counts.running} downloading, ${counts.queued} waiting` : 'Idle'}
          {` · ${counts.done} done`}{counts.failed ? ` · ${counts.failed} failed` : ''}{counts.paused ? ` · ${counts.paused} paused` : ''}
          {downloads.held ? ' · paused for all' : ''}
          {overall !== null && working ? ` · ${overall}% overall` : ''}
        </span>
        {downloads.held || counts.paused
          ? <button onClick={() => act(() => bridge().controlDownloads('resume', null))}>Resume all</button>
          : <button disabled={working === 0} onClick={() => act(() => bridge().controlDownloads('pause', null))}>Pause all</button>}
        <button disabled={working + counts.paused === 0} onClick={() => act(() => bridge().controlDownloads('cancel', null))}>Cancel all</button>
        <button disabled={counts.failed === 0} onClick={() => act(() => bridge().controlDownloads('retry', null))}>Retry failed</button>
        <label className="queue-option" title="Download items again even if they were downloaded before">
          <input type="checkbox" checked={options.force} onChange={event => set({ force: event.target.checked })} /> Force
        </label>
        <label className="queue-option">
          At once
          <select aria-label="Downloads at once" value={options.concurrency} onChange={event => set({ concurrency: Number(event.target.value) })}>
            {[1, 2, 3, 4, 5, 6].map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <button title={downloads.directory} onClick={() => act(() => bridge().openDownloadFolder())}>Open folder</button>
        <button onClick={() => act(() => bridge().chooseDownloadFolder())}>Change folder…</button>
      </div>
      <Options options={options} metadata={metadata} act={act} />
      {rows.length === 0
        ? <div className="empty-panel"><strong>No downloads yet</strong><p>Downloads from runs and from pages you browse land in {downloads.directory}.</p></div>
        : (
          <table className="queue-table" aria-label="Downloads">
            <thead><tr><th>File</th><th>Status</th><th>Progress</th><th>Speed</th><th>Time left</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
            <tbody>{rows.map(row => <Row key={row.id} row={row} act={act} />)}</tbody>
          </table>
        )}
    </div>
  );
}
