import { randomUUID } from 'node:crypto';
import type { Locator, Step, Workflow, WorkflowSummary } from '../../shared/types.js';
import type { DocumentRepository } from '../store/repositories.js';
import type { CompileResult } from '../learn/step-compiler.js';
import { UserFacingError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { WorkflowChange } from '../../shared/ipc.js';
import { addPageLoop, applyChange } from './workflow-edit.js';
import type { PaginationPattern } from '../../shared/learn.js';
import { findStep } from './steps.js';
import { WorkflowFormatError, readWorkflowFile, writeWorkflowFile } from './workflow-json.js';

// Saved workflows plus the one selected in the UI. Summaries are cached because AppState is rebuilt on every
// change (including each log line), and re-validating every stored workflow each time would be wasteful.
export class WorkflowLibrary {
  private summaries: WorkflowSummary[] = [];
  // The selected workflow is kept parsed for the same reason.
  private current: Workflow | null = null;

  constructor(private repository: DocumentRepository<Workflow>, private log: Logger) {
    this.refresh();
  }

  list(): WorkflowSummary[] {
    return this.summaries;
  }

  selected(): Workflow | null {
    return this.current;
  }

  select(id: string) {
    this.current = this.load(id);
  }

  update(id: string, version: number, change: WorkflowChange): Workflow {
    const workflow = this.load(id);
    if (workflow.version !== version) throw new UserFacingError('This workflow changed since it was displayed. Try the edit again.');
    const next = applyChange(workflow, change);
    this.save(next, 'That change would break the workflow');
    if (this.current?.id === id) this.current = next;
    return next;
  }

  addPageLoop(id: string, version: number, pagination: PaginationPattern): Workflow {
    const workflow = this.load(id);
    if (workflow.version !== version) throw new UserFacingError('This workflow changed since it was displayed. Try again.');
    const next = addPageLoop(workflow, pagination);
    this.save(next, 'The page loop could not be added');
    if (this.current?.id === id) this.current = next;
    return next;
  }

  // Saves locators a run had to heal and flags the step for review. Not version-checked: it comes from the
  // runner, not from a possibly stale UI copy. Repeated heals keep the *original* locators for undo.
  heal(id: string, stepId: string, locators: Locator[], reason: string) {
    const workflow = this.load(id);
    const next = structuredClone(workflow);
    const step = findStep(next.steps, stepId)?.step;
    if (!step) return;
    step.review = { reason, at: new Date().toISOString(), previous: step.review?.previous ?? step.locators };
    step.locators = locators;
    next.version = workflow.version + 1;
    this.save(next, 'The healed locators could not be saved');
    if (this.current?.id === id) this.current = next;
  }

  // Ties a workflow to the site profile learned from it (plan §10's Workflow.siteProfileId).
  link(id: string, siteProfileId: string) {
    const workflow = this.load(id);
    if (workflow.siteProfileId === siteProfileId) return;
    const next = { ...workflow, siteProfileId, version: workflow.version + 1 };
    this.save(next, 'The site profile could not be linked');
    if (this.current?.id === id) this.current = next;
  }

  // "Re-teach this step" (plan §2): a short recording of the right element replaces only that step's locators and
  // frame path. Its type, tab, waits and the rest of the workflow stay as they were; a pending review is cleared.
  reteach(id: string, stepId: string, taught: Step): Workflow {
    const workflow = this.load(id);
    const next = structuredClone(workflow);
    const step = findStep(next.steps, stepId)?.step;
    if (!step) throw new UserFacingError('That step no longer exists.');
    step.locators = taught.locators;
    step.target = { ...step.target, frames: taught.target.frames, shadowHosts: taught.target.shadowHosts };
    delete step.review;
    next.version = workflow.version + 1;
    this.save(next, 'The re-taught step could not be saved');
    if (this.current?.id === id) this.current = next;
    return next;
  }

  remove(id: string) {
    if (!this.repository.delete(id)) throw new UserFacingError('That workflow no longer exists.');
    if (this.current?.id === id) this.current = null;
    this.refresh();
  }

  async exportTo(id: string, path: string) {
    await writeWorkflowFile(path, this.load(id));
  }

  // Imported files always get a fresh ID, so importing can never overwrite an existing workflow.
  async importFrom(path: string): Promise<Workflow> {
    let workflow: Workflow;
    try {
      workflow = await readWorkflowFile(path);
    } catch (error) {
      if (error instanceof WorkflowFormatError) throw new UserFacingError(error.message);
      throw new UserFacingError('The file could not be read.');
    }
    const imported = { ...workflow, id: randomUUID() };
    this.save(imported, 'The file could not be imported');
    this.current = imported;
    return imported;
  }

  // Turns a finished recording into a saved, selected workflow.
  createFromRecording(result: CompileResult & { startUrl: string | null }, now = new Date()): Workflow {
    if (result.steps.length === 0) {
      throw new UserFacingError('Nothing was recorded. Start recording, then click, type or download on the page.');
    }
    const firstUrl = result.startUrl ?? result.steps.find(step => step.type === 'navigate')?.params.url ?? null;
    const host = firstUrl ? new URL(firstUrl).host : 'page';
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const workflow: Workflow = {
      schemaVersion: 1, id: randomUUID(), name: `Recording · ${host} · ${stamp}`, siteProfileId: null,
      steps: result.steps, variables: {}, createdAt: now.toISOString(), version: 1,
    };
    this.repository.save(workflow);
    this.refresh();
    this.current = workflow;
    return workflow;
  }

  private load(id: string): Workflow {
    let workflow: Workflow | null;
    try {
      workflow = this.repository.get(id);
    } catch {
      throw new UserFacingError('That workflow is damaged and cannot be opened. See the log for details.');
    }
    if (!workflow) throw new UserFacingError('That workflow no longer exists.');
    return workflow;
  }

  // Schema violations (e.g. a popup step moved before the step that opens it) become readable refusals.
  private save(workflow: Workflow, refusal: string) {
    try {
      this.repository.save(workflow);
    } catch (error) {
      if (error instanceof WorkflowFormatError) throw new UserFacingError(`${refusal}: ${error.message.replace(/^Workflow is invalid: /, '')}`);
      throw error;
    }
    this.refresh();
  }

  private refresh() {
    const summaries: WorkflowSummary[] = [];
    for (const id of this.repository.ids()) {
      try {
        const workflow = this.repository.get(id);
        if (workflow) summaries.push({ id, name: workflow.name, steps: workflow.steps.length, createdAt: workflow.createdAt });
      } catch (error) {
        this.log.write('error', `Workflow ${id} could not be loaded: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    // Newest first: the workflow just recorded is at the top.
    this.summaries = summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

const pad = (value: number) => String(value).padStart(2, '0');
