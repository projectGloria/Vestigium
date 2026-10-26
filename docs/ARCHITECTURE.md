# Architecture — Milestone 1

## Process model and build

Electron main (`src/main/app.ts`) owns the BrowserWindow, WebContentsView tab manager, persistent Chromium session, SQLite, file logging and settings. React owns only the application chrome. Each remote page is displayed in a native WebContentsView, never a BrowserView or webview element. Tab geometry uses the same shared layout constants as React, recalculated on window resize. Popup WebContents are adopted into managed views; no additional BrowserWindow is created. Closing the last tab creates a blank tab. A typed optional `onDocumentReady` hook is the only recorder integration point; no script is injected.

electron-vite builds main and preload as CommonJS bundles and the renderer as browser assets. Sandboxed preload is a single self-contained bundle with only Electron's allowed built-in imports. Renderer source imports neither Electron nor Node. The development server supplies ES modules and linked CSS without inline scripts, unsafe-eval or React refresh preambles. Versions are pinned in package.json and package-lock.json, with host Node in .nvmrc. The Electron native rebuild runs after installation. Unit tests execute bundled node:test files using Electron in Node mode, retaining the correct better-sqlite3 ABI.

## IPC contract

`src/shared/ipc.ts` owns every channel, payload map, result union, renderer API and geometry constant. Preload exposes only `window.vestigium`. Its methods cover:

- getting state, and subscribing or unsubscribing to state updates
- navigation: navigate, Back/Forward/Reload, new/select/close tab
- setting the theme
- recording: start and stop
- runs: run and stop
- workflows: select, edit, delete, and export or import, through native dialogs opened by main so the renderer never handles paths

There is no generic send/invoke method, filesystem operation, SQL interface or raw IPC event exposed to React. `registerIpc` ends its command switch with a `never` check, so a channel added without a handler fails typecheck (this caught `state`, which previously only worked by falling through). Only `UserFacingError` messages reach the UI verbatim.

Main checks the sender WebContents, main-frame identity and exact trusted shell URL for every request. Zod rejects malformed payloads, extra keys, invalid IDs and unsupported URL schemes. IPC results are success-with-state or a readable error. Main emits state snapshots containing tab metadata, validated settings and the bounded recent log. Web pages never receive the preload bridge, including popups and subframes.

## Database and settings

The database is `vestigium.sqlite` in `app.getPath('userData')`, using WAL and synchronous FULL. `schema_migrations(version, applied_at)` records applied migrations. Each migration is transactional and idempotent; opening a newer database fails clearly instead of downgrading it. Migration sources live under `src/main/store/migrations/` and are bundled with main.

| Table | Current storage contract |
| --- | --- |
| `workflows` | ID, schema_version, versioned Workflow JSON |
| `site_profiles` | ID, schema_version, versioned SiteProfile JSON |
| `items` | ID, schema_version, versioned Item JSON; URL expression index |
| `download_jobs` | ID, schema_version, versioned DownloadJob JSON; itemId, status, sha256 and createdAt expression indexes (migration 002) |
| `run_log` | ID, schema_version, versioned LogEntry JSON; reserved for future workflow run records |
| `settings` | Key, schema_version, JSON envelope `{schemaVersion:1,value}` |

JSON columns require valid JSON and schema version 1. Shared TypeScript types describe stored entities. Main-only typed repositories implement get/list/save/delete using parameterized values and a closed set of table names. Workflows, items and download jobs are validated with strict zod schemas on every read and write. JSON storage keeps the document model intact; later milestones add expression indexes in migrations as behavior needs them. Settings additionally validate on read/write and persist immediately: theme, last URL, normal window position/size. Off-screen saved windows are recentered. Application logs are rotating files, separate from future `run_log` records.

## Workflow documents (milestone 2 in progress)

`src/shared/types.ts` defines `Step` as a union over `StepType` (narrowing `type` narrows `params`). `src/main/engine/workflow-schema.ts` mirrors it with strict zod schemas and a compile-time check that schema output and shared types are identical, so drift fails `npm run typecheck`.

- Deviation from the plan's schema: every step has `target: { tab, frames, shadowHosts }`. `tab` is an alias (`main`, `popup-N`) because tab IDs do not survive a replay. `frames` is the path from the top document (`{url, name, index}` per hop). `shadowHosts` is one CSS selector per shadow root crossed, because selectors cannot pierce shadow roots. `scroll` is an additional node type because the plan requires recording scroll but names no node for it.
- Validation rules beyond shapes: click/type/select/download steps need at least one locator; step IDs are unique; a popup alias must be opened by an earlier step's `opensTab` and only once; navigate URLs follow the browser URL rules (http/https/about:blank, no credentials). `extract`, `loop_pages`, `loop_items`, `condition` and `run_workflow` accept free-form params until their milestones define them.
- `src/main/engine/workflow-json.ts` serializes with a fixed key order (identity, behavior, then locators), 2-space indentation and a trailing newline, so files diff cleanly. Import strips a UTF-8 BOM, rejects files over 5 MiB and reports up to five issues with their paths. Files are written to a temporary name and renamed.
- The workflows repository validates on every save and read. Recorder page events have their own strict schema (`pageEventSchema`) that cannot carry a tab, frame or timestamp: main stamps those from the trusted sender frame.

## Recorder script (`src/recorder/`, milestone 2 in progress)

Dependency-free TypeScript bundled by electron-vite as a second sandboxed preload, `out/preload/recorder.cjs`, alongside the shell's `index.cjs`. Both bundles are self-contained and only `require("electron")`; the entries share no runtime modules, so no chunk is emitted. Main registers it on `persist:vestigium` with `session.registerPreloadScript({ type: 'frame' })`. Browser views set `nodeIntegrationInSubFrames: true`, which with `sandbox: true` adds no Node.js; it only makes session preloads run in iframes. The preload is inert until main arms it.

- `core.ts` wires capture, highlight and replay to a `RecorderTransport` with three methods: send an event, receive arm/disarm, receive a command and return a result. `preload.ts` implements it with `ipcRenderer` on the `RECORDER_CHANNELS` in `src/shared/recorder.ts`. Tests implement it with a Playwright binding (`tests/e2e/recorder-harness.ts`), so the production core is tested in plain Chromium across documents, shadow roots and cross-origin frames.
- `capture.ts` installs capture-phase `window` listeners at document start. They emit only while armed and only for `isTrusted` events, and the overlay is excluded. Rules:
  - A click is recorded on the innermost interactive element of the composed path. Clicks on `<select>` are ignored. The browser's echo click on a label's control is dropped.
  - Typing is coalesced per field and flushed on change, blur, Enter/Tab, any other recorded event, `pagehide` or disarm.
  - Enter and Tab are recorded only in text fields.
  - A select is recorded from its change event.
  - A scroll is recorded per container (or the window) after 400 ms of settling, and only within 1 s of user scroll intent (wheel, touch, pointer, scroll keys), so page-initiated scrolling is ignored.
  - Password, payment and one-time-code fields produce one content-free `{kind:"sensitive"}` event per field and nothing else.
  - Scroll intent is narrow: a `pointerdown` counts only on a scrollbar, and scroll keys count only outside form controls. Otherwise a click followed by page-driven scrolling (scrollIntoView, automation, a page reacting to the click) would record bogus scroll steps.
