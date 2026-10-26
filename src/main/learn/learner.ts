import type { WebContents } from 'electron';
import type { PaginationPattern } from '../../shared/learn.js';
import type { FrameCommandBridge } from '../engine/locator-resolver.js';
import { UserFacingError } from '../errors.js';
import { choosePagination } from './pagination-detector.js';

// Learns how the list in `contents` paginates. Reads the page; only when nothing else is found does it scroll
// to the bottom once, to find out whether the list loads more on scroll (infinite scroll).
export async function learnPagination(bridge: FrameCommandBridge, contents: WebContents): Promise<PaginationPattern> {
  const report = await bridge.query(contents, [], { kind: 'analyze-pagination' }, 8000);
  if (!report.ok) throw new UserFacingError(`The page could not be analyzed: ${report.message}`);
  let choice = choosePagination(report.value, null);
  if (!choice.ok && !report.value.next?.disabled) {
    const probe = await bridge.query(contents, [], { kind: 'scroll-probe', waitMs: 4000 }, 9000);
    if (probe.ok) choice = choosePagination(report.value, probe.value);
  }
  if (!choice.ok) throw new UserFacingError(choice.reason);
  return choice.pattern;
}
