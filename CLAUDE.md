# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Vestigium is an Electron desktop app that learns a browse-and-download workflow from a single demonstration and then runs it across every item on every page. The full spec lives outside the repo at `C:\Users\Nihil\Desktop\Vestigium Plan.md` (milestones 0–9, schemas, edge cases, definitions of done). **Milestones 0–9 are done (the whole plan)** (demo site; shell, persistent profile, SQLite; recorder, workflow JSON, multi-locator replay, workflow UI; smart waits, self-healing with review, trusted clicks, run/step/dry modes, pauses, pacing; pagination detection and `loop_pages`; item pattern inference, automatic generalization of a one-item recording, `loop_items`, item highlighting with exclusions; download interception, the resumable persistent download queue, verification, dedupe and history; item details captured from pages, filename templates, `_info.txt` sidecars, unpacking ZIP (ZipCrypto/AES) built in and 7z/RAR through 7-Zip; "Needs you" pauses for captchas, logins and countdowns that continue by themselves, site profiles with Start and health, re-teaching one step, failure screenshots, persistent run history, safety confirmations and an allowlist, clipboard link, tray; the `vestigium run` command line and the NSIS installer). The user asked to keep going through the milestones without stopping until they say otherwise. Each milestone has its evidence in `docs/MILESTONE-N-VERIFICATION.md`. 

Rules from the plan that govern every change:
- Do one milestone at a time. Stop after each one, summarize it, and wait for the user before starting the next.
- Don't write placeholder, mock or TODO implementations of core logic. Name anything deferred explicitly.
- A milestone isn't done until its tests pass and its acceptance check has been run in the real app. Record the evidence in `docs/MILESTONE-N-VERIFICATION.md` with the actual command output.
- Update `docs/ARCHITECTURE.md` and `README.md` every milestone.
- Non-goals: captcha solving, bot-protection or paywall bypass, proxy rotation, cloud sync, telemetry. For captchas, countdowns and logins, pause for the human.
- The user's old Python downloader is reference material only. Never port its site-specific scraping.

## Commands

The toolchain is pinned with exact versions: Node 26.8.1 (`.nvmrc`), npm 11.19.0, Electron 45, electron-vite 6, Vite 8, React 19.3, TypeScript 7, better-sqlite3 13. Keep dependencies exact-versioned.

```bash
npm ci && npx playwright install chromium   # postinstall rebuilds better-sqlite3 for Electron's ABI
npm run dev          # electron-vite dev (HMR renderer)
npm run build        # -> out/main/app.cjs, out/preload/index.cjs, out/renderer
npm start            # preview the production build
npm run demo         # demo site on 127.0.0.1:4173 (+ second origin :4174)
npm run typecheck    # tsc --noEmit
npm test             # test:unit + test:demo + test:e2e (full suite)
npm run test:unit    # tests/app-unit via Electron-as-Node (see below)
npm run test:demo    # Playwright, all tests/**/*.spec.ts except tests/electron
npm run test:http    # only tests/unit (HTTP/download fixture tests)
npm run test:e2e     # builds, then Playwright Electron tests (workers: 1)
npm run cli -- run --profile <site> …   # the command line (development build)
npm run dist         # icon + build + electron-builder → release/Vestigium Setup <version>.exe
npm run test:package # after dist: launches the app extracted from the installer (needs 7-Zip)
```

Running a single test:
```bash
npx playwright test tests/e2e/site.spec.ts -g "test name" --config playwright.config.ts
npm run build && npx playwright test --config playwright.electron.config.ts -g "test name"
```

Native module gotcha: better-sqlite3 is compiled against the **Electron** ABI. Never run `npm rebuild better-sqlite3`, because it swaps in a host-Node binary. Use `npm run native:rebuild` instead. For the same reason, `scripts/test-unit.mjs` finds every `tests/app-unit/*.test.ts`, bundles them with esbuild into `.unit-build/` and runs them with `node:test` under `ELECTRON_RUN_AS_NODE=1`.

Environment variables: `VESTIGIUM_USER_DATA` points the app at an isolated profile directory, which tests use. `VESTIGIUM_TEST=1` suppresses only the blocking startup error dialogs. Demo-server settings (`DEMO_PORT`, `DEMO_SEED`, `DEMO_THROTTLE_BPS`, `DEMO_RANGE`, `DEMO_LOGIN`, and others) are documented in README.md.

## Architecture

