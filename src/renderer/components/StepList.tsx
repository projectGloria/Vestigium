import { useState } from 'react';
import type { WorkflowChange } from '../../shared/ipc.js';
import type { ItemPreview, RunState, Step, Workflow } from '../../shared/types.js';
import { bridge, type Act } from '../bridge.js';
import { LocatorInspector } from './LocatorInspector.js';

const STATUS_TEXT = { done: '✓', skipped: '–', failed: '✕', running: '…' } as const;

interface Context {
  locked: boolean; run: RunState | null; edit: (change: WorkflowChange) => void;
  preview: ItemPreview | null; showItems: (stepId: string, show: boolean) => void;
  // Plan §2/§6: a step that failed can be re-taught alone (opens its page, records one click).
  reteach: (stepId: string) => void;
}

interface RowProps extends Context {
  step: Step; number: string; index: number; count: number; topLevel: boolean;
  status: keyof typeof STATUS_TEXT | null;
}

// A page loop: what moves the list on, how many pages at most, and the steps repeated on every page.
function PageLoop({ step, number, ...context }: Context & { step: Extract<Step, { type: 'loop_pages' }>; number: string }) {
  const { pagination, maxPages, steps } = step.params;
  return (
    <div className="loop" aria-label={`Loop of step ${number}`}>
      <p className="loop-how">{pagination.description}</p>
      {/* key: a new stored value resets the uncontrolled field. */}
      <form key={maxPages} className="loop-limit" onSubmit={event => {
        event.preventDefault();
        const value = Number(new FormData(event.currentTarget).get('maxPages'));
        if (Number.isInteger(value) && value >= 1 && value <= 10_000 && value !== maxPages) {
          context.edit({ kind: 'set-max-pages', stepId: step.id, maxPages: value });
        }
      }}>
        <label>At most <input name="maxPages" type="number" min={1} max={10_000} defaultValue={maxPages} disabled={context.locked}
          aria-label={`Maximum pages for step ${number}`} onBlur={event => event.currentTarget.form?.requestSubmit()} /> pages</label>
      </form>
      {steps.length
        ? <Steps steps={steps} prefix={`${number}.`} label={`Steps repeated on every page (step ${number})`} {...context} />
        : <p className="hint">No steps repeat yet: the loop only visits the pages.</p>}
    </div>
  );
}

// An item loop: how items are recognized, a limit, the items found on the list (untick to exclude), and the steps
// done on every item page. The item list shown is main's latest preview; exclusions come from the stored workflow.
function ItemLoop({ step, number, ...context }: Context & { step: Extract<Step, { type: 'loop_items' }>; number: string }) {
  const { pattern, maxItems, exclude, steps } = step.params;
  const shown = context.preview?.stepId === step.id ? context.preview : null;
  const excluded = new Set(exclude);
  return (
    <div className="loop" aria-label={`Loop of step ${number}`}>
      <p className="loop-how">{pattern.description}</p>
      <form key={maxItems} className="loop-limit" onSubmit={event => {
        event.preventDefault();
        const value = Number(new FormData(event.currentTarget).get('maxItems'));
        if (Number.isInteger(value) && value >= 1 && value <= 100_000 && value !== maxItems) {
          context.edit({ kind: 'set-max-items', stepId: step.id, maxItems: value });
        }
      }}>
        <label>At most <input name="maxItems" type="number" min={1} max={100_000} defaultValue={maxItems} disabled={context.locked}
          aria-label={`Maximum items for step ${number}`} onBlur={event => event.currentTarget.form?.requestSubmit()} /> items</label>
      </form>
      <div className="item-tools">
        <button disabled={context.locked && !shown} onClick={() => context.showItems(step.id, !shown)}>
          {shown ? 'Hide items' : '◎ Show items on the page'}
        </button>
        {!shown && exclude.length > 0 && <small>{exclude.length} excluded</small>}
      </div>
      {shown && (
        <>
          <p className="hint">
            {shown.items.length - shown.items.filter(item => excluded.has(item.url)).length} of {shown.items.length} items on this page will be opened.
            {shown.loose && ' Found by a looser match because the item links moved: check them.'} Untick an item to leave it out.
          </p>
          <ol className="item-preview" aria-label={`Items found for step ${number}`}>
            {shown.items.map(item => (
              <li key={item.url}>
                <label title={item.url}>
                  <input type="checkbox" checked={!excluded.has(item.url)} disabled={context.locked}
                    onChange={event => context.edit({ kind: 'exclude-item', stepId: step.id, url: item.url, excluded: !event.target.checked })} />
                  <span>{item.title}</span>
                </label>
              </li>
            ))}
          </ol>
        </>
      )}
      {steps.length
        ? <Steps steps={steps} prefix={`${number}.`} label={`Steps done on every item (step ${number})`} {...context} />
        : <p className="hint">Nothing is done on the item pages yet: the loop only opens each item.</p>}
    </div>
  );
}

