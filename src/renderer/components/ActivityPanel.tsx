import { useState } from 'react';
import type { AppState, RunRecord, StepRunResult } from '../../shared/types.js';
import { bridge, type Act } from '../bridge.js';
import { QueuePanel } from './QueuePanel.js';

type Panel = 'Queue' | 'Log' | 'History';

// A failed step or item: its message, a screenshot of the page (plan §6), and re-teaching when it is a step.
function Failure({ result, workflowId, act }: { result: StepRunResult; workflowId: string; act: Act }) {
  return (
    <>
      {result.screenshot && <button className="link" onClick={() => act(() => bridge().openScreenshot(result.screenshot!))}>Screenshot</button>}
      {/* An item's own record ("… · Repeat for every item") is not a step to re-teach; its failing step is listed too. */}
      {!result.label.endsWith('Repeat for every item') && (
        <button className="link" onClick={() => act(() => bridge().reteachStep(workflowId, result.stepId))}>Re-teach this step</button>
      )}
    </>
  );
}

function PastRun({ record, act }: { record: RunRecord; act: Act }) {
  return (
    <li className={record.status}>
      <details>
        <summary>
          <b>{record.status}</b> {record.workflowName} · {new Date(record.startedAt).toLocaleString()}
          <small> · {record.done} done{record.failed ? `, ${record.failed} failed` : ''}{record.skipped ? `, ${record.skipped} skipped` : ''}</small>
        </summary>
        {record.error && <p className="run-error">{record.error}</p>}
        <ul>
          {record.failures.map((result, index) => (
            <li key={index}>{result.label} · <small>{result.message}</small> <Failure result={result} workflowId={record.workflowId} act={act} /></li>
          ))}
        </ul>
      </details>
    </li>
  );
}

function statusLine(state: AppState | null, error: string): { text: string; error: boolean } {
  const active = state?.tabs.find(tab => tab.id === state.activeTabId);
  if (error) return { text: error, error: true };
  if (active?.error) return { text: active.error, error: true };
  if (state?.recording.active) return { text: `Recording · ${state.recording.events} events`, error: false };
  const run = state?.run;
  if (run?.status === 'paused') return { text: run.pauseReason ?? 'Paused', error: false };
  if (run?.status === 'running') {
    const verb = run.mode === 'dry' ? 'Dry run of' : 'Running';
    const where = run.progress ? ` · ${run.progress}` : '';
    return { text: `${verb} "${run.workflowName}" · step ${(run.current ?? 0) + 1} of ${run.total}${where}`, error: false };
  }
  return { text: active?.loading ? 'Loading…' : 'Ready', error: false };
}

export function ActivityPanel({ state, error, act }: { state: AppState | null; error: string; act: Act }) {
  const [panel, setPanel] = useState<Panel>('Queue');
  const status = statusLine(state, error);
  const run = state?.run ?? null;
  return (
    <section className="bottom" aria-label="Activity">
      <div className="panel-bar">
        <div role="tablist" aria-label="Activity panels">
          {(['Queue', 'Log', 'History'] as const).map(name => (
            <button key={name} role="tab" aria-selected={panel === name} onClick={() => setPanel(name)}>
              {name}{name === 'Log' && state ? ` · ${state.logs.length}` : ''}
              {name === 'Queue' && state && state.downloads.counts.running + state.downloads.counts.queued > 0 ? ` · ${state.downloads.counts.running + state.downloads.counts.queued}` : ''}
            </button>
          ))}
        </div>
        <span className={status.error ? 'error' : 'status'} role="status">{status.text}</span>
      </div>
      <div role="tabpanel" aria-label={panel} className="panel-content">
        {panel === 'Log' && (
          <div className="log-list">
            {state?.logs.slice().reverse().map(entry => (
              <div className="log-entry" key={entry.id}>
                <time>{new Date(entry.time).toLocaleTimeString()}</time><b className={`level-${entry.level}`}>{entry.level}</b><span>{entry.message}</span>
              </div>
            ))}
          </div>
        )}
        {panel === 'Queue' && state && <QueuePanel downloads={state.downloads} options={state.settings.downloads} metadata={state.settings.metadata} act={act} />}
        {panel === 'History' && (run || state?.history.length
          ? (
            <div className="run-history">
              {run && (
                <>
                  <p className={`run-summary ${run.status}`}>
                    <strong>{run.workflowName}</strong> · {run.mode === 'dry' ? 'dry run · ' : ''}{run.status} · started {new Date(run.startedAt).toLocaleTimeString()}
                    {run.error && <span className="run-error"> — {run.error}</span>}
                    {/* Items already downloaded are skipped by a new run, so running again retries exactly what failed. */}
                    {run.finishedAt && run.results.some(result => result.status === 'failed') && (
                      <button className="link" onClick={() => act(() => bridge().runWorkflow(run.workflowId))}>↻ Retry failed items</button>
                    )}
                  </p>
                  <ol>
                    {run.results.map((result, index) => (
                      <li key={index} className={result.status}>
                        <b>{result.status}</b> {result.label}{result.locator && <small> · matched {result.locator}</small>}
                        {result.status !== 'done' && <small> · {result.message}</small>}
                        {result.status === 'failed' && <> <Failure result={result} workflowId={run.workflowId} act={act} /></>}
                      </li>
                    ))}
                  </ol>
                </>
              )}
              {state && state.history.length > 0 && (
                <>
                  <h3>Earlier runs</h3>
                  <ul className="past-runs" aria-label="Earlier runs">{state.history.map(record => <PastRun key={record.id} record={record} act={act} />)}</ul>
                </>
              )}
            </div>
          )
          : <div className="empty-panel"><strong>No runs yet</strong><p>Runs, with their failures and screenshots, are listed here and kept across restarts.</p></div>)}
      </div>
    </section>
  );
}
