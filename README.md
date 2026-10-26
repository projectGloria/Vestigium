# Vestigium

A desktop app intended to learn a browsing/download workflow from one demonstration. **Milestones 0–9 are implemented (all of the plan):** the adversarial demo site; the Electron/React shell with persistent browser tabs, typed IPC, SQLite storage and settings; recording a demonstration into readable workflow JSON; replaying it; and editing it in the UI. Since milestone 3, replay waits for pages and elements to settle, clicks with real OS-level input in the main frame, dismisses cookie banners that cover a target, and heals steps whose element changed, flagging them for your review. Since milestone 4, a workflow can repeat on every page of a list: open the list's first page and press **↻ Repeat on every page**. Vestigium finds the Next link or button, numbered pages, a "Load more" button or infinite scrolling, and stops at the end. Since milestone 5, teaching ONE item is enough: open a list, press **● Teach**, open one item and click its download link, then stop. Vestigium recognizes the item as one of the list's items, turns the recording into "for every page → for every item → download", and shows a plain-language summary. **◎ Show items on the page** highlights every item it found; untick any to leave them out. A run opens each item in its own tab, skips items it already did, and reports failed items without stopping. Since milestone 6, files are really downloaded: a persistent queue fetches each file through the browser's session (so logins apply), resumes partial files with HTTP Range after a pause, a network drop or even a crash, retries with backoff, checks every file (size, ZIP test, not an error page) and skips items and files it already has. Files land in `Downloads\Vestigium\<site>\`; the **Queue** tab shows progress, speed and time left, with pause, resume, cancel and retry per file or for all. Since milestone 7, each item page's details (title, tags, date, author, and the password under labels like Password, Pass, Unzip password or Şifre) are saved with the file in `<name>_info.txt`; **Download options** sets the file names from a template such as `{site}/{tag}/{title}.{ext}` and can unpack archives with the captured password (ZIP built in, including AES; 7z/RAR when 7-Zip is installed). Since milestone 8, a run that hits a countdown, a captcha or a login **pauses for you** ("Needs you"), brings the window forward with the element highlighted, and **continues by itself** once you are done (Vestigium never clicks a captcha). Teaching one item on a list also saves a **site profile**: next time, open any list of that site and press **▶ Start**. A failed step comes with a screenshot and **↻ Re-teach this step**, which records only that step again. Runs are kept in the History tab across restarts; clicks that read like buying, paying or deleting wait for your OK; an optional allowlist limits which sites a run may use; a tray icon can keep Vestigium working while minimized.

## Install

`npm run dist` builds `release/Vestigium Setup 0.1.0.exe`, a per-user Windows installer. It is not code-signed, so Windows SmartScreen asks for confirmation the first time ("More info" → "Run anyway"). `npm run test:package` checks the app inside that installer after a build.

## Command line

The same engine without the window, using the app's saved site profiles, settings and logins (close the window first: one process per profile):

```powershell
vestigium run --profile example.com --url "https://example.com/list" --output D:\Downloads\example --max-pages 5 --force
vestigium profiles
vestigium --help
```

`vestigium` is the `vestigium.cmd` next to `Vestigium.exe` in the install folder. In development, use `npm run cli -- run --profile …`. The run prints its progress, waits for its downloads, and exits with 0 (done), 1 (something failed), 2 (wrong arguments) or 3 (could not start). If a page needs you (captcha, login, countdown), the window opens and the run waits. Call `Vestigium.exe` directly only with `--` before the command: Electron refuses to start when anything follows a URL argument otherwise.

## Run the desktop app

The toolchain is pinned: Node **26.8.1** (`.nvmrc`), npm **11.19.0**, Electron **45.0.0**, electron-vite **6.0.0**, Vite **8.3.5**, React **19.3.1**, better-sqlite3 **13.0.3**. Direct dependencies and the lockfile use exact versions.

```powershell
npm ci
npx playwright install chromium
npm run dev
```

For the production build:

