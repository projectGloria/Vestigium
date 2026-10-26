# Milestone 2 verification

**Definition of done (plan §15):** "I record a click-through on the demo site and get readable workflow JSON that replays it."

Verified on Windows on 23 October 2026 with Node 26.8.1, Electron 45.0.0, Playwright 1.64.1. Milestone 3 functionality (self-healing, smart waits, step-by-step and dry-run modes) is not implemented.

## Actual command output

```text
> vestigium@0.1.0 typecheck
> tsc --noEmit

> vestigium@0.1.0 test
> npm run test:unit && npm run test:demo && npm run test:e2e

> vestigium@0.1.0 test:unit
> node scripts/test-unit.mjs
ℹ tests 36
ℹ pass 36
ℹ fail 0
ℹ duration_ms 902.4816

> vestigium@0.1.0 test:demo
> playwright test --config playwright.config.ts
Running 48 tests using 4 workers
  48 passed (16.7s)

> vestigium@0.1.0 test:e2e
> npm run build && playwright test --config playwright.electron.config.ts
out/main/app.cjs  72.25 kB
out/preload/index.cjs      2.08 kB
out/preload/recorder.cjs  36.25 kB
Running 17 tests using 1 worker
  17 passed (1.4m)
```

The full transcripts are kept locally (ignored by git) as `artifacts/step-2.1-tests.txt` … `artifacts/step-2.6-tests.txt`, one per checkpoint commit.

### Development-mode acceptance (`artifacts/check-dev-m2.mts`)

The script ran the Vite renderer dev server and the built main process with a temporary profile. It used only the visible UI: ● Teach → click "Field Notes 01" → click "Download ZIP" → ■ Stop recording → switch to the light theme → new tab → ▶ Run.

```text
{
  "workflow": {
    "name": "Recording · 127.0.0.1:49435 · 2026-10-23 18:02",
    "steps": [
      "Open http://127.0.0.1:49435/list",
      "Click link \"Field Notes 01\"",
      "Download \"field-notes.zip\" by clicking link \"Download ZIP\""
    ]
  },
  "run": {
    "status": "done",
    "error": null,
    "results": [
      "done: Open http://127.0.0.1:49435/list",
      "done: Click link \"Field Notes 01\" (matched role: link \"Field Notes 01\")",
      "done: Download \"field-notes.zip\" by clicking link \"Download ZIP\" (matched role: link \"Download ZIP\")"
    ]
  },
  "layout": { "display": "grid", "theme": "light", "sidebar": "340px" },
  "consoleErrors": []
}
Development acceptance passed: taught one item download in the UI, replayed it in a fresh tab, no console errors.
```

Screenshots were inspected: `artifacts/milestone-2-dev-recorded.png` (dark, locator table open), `artifacts/milestone-2-dev-replayed-light.png` (light, History tab) and `artifacts/milestone-2-dev-replayed-page.png` (the replayed tab's item page). As in milestone 1, Electron's shell capture does not composite the native browser view, so the browser area appears blank in shell screenshots.

**Side effect.** `electron-vite dev --rendererOnly` also launched one Electron instance on the real `%APPDATA%\Vestigium` profile. It was closed gracefully (the log ends with "Browser session saved." and "Vestigium closed."), so the encrypted session snapshot was written back. Future dev checks must set `VESTIGIUM_USER_DATA` for the dev server too.

## The recorded workflow JSON (excerpt)

This is the click step from the recording above. Export writes the canonical key order shown here (identity, then behavior, then locators), with 2-space indentation.

```json
{
  "id": "s2",
  "type": "click",
  "label": "Click link \"Field Notes 01\"",
  "enabled": true,
  "target": { "tab": "main", "frames": [], "shadowHosts": [] },
  "params": {},
  "waitFor": { "navigation": true },
  "timeoutMs": 15000,
  "onFail": "retry",
  "locators": [
    { "strategy": "role", "value": "link \"Field Notes 01\"", "confidence": 0.9 },
    { "strategy": "text", "value": "a \"Field Notes 01\"", "confidence": 0.75 },
    { "strategy": "css", "value": "#items > article.card:nth-of-type(1) > h3 > a", "confidence": 0.5 },
    { "strategy": "fingerprint", "value": "{\"tag\":\"a\",\"id\":null,\"classes\":[],\"attributes\":{\"href\":\"/item/1\"},...}", "confidence": 0.4 },
    { "strategy": "xpath", "value": "/html[1]/body[1]/div[1]/main[1]/section[1]/article[1]/h3[1]/a[1]", "confidence": 0.3 }
  ]
}
```

## Acceptance evidence

| Plan requirement | Evidence |
| --- | --- |
| Capture clicks, typing, selects, Enter/Tab, scroll, navigation including SPA routes, new tabs/popups, downloads | `tests/electron/recording.spec.ts`: list → item → download; the lab flow (typing+Enter, select, shadow DOM, same- and cross-origin iframes, `pushState` route, container scroll); an auto-downloading popup. `tests/e2e/recorder.spec.ts` (11 tests) covers the recorder core in Chromium. |
| Never record password or payment fields | The lab test types into a password field; neither the value nor the field's label appears in the workflow. Only a content-free notice is logged. |
| Several locators per element (role + name, text, testid, CSS, XPath, DOM fingerprint) | Every element step in the recordings has at least 3 ranked locators. Each one individually re-finds the element on a fresh load (recorder spec). Generated classes and IDs are never used. The demo's `data-item-id` never appears. |
| Iframes and shadow DOM | The frame path and shadow-host chain are recorded and replayed; cross-origin frames work in both recording and replay. |
| Readable, versioned workflow JSON | Strict zod schema with a compile-time equality check against the shared types. Canonical key order, atomic file writes, `schemaVersion: 1`, revision counter. |
| Plain-language summary you can correct | Step labels such as `Type "notes" into "Search notes" and press Enter`. The UI renames workflows, relabels, disables, reorders and deletes steps, and inspects locators (`tests/electron/workflow-ui.spec.ts`). |
| Replay | `tests/electron/replay.spec.ts`: list → item → download, the full lab flow, the popup download and the countdown (disabled button waited for) replay in a fresh tab. Stop works mid-step. |
| Safe failure | A step whose item moved away fails with `…A position-based match was rejected: it is link "Field Notes 09", not the recorded link "Field Notes 10". Waited 15 s.` It never clicks the look-alike. This guard was added after the replay test caught replay doing exactly that. |

## Deviations from the plan's schema

- Each `Step` has a `target: { tab, frames, shadowHosts }`. Tab aliases (`main`, `popup-N`) replace tab IDs, which don't survive replays.
- `scroll` is an additional node type: the plan requires recording scroll but names no node for it.
- A `type` step's `value` may be `null`, meaning "press the key and leave the field as it is".

## Known limits and open issues

- **Replay input is synthetic DOM input,** not OS-level trusted input (milestone 3).
- **No self-healing beyond the ranked fallbacks.** A legitimately renamed element fails the step instead of being matched fuzzily (milestone 3).
- **A recorded cookie-banner click fails on replay** once the banner stays dismissed (automatic banner handling is milestone 3).
- **Not handled yet:** typing into `contenteditable` elements, and multi-select lists, which only record the first selected option.
- **Run history is in memory** (the latest run only). Deleting a single step has no undo.
- **Intermittent shutdown hang (open).** Twice in roughly 60 Electron test runs, an app instance failed to close during test cleanup. Both times the test passed on rerun. Shutdown steps are now isolated, so no single failing step can block quitting, and the shared Electron fixture keeps the app log of any failed test. The cause is not yet identified.
