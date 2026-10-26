# Milestone 4 verification

**Definition of done (plan §15):** "Paginated, load-more and infinite-scroll lists are crawled fully and stop correctly."

Verified on Windows on 23 October 2026 with Node 26.8.1, Electron 45.0.0, Playwright 1.64.1. Item inference (milestone 5) and downloads (milestone 6) are not implemented, so a page loop repeats the *recorded* steps on every page; it does not yet open each item.

## Actual command output

```text
> vestigium@0.1.0 typecheck
> tsc --noEmit

> vestigium@0.1.0 test
> npm run test:unit && npm run test:demo && npm run test:e2e

> vestigium@0.1.0 test:unit
> node scripts/test-unit.mjs
ℹ tests 43
ℹ pass 43
ℹ fail 0
ℹ duration_ms 1002.4865

> vestigium@0.1.0 test:demo
> playwright test --config playwright.config.ts
Running 55 tests using 4 workers
  55 passed (17.1s)

> vestigium@0.1.0 test:e2e
> npm run build && playwright test --config playwright.electron.config.ts
out/main/app.cjs  97.34 kB
out/preload/index.cjs      2.58 kB
out/preload/recorder.cjs  51.58 kB
Running 29 tests using 1 worker
  ok 13 tests\electron\pagination.spec.ts:46:3 › numbered pages (cards): the Next link is followed to the last page (7.5s)
  ok 14 tests\electron\pagination.spec.ts:46:3 › numbered pages (table): the Next link is followed to the last page (7.3s)
  ok 15 tests\electron\pagination.spec.ts:61:1 › load more and infinite scroll grow one list until nothing new arrives (15.5s)
  ok 16 tests\electron\pagination.spec.ts:77:1 › an SPA list (content changes, URL does not) and a list whose last page wraps back to page 1 (11.1s)
  ok 17 tests\electron\pagination.spec.ts:94:1 › the page limit, duplicates, a URL pattern and a dry run all stop where they should (13.0s)
  ok 18 tests\electron\pagination.spec.ts:131:1 › learning refuses a page without pagination; on the last page it falls back to the URL pattern; the UI button works (8.7s)
  29 passed (3.6m)
```

The full transcript is kept locally in `artifacts/m4-tests.txt` (ignored by git).

## Acceptance evidence (real built app, `tests/electron/pagination.spec.ts`)

Each test records a short workflow on the demo list (open the page, scroll once), learns the pagination from the active tab, and runs the result. The loop step's own result message is asserted verbatim.

| List | Learned pattern | Run result |
| --- | --- | --- |
| Numbered pages, cards and table layout | `next`: the link "Next →" (rel=next) | `Visited 5 pages (47 content links). Stopped because the next control is missing.` The recorded scroll ran once on each of pages 1–5. |
| Load more | `load-more`: the button "Load more" | `Visited 5 pages (47 content links). Stopped because the "load more" control is disabled.` |
| Infinite scroll | `infinite-scroll` (only after a probe proved scrolling loads more) | `Visited 5 pages (47 content links). Stopped because scrolling to the bottom loaded nothing new.` |
| SPA (Next swaps content via fetch, URL never changes) | `next`: the button "Next ›" | `Visited 5 pages (47 content links). Stopped because the next control is disabled.` The tab URL is still `/list?mode=spa`. |
| Last page links back to page 1 (`wrap=1`) | `next` | `Visited 6 pages (47 content links). Stopped because page 6 repeats an earlier page.` |
| Duplicates across pages | `next` | 47 distinct links over 5 pages; items 9 and 10 that reappear on page 2 are counted once. |
| Page limit 2, set in the step list UI | — | `Visited 2 pages (18 content links). Stopped because reached the limit of 2 pages.` |
| Dry run | — | `Visited 1 page (10 content links). Stopped because dry run: would continue with Next page: …`; nothing is clicked. |
| URL pattern `/list?page={{page}}` (imported workflow) | `url` | `Visited 6 pages (47 content links). Stopped because page 6 brought no new links.` |
| An item page (no pagination) | refused | `No pagination found on this page: no next link or button, no numbered pages, no "Load more" button, and scrolling to the bottom loaded nothing new.` |
| Learning on the last page (`page=5`) | `url` | The Next control is disabled, but the numbered links still reveal `/list?page={{page}}`. |
| UI | — | **↻ Repeat on every page** wraps the steps after the opening navigation into a loop, shows the pattern's description, and disappears once the workflow has a loop. |

Chromium tests (`tests/e2e/learn.spec.ts`) cover the page-side analysis: `rel=next` beats text matches, numbered links are listed, the last page reports a disabled Next control, load-more/infinite/SPA lists are recognised, and content signatures change with the content but ignore site chrome. Unit tests (`tests/app-unit/pagination-detector.test.ts`, `workflow-edit.test.ts`) cover the pure pattern choice, URL-template derivation, readable refusals, the recursive schema and loop edits.

## Changed behavior worth knowing

- The workflow schema gained `loop_pages` with a nested `steps` list. Step IDs are unique across all levels, and a page loop cannot contain another page loop.
- `RunState.progress` shows "Page N: X new links (Y in total)" in the status bar while a loop runs.
- The demo site gained `mode=spa` and `wrap=1`. The infinite-scroll list now really hides its "Load more" button (its CSS had overridden the `hidden` attribute).
- Dry runs whose step is a window scroll no longer fail with "nothing to find".

## Known limits

- **One loop per workflow, not nested,** and learning always wraps everything after the first navigation. Moving steps in or out of the loop isn't possible yet; delete steps instead.
- **The pagination pattern can't be edited in the UI** (only its page limit). Re-learn it, or edit the exported JSON and import it.
- **Infinite scroll is probed on the window only**, not inside scrollable containers.
- **"New content" means new links inside the main content area.** A list whose items aren't links stops after the first page that adds none. Milestone 5's item inference is the place to improve this.
- **The intermittent shutdown hang from milestone 2 did not occur in this milestone's runs.** It remains unexplained; failed Electron tests keep the app log.