- `locators.ts` builds the locators below, keeps only ones unique within the element's root, and ranks them by confidence. `role` and `text` that match several elements get a ` >> nth=K` suffix at half confidence.

  | Strategy | Confidence |
  | --- | --- |
  | `testid` (`data-testid`, `data-test`, `data-qa`, `data-cy`, a stable `id`, or `name` on form fields) | 0.95 / 0.9 / 0.85 |
  | `role` + accessible name | 0.9 (0.6 without a name) |
  | `text` (tag + text) | 0.75 |
  | `css` (stable classes, or a child path anchored at a stable id) | 0.7 / 0.6 / 0.5 |
  | positional `xpath` | 0.3 |
  | JSON `fingerprint` (tag, classes, key attributes, text, three parents, sibling position) | 0.4 |

  Generated IDs and classes (hash-like runs containing digits, framework prefixes) and state classes are never used. `aria.ts` is a deliberately small role and name subset that only needs to be consistent between recording and replay.
- `shadowHosts` holds one unique selector per open shadow root crossed. Closed shadow roots are opaque by design: clicks inside them record the host.
- `resolve.ts` replays a command:
  1. Walk the shadow-host chain.
  2. Try locators in confidence order. The first with exactly one match wins; ambiguous ones are skipped, never guessed. A fingerprint matches only when the best score is at least 0.7 and leads the runner-up by 0.1.
  3. If the match is hidden or disabled, return `not-ready`; if nothing matches, `not-found`. Main retries both until the step times out.
  4. Act. Input is synthetic DOM input: a pointer/mouse sequence plus `HTMLElement.click()`; the prototype value setter plus `input`/`change` (so framework value trackers see a change); select by value, falling back to label; Enter calls `requestSubmit` and Tab focuses the next field when the page does not prevent the key. Trusted OS-level input is deferred to milestone 3.
- `highlight.ts` draws a closed-shadow-root overlay (`pointer-events:none`) showing a hover outline, a "Recording" badge in the top frame and a replay flash.

## Recording session (`src/main/browser/recording.ts`) and step compiler (`src/main/learn/step-compiler.ts`)

- **Starting.** `recordStart` (shell IPC) records the active tab as alias `main`; its current URL becomes the first `navigate` step. Main arms every frame in the tab. Frames that load later (new documents, iframes, popups) send `ready` and are armed if their tab is being recorded. Popups opened by a recorded tab get `popup-N` aliases (`TabManager` reports the opener). Other tabs are never armed, and their messages are ignored.
- **Page events.** These are accepted only from managed, recorded tabs and validated with `pageEventSchema`. Main stamps the time, the tab alias and the frame path from `event.senderFrame` (`frameTreeNodeId` order among siblings). Messages are capped at 5000 per recording. Malformed messages and sensitive-field notices are logged once each.
- **Browser events.** Main observes these itself: `did-navigate` and `did-navigate-in-page` via `TabManager` hooks, flagged `fromAddressBar` when the URL box or Back/Forward/Reload started them; popup adoption; and `will-download` from the session, read before the download is cancelled.
- **Stopping.** `recordStop` disarms all frames, waits 250 ms for flushed typing and scrolls, then compiles. `WorkflowLibrary` saves the result as a new selected workflow. It caches summaries and the selected workflow because `AppState` is rebuilt on every change, and skips (and logs) a corrupted stored row instead of failing startup. An empty recording returns a readable `UserFacingError`. Only that class's messages pass through IPC unchanged; other failures get a generic message.
- **Compiler.** A pure function with these rules:
  - Address-bar navigations become `navigate` steps.
  - A page navigation (including an SPA route) after a user action sets `waitFor.navigation` on that action.
  - A focus click on a text field followed by typing collapses into one `type` step; typing plus Enter or Tab becomes "type X and press Enter". A bare key keeps the field value (`value: null`).
  - Consecutive selects or scrolls of the same target keep the last value.
  - A popup marks the preceding click with `opensTab`.
  - A download turns the click that caused it into a `download` step: the click in the same tab, or the click that opened an auto-downloading popup.
  - Unexplained popups and downloads become notes in the log, not steps.
  - Labels are plain language, for example `Type "notes" into "Search notes" and press Enter` or `Click button "Frame action" (inside a frame from 127.0.0.1:4174)`.
- The `onDocumentReady` placeholder hook from milestone 1 was removed: the session preload replaced the need to inject from `dom-ready`. Back/Forward/Reload moved into `TabManager` so it can flag shell-initiated navigations.

## Replay engine (`src/main/engine/`, milestone 2)

- **`workflowRun`** runs a saved workflow in the active tab (alias `main`). Steps whose `opensTab` fires bind the popup that the step's tab opens to that alias. Recording and running are mutually exclusive.
- **`workflow-runner.ts`** runs steps in order.
  - It skips disabled steps.
  - It rejects step types that later milestones will implement.
  - It listens for a step's effects (navigation, popup, download) *before* acting, and waits for them afterwards with their own 15 s budget.
  - After a cross-document navigation it waits for `dom-ready`, so the next command reaches the new document's recorder.
- **Failure handling:**
  - Retryable failures (frame missing, page not answering within 1.5 s, element not found, hidden or disabled) are polled with backoff until the step's `timeoutMs`. This is how the countdown's disabled Continue button is waited for.
  - Failures after the action happened are not retried silently; only `onFail: "retry"` repeats the action, at most twice.
  - `skip` records and continues.
  - `abort` stops the run. `pause` also stops it for now, with a note that pausing for you arrives in milestone 8.
- **Stop** aborts all waits immediately.
- **Run state:** `AppState.run` holds the per-step result (done, skipped or failed), the locator that matched (e.g. `role: link "Download ZIP"`) and a readable error such as `Step 2/2 failed: Click link "Field Notes 10". … Waited 15 s.`.
- **`locator-resolver.ts`** finds the target frame by recorded path (`frame-match.ts`, a pure function). It matches by exact URL, then origin + path (tokens in queries), then name, with position only as a tiebreaker. Position alone never matches, and equal candidates are refused. It sends `{id, command}` to that frame's recorder and accepts a reply only from the same frame (`processId` + `frameToken`), validated with zod.
- **Identity guard (`src/recorder/resolve.ts`).** Position-based locators (CSS with `:nth-of-type`, XPath, fingerprint, `>> nth=`) can confirm an element but never contradict the recorded role/name or text. Found by the replay test on the "changing" list: item 10 moved off page 1, and its positional CSS pointed at the card now holding item 9. Without the guard, replay clicked the wrong item and reported success. Healing legitimately renamed elements, with review, is milestone 3.
- A download step passes when the browser asks to download from one of the run's tabs. The file is then fetched by the download queue (milestone 6); the run moves on while it transfers.

