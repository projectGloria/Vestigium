# Milestone 5 verification

**Definition of done (plan §15):** "After teaching one item, all items on the list are found and highlighted correctly."

Verified on Windows on 23 October 2026 with Node 26.8.1, Electron 45.0.0, Playwright 1.64.1. Downloads are still cancelled by `will-download` (the download manager is milestone 6), so a "download" result means the download was requested by the item page and seen by main, not that a file was written.

## Actual command output

```text
> vestigium@0.1.0 typecheck
> tsc --noEmit

> vestigium@0.1.0 test
> npm run test:unit && npm run test:demo && npm run test:e2e

> vestigium@0.1.0 test:unit
> node scripts/test-unit.mjs
ℹ tests 50
ℹ pass 50
ℹ fail 0
ℹ duration_ms 1075.4396

> vestigium@0.1.0 test:demo
> playwright test --config playwright.config.ts
Running 59 tests using 4 workers
  ok  3 tests\e2e\items.spec.ts:91:1 › class renames and wrappers do not break the pattern; excluded items are reported and marked (880ms)
  ok  1 tests\e2e\items.spec.ts:37:1 › a click on one card learns the card pattern: all 10 cards, which one was opened, and the pagination (1.1s)
  ok  4 tests\e2e\items.spec.ts:114:1 › clicks that are not items carry no list: chrome links, pagination, a lone button, the decoy sidebar (1.1s)
  ok  2 tests\e2e\items.spec.ts:67:1 › a table row, a later page, load more and an SPA list all reuse the same pattern (1.3s)
  59 passed (18.8s)

> vestigium@0.1.0 test:e2e
> npm run build && playwright test --config playwright.electron.config.ts
out/main/app.cjs  112.97 kB
out/preload/index.cjs      2.74 kB
out/preload/recorder.cjs  57.69 kB
Running 33 tests using 1 worker
  ok 10 tests\electron\engine.spec.ts:145:1 › dry run highlights targets without acting; step mode pauses before each step; pause and resume work (10.9s)
  ok 13 tests\electron\items.spec.ts:48:1 › teach one item, press Run: all 47 items on all 5 pages are opened and downloaded, then the run stops by itself (37.9s)
  ok 14 tests\electron\items.spec.ts:89:1 › show the items on the page, exclude one, dry-run, then run two pages of a list with duplicates (17.2s)
  ok 15 tests\electron\items.spec.ts:132:1 › one broken item is reported and skipped; the item limit ends the whole crawl (16.2s)
  ok 16 tests\electron\items.spec.ts:172:1 › a crawl keeps working while the window is minimized: clicks fall back to in-page input (13.2s)
  33 passed (5.2m)
```

The full transcript is kept locally in `artifacts/m5-tests.txt` (ignored by git).

## Acceptance evidence (real built app, `tests/electron/items.spec.ts`)

Each test teaches exactly one item: it opens a demo list, presses Teach, clicks one item, clicks "Download ZIP" on the item page, and stops. Nothing is edited by hand unless the row says so.

| Scenario | What was learned | Run result |
| --- | --- | --- |
| Cards list, item 3 taught | `navigate` → `loop_pages` (next: "Next →", rel=next) → `loop_items` (pattern `main > section > article`, link `h3 > a`) → download in the `item` tab. Log: `Found 10 items on the list (you opened number 3).` | 5 pages, `Opened 10 items.` ×4 then `Opened 7 items.`; 47 download results, first `Page 1 › Item 1/10 › …`, last `Page 5 › Item 7/7 › …`; `Download started: field-notes.zip` logged 47 times; 37.9 s. The item tab is closed afterwards and the list (`/list?page=5`) is the visible tab. |
| Summary (plan §1) | — | Shown in the Workflow panel: `Page type: LIST. Each item is a card (<article> in <section>), opened through its link (h3 > a).` / `Open each item → Download "field-notes.zip" by clicking link "Download ZIP" (file type ZIP).` / `Next page: the link "Next →" (rel=next, text "Next →").` |
| **Show items** while the active tab is on an item page | — | The list is opened again, all 10 cards are found and highlighted with numbered boxes (`items-highlighted.png`); log `Found 10 items on the list; 10 are highlighted on the page.` |
| Untick item 2 in the UI | `exclude: ["…/item/2"]` stored as a versioned edit | Hint `9 of 10 items on this page will be opened.`; summary `1 item is excluded.`; the box on the page turns dashed red. |
| Dry run | — | `Found 10 items, 9 to open (1 excluded by you); highlighted, not opened (dry run). First: "…".` No downloads. |
| Duplicates list, page limit 2 | — | `Opened 9 items (1 excluded by you).`, `Opened 8 items (2 already done earlier in this run).`; 17 downloads; `Visited 2 pages (18 content links). Stopped because reached the limit of 2 pages.` |
| Broken item 3 (`/list?broken=3`), download timeout set to 3 s by importing an edited export | — | Two failed records: the step (`… Waited 3 s.`) and the item (`Page 1 › Item 3/10 › <title> · Repeat for every item`). Loop: `Opened 9 items; 1 failed ("…": …)`. 9 downloads; the other items ran. |
| Item limit 2, set in the UI | `maxItems: 2` | `Opened 2 items; stopped at the limit of 2 items.` and the page loop: `Visited 1 page (10 content links). Stopped because the item limit was reached.` |
| Window minimized during a 2-page crawl (limit 12 items) | — | `Opened 10 items.`, `Opened 2 items; stopped at the limit of 12 items.`; 12 downloads; log: `The Vestigium window is minimized, so clicks are performed inside the page instead of with real mouse input. …` |

