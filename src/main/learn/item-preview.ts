import type { WebContents } from 'electron';
import type { ItemPattern } from '../../shared/learn.js';
import type { ItemPreview, Workflow } from '../../shared/types.js';
import type { FrameCommandBridge } from '../engine/locator-resolver.js';
import { findStep } from '../engine/steps.js';
import type { TabManager } from '../browser/tabs.js';
import { UserFacingError } from '../errors.js';
import type { Logger } from '../logger.js';

// "Show items": finds an item loop's items on the list and highlights them in the page, so the user can confirm
// the inference and untick items to exclude. Uses the active tab when it shows the list; otherwise it opens the
// page the loop was taught on.

const ANSWER_MS = 3000;
const LOAD_WAIT_MS = 10_000;

export class ItemPreviewer {
  private current: (ItemPreview & { contents: WebContents; pattern: ItemPattern }) | null = null;

  constructor(private tabs: TabManager, private bridge: FrameCommandBridge, private log: Logger) {}

  state(): ItemPreview | null {
    if (!this.current) return null;
    const { contents: _contents, pattern: _pattern, ...preview } = this.current;
    return preview;
  }

  async show(workflow: Workflow, stepId: string) {
    const step = findStep(workflow.steps, stepId)?.step;
    if (step?.type !== 'loop_items') throw new UserFacingError('That step is not an item loop.');
    const { pattern, exclude, listUrl } = step.params;
    const contents = this.tabs.active();
    let found = await this.find(contents, pattern, exclude, 0);
    if (!found || found.items.length === 0) {
      // Not on the list (or not loaded yet): open the page the loop was taught on.
      try {
        await contents.loadURL(listUrl);
      } catch {
        throw new UserFacingError(`The list page could not be opened: ${listUrl}`);
      }
      found = await this.find(contents, pattern, exclude, LOAD_WAIT_MS);
    }
    if (!found || found.items.length === 0) throw new UserFacingError(`No items were found on this page. ${pattern.description}`);
    this.current = { workflowId: workflow.id, stepId, pageUrl: contents.getURL(), items: found.items, loose: found.loose, contents, pattern };
    this.log.write('info', `Found ${found.items.length} items on the list; ${found.highlighted} are highlighted on the page.`
      + (found.loose ? ' They were found by a looser match (the item links moved).' : ''));
  }

  // After an exclusion changed: redraw the highlight (excluded items are marked) without changing the item list.
  async refresh(workflow: Workflow) {
    const current = this.current;
    if (!current || current.workflowId !== workflow.id || current.contents.isDestroyed()) return;
    const step = findStep(workflow.steps, current.stepId)?.step;
    if (step?.type !== 'loop_items') return this.hide();
    await this.find(current.contents, current.pattern, step.params.exclude, ANSWER_MS);
  }

  async hide() {
    const current = this.current;
    this.current = null;
    if (current && !current.contents.isDestroyed()) {
      await this.bridge.query(current.contents, [], { kind: 'find-items', pattern: current.pattern, highlight: false, exclude: [] }, ANSWER_MS);
    }
  }

  // Forget the preview when what it shows no longer applies (another workflow, a run, an edit elsewhere).
  forget(workflowId?: string) {
    if (!workflowId || this.current?.workflowId !== workflowId) void this.hide();
  }

  private async find(contents: WebContents, pattern: ItemPattern, exclude: string[], limitMs: number) {
    const end = Date.now() + limitMs;
    for (;;) {
      const answer = await this.bridge.query(contents, [], { kind: 'find-items', pattern, highlight: true, exclude }, ANSWER_MS);
      if (answer.ok && answer.value.items.length > 0) return answer.value;
      if (Date.now() >= end) return answer.ok ? answer.value : null;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}