## Ad blocking (after milestone 9, `src/main/browser/ad-blocker.ts`)

Download sites run ad networks whose popunders and overlays get in the way of runs: a popunder becomes a managed tab, and the first click on the page goes to the ad. Vestigium blocks them at the network level with filter lists.

- **Engine:** Ghostery's `@ghostery/adblocker` core (MPL-2.0), not its Electron wrapper. The wrapper registers its own `session.webRequest.onBeforeRequest`, and Electron keeps only one listener per event per session, so it would silently replace `NetworkMonitor`'s network-idle tracking. Instead, `NetworkMonitor` asks `AdBlocker.decide()` inside its one listener. Blocked requests are not counted as in flight.
- **Network filters only:** cosmetic filters, scriptlets and HTML filtering are off. Nothing is injected into pages (the recorder stays the only script), and the recorder sees the page's own DOM. Blocked ads can leave empty slots. Filters with a `redirect=` (analytics, tag managers) get a harmless `data:` stub, so pages that call them keep working.
- **What is filtered:** only requests from browser tabs (`webContentsId` set), and never top-level navigations. The download queue's `session.fetch` requests carry no `webContentsId`, so a file the person asked for is never blocked. Popups are judged as documents in `TabManager`'s window-open handler; a blocked popup is refused, so popunders never become tabs. A popup opened as `about:blank` and navigated afterwards is not caught there, but the script that opens it is usually blocked first.
- **Lists:** `filter-lists.ts` names the subscriptions (Ghostery's mirror of EasyList, EasyPrivacy, Peter Lowe's list and uBlock Origin's filters, badware, privacy, quick-fixes, resource-abuse and unbreak lists). No annoyance or cookie-notice lists: they hide content, which would change what the recorder learns. A copy ships in `resources/filter-lists` (`npm run filter-lists` refreshes it; electron-builder copies it to `resourcesilter-lists` through `extraResources`).
- **Loading:** at startup, before the first tab opens. The serialized engine cached in `userData/adblock/engine.bin` loads in milliseconds. Without a usable cache (first start, another engine version, a corrupt file, or bundled lists newer than the cache after an app update), the bundled lists are parsed (about half a second for 120,000 filters) and cached.
- **Refresh:** weekly, in the background (first check a minute after start, then every 6 hours), through `net.fetch` on the default session, so no site cookies. Every list must download; the new engine must have at least half as many filters as the current one. Otherwise the current engine stays and the log says why. Not from the command line, and not when `VESTIGIUM_FILTER_LISTS` pins the lists or `VESTIGIUM_FILTER_REFRESH=off` (tests).
- **Setting:** `adblock: { enabled }`, on by default, in Settings ("Safety, ads and tray"), with a status line (filters, list date, requests blocked since start). The blocker keeps its own copy of the flag because it is consulted on every request. Turning it on or off applies to new requests; open pages keep what they loaded until reloaded.
- **Logs:** the engine's source and size, refreshes, and "Blocked an ad popup." No per-request lines and no URLs.
- **Known limit:** sites that load ads through their own inline script, which tries fresh throwaway domains, get past the lists until the lists catch up (measured on misskon.com: the banners and listed networks were blocked, but a popunder to a domain no list knew yet still opened). Such a popup recorded while teaching becomes the clicked step's `opensTab`, and replay then waits for it. Network filtering cannot reach a first-party inline script.

## Command line and installer (milestone 9)

- **CLI** (plan §8, `src/main/cli/`).
  - **Commands:** `vestigium run --profile <site> [--url <list>] [--output <folder>] [--max-pages N] [--max-items N] [--force] [--dry-run]`, `vestigium profiles` and `vestigium --help`.
  - **Parsing:** `args.ts` is pure and unit-tested.
  - **Same engine:** `app.ts` parses the arguments before anything starts. A command runs the *same* app (profile, database, browser session and logins, runner, queue) with the window never shown. It appears only if a run needs a person ("Needs you"), and there is no tray icon.
  - **`run.ts`:** plans the profile's workflow exactly as ▶ Start does, applies the limits to a copy, runs it, then waits until every download the run queued has settled (`DownloadQueue.summarySince`).
  - **Overrides:** `--output` and `--force` override the download settings for this process only.
  - **Output:** log lines stream to stdout (`Logger.onWrite`), followed by a report.
  - **Exit codes:** 0 done; 1 the run or a download failed (or is paused); 2 wrong arguments; 3 could not start (unknown site, or the window is open: one process per profile, through the single-instance lock).
  - **Shutdown:** the normal path, ending in `app.exit(code)`.
- **Electron's command-line guard.** Electron refuses to start when *any* argument follows a URL-like one (`scheme:…`), its CVE-2018-1000006 mitigation (`shell/app/command_line_args.cc`), unless `--` comes first. `--url http://… --max-pages 1` therefore never reaches the app, and the process exits with −1 and no output.
  - **The fix:** every launcher passes `--` before the command (`vestigium.cmd`, `npm run cli`, the tests), and the parser skips a leading `--`.
  - **A side benefit:** Chromium does not read our options as its own switches.
  - Found by the CLI acceptance test; the rule was confirmed in Electron's source.
- **Installer** (`electron-builder.yml`, `npm run dist` → `release/Vestigium Setup <version>.exe`, NSIS, x64):
  - **Install mode:** per user, with a choosable folder, Start menu and desktop shortcuts. Uninstalling keeps the user's profile.
  - **Electron:** `electronDist` reuses the development Electron (same version, no download).
  - **Native module:** `npmRebuild: false`, because better-sqlite3 13 loads its Node-API prebuild (`prebuilds/win32-x64.node`), which works under Electron and Node alike. That binary is unpacked from the asar, and other platforms' binaries and the native sources are excluded.
  - **Payload:** runtime `dependencies` are only `better-sqlite3` and `zod`. React is bundled, and `express`/`yazl` (demo and tests) are dev dependencies now.
  - **Icon:** `build/icon.png` is the tray mark rendered at 256 px (`npm run icon`).
  - **`vestigium.cmd`** sits next to `Vestigium.exe`. It adds `--`, and as a .cmd file it waits for the run and returns its exit code. Electron attaches to the parent console, so output appears in the terminal.
- **Verifying the installer** (`npm run test:package`): the app is extracted *from the installer's payload* (`$PLUGINSDIR\app-64.7z`, with 7-Zip) into a temporary folder, launched with a fresh profile (window, browsing, SQLite), and its `vestigium.cmd` is run. Nothing is installed into the user account.
- **Known limits:**
  - **Not code-signed:** the installer has no certificate, so SmartScreen warns on first run.
  - **Clean-machine install:** not verified here. Windows Sandbox is not enabled on the development machine; see the verification doc for the manual check.
  - **Leftover file:** Electron's inert `default_app.asar` is copied from the development Electron.
  - **Platforms:** Windows only; macOS and Linux targets are not configured.

## Human-in-the-loop, site profiles, safety and UI polish (milestone 8)

- **Needs you** (plan §4, `workflow-runner.ts` + `src/recorder/learn/obstacles.ts`).
  - **When it triggers:** while a step keeps failing in a retryable way, the runner asks the step's page about obstacles (query `obstacles`, at most about once a second):
    - **A captcha:** the usual widget markers (`.g-recaptcha`, `.h-captcha`, `.cf-turnstile`, `[data-sitekey]`), provider frames, or "I'm not a robot" text.
    - **A login wall:** a visible password field in a form, where the step's target is missing.
    - **A countdown or confirmation:** the target is there but has stayed disabled past 2.5 s. The page's own "Wait N seconds" text is quoted when there is one.
  - **What happens:**
    - The run pauses with `RunState.waitingFor` set and a "Needs you: …" reason.
    - It selects the step's tab, highlights the target, and asks the app to bring the window forward (restore, show, focus, flash; a desktop notification outside tests).
    - `pauseUntil` then polls every second and **releases itself** once the page has no captcha or login form and the target resolves enabled. Resume (retry now) and Stop still work.
    - After 15 minutes the step fails, without retries.
  - **Never bypassed:** captcha clicks are never recorded (`capture.ts` emits a `captcha` event instead), and captcha providers' frames get no recorder at all (`isCaptchaFrame`). Not recording them was not enough: a step recorded on one page can match a captcha element on another. On ouo.io, the first "Get Link" button is the reCAPTCHA trigger and has the same id and name as the plain "Get Link" on the next page. A real run pressed it after Resume. So `resolveTarget` also refuses any match inside a captcha widget (`isCaptchaElement`) with "not-ready", for every command, including the readiness probe. The run pauses for the person and continues only once the page has moved past the captcha. Only the person solves it.
  - **The demo:** `hostOrigin/captcha` accepts only a trusted click on its checkbox. `item?variant=captcha` leads there. `item?variant=shortlink` opens a link-shortener popup whose first "Get Link" is the captcha, followed by a countdown page with a look-alike "Get Link".
- **Safety** (plan §7, `safetyCheck`, settings `safety`), both manual pauses with `waitingFor` `confirm` or `site`, allowed once per run:
  - **Risky clicks:** a click whose label reads like buying, paying, deleting or unsubscribing (English, Turkish, Spanish, French, German; Unicode letter boundaries, because `\b` is ASCII-only) waits for Resume.
  - **The allowlist:** a non-empty allowlist (`example.com`, `*.example.com`, optionally with a port) makes a run ask before opening or acting on any other site.
- **Site profiles** (plan §2, `engine/site-profiles.ts`, table `site_profiles`, validated).
  - **Saving:** Stop recording on a recording that generalized into an item loop saves the profile for the list's host (including the port) and links the workflow (`Workflow.siteProfileId`). The profile holds the list URL, item pattern, pagination, the workflow and its item-body labels, and the pacing. Teaching the same site again replaces it.
  - **Starting:** **▶ Start** (toolbar, or a profile's own button) plans a *copy* of that workflow whose opening step and item loop use the current (or given) list URL, and runs it. The stored workflow is unchanged.
  - **Health:** each run grades the profile.
    - `ok`: done, nothing healed, no failed item.
    - `degraded`: heals or failed items.
    - `broken`: the run failed. `brokenStepId` and `brokenStepLabel` name the step to re-teach.
    - Dry and stopped runs grade nothing.
- **Re-teach one step** (plan §2/§6, IPC `workflowReteach`):
  - Opens the page where the step failed (`RunState.failure`: the first failing step and its tab's URL) and starts a recording.
  - **Stop recording** replaces *only* that step's locators and frame path (`WorkflowLibrary.reteach`) with the recorded click: a download for a download step, else the first click. Its type, tab, waits, timeout and every other step stay as they were, and a pending review is cleared.
- **Failures and history** (plan §6):
  - **Screenshots:** a failed step gets a screenshot (`capturePage`, best effort; a hidden window may give none), saved as `<uuid>.png` under `userData/failures`. The UI opens it by name only: `screenshotOpen` accepts nothing but a UUID file name.
  - **Persistent history:** every finished run becomes a `RunRecord` in `run_log`, the table reserved for this since milestone 1. It holds the counts, the first failure, and up to 50 failed results with screenshots; the newest 200 are kept. The History tab shows the current run and "Earlier runs", with **Screenshot** and **Re-teach this step** on failures.
  - **Retry failed items:** runs the workflow again. Downloaded items are skipped (milestone 6), so exactly the unfinished ones run.
- **UI polish** (plan §6):
  - **Toolbar:** **▶ Start** and **Open folder**.
  - **Copied link:** "Open copied link: …" in the tab strip when the window gets focus and the clipboard holds an http(s) link, offered once. Nothing else from the clipboard is kept. It sits in the tab strip because the toolbar is full, and nothing can show below it: the native browser view draws over that area.
  - **Tray:** a tray icon (`tray-icon.ts`, a PNG drawn in code), with Show, Pause/Resume all downloads, and Quit. With **Minimizing while working hides Vestigium in the tray** on, minimizing during a run or downloads hides the window. Downloads keep going, and runs use in-page clicks while hidden (milestone 5). "Needs you" brings the window back.
  - **Sidebar:** Site profiles with health, last success, Start, Forget and Re-teach, plus a "Safety and tray" block.
- **Shutdown** (found in milestone 7): close and quit handlers only `preventDefault()` and start shutdown with `setImmediate`. Shutdown detaches the log's change hook first and always quits in `finally`. A run is stopped *and awaited* (`stopAndSettle`, at most 5 s) before the database closes, so the stopped run's history record is written; before this, closing the window mid-run lost it.
- **Known limits:**
  - **Detection is generic:** a site-specific challenge that looks like none of these patterns times out as an ordinary missing element.
  - **Login waits** only start when the target is missing and a password form is visible. A site that logs out by showing a modal without a password field is not recognized.
  - **Per-site pacing:** the profile stores it, but runs still use the global pacing setting.
  - **Screenshots** of a minimized or hidden window may be empty and are then skipped.
  - **The toolbar is crowded** at the minimum window width (900 px).

## Item details, sidecars and unpacking (milestone 7)

- **Capturing details** (`src/recorder/learn/metadata.ts`, query `extract-metadata`). This covers plan §2's "metadata capture".
  - **What is read:** the item page's main heading (outside site chrome), `rel=tag` links, `<time datetime>`, and the value next to every configured label.
  - **Where values are found:** `<dt>`/`<dd>`, table rows (a short first cell is the label), "Label: value" on one rendered line, and a label element followed by its value. The inline rule requires a single rendered line; without that, a wrapper around several labelled lines would read as one label followed by everything after it.
  - **Matching:** labels match case-insensitively, ignoring a trailing colon. Hidden elements are ignored. A `type=password` field is never read.
  - **Answer validation:** main validates the page's answer with a strict schema, like every page message.
- **Configurable labels:** `settings.metadata.labels`, editable as "Details to capture" in the Queue tab. The defaults are plan §2's examples plus common translations of "password" (Pass, Unzip password, Şifre, Parola, Contraseña, Mot de passe, Passwort…).
  - Values are stored under the configured spelling, plus Title, Tags and Date (`learn/metadata.ts`).
  - `passwordOf()` finds the archive password under any label that means "password", in several languages.
- **When details are read:**
  - **In a run:** right after each item page opens (`captureDetails`), before its download starts. The download may come from another page (a file host) that does not show the details.
  - **For a manual download (or a flat workflow):** `app.ts` reads the page that started it, for up to 3 s, and drops the details if the tab has moved to another URL by then.
  - **Storage:** details go to `Item.metadata`. New details merge over old ones.
- **Logging:** passwords are stored in the item and the sidecar, as the plan requires, but **never logged**. Log lines and the queue table show labels only ("Item details: Title, Author, Tags, Date, Pass.").
- **Filename templates** (`filename.ts`, setting `downloads.template`, default `{site}/{filename}`):
  - **Tokens:** `{site} {title} {tag} {date} {name} {ext} {filename}`, plus every detail label as a token (`Unzip password` → `{unzip_password}`).
  - **Sanitizing:** each resolved part is sanitized on its own, so a value cannot add folders (`a/b` becomes `a_b`).
  - **Empty values:** an empty folder part is dropped, and an empty file part falls back to the file's own name.
  - **File type:** the file keeps its real extension, so `{name}.exe` saves `x.exe.zip`.
  - **Validation:** templates are checked by `templateSchema` (relative, no `..`, no Windows-forbidden characters).
- **Sidecar** (`sidecar.ts`, `downloads.sidecar`, on by default): `<name>_info.txt` next to the file, in UTF-8 with a BOM so Notepad shows non-Latin text.
  - **Contents, in order:** the title, the password, every other detail, then the file name, size, SHA-256, page, URL, time, and the unpack folder.
  - Duplicates of identical bytes get no sidecar of their own.
- **Unpacking** (`archive.ts`, `downloads.extract`: `off` by default as the plan calls it optional; `keep` or `delete` the archive):
  - **ZIP is built in** (`zip.ts`): stored and deflated entries, traditional PKWARE encryption (ZipCrypto, with a CRC-driven key stream and its 12-byte header check), and WinZip AES (AE-1/AE-2, 128/192/256-bit).
    - **AES:** PBKDF2-HMAC-SHA1 with 1000 rounds derives the key, the HMAC key and a 2-byte verifier. Decryption is AES in CTR mode with WinZip's *little-endian* counter starting at 1, built by hand over ECB because Node's `aes-*-ctr` counts big-endian. A 10-byte HMAC-SHA1 authenticates the data.
    - **Checks:** the CRC-32 for everything but AE-2, where the HMAC replaces it.
  - **7z and RAR use 7-Zip when it is installed** (`findSevenZip`: `VESTIGIUM_7ZIP`, Program Files, `/usr/bin/7z`). It is spawned with an argument list and no shell. `-p` is always passed, because 7-Zip would otherwise wait for a password on stdin. Links in the result are removed.
  - **Safety:**
    - Paths with `..`, a root or a drive are skipped (zip-slip).
    - Every path segment is sanitized for Windows. Two names that sanitize alike: the second is skipped.
    - Files are created exclusively (`wx`).
    - An entry may not produce more bytes than declared (zip bombs), and the declared total must fit the free disk space minus the reserve.
    - Output goes to `<folder>.vestigium-unpacking` and is renamed into place only on success.
  - **Ordering:** the job is saved `done` as soon as the file is placed. Unpacking and the sidecar come after, so a crash while unpacking never downloads the file again.
  - **Failures** never fail the download. The job gets an `extractNote` ("Not unpacked: The password from the item page does not open the archive."), the archive is kept, and the sidecar is still written.
- **Tested against an independent encoder.** The demo's protected archives (`tests/demo-site/archives/`: ZipCrypto ZIP, AES-256 ZIP, encrypted `.7z`) were made by 7-Zip, so decryption is checked against real archives, not a mirror of our own code.
- **Default concurrency** is now 3 parallel downloads (plan §4).
- **Known limits:**
  - **Formats:** 7z and RAR need 7-Zip installed. Without it they are kept as they are, with a note saying so. ZIP entries using other compression methods (bzip2, LZMA, Deflate64) are skipped with a note.
  - **Non-ASCII ZipCrypto passwords:** read as UTF-8. Archives made by tools that used a legacy code page may not open with such a password.
  - **Labels:** details are found by label, so a page that shows the password with no label (just "Unzip with: …") needs that phrase added to the labels.

## Downloads (milestone 6, `src/main/downloads/`)

- **Interception.** `will-download` reads what Chromium knows (URL, suggested name, MIME type, size, the page and its title), then cancels Chromium's own download. The queue fetches the file again itself with `session.fetch` on `persist:vestigium`.
  - Cookies must be requested explicitly (`credentials: 'include'`): Electron blocks them otherwise. With them, files behind a login download too.
  - `net.fetch` ignores `RequestInit.referrer`, so the page goes in as a `Referer` header.
  - **Why not Chromium's DownloadItem:** resuming across restarts (`createInterruptedDownload`), 416 handling, restarts without Range support and HTML-error detection are opaque there and cannot be unit-tested. Owning the transfer makes every rule explicit and testable against the demo server.
  - **The cost:** the file URL is requested a second time, so single-use links fail (see Known limits).
- **Routing** (`app.ts`), in this order:
  1. A link renewal (below) claims the download's fresh URL.
  2. While teaching, the download is recorded but not saved.
  3. During a run, the runner's `downloadContext` ties the download to the current item (the item page URL, the dedupe key) and to the step that produced it (`origin`).
  4. Otherwise it is a manual download, tied to the page it came from.
- **Transfer** (`transfer.ts`, one attempt, pure Node plus an injected fetcher):
  - Appends to `<folder>/.vestigium-parts/<job id>.part`. The part's size is the resume offset, so a crash loses only the bytes in flight.
  - A resume sends `Range: bytes=<offset>-` plus `If-Range` with the strong ETag (or Last-Modified), so a changed file comes back whole instead of being spliced.
  - **206** at the requested offset: append. **200** to a range request: truncate and restart. **416**: complete if `Content-Range: */size` equals the offset, otherwise truncate and restart once.
  - **404** is a dead link. **401/403/410** is an expired or refused link. **408/425/429/5xx** and network errors are retryable. A `text/html` response is a host error page.
  - Writes are awaited per chunk (backpressure), and the part is fsynced before it is renamed. `Accept-Encoding: identity` keeps byte offsets meaningful.
- **Queue** (`queue.ts`, persistent in `download_jobs`):
  - **States:** `queued → running → verifying → done | failed | cancelled`, with `paused` reachable from queued and running.
  - **Concurrency:** 3 by default (plan §4; 1–6).
  - **Retries:** with exponential backoff (1, 2, 4… s, at most 30 s), 4 by default.
  - **Controls:** pause, resume, cancel and retry work per job and for all. "Pause all" also holds new jobs.
  - **Startup:** jobs found `running` or `verifying` were interrupted by a crash and go back to `queued`.
  - **Clean quit:** `dispose()` stores running jobs as queued with their byte counts *synchronously*, because the DB closes right after. The aborted transfers find `disposed` set and write nothing more.
  - **Disk space:** before each attempt, free space must cover the remaining bytes plus a 64 MB reserve. Otherwise the job is *paused* with a readable message, never failed.
  - **When a batch ends:** a log line, plus a desktop notification outside tests.
- **Verification** (`verify.ts`) runs before a file is kept:
  - The file must not be empty, and its size must match the server's.
  - A web page disguised as a file fails.
  - **ZIP:** a full test. Every entry is inflated and its CRC-32 compared, streamed in 1 MB chunks, with ZIP64 supported. Encrypted entries and unusual compression methods are checked for structure only.
  - **RAR and 7z:** recognized by signature only, because testing them needs an external unpacker.
  - Then a SHA-256 of the whole file.
- **Dedupe:**
  - **By item URL:** a run does not even open an item whose download is already `done`. `enqueue` also skips it.
  - **By hash:** a file with the same SHA-256 as an earlier one is not stored twice. The job is `done` with `duplicateOf` set and points at the existing file.
  - **Force** (a setting) turns both off.
  - A second click on a link that is already queued or running does not queue it again.
- **Names** (`filename.ts`):
  - **Source order (plan §11):** Content-Disposition (RFC 5987 `filename*` first), then the URL's last path segment if it has an extension, then Chromium's suggestion, then the page title plus an extension from the MIME type.
  - **Made safe for Windows:** NFC normalization; `<>:"/\|?*` and control characters replaced; bidi control characters removed (they can disguise an extension); trailing dots and spaces removed; reserved device names (CON, LPT1…) prefixed.
  - **Length:** at most 150 characters, trimmed by code point so surrogate pairs stay whole.
  - **Collisions:** ` (2)`, ` (3)`… Picking a free name and renaming into it is serialized between jobs.
  - **Folder:** by template since milestone 7 (default `<download folder>\<site host>\<file name>`).
- **Expired links.** On 401/403/410 the queue asks `runner.renew(workflow, job)`, but only when no run is active.
  - The runner opens the job's source page in a tab of its own and redoes the item loop's body, or the single download step, retargeting `item` to `main`. The download that follows hands its fresh URL to the waiting job (`claimRenewal`), not to the queue.
  - The job then continues its `.part` with Range and If-Range.
  - While a run is active, the job fails with its "expired" message until Retry.
- **Dead links in a run.** A download step listens for a navigation of the run's tabs with an HTTP error status (`did-navigate` now reports it).
  - If the click leads to an error page, the step fails at once ("The download link led to an error page (HTTP 404) instead of a file.") instead of after the 60 s download timeout.
  - The failure is *final*: `onFail: retry` does not repeat the click, because the page it needs is gone.
  - The item is marked `no_download`. An item whose page failed for another reason is marked `failed`. Neither blocks the other items.
- **UI** (Queue tab, `QueuePanel.tsx`): one row per job (newest 200) with status, a progress bar, bytes, speed, time left, and per-row Pause/Resume/Cancel/Retry/Show.
  - A summary line shows counts and overall progress.
  - The bar holds Pause all/Resume all, Cancel all, Retry failed, Force, "At once", Open folder and Change folder….
  - The folder never comes from the renderer: **Change folder…** opens the native folder dialog in main. `shell.openPath` and `showItemInFolder` only open local paths.
- **Settings:** `downloads: { directory, concurrency, retries, force }`. `directory` '' means `Downloads\Vestigium`. `VESTIGIUM_DOWNLOADS` overrides that default, and tests use it to keep files inside their temporary profile.
- **Known limits:**
  - **Single-use links:** the re-request fails on links that work only once, and on downloads that need a POST. Both would need Chromium's own transfer.
  - **Renewal during a run:** a link cannot be renewed while a run is active.
  - **RAR/7z:** not test-extracted.
  - **Run history:** only the latest run is kept in memory. The queue's history is persistent.

## Item inference and item loops (milestone 5)

- **When:** at the moment of a recorded click. In the top frame, the recorder checks whether the clicked link is one of many similar items, synchronously, because the click may navigate away immediately (`src/recorder/learn/items.ts`).
  - It climbs from the link. At each ancestor level it counts the siblings with the same tag that hold a link at the same child path. The level with the most such siblings is the item (cards, table rows, list entries).
  - Only tag names are stored: `{ parent, container, item, link }`, e.g. `main > section > article`, link `h3 > a`. Classes and IDs are never used, because they are what changes between renders and deploys.
  - Site chrome (header, nav, aside, footer, dialogs) is never part of a list, so the demo's identical "popular posts" cards in the sidebar are ignored.
  - The click event then carries a `ListContext`: the pattern, the item count, which item was opened, and the page's pagination report.
  - Main validates the context with strict schemas, like every page message. Analysis errors never cost the user the recorded click.
- **Generalization** (`learn/generalize.ts`, pure, unit-tested) runs on Stop recording, after the step compiler.
  - It looks for the first click in the main tab's top frame that (a) had a `ListContext` and (b) opened a page (it navigated or opened a tab).
  - That click becomes a `loop_items` step. The steps after it, up to the next address-bar navigation, become its body; everything after that point is left out, with a note.
  - Body steps that acted on the item page are retargeted to the `item` tab alias.
  - Steps before the click run once.
  - If the list page offered a usable next control or numbered links (`choosePagination` without a scroll probe), the item loop is wrapped in a `loop_pages` step. Otherwise the log explains why and points to **↻ Repeat on every page**, which can later wrap the item loop, e.g. for infinite scroll.
- **`loop_items`** is `{ pattern, listUrl, maxItems, exclude, steps }`. Its rules:
  - The body runs in the `item` tab alias, which exists only inside the loop (schema walk).
  - It reads its list from `main`.
  - It cannot contain another item loop or a page loop. A page loop may contain it.
- **Runner** (`loopItems`):
  - It lists the list tab's items with the `find-items` query and highlights them.
  - It skips excluded URLs and URLs already opened in this run (duplicates across pages).
  - It opens each item in one dedicated item tab, created per loop run, so the list tab keeps its place, which load-more and SPA lists need. Pacing applies.
  - **Per item:** the body runs, and tabs it opened are closed. A failing item is recorded (`… › Item 3/10 › <title> · …`) and skipped; it never stops the rest.
  - **When the loop ends:** the list tab is selected again before the item tab is closed, because pagination clicks are real input.
  - `maxItems` caps the whole run, and reaching it ends the page loop too.
  - A dry run only finds and highlights the items.
- **Show items** (`learn/item-preview.ts`, `workflowPreviewItems` IPC) finds the items on the active tab, or opens `listUrl` when the active tab is not the list.
  - It highlights the items with numbered boxes in a closed shadow root. The boxes use document coordinates and `pointer-events: none`, so they never become click targets, locators or content links.
  - It publishes the list as `AppState.itemPreview`. Unticking an item is a versioned `exclude-item` edit, after which main redraws the highlight with that item marked as excluded.
- **Summary** (`src/shared/summary.ts`): the plain-language summary from plan §1 ("Page type: LIST. Each item is … Open each item → … Next page: …"). It is derived from the stored workflow on every render, so it can never disagree with the steps.
- **Not covered:**
  - Lists inside iframes.
  - Items without a link, e.g. cards that open a dialog.
  - List items that are themselves download links (the click must open a page). Download detection is milestone 6.
  - Page-type classification is limited to what the demonstration shows: a list is a page with repeated linked items, and item pages are where those links lead. There is no separate classifier for download-host pages yet.

## Pagination and page loops (milestone 4)

- **Page analysis** (`src/recorder/learn/`) answers read-only queries on a separate recorder channel (`vestigium:recorder:query`, replies on the result channel). Main validates every answer with a strict per-kind schema (`FrameCommandBridge.query`). The queries:
  - `analyze-pagination`: candidate "next" controls, a "load more" control, numbered page links and how many content links the page has.
    - Next-control evidence: `rel=next`, an aria-label or text in the plan's languages, or an arrow symbol.
    - `rel=next` links also get a top-ranked `a[rel~="next"]` locator.
    - A control counts as disabled if it has the disabled attribute, `aria-disabled`, no href, or a `disabled` class on it or its container.
  - `signature`: an FNV-1a hash of the absolute URLs of the *content* links. Content means `main` minus header, nav, footer, aside, dialogs and pagination, so site chrome never makes two pages look alike.
  - `control-state`: whether recorded locators find a control that is enabled, disabled or missing. Exact matching only, no healing.
  - `scroll-probe`: scroll to the bottom and report the content-link count before and after.
- **`learn/pagination-detector.ts`** (pure) picks the pattern in this order: an enabled next control; a `{{page}}` URL template derived from numbered links (the number must sit alone between URL delimiters, and at least two links must agree); an enabled "load more" control; infinite scroll, only if a scroll probe actually loaded more. Each pattern carries a plain-language description. `learn/learner.ts` scrolls only when nothing else was found.
- **`loop_pages`** is a step with `{ pagination, maxPages, steps }`.
  - The schema is recursive (`z.lazy`). IDs are unique across all levels; tabs opened inside a body do not leak out of it; a page loop cannot be inside another page loop or an item loop. URL templates must yield http(s) URLs.
  - Edits find steps at any depth (`engine/steps.ts`); moves stay within the step's own list. A body may be empty, which gives a crawl that only visits pages.
  - `addPageLoop` wraps everything after the opening navigation. The pattern always comes from main's own analysis of the active tab (`learnPages`), never from the renderer.
- **Runner.** `runSequence` runs the top level and loop bodies; body results and log lines are prefixed `Page N › `.
  - **Per page:** wait for network idle → take the signature → run the body → check `maxPages` → advance.
  - **Stop conditions:** the page repeats an earlier signature; a page after the first brings no new content links; the next or load-more control is missing or disabled; a scroll loads nothing; pressing a control changes nothing within 15 s; `maxPages` is reached.
  - **Advancing:** a click goes through the normal click path (settle, obstruction and banner handling, trusted input). Success means a changed signature, which covers both real navigations and SPA content swaps. URL patterns use `loadURL`. Pacing applies between pages.
  - **Dry run:** checks page 1 only and reports how it would continue. `RunState.progress` shows "Page N: X new links (Y in total)".
- **Demo additions:** `mode=spa` (Next swaps items in place via fetch; the URL never changes) and `wrap=1` (the last page links back to page 1). The infinite-scroll list now really hides its "Load more" button: the page CSS had overridden the `hidden` attribute, so a crawler could pass the infinite-scroll test by clicking.

## Run engine: smart waits, self-healing, modes (milestone 3)

- **Smart waits.**
  - Before each element step, the runner waits (best effort, at most 4 s) for **network idle**. `browser/network.ts` counts in-flight requests per tab via `session.webRequest`; it ignores WebSockets and requests older than 10 s, so streams and long polls do not keep a page "busy".
  - In the page, the resolver scrolls the target into view and waits for it to **settle**: its box unchanged for two 50 ms samples and no DOM mutation for 150 ms, capped at 1.2 s for pages that never go quiet (`src/recorder/settle.ts`).
  - Hidden, disabled or covered targets return `not-ready` and are polled until the step timeout.
- **Obstructions.** If the target's centre is covered (`src/recorder/obstruction.ts`) and the cover belongs to a recognizable cookie/consent container, its most privacy-preserving button is pressed: reject, then necessary-only, then accept, then close. Any other overlay is left alone and the step waits, reporting what covers the target.
- **Trusted input.** Main-frame clicks use action `locate` (settle, obstruction check, centre point), then main sends `mouseMove`/`mouseDown`/`mouseUp` with `webContents.sendInputEvent`, scaled by the page zoom. Pages see `isTrusted` clicks with user activation. Clicks inside iframes and all typing and selecting remain synthetic, because frame offsets are not reliably known in main. While the window is minimized or hidden, main-frame clicks are synthetic too, logged once per run: Chromium keeps tabs created meanwhile (each page's item tab) at a 0×0 viewport, where OS-level input hits no element (milestone 5 finding). `TabManager.layout()` keeps the last non-zero content size and lays out again on restore.
- **Self-healing** (`src/recorder/heal.ts`) runs when no recorded locator matches exactly one element:
  - It scores visible candidates with the recorded role (or tag) on name similarity (word and character-pair Dice) and structural fingerprint similarity.
  - It accepts the best candidate only if the score is ≥ 0.7, the name similarity is ≥ 0.5, and it leads the runner-up by ≥ 0.15.
  - Numbers in the recorded name must match exactly, so "Field Notes 10" can never heal to "Field Notes 01".
  - Whenever the best-ranked recorded locator did not match (a fallback was used, or a heal), the page returns locators rebuilt from the element actually used. `WorkflowLibrary.heal` saves them as a new revision and sets `step.review = { reason, at, previous }`, where `previous` keeps the originally recorded locators across repeated heals.
  - The UI shows "⚠ Healed during a run" with **Keep new locators** (`accept-review`) and **Undo heal** (`revert-review`). Dry runs report heals but never save them.
- **Modes and pauses.**
  - `run`; `step` (pause before every step, with the next target highlighted; **Next step** runs one step, **Resume** continues normally); `dry` (navigations happen, element steps are found and highlighted but not acted on, and steps on pages that a skipped action would have reached are reported as not checked).
  - **Pause** takes effect before the next step. **Stop** works at any time, including while paused.
  - A step with `onFail: "pause"` pauses with "Step N needs you: … press Resume to retry this step", and Resume retries it. This is the human-in-the-loop core; milestone 8 adds automatic detection, bringing the window forward and continuing on its own.
- **Pacing** (`settings.run`, via `setRunSettings`): a random delay between steps (default 300–900 ms) and a minimum interval between steps on the same host (default 1 s). Both are validated, persisted in SQLite and skipped in dry runs. A settings UI and per-site values come with site profiles (milestone 8).
- **Bridge.** The bridge result schema accepts the new fields (`point`, `refreshed`, `healed`, `banner`) and checks proposed locators with the workflow locator schema; they are validated again when saved. The recorder transport is now async because the page may spend time settling.

## Workflow UI (`src/renderer/`, milestone 2)

- **Layout.** `bridge.ts` holds the only renderer state: the latest `AppState` snapshot from main, plus the last error. `act()` wraps each bridge call in a React 19 transition, so buttons can disable while main is busy. Components: `Toolbar` (navigation, address bar, **● Teach / ■ Stop recording**, **▶ Run / ■ Stop run**, theme), `WorkflowPanel` (name, steps, export/import/delete, saved workflows), `StepList` with `LocatorInspector`, and `ActivityPanel` (Queue, Log, History of the latest run).
- **Local state.** Only UI drafts (a URL being typed, a label being edited, a pending delete confirmation) live in component state. The address bar and name field reset via `key` instead of syncing props into state with an effect.
- **Edits.** Workflow edits are `WorkflowChange` values: rename, relabel, toggle, move, or delete-step. Each is sent with the revision it was made against. Main applies it with the pure `applyChange`, refuses stale revisions, and validates the result with the workflow schema, so a step cannot be moved above the step that opens its popup. Editing or deleting the workflow that is running is refused. Deleting a whole workflow takes a second, explicit click; deleting a single step does not, and there is no undo yet.
- **Import and export.** Import always assigns a fresh ID, so it can never overwrite an existing workflow.
- **Sidebar width.** `LAYOUT.sidebar` grew to 340 px for the step list; the native browser view follows it automatically.

## Browser persistence and security

- The shell and every browser view use sandbox=true, contextIsolation=true, nodeIntegration=false and webviewTag=false. Browser pages use `persist:vestigium`; the shell uses its own nonpersistent session and alone receives preload.
- The renderer CSP starts with default-src none, permits only local scripts/styles, forbids frames, objects, base URLs and forms, and permits loopback WebSockets for Vite development. There is no unsafe-inline or unsafe-eval.
- Shell navigation, redirects, embedded webviews and new windows are blocked. Browser top-level navigation and redirects allow HTTP/HTTPS and about:blank only. External protocols, credential-bearing URLs and local file navigation are rejected; no external protocol handler is launched.
- Permission request/check handlers, device permissions and screen-capture requests are denied. Chromium web security stays enabled; no certificate exceptions are installed. Chromium's own downloads are cancelled; the download queue fetches the file through the same session (milestone 6).
- Chromium retains persistent profile data. A versioned session-only-cookie snapshot is OS-encrypted using safeStorage on clean shutdown, atomically replaced and restored before the first tab loads. It is consumed after restoration. Cookie values never enter SQLite settings, IPC or logs. Persistent-cookie expiration is not changed. Without real OS encryption, session-only persistence is disabled with a log warning. Server-side expiry still wins.
- Shutdown saves window state and cookies, flushes Chromium storage, closes views, then closes SQLite. An app instance lock prevents simultaneous access to one profile. Tests use distinct temporary profile paths; their only mode flag suppresses startup dialogs, not security checks.

## Verification

Unit tests cover empty/idempotent migrations, newer-version rejection, CRUD for each entity, settings validation/persistence, payload rejection and log rotation. Playwright Electron tests launch actual app processes with fresh profiles, close and relaunch for persistence checks, inspect the remote page for bridge/Node absence, test permission denial and compare native view bounds against the React layout after resize. The complete milestone 0 suite remains separate and unchanged in behavior.

## Milestone 0 fixture components

`tests/demo-site/server.ts` exports `createDemoServer(options): Promise<DemoServer>`. Options select two ports, seed, log directory, generated-file size, throttle, Range behavior, token lifetime, login mode and request budget. The result exposes `origin`, `hostOrigin`, and idempotent asynchronous `close()`. Port zero requests an available port. If the second listener fails, the first is closed.

Two Express applications share a single instance's in-memory session/token state. The primary origin serves scenario navigation, lists, item pages and downloads; the second hosts countdown and popup destinations. Both provide health checks, login and download endpoints. All network listeners are loopback-only.

Fixture definitions own item metadata, expected list sequences and scenario links. Rendering produces ordinary semantic HTML with links and buttons, without production automation hooks. `data-item-id` identifies fixtures for assertions; future inference must use visible content and structure rather than this attribute. CSS, scripts, metadata and archive contents are local.

The download responder streams generated bytes in bounded chunks, respects backpressure, cancels timers/writes on disconnect, and implements single-byte-range semantics. A small ZIP is generated once per instance. Expiring links and countdown tickets are validated before any download bytes are sent. Authentication is checked before protected routes. These are test server behaviors, not a production download client.

The class-mutation sequence is derived from seed plus item-render count. Move, wrapper and reorder modes make distinct, reproducible structural changes. The changing dataset mutates after its first request, including fragment requests. Sessions, tokens, counters and mutable datasets are instance-local. Tests use independent instances, browser contexts and log directories.

The logger writes structured levels and readable reasons synchronously to bounded rotating files. Shutdown destroys active connections, closes both listeners and releases state. The CLI development entry handles SIGINT/SIGTERM. There is no application CLI yet.

## Verification boundary

Playwright browser tests exercise actual navigation, overlays, list growth, downloads, login and countdown interaction. HTTP tests independently inspect statuses, headers, byte counts, SHA-256 hashes and ZIP entries, including aborted and resumed streams. Logs rotate under a small test limit. The tests establish trustworthy fixtures; they do not claim automatic crawling, self-healing or download recovery by Vestigium.

## Subsequent application components (not implemented)

- `src/main/`: workflow engine, learning, downloads and headless CLI will extend the implemented shell/storage.
- `src/recorder/`: dependency-free event capture, locator/fingerprint construction and highlights, including frames and shadow DOM.
- `src/renderer/`: workflow editor and actual queue/history controls will extend the current React shell.
- `src/shared/`: evolve the existing versioned document types as workflow behavior is implemented.

Milestone 2 introduces recording, readable workflow JSON and replay. Later milestones add inference, self-healing, durable downloads, metadata/extraction, profile repair and packaging. The supplied Python downloader is reference material only; no site-specific logic is imported.