Updated older Electron specs show the same generalization from their recordings: `recording.spec.ts` (list → item → download becomes `Open …/list`, `Repeat on every page` › `Repeat for every item` › the download in the `item` tab), `workflow-ui.spec.ts` (steps 2 / 2.1 / 2.1.1 edited and run entirely from the UI; History shows `Page 1 › Item 2/10 › Download the field note · matched role: link "Download ZIP"`) and `replay.spec.ts`.

### Highlighting in plain Chromium (`tests/e2e/items.spec.ts`)

The production recorder core is injected into demo pages with a stub transport. One recorded click on one item must yield a pattern that, matched again by `find-items`, returns exactly the expected items (asserted against `tests/demo-site/fixtures.ts`, which reads `data-item-id` for the assertion only; the inference never sees it):

- Cards and table layouts, a later page, a load-more list after growing, and the SPA list all reuse the same pattern.
- Class renames and extra wrapper elements break the strict path; the loose fallback still finds every item and says so (`loose: true`).
- Clicks on the Next link, a sidebar "popular posts" card (identical markup, inside `<aside>`) and a plain button carry no list context.
- `cards-highlighted.png`: numbered boxes on the 10 main cards; the decoy sidebar cards are untouched. Checked by eye.

### Unit tests (`tests/app-unit/generalize.test.ts`, `workflow-schema.test.ts`, `workflow-edit.test.ts`)

Generalization is a pure function, tested on compiled step lists:
- The item click becomes `loop_items`, wrapped in `loop_pages` when the list had usable pagination; without it the item loop stands alone and the note says why.
- An item opened in a new tab: that tab becomes `item`; popups opened from it stay popups.
- Steps before the click run once. Steps after leaving the item by address are left out with a note.
- Nothing is generalized for a click without a list context, a click that opened nothing, or a click inside a frame.

The schema test rejects class-bearing or uppercase patterns, unknown pattern keys, non-http(s) `listUrl`/`exclude`, `maxItems: 0`, the `item` alias outside the loop, an item loop not reading from `main`, and a nested item loop. The edit test covers exclude/include, the item cap, and wrapping a page loop around an item loop.

## Changed behavior worth knowing

- **Stop recording now generalizes automatically.** A recording that opens an item from a recognized list is saved as page loop › item loop › body. Recordings without such a click are saved exactly as before.
- New tab alias `item`, valid only inside an item loop. New edits: `exclude-item`, `set-max-items`. New IPC command: `workflowPreviewItems`.
- `AppState.itemPreview` holds the items currently shown in the panel.
- The demo site gained `broken=N` on `/list`.
- `engine.spec.ts`'s run-mode test (milestone 3) recorded list → item → download, which now generalizes. It now records list → Next → Next, a flat three-step workflow, so it still tests dry run, step mode and pause on plain steps. The first full run before that change failed only this test.
- **Minimized window (bug found by this milestone's full-suite run).** The second full run failed once: on page 2 of a crawl every item "clicked" but no download started, and each one waited out the 60 s timeout. Root cause: Chromium keeps a tab created while the window is minimized at a 0×0 viewport until the window is restored, so OS-level clicks hit no element. Page 2 creates a fresh item tab, and the window had been minimized meanwhile. Probed directly: `getContentSize()` is `[0, 0]`, the new tab's `innerWidth/innerHeight` are `0, 0`, trusted `mousedown`/`click` events arrive, but no download starts; after `restore()` the same click downloads. Fix: while the window is minimized or hidden, the runner clicks in-page (the iframe path) and logs that once per run. `TabManager.layout()` also no longer shrinks views to 1×1 from a 0×0 size and lays out again on restore. Regression test: `items.spec.ts` "a crawl keeps working while the window is minimized" (it failed with the 60 s timeouts before the fallback).
- Fixed a milestone 4 cosmetic bug: a page loop's dry-run message ended in `..` because the pagination description already ends with a period.

## Known limits

- **Lists inside iframes are not recognized**; inference runs in the top frame only.
- **Items must be links that open a page.** Cards that open a dialog, and list entries that are themselves download links, are not item loops yet (download detection is milestone 6).
- **Only the steps up to the next address-bar navigation** form the item body; anything recorded after that is left out with a note in the log.
- **Infinite-scroll lists** are not wrapped in a page loop automatically (learning does not probe scrolling at Stop); press **↻ Repeat on every page** afterwards.
- **In-page clicks while minimized lack user activation.** A site that only accepts real input (or opens popups only on a real gesture) may ignore them; the log says to restore the window.
- **Exclusions are by URL.** A site that changes item URLs between visits will bring an excluded item back.
