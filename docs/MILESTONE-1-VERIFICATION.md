# Milestone 1 verification

Verified on Windows on 23 October 2026 with Node 26.8.1, Electron 45.0.0 and better-sqlite3 13.0.3. The native Electron rebuild completed successfully. No milestone 2 functionality was implemented.

## Actual command output

```text
> vestigium@0.1.0 typecheck
> tsc --noEmit

> vestigium@0.1.0 test
> npm run test:unit && npm run test:demo && npm run test:e2e

> vestigium@0.1.0 test:unit
> node scripts/test-unit.mjs
ℹ tests 7
ℹ pass 7
ℹ fail 0
ℹ duration_ms 888.7876

> vestigium@0.1.0 test:demo
> playwright test --config playwright.config.ts
Running 33 tests using 4 workers
33 passed (11.6s)

> vestigium@0.1.0 test:e2e
> npm run build && playwright test --config playwright.electron.config.ts
vite v8.3.5 building ssr environment for production...
out/main/app.cjs  23.01 kB
✓ built in 30ms
out/preload/index.cjs  1.17 kB
✓ built in 18ms
vite v8.3.5 building client environment for production...
✓ built in 108ms
Running 6 tests using 1 worker
6 passed (10.4s)
```

All commands exited successfully. The full npm test transcript was retained locally in `artifacts/milestone-1-tests.txt`. A final screenshot check strengthened Reload synchronization to wait for the page load event; its targeted rerun passed: `1 passed (2.2s)`.

## Acceptance evidence

- The app opens with every requested panel and real log entries; SQLite exists with its format header. Unit tests verify all six tables, migration history, WAL, idempotence, CRUD and settings durability.
- An Electron browser tab signs into the original demo login fixture, the application fully closes, and a new process using the same profile restores the logged-in page. The cookie remains absent from plaintext in the encrypted snapshot. A fresh profile reaches the login form.
- A popup is adopted as a second managed tab while exactly one BrowserWindow remains. Closing active/inactive/last tabs behaves correctly. Back, Forward and Reload work.
- The remote page and popup report no preload bridge or Node globals. Runtime process metrics confirm sandboxing on Windows. Bad IPC payloads are rejected; shell navigation is blocked; notification permission is denied.
- Light theme, last URL and window bounds survive a full restart. Native browser view bounds match the React browser region after resizing.
- All 33 milestone 0 tests pass unchanged in behavior.

`npm run dev` was also launched and checked through a separate isolated Electron smoke run: `Development smoke passed: styled React shell, typed IPC, no console errors.` Shell and browser-page screenshots were inspected separately; Electron's shell capture does not composite the child WebContentsView surface.

## Limits

Windows was exercised; macOS/Linux execution and installer packaging were not tested in this milestone. Session-only cookie recovery is guaranteed for clean shutdown with an available OS encryption backend; websites can still expire sessions. Downloads are intentionally disabled until a later milestone. Recorder, execution engine, inference, queue processing and application CLI remain unimplemented.