function StepRow({ step, number, index, count, topLevel, status, ...context }: RowProps) {
  const { locked, run, edit } = context;
  // Only the in-progress label draft is local; everything shown otherwise comes from the stored workflow.
  const [editing, setEditing] = useState(false);
  // In a loop a step runs many times; show its latest result.
  const result = run?.results.findLast(item => item.stepId === step.id);
  return (
    <li className={`step ${step.enabled ? '' : 'disabled'} ${status ?? ''}`} aria-label={`Step ${number}`}>
      <div className="step-row">
        <span className="step-number">{number}</span>
        <input type="checkbox" aria-label={`Enable step ${number}`} checked={step.enabled} disabled={locked}
          onChange={event => edit({ kind: 'toggle', stepId: step.id, enabled: event.target.checked })} />
        {editing
          ? (
            <form className="step-label-form" onSubmit={event => {
              event.preventDefault();
              const label = String(new FormData(event.currentTarget).get('label') ?? '').trim();
              if (label && label !== step.label) edit({ kind: 'relabel', stepId: step.id, label });
              setEditing(false);
            }}>
              <input name="label" aria-label={`Label of step ${number}`} defaultValue={step.label} maxLength={500} autoFocus
                onKeyDown={event => { if (event.key === 'Escape') setEditing(false); }} />
            </form>
          )
          : <span className="step-label" title={step.label} onDoubleClick={() => !locked && setEditing(true)}>{step.label}</span>}
        {status && <span className={`step-status ${status}`} aria-label={status}>{STATUS_TEXT[status]}</span>}
      </div>
      <div className="step-actions">
        <button aria-label={`Rename step ${number}`} disabled={locked || editing} onClick={() => setEditing(true)}>✎</button>
        <button aria-label={`Move step ${number} up`} disabled={locked || index === 0} onClick={() => edit({ kind: 'move', stepId: step.id, direction: 'up' })}>↑</button>
        <button aria-label={`Move step ${number} down`} disabled={locked || index === count - 1} onClick={() => edit({ kind: 'move', stepId: step.id, direction: 'down' })}>↓</button>
        <button aria-label={`Delete step ${number}`} disabled={locked || (topLevel && count === 1)} onClick={() => edit({ kind: 'delete-step', stepId: step.id })}>✕</button>
      </div>
      {result && result.status !== 'done' && <p className="step-message">{result.message}</p>}
      {result?.status === 'failed' && ['click', 'download', 'select', 'type'].includes(step.type) && (
        <button className="reteach" disabled={locked} onClick={() => context.reteach(step.id)}>↻ Re-teach this step</button>
      )}
      {result && result.status === 'done' && (step.type === 'loop_pages' || step.type === 'loop_items') && <p className="step-note">{result.message}</p>}
      {step.review && (
        <div className="review" role="note" aria-label={`Review step ${number}`}>
          <p><b>⚠ Healed during a run.</b> {step.review.reason}</p>
          <div>
            <button disabled={locked} onClick={() => edit({ kind: 'accept-review', stepId: step.id })}>Keep new locators</button>
            <button disabled={locked} onClick={() => edit({ kind: 'revert-review', stepId: step.id })}>Undo heal</button>
          </div>
        </div>
      )}
      {step.type === 'loop_pages'
        ? <PageLoop step={step} number={number} {...context} />
        : step.type === 'loop_items' ? <ItemLoop step={step} number={number} {...context} /> : (
          <details>
            <summary>{step.locators.length ? `Locators (${step.locators.length})` : 'Details'}</summary>
            <LocatorInspector step={step} result={result} />
          </details>
        )}
    </li>
  );
}

function Steps({ steps, prefix, label, ...context }: Context & { steps: Step[]; prefix: string; label: string }) {
  const topLevel = prefix === '';
  return (
    <ol className={topLevel ? 'steps' : 'steps nested'} aria-label={label}>
      {steps.map((step, index) => {
        const result = context.run?.results.findLast(item => item.stepId === step.id);
        // `current` tracks the top level only; nested rows show their latest result.
        const status = topLevel && context.run?.current === index && context.run.status !== 'done' ? 'running' : result?.status ?? null;
        return (
          <StepRow key={step.id} step={step} number={`${prefix}${index + 1}`} index={index} count={steps.length}
            topLevel={topLevel} status={status} {...context} />
        );
      })}
    </ol>
  );
}

export function StepList({ workflow, run, preview, act }: { workflow: Workflow; run: RunState | null; preview: ItemPreview | null; act: Act }) {
  const runOfThis = run?.workflowId === workflow.id ? run : null;
  const locked = runOfThis?.status === 'running' || runOfThis?.status === 'paused';
  // Every edit carries the version it was made against; main refuses edits to a stale copy.
  const edit = (change: WorkflowChange) => act(() => bridge().updateWorkflow(workflow.id, workflow.version, change));
  const showItems = (stepId: string, show: boolean) => act(() => bridge().previewItems(workflow.id, stepId, show));
  const shown = preview?.workflowId === workflow.id ? preview : null;
  const reteach = (stepId: string) => act(() => bridge().reteachStep(workflow.id, stepId));
  return <Steps steps={workflow.steps} prefix="" label="Steps" locked={locked} run={runOfThis} edit={edit} preview={shown} showItems={showItems} reteach={reteach} />;
}
