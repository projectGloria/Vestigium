# Milestone 8 verification

**Definition of done (plan §15):** "The countdown scenario pauses for me, then continues automatically."

Verified on Windows on 23 October 2026 with Node 26.8.1, Electron 45.0.0, Playwright 1.64.1.

## Actual command output

```text
> vestigium@0.1.0 typecheck
> tsc --noEmit

> vestigium@0.1.0 test
> npm run test:unit && npm run test:demo && npm run test:e2e

> vestigium@0.1.0 test:unit
> node scripts/test-unit.mjs
ℹ tests 74
ℹ pass 74
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 3798.1365

> vestigium@0.1.0 test:demo
> playwright test --config playwright.config.ts
  ok 17 tests\e2e\obstacles.spec.ts:29:1 › a countdown, a captcha and a login form are recognized; an ordinary item page has none (6.1s)
  ok 18 tests\e2e\obstacles.spec.ts:49:1 › clicking a captcha widget while recording records no click, only that a captcha was solved (555ms)
  65 passed (20.6s)

> vestigium@0.1.0 test:e2e
> npm run build && playwright test --config playwright.electron.config.ts
out/main/app.cjs  217.44 kB
out/preload/index.cjs      4.20 kB
out/preload/recorder.cjs  62.97 kB
Running 45 tests using 1 worker
  ok 16 tests\electron\human.spec.ts:34:1 › the countdown pauses the run for you, then it continues by itself once the button is ready (15.2s)
  ok 17 tests\electron\human.spec.ts:66:1 › a captcha is never clicked by Vestigium: the run waits until you solve it, then continues (8.8s)
  ok 18 tests\electron\human.spec.ts:96:1 › a login that expired before the run: it waits for you to sign in, then continues and downloads (4.8s)
  ok 31 tests\electron\profiles.spec.ts:27:1 › teach a site once; later a list URL and Start are enough, and the profile records how it went (7.5s)
  ok 32 tests\electron\profiles.spec.ts:65:1 › a broken step: the run fails with a screenshot; "Re-teach this step" records only that step and the next run works (11.4s)
  ok 33 tests\electron\profiles.spec.ts:123:1 › plan §7 safety: a click that reads like deleting waits for your OK; a site outside the allowlist too (4.9s)
  ok 34 tests\electron\profiles.spec.ts:153:1 › a link on the clipboard is offered once; minimizing while downloading hides Vestigium to the tray (14.4s)
  45 passed (7.0m)
```

This run was made on the working tree, which already held the start of milestone 9's command line (`src/main/cli/`, a CLI branch in `app.ts`). That code is inactive unless the app gets CLI arguments. The milestone 8 commit leaves it out, and it was checked to typecheck on its own.

The full transcript is kept locally in `artifacts/m8-tests.txt` (ignored by git).

## Acceptance evidence (real built app)

### `tests/electron/human.spec.ts`: plan §4, human-in-the-loop

| Scenario | What happens | Result |
| --- | --- | --- |
| **Countdown (definition of done)** | Taught normally on `/item/1?variant=countdown` (the host disables "Continue" for 5 s), with nothing set up by hand (`onFail` stays "retry"). Replayed in a fresh tab. | After about 2.5 s the run pauses with `waitingFor: 'countdown'` and `Needs you: The page says "Wait 3 seconds"; "Download "field-notes.zip" by clicking button "Continue"" waits until it is ready. The run continues by itself once that is done.` The reason shows as an alert, and the countdown page is the visible tab. **Nobody presses Resume:** the run continues by itself (`Continuing: the page is ready again (countdown).`), all 3 steps are done, and the queue finishes the download. Screenshot: `needs-you-countdown.png`. |
| **Captcha** | Teach clicks "I'm not a robot". | The log says `You solved a captcha; it is not recorded.`, and the workflow has no captcha step. The run pauses with `Needs you: Solve a captcha (I'm not a robot) in the page. …` and is still waiting 3 s later. Once the "person" (the test, with trusted input) checks the box, the run continues by itself and is done. |
| **Login expired** | Signed in before teaching, then the session cookies are cleared. | Opening the item lands on the login form, and the run pauses with `Needs you: The site wants you to sign in. Sign in in the page. …`. After signing in there, the site returns to the item, the run continues by itself, and the queue downloads with the new session. |

### `tests/electron/profiles.spec.ts`: profiles, re-teach, history, safety, tray

- **Site profile and Start:**
  - **After teaching:** the log says `Saved a site profile for 127.0.0.1:…: next time, open a 127.0.0.1:… list and press Start; no teaching needed.`, and the workflow is linked.
  - **After a restart:** the profile card shows "not run yet". Opening `/list?dataset=duplicates` and pressing toolbar **▶ Start** gives `Open …/list?dataset=duplicates`, then `Opened 3 items; stopped at the limit of 3 items.`, and 3 downloads.
  - **Afterwards:** the profile shows "Working" and "last worked …", and the History has the run.
