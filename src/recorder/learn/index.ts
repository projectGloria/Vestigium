import type { QueryResults, RecorderQuery } from '../../shared/learn.js';
import { resolveTarget } from '../resolve.js';
import { contentLinks, signature } from './content.js';
import { analyzePagination, looksDisabled } from './pagination.js';
import { findItems } from './items.js';
import { extractMetadata } from './metadata.js';
import { findObstacles } from './obstacles.js';

// Read-only page analysis for learning and loops. Never clicks; the scroll probe only scrolls.
export async function answerQuery(document: Document, query: RecorderQuery): Promise<QueryResults[RecorderQuery['kind']]> {
  switch (query.kind) {
    case 'analyze-pagination':
      return analyzePagination(document);
    case 'signature':
      return signature(document);
    case 'control-state': {
      // Exact recorded locators only (no healing): a pagination control that cannot be found is the end of the list.
      const resolution = resolveTarget(document, { locators: query.locators, shadowHosts: query.shadowHosts, includeDisabled: true });
      if (!resolution.ok) return { state: 'missing' };
      return { state: looksDisabled(resolution.found.element) ? 'disabled' : 'enabled' };
    }
    case 'find-items':
      return findItems(document, query.pattern, query.highlight, query.exclude);
    case 'extract-metadata':
      return extractMetadata(document, query.labels);
    case 'obstacles':
      return findObstacles(document);
    case 'scroll-probe': {
      const before = contentLinks(document).length;
      const view = document.defaultView!;
      const root = document.scrollingElement ?? document.documentElement;
      view.scrollTo(0, root.scrollHeight);
      // Lists that load on scroll usually react within a second; poll so a fast list returns early.
      const end = Date.now() + query.waitMs;
      let after = before;
      while (Date.now() < end) {
        await new Promise(resolve => view.setTimeout(resolve, 150));
        after = contentLinks(document).length;
        if (after > before) break;
      }
      return { before, after };
    }
  }
}