```powershell
npm run build
npm start
```

Enter an HTTP/HTTPS address and press Go. Back, Forward and Reload control the active browser tab. Popups become managed tabs; each tab has a close button. The Light/Dark button persists your theme. Press **● Teach**, do the task once in the current tab, then press **■ Stop recording**. The steps appear in the Workflow panel in plain language. From there you can rename the workflow, relabel, disable, reorder or delete steps, inspect each step's ranked locators, and export or import the workflow as JSON. **▶ Run** replays the selected workflow in the current tab. The mode menu next to it offers **Step by step** (pause before each step: ⏭ Next step / ▶ Resume) and **Dry run** (highlight targets without clicking). **❚❚ Pause** and **■ Stop run** work during a run. A step that had to be healed shows "⚠ Healed during a run" with **Keep new locators** and **Undo heal**. Results appear on each step and in the History tab, including which locator matched. Password and payment fields are never recorded. Downloads you start yourself, and every download of a run, go to the **Queue** tab: **Pause all / Resume all**, **Cancel all**, **Retry failed**, **Force** (download items again even if already downloaded), how many downloads run at once, **Open folder** and **Change folder…**. A file identical to one already saved is not stored twice. While teaching, the download is recorded but not saved. Site profiles are still a placeholder for milestone 8.

**Ad blocking.** Browser tabs block ads, trackers and ad popups with the EasyList, EasyPrivacy and uBlock Origin filter lists (network requests only; nothing is injected into pages). It is on by default; Settings → **Safety, ads and tray** turns it off and shows how many filters are loaded and how many requests were blocked. The lists ship with the app and refresh weekly into the profile (`adblock/`). Your own downloads are never blocked. Ad networks that rotate to brand-new domains can still open a popunder until the lists catch up. `npm run filter-lists` refreshes the copy bundled with the app.

### Persistent data and native SQLite

The main process creates `vestigium.sqlite` in Electron's OS user-data directory (Windows: `%APPDATA%/Vestigium`; macOS: `~/Library/Application Support/Vestigium`; Linux: `$XDG_CONFIG_HOME/Vestigium`, usually `~/.config/Vestigium`). Browser data uses the `persist:vestigium` partition inside that directory. Logs rotate under `logs/` at 1 MiB with three backups; the UI shows the latest 200 entries.

Chromium persists the browser profile. On clean shutdown, session-only cookies are additionally saved to `session-cookies.enc` using Electron safeStorage OS encryption and restored before browsing on the next launch. Persistent-cookie expiration is not extended. The session snapshot is consumed after restoration so an old snapshot cannot resurrect a logged-out session following a crash. Without an OS encryption backend (including Linux `basic_text`), the app logs a warning and does not save session-only cookies. This milestone guarantees a clean close/relaunch, not crash recovery of session cookies. A website can still expire/revoke its server-side session.

`npm ci` runs `postinstall`, which calls `electron-rebuild -f -w better-sqlite3` for the **pinned Electron ABI**, not the host Node ABI. If Electron or dependencies change, run `npm run native:rebuild`. If no matching prebuilt native binary is available, Windows requires Python and Visual Studio Build Tools with the C++ workload. Do not run `npm rebuild better-sqlite3` for host Node: it can replace the Electron-compatible binary. Unit tests run under Electron's Node mode so they use the same native ABI as the application.

`VESTIGIUM_USER_DATA` can select a separate absolute profile directory for development/testing. Tests create isolated temporary profiles and keep the demo server alive across app restarts. `VESTIGIUM_DOWNLOADS` sets the default download folder (tests point it into their temporary profile). `VESTIGIUM_7ZIP` points to 7-Zip's `7z.exe` if it is not in Program Files. `VESTIGIUM_FILTER_LISTS` replaces the bundled filter lists with another folder (a `manifest.json` with `fetchedAt` plus `*.txt` lists) and disables refreshing; `VESTIGIUM_FILTER_REFRESH=off` only disables refreshing (tests set it). `VESTIGIUM_TEST=1` suppresses only blocking startup error dialogs and desktop notifications; errors still go to stderr and the application log, and startup failure exits nonzero.