- **Broken step, then re-teach:** the download step's locators are replaced by `#gone-for-good` (imported).
  - **The failing run:** it fails, and `RunState.failure` names the step and `…/item/1`. The failed result has a `<uuid>.png` screenshot.
  - **After a restart:** History still lists the run, its failure and the same screenshot.
  - **Re-teaching:** **↻ Re-teach this step** in the step list opens the failing page and starts a recording. One click on "Download ZIP" plus **Stop recording** logs `Re-taught "…": it now finds role: link "Download ZIP".`
  - **What changed:** the same workflow ID and step IDs; only that step's locators (its 2 s timeout is untouched).
  - **The next run** is done.
- **Safety:**
  - **Risky click:** a recorded click on "Delete this note" (`/confirm`) pauses with `waitingFor: 'confirm'` and `Needs you: "Click button "Delete this note"" looks like buying, paying or deleting something. …`. Nothing is clicked until Resume, and then the page shows "Deleted (demo only).".
  - **Allowlist:** with the allowlist set to `example.com`, the next run pauses with `waitingFor: 'site'` ("This run wants to use 127.0.0.1:…, which is not on your list of allowed sites") and asks once.
- **Clipboard and tray:**
  - **Clipboard:** a link in the (stubbed) clipboard is offered as "Open copied link" in the tab strip when the window gets focus. One click opens it, and the same link is not offered again.
  - **Tray:** with "Minimizing while working hides Vestigium in the tray" on, minimizing during a throttled download hides the window. The log says "Vestigium keeps working in the tray.", and the download finishes while hidden.

### Page-side and unit tests

- **`tests/e2e/obstacles.spec.ts` (Chromium, production recorder core):**
  - Countdown text is found while counting and is gone once ready.
  - The captcha is found, and is gone after a person's click.
  - The login form is found; an ordinary item page has no obstacles.
  - While recording, a captcha click emits only `captcha` and the following "Continue" click is recorded normally.
- **`tests/app-unit/profiles.test.ts`:**
  - **Learning:** a generalized recording becomes the profile of `shop.test:8080`; a workflow without an item loop does not.
  - **Planning a Start:** sets the new URL in the opening step and in `listUrl` of a copy, leaving the stored workflow untouched. An unknown site gets "No site profile … Teach it once".
  - **Re-teaching a site** replaces its profile.
  - **Grading:** ok, then degraded (a heal), broken (with step and label), unchanged by stopped and dry runs, then ok again.
  - **History:** keeps counts, the first failure and screenshots, newest first.
  - **The tray icon** is a valid 32×32 RGBA PNG, and the allowlist accepts site names only.

## Changed behavior worth knowing

- **Waits for a person are now automatic.** A run no longer just times out on a countdown, a captcha or a login wall: it pauses, says why, and continues by itself.
- **New pauses:**
  - **Risky clicks:** clicks that read like buying, paying or deleting wait for your OK (setting `safety.confirmRisky`, on by default).
  - **The allowlist** (`safety.allowlist`, empty by default) makes runs ask before using other sites.
- **New state and settings:**
  - `RunState.waitingFor` and `RunState.failure`; `StepRunResult.screenshot`.
  - AppState gains `profiles`, `history`, `clipboardUrl` and `reteach`.
  - Settings gain `safety` and `tray`.
- **New IPC:** `profileStart`, `profileDelete`, `workflowReteach`, `screenshotOpen`, `clipboardDismiss`, `safetySettings`, `traySettings`.
- **Storage:** `run_log` now stores `RunRecord`s, and site profiles are validated.
- **Demo site:** a captcha host page, `variant=captcha`, and `/confirm`.
- **"Done" now means finished (a fix to milestone 7).** A job stays `verifying` while its archive is unpacked and its sidecar written, and only then becomes `done`. Before, it showed Done as soon as the file was placed, and a full-suite run read an empty sidecar. The final path is saved before that step, so after a crash startup completes the job instead of downloading it again.
- **Expectation updates in older tests:**
  - The milestone 3 countdown replay now waits for `done` through the automatic "Needs you" pause, and checks the "Continuing" log line.
  - The workflow UI test's revision numbers moved by one: the taught workflow is linked to its new site profile in the same Stop recording.
- **The History panel keys results by position:** loop results repeat a step ID, which gave React duplicate keys.
- **Test harness finding:** the first version of the clipboard test wrote a URL to the real Windows clipboard of the machine running the tests (once, on 23 October 2026), and later launches offered it. Test launches now stub the app's clipboard read (`globalThis.__testClipboard`), and no test touches the real clipboard.
- **Layout finding:** the copied-link chip first lived in the toolbar and overlapped **● Teach** at the default width; the clipboard test caught it. It now sits in the tab strip.

## Known limits

- **Obstacle detection is generic** (captcha widgets and frames, a visible password form, "N seconds" text). A site-specific challenge that looks like none of these times out like an ordinary missing element.
- **Login waits** start only when the target is missing and a password form is visible.
- **Per-site pacing:** profiles store a rate limit, but runs still use the global pacing setting.
- **Re-teaching changes locators only.** If a site's flow changed (a new intermediate page), teach the site again.
- **Screenshots** of a minimized or hidden window may be empty, and are then skipped.
- **The toolbar is crowded** at the minimum window width of 900 px.