**Process boundaries.** The Electron main process owns the window, the browser tabs, SQLite, logging and settings. React (`src/renderer`) only draws the app chrome. Its source never imports Electron or Node, and it never touches the filesystem or the DB.
- **Typed IPC is the only bridge.** `src/shared/ipc.ts` defines every channel, the payload map, the `Result` union, the `Bridge` interface and the `LAYOUT` geometry constants. The sandboxed preload (`src/preload`) exposes only `window.vestigium`, with no generic invoke. `src/main/ipc.ts` checks that each sender is the exact shell WebContents, main frame and shell URL, then validates the payload with zod (`src/main/validation.ts`, strict schemas with no extra keys). To add a command, update all four places: `CHANNELS`, `Payloads`, `Bridge`/preload, and the zod schema plus the switch in `registerIpc`. Main pushes full `AppState` snapshots on `vestigium:changed`.
- **Browser pane.** `src/main/browser/tabs.ts` (`TabManager`) shows each tab as a native `WebContentsView`, not BrowserView or `<webview>`. View bounds come from the same `LAYOUT` constants the React layout uses, so changing the UI layout means changing `LAYOUT`. Popups are adopted as managed tabs, never as extra BrowserWindows. Browser pages run in the `persist:vestigium` partition with sandbox on. The only script added to them is the recorder: a session-registered frame preload (`src/recorder/preload.ts`, built to `out/preload/recorder.cjs`). It runs in Electron's isolated world in every frame and exposes nothing to the page. Web pages must never get the shell bridge. The shell uses a separate in-memory `vestigium-shell` session. `BrowserHooks` (`onNavigate`, `onPopup`) feed both the recording session and the runner.
- **Session persistence** (`src/main/browser/session.ts`). Chromium persists the profile itself. On clean shutdown, session-only cookies are also saved with `safeStorage` encryption to `session-cookies.enc`, then restored and **deleted** on the next start. This is deliberate, so a crash can't bring back a stale session. Permissions are denied on both sessions. `will-download` cancels Chromium's own download; `src/main/downloads/` fetches the file itself through `session.fetch` (with `credentials: 'include'`) into `.part` files, resumable and persistent (see `docs/ARCHITECTURE.md`, "Downloads"). Passwords captured from pages go to the item record and the sidecar, never into log lines. Ad blocking (`browser/ad-blocker.ts`) is network-only and runs inside `NetworkMonitor`'s `onBeforeRequest`: Electron keeps one listener per webRequest event per session, so never register a second one (or Ghostery's `ElectronBlocker`). Electron tests set `VESTIGIUM_FILTER_REFRESH=off` (no list downloads); `VESTIGIUM_FILTER_LISTS` pins a list folder (`tests/demo-site/filter-lists` blocks the demo's `/demo-ads/`). Every CLI launcher must pass `--` before the command (Electron's CVE-2018-1000006 guard refuses any argument after a URL otherwise). Vestigium must never click or record a captcha (recorder skips captcha widgets and provider frames; runs pause for a person). Electron test launches stub `clipboard.readText` (tests set `globalThis.__testClipboard`): never read or write the machine's real clipboard in tests. The demo's protected archives in `tests/demo-site/archives/` were made with 7-Zip on purpose (an independent encoder); regenerate them with 7-Zip, not with our own code. Electron tests set `VESTIGIUM_DOWNLOADS` so files stay inside the temporary profile; to simulate a crash, kill the whole process tree (`taskkill /T /F`): `app.process()` is only a launcher.
- **Storage** (`src/main/store`). SQLite runs in WAL mode with `synchronous=FULL`. Numbered, transactional migrations are recorded in `schema_migrations`, and the app refuses to open a DB created by a newer version. Each entity table (`workflows`, `site_profiles`, `items`, `download_jobs`, `run_log`) stores a versioned JSON `document` column through the generic `DocumentRepository`, and every record needs `schemaVersion: 1`. Settings are a `{schemaVersion, value}` envelope, validated with zod on read and on write. Entity types live in `src/shared/types.ts` and follow the plan's schemas. Add relational columns or indexes through new migrations when behavior needs them, for example dedupe by URL or file hash.
- **Shutdown order** (`src/main/app.ts`): save window bounds and cookies, remove IPC, stop any run, the replay bridge and the recorder, dispose the tabs, then close the DB. Each step is isolated so one failure cannot block quitting. A single-instance lock guards the profile.
- **Recording, replay and edits.** These all go through main: `browser/recording.ts` turns validated recorder events into steps via the pure `learn/step-compiler.ts`; `engine/workflow-runner.ts` replays them via `engine/locator-resolver.ts`; and `engine/workflow-library.ts` saves, edits (`engine/workflow-edit.ts`), imports and exports workflows. Position-based locators must never override a step's recorded role/name or text (`src/recorder/resolve.ts`). See `docs/ARCHITECTURE.md` for the rules.
- **Logging.** `src/main/logger.ts` writes rotating files (1 MiB × 3) under `userData/logs`. The UI shows the last 200 entries. Messages must be readable to a human and must never contain cookie values, tokens or passwords.

**Demo site** (`tests/demo-site`). `createDemoServer({port: 0, hostPort: 0, ...})` runs two Express apps on loopback, one for the main origin and one for a "file host" origin used for countdowns and popups. It covers every scenario the plan's e2e tests need: pagination, infinite scroll, load more, duplicate and changing lists, ZIP items, countdown, popup, dead and HTML-error links, expiring links, Range and throttle, filename edge cases, `mutate=` DOM changes for self-healing, and login. README.md has the route table. `tests/demo-site/fixtures.ts` exports the expected item sequences that crawler tests should assert against. Inference code must work from visible content and structure. **`data-item-id` exists only for test assertions** and must never feed the learning logic. The Playwright fixture in `tests/support.ts` starts a fresh demo instance on random ports for each test.

**Test layers.** `tests/app-unit` covers main-process modules (node:test under Electron). `tests/unit` runs Playwright HTTP tests against the demo downloads. `tests/e2e` runs Playwright Chromium against the demo site; `recorder.spec.ts` injects the production recorder core with a stub transport (`recorder-harness.ts`). `tests/electron` launches the real built app with temporary profiles; new specs use `tests/electron/fixtures.ts`, which copies the app log into the test output on failure. Native dialogs are stubbed in the main process via `app.evaluate`. Per the plan, `learn/` and `downloads/` have unit tests (`tests/app-unit/downloads.test.ts` runs the queue against a real demo server), and every e2e test runs against the demo site.

## Layout

`src/main/`: `browser/` (session, tabs, recording), `engine/` (runner, resolver, workflow library and edits, site profiles, run history), `learn/` (step compiler, generalization, pagination, metadata), `downloads/` (queue, transfer, verification, ZIP, unpacking, names, sidecars), `cli/` (command line), `store/` (SQLite). `src/recorder/` is the injected script; it must stay dependency-free and keep working in iframes and shadow DOM. `docs/ARCHITECTURE.md` describes each part, one section per milestone.