## Run the demo

From another terminal, using the pinned toolchain:

```powershell
npm ci
npx playwright install chromium
npm run demo
```

Open <http://127.0.0.1:4173>. The second local origin is <http://127.0.0.1:4174>. Both bind only to `127.0.0.1`. Press Ctrl+C to stop both servers. Dependencies/browser installation needs internet; running the demo does not.

The index links every scenario. Dismiss the cookie overlay to interact. Each origin stores its own dismissal preference. No external assets, telemetry or production credentials are used.

## Scenarios

| Scenario | Route / behavior |
| --- | --- |
| Paginated cards / table | `/list`, `/list?layout=table`: 47 distinct items, 10 per page, five pages, disabled Next at the end |
| Infinite scroll / Load more | `/list?mode=infinite`, `/list?mode=more`; combine either with `layout=table` |
| SPA pagination / wrapping | `/list?mode=spa`: a Next button swaps items in place without changing the URL; `/list?wrap=1`: the last page's Next link points back to page 1 |
| Single / empty | `/list?dataset=single` (7 items), `/list?dataset=empty` (0 items) |
| Broken item link | `/list?broken=3`: item 3's link points to a page that does not exist (per-item failure) |
| Captcha | `/item/N?variant=captcha`: the download goes through a host page with a stand-in captcha that only a person's click clears |
| Short link | `/item/N?variant=shortlink`: the download opens a link-shortener popup (like ouo.io) whose first "Get Link" button is the captcha (`.g-recaptcha`); the next page counts down 3 s, then its own "Get Link" (same id and name) downloads |
| Risky button | `/confirm`: a "Delete this note" button (nothing is deleted) |
| Ads | `/ads`: a banner script from the second origin (`/demo-ads/banner.js`) inserts an ad and opens a popunder on the first click; "Visit our sponsor" opens an ad page from an inline script. `tests/demo-site/filter-lists` blocks `/demo-ads/` |
| Dead download in a list | `/list?dead=3`: item 3's page exists, but its download link is dead (404) |
| Protected archives | `/files/encrypted` (ZipCrypto ZIP), `/files/aes` (AES-256 ZIP), `/files/sevenzip` (encrypted 7z), all made with 7-Zip, password `vestigium-demo`; `/list?variant=aes` makes every item serve one |
| Metadata layouts | `/item/N?meta=table` or `?meta=inline` shows the item's details as a table or as "Label: value" lines instead of a definition list |
| Duplicates | `/list?dataset=duplicates`: 49 occurrences, 47 unique IDs; IDs 9 and 10 repeated on page 2 |
| Changing list | `/list?dataset=changing`: after the first request, remove 11, move 20 to the front, append new item 48 |
| Item / ZIP | `/item/1`; the real ZIP contains `readme.txt` |
| External host / popup | `/item/1?variant=countdown`, `/item/1?variant=popup` |
| Dead / HTML error | `variant=dead` gives 404; `variant=html` gives 200 with `text/html` and an error document |
| Expiring link | `variant=expiring`; reload the item page for a fresh token after 410 |
| Generated file | `variant=large`: 64 MiB by default; append `&throttle=65536` for 64 KiB/s or `&range=off` to ignore Range |
| Filename sources | `variant=disposition`, `variant=url`, `variant=none` |
| Filename edge cases | `variant=unicode`, `variant=long`, `variant=invalid`; candidate names are intentionally unsanitized headers |
| DOM changes | `mutate=classes`, `move`, `wrap`, `reorder`, or `all` on an item URL; `mutate=label` renames the button to "Download ZIP file" (not part of `all`) |
| Login | `/list?login=1`; fictional credentials **demo / vestigium** |
| Recorder lab | `/lab`: search box submitted with Enter, `<select>`, password field, open-shadow-root widget, same-origin and cross-origin iframes (`/lab/frame`), `pushState` routes (`/lab/spa/one`, `/lab/spa/two`), nested scroll area, and a "Trusted action" button that reports whether a click was trusted input |

