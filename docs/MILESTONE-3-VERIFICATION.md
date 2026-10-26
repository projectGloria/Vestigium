# Milestone 3 verification

**Definition of done (plan §15):** "Replay survives the random class-rename mode of the demo site."

Verified on Windows on 23 October 2026 with Node 26.8.1, Electron 45.0.0, Playwright 1.64.1. Pagination and list inference (milestones 4–5) are not implemented.

## Actual command output

```text
> vestigium@0.1.0 typecheck
> tsc --noEmit

> vestigium@0.1.0 test
> npm run test:unit && npm run test:demo && npm run test:e2e

> vestigium@0.1.0 test:unit
> node scripts/test-unit.mjs
ℹ tests 37
ℹ pass 37
ℹ fail 0
ℹ duration_ms 1013.2863

> vestigium@0.1.0 test:demo
> playwright test --config playwright.config.ts
Running 52 tests using 4 workers
  52 passed (16.7s)

> vestigium@0.1.0 test:e2e
> npm run build && playwright test --config playwright.electron.config.ts
out/main/app.cjs  83.78 kB
out/preload/index.cjs      2.44 kB
out/preload/recorder.cjs  45.17 kB
Running 23 tests using 1 worker
  23 passed (2.6m)
```

The full transcript is kept locally in `artifacts/m3-tests.txt` (ignored by git).

## Acceptance evidence (real built app, `tests/electron/engine.spec.ts`)

| Requirement | Evidence |
| --- | --- |
| **DoD: survives random class renames** | A workflow is recorded on `/item/1?mutate=classes` and replayed three times in fresh tabs; every render has new random classes. Every run finishes, matching `role: link "Download ZIP"`. The same workflow against `?mutate=all` (classes, wrapper, moved button, reordered content) also finishes. Nothing is flagged for review because the best locator always matched. |
| Self-healing: fallback, then fuzzy match on text and role; update the workflow; flag it for review | With `?mutate=label` (the button becomes "Download ZIP file"), the class-based CSS fallback matches. The step's locators are refreshed and saved as a new revision with `review.reason = "The best recorded locator no longer matched; matched by css instead."`, and the UI shows "⚠ Healed during a run" (screenshot: `artifacts/milestone-3-heal-review.png`). **Keep new locators** clears the flag. With the CSS locator removed, only fuzzy healing finds the button: `Healed. No recorded locator matched; healed to link "Download ZIP file" (recorded as "Download ZIP", N% similar).` **Undo heal** restores the recorded locators. |
| Healing never picks a look-alike | Chromium test: on the shifted "changing" list, item 10's locators with healing enabled still return `not-found`, because numbers in names must match exactly. |
| Smart waits (visible and enabled, DOM stable, network idle) | Chromium test: a button moving for about 600 ms is located at its final position. A mutation test (settling disabled) makes that test fail. A disabled countdown button is polled until enabled (milestone 2 test, still passing). Network idle is awaited before element steps and after navigations. |
| Per-step timeouts, retry with backoff | Unchanged from milestone 2 and still covered: polling with backoff until `timeoutMs`; up to 2 action retries for `onFail: "retry"`. |
| Human-in-the-loop (core) | A countdown workflow whose Continue step has `onFail: "pause"` and a 1 s timeout pauses with `Step 3/3 needs you: … is disabled. Waited 1 s. Fix it in the page, then press Resume to retry this step.`. After the countdown, **▶ Resume** retries the step and the run finishes. |
| Modes: Run, Step-by-step, Dry run, Pause/Resume/Stop | **Dry run** opens the list, finds and highlights the item link without clicking (the tab stays on `/list`), reports the download step as "Not checked…", and nothing is downloaded. **Step mode** pauses before step 1, **⏭ Next step** runs exactly one step, and **▶ Resume** finishes. **❚❚ Pause** mid-run pauses before the next step, and Resume finishes. Stop was covered in milestone 2 and also works while paused. |
| Trusted input | The lab's "Trusted action" button reports "Trusted click received" on replay. Forcing synthetic clicks (mutation) makes the test fail with "Synthetic click received". |
| Sticky overlays and cookie banners covering buttons (plan §11) | Consent is reset before replay. The runner dismisses the banner and logs `Dismissed a cookie banner ("Accept cookies") before "Click button "Trusted action""`. Chromium test: a non-consent overlay is never clicked away; the step reports `The target is covered by <div#blocker>.`. |
| Per-domain rate limiting and random delays | With a 1.2 s host interval, a 3-step run on one host takes ≥ 2.4 s. Invalid settings (min > max) are refused, and settings persist in SQLite. |

## Changed behavior worth knowing

- All main-frame clicks during replay are now real OS-level input. Clicks inside iframes, typing and selecting stay synthetic.
- The demo site gained `mutate=label` (not part of `mutate=all`) and a "Trusted action" button on `/lab`.
- `RunState` gained `mode` and `pauseReason`, and `RunStatus` gained `paused`. `isRunning()` is true while paused, so edits and recording stay blocked during a paused run.

## Known limits

- **Healed steps keep their old label** (e.g. still `…clicking link "Download ZIP"`). Relabel the step if you like.
- **Network idle is best effort** (at most 4 s), and settling is capped at 1.2 s; pages that never go quiet proceed after the cap.
- **Banner handling only recognizes consent containers** by role, id or class and consent wording. Other modals make the step wait and are reported.
- **The run-pacing settings have no UI yet** (bridge only); site profiles and settings UI come in milestone 8.
- **The intermittent shutdown hang from milestone 2 did not occur in this milestone's runs.** It remains unexplained; failed Electron tests keep the app log.
