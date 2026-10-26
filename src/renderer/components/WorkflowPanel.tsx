import { useState } from 'react';
import type { AppState } from '../../shared/types.js';
import { bridge, type Act } from '../bridge.js';
import { StepList } from './StepList.js';
import { summarize } from '../../shared/summary.js';

export function WorkflowPanel({ state, act }: { state: AppState | null; act: Act }) {
  // Deleting a whole workflow is irreversible, so it takes a second, explicit click.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const workflow = state?.selectedWorkflow ?? null;
  const run = state?.run ?? null;
  const locked = (run?.status === 'running' || run?.status === 'paused') && run.workflowId === workflow?.id;
  const reviews = workflow?.steps.filter(step => step.review).length ?? 0;
  const recording = state?.recording.active ?? false;
  // Derived on every render from the stored workflow: it can never disagree with the steps below it.
  const summary = workflow ? summarize(workflow) : null;

  return (
    <section aria-label="Workflow" className="workflow-panel">
      <div className="panel-heading">
        <h2>Workflow</h2>
        <button onClick={() => act(() => bridge().importWorkflow())}>Import…</button>
      </div>
      {recording && !state?.reteach && <p className="hint recording-hint">Recording · {state?.recording.events} events. Use the page, then press Stop recording.</p>}
      {state?.reteach && <p className="hint recording-hint" role="status">Re-teaching "{state.reteach.label}": click the right element in the page, then press ■ Stop recording. Only this step changes.</p>}
      {workflow
        ? (
          <>
            {/* key: a different workflow or a new version resets the uncontrolled name field. */}
            <form key={`${workflow.id}:${workflow.version}`} className="workflow-name" onSubmit={event => {
              event.preventDefault();
              const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
              if (name && name !== workflow.name) act(() => bridge().updateWorkflow(workflow.id, workflow.version, { kind: 'rename', name }));
            }}>
              <input name="name" aria-label="Workflow name" defaultValue={workflow.name} maxLength={200} disabled={locked}
                onBlur={event => event.currentTarget.form?.requestSubmit()} />
            </form>
            <p className="meta">{workflow.steps.length} steps · revision {workflow.version}{reviews > 0 && <span className="needs-review"> · {reviews} to review</span>}</p>
            {run?.status === 'paused' && run.workflowId === workflow.id && <p className="hint paused" role="alert">{run.pauseReason}</p>}
            {summary && (
              <div className="summary" role="note" aria-label="What this workflow does">
                {summary.map(line => <p key={line}>{line}</p>)}
              </div>
            )}
            <StepList workflow={workflow} run={run} preview={state?.itemPreview ?? null} act={act} />
            {!workflow.steps.some(step => step.type === 'loop_pages') && (
              <div className="learn">
                <button disabled={locked || recording} onClick={() => act(() => bridge().learnPages(workflow.id, workflow.version))}>↻ Repeat on every page</button>
                <small>Open the first page of the list in the current tab, then press this: Vestigium finds how the list moves on.</small>
              </div>
            )}
            <div className="workflow-actions">
              <button onClick={() => act(() => bridge().exportWorkflow(workflow.id))}>Export…</button>
              {confirmDelete === workflow.id
                ? <>
                  <button className="danger" disabled={locked} onClick={() => { setConfirmDelete(null); act(() => bridge().deleteWorkflow(workflow.id)); }}>Confirm delete</button>
                  <button onClick={() => setConfirmDelete(null)}>Cancel</button>
                </>
                : <button disabled={locked} onClick={() => setConfirmDelete(workflow.id)}>Delete…</button>}
            </div>
          </>
        )
        : !recording && <p className="hint">No workflow selected. Open a page, press <b>● Teach</b>, do the task once, then press Stop recording.</p>}
      {(state?.workflows.length ?? 0) > 0 && (
        <nav aria-label="Saved workflows" className="saved">
          <h3>Saved workflows</h3>
          <ul>
            {state!.workflows.map(summary => (
              <li key={summary.id}>
                <button aria-current={summary.id === workflow?.id ? 'true' : undefined} onClick={() => act(() => bridge().selectWorkflow(summary.id))}>
                  <span>{summary.name}</span><small>{summary.steps} steps</small>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </section>
  );
}