Lists include similar popular-post cards outside the main collection, header/footer links and the overlay. The changing scenario is stateful per server instance: restart the server to reset it. Its sequential five-page crawl returns 47 occurrences, including ID 10 twice and item 48 at the end; it misses removed 11 and relocated 20. Expected sequences are exported by `tests/demo-site/fixtures.ts` so future crawler tests can distinguish duplicates and unavoidable offset-pagination omissions.

Items 1–5 respectively use `Password:`, `Pass:`, `Unzip password:`, `Şifre:`, and no password. Labels repeat across the dataset. The metadata password is `vestigium-demo`; the small ZIP is intentionally unencrypted. Encryption/extraction behavior belongs to milestone 7. Items include author, tag and date metadata.

The countdown is enforced on the server for five seconds, then requires a manual Continue click. Direct access before readiness gives 425; a missing ticket gives 403. The popup automatically initiates a real browser download in the new tab. Tabs remain open for inspection.

Login sessions allow five protected requests by default. Protected document and download requests consume the limit; health, assets and login do not. Explicit `login=1` is propagated by list/item/host links. Global login mode protects routes without a query flag. Expiry redirects to login with a local return destination. Sessions are in memory; restarting the demo intentionally resets them. Persistent application sessions are milestone 1.

## Configuration

Set environment variables before `npm run demo`, for example:

```powershell
$env:DEMO_THROTTLE_BPS = '262144'
$env:DEMO_SESSION_REQUESTS = '3'
npm run demo
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEMO_PORT` / `DEMO_HOST_PORT` | `4173` / `4174` | Main and file-host TCP ports |
| `DEMO_SEED` | `1` | Reproducible class-mutation sequence |
| `DEMO_LARGE_BYTES` | `67108864` | Generated file size |
| `DEMO_THROTTLE_BPS` | `0` | Bytes/second; zero is unthrottled; URL `throttle` overrides it |
| `DEMO_RANGE` | on | Set `off` to disable Range globally; URL `range=off` also disables it |
| `DEMO_TOKEN_TTL_MS` | `5000` | Expiring-link lifetime |
| `DEMO_SESSION_REQUESTS` | `5` | Successful authenticated request budget |
| `DEMO_LOGIN` | off | Set `1` to require login globally |

HTTP Range supports bounded, suffix and open-ended single ranges, If-Range ETags and 416 with total size. Range-disabled responses return the full body with 200. Generated byte at offset `n` equals `n % 251`, enabling independent integrity checks. Streaming honors backpressure and stops on client disconnect. The fixture supports resumable responses; it does not implement the future download manager.

## Verification

```powershell
npm run typecheck
npm test
npm run test:unit
npm run test:demo
npm run test:http
npm run test:e2e
```

`npm test` runs application unit tests, every milestone 0 test, then a production build and Playwright Electron tests. `test:e2e` tests the Electron app; `test:demo` retains the entire original browser/HTTP demo suite. No manually running server is required. Electron tests verify login after full process restart, fresh-profile isolation, managed popups, browser sandbox/bridge separation, rejected IPC, permissions, settings and native-pane resizing. `test:unit` bundles every `tests/app-unit/*.test.ts` file (no manual list). Unit tests cover migrations, repository CRUD, validation and log rotation. Demo tests retain all original download and list scenarios. Screenshots, traces and per-test server logs go to ignored `test-results/`.

Manual servers write JSON-lines logs under `.demo-logs/<instance>/demo.log`, rotating at 1 MiB with three backups. Logs contain levels, HTTP status and readable errors; query tokens, passwords and cookie values are not logged.

See [architecture](docs/ARCHITECTURE.md) for process boundaries, IPC, schema and security decisions. Each milestone's evidence is in `docs/MILESTONE-N-VERIFICATION.md`.
