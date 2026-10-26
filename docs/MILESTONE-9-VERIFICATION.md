# Milestone 9 verification

**Definition of done (plan §15):** "CLI run produces the same result as the GUI run; the installer launches on a clean Windows machine."

Verified on Windows 11 Enterprise LTSC 2024 (10.0.26100) on 24 October 2026 with Node 26.8.1, Electron 45.0.0, electron-builder 26.15.3, Playwright 1.64.1 and 7-Zip.

**Status:** the first half is fully verified. For the second half, the installer was built and the app *taken from the installer* was launched and exercised here. The literal "clean machine" step could not be run on this machine (see below).

## Actual command output

### `npm run typecheck` and `npm test`

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

> vestigium@0.1.0 test:demo
> playwright test --config playwright.config.ts
  65 passed (20.6s)

> vestigium@0.1.0 test:e2e
> npm run build && playwright test --config playwright.electron.config.ts
out/main/app.cjs  217.59 kB
Running 46 tests using 1 worker
  ok  7 tests\electron\cli.spec.ts:54:1 › vestigium run produces the same files as ▶ Start in the window (17.4s)
  46 passed (6.3m)
```

### `npm run dist`

```text
> vestigium@0.1.0 dist
> npm run icon && npm run build && electron-builder --win nsis
build/icon.png written (256×256).
  • electron-builder  version=26.15.3 os=10.0.26100
  • loaded configuration  file=…\Vestigium\electron-builder.yml
  • skipped dependencies rebuild  reason=npmRebuild is set to false
  • packaging       platform=win32 arch=x64 electron=45.0.0 appOutDir=release\win-unpacked
  • using custom unpacked Electron distribution  electronDist=node_modules\electron\dist
  • building        target=nsis file=release\Vestigium Setup 0.1.0.exe archs=x64 oneClick=false perMachine=false
  • building block map  blockMapFile=release\Vestigium Setup 0.1.0.exe.blockmap
```

### `npm run test:package`

```text
> vestigium@0.1.0 test:package
> playwright test --config playwright.package.config.ts
  ok 1 tests\package\package.spec.ts:48:1 › the app from the installer starts, opens its window, browses and keeps its database (5.7s)
  ok 2 tests\package\package.spec.ts:71:1 › vestigium.cmd from the installer runs the command line (4.6s)
  2 passed (12.4s)
```

## CLI = GUI (`tests/electron/cli.spec.ts`)

1. **Teach once in the window.** On `/list?variant=aes` (password-protected archives), with template `{site}/{tag}/{title}.{ext}`, unpacking on, sidecars on, and the run limited to one page and four items.
2. **GUI run:** toolbar **▶ Start** on that list gives 4 downloads.
3. **The window is closed** (one process per profile).
4. **CLI run:** `vestigium run --profile 127.0.0.1:<port> --url …/list?variant=aes --output <other folder> --max-pages 1 --max-items 4 --force`. A real child process (the same Electron binary, the same profile, no window) exits **0** and prints `Running the … profile on …`, `Run done.`, `Opened 4 items; stopped at the limit of 4 items.`, `Downloads: 4 done, 0 failed.` and the file list.
5. **Comparison:** every file under the two `127.0.0.1` folders, compared by SHA-256: 4 archives, their unpacked `notes\readme.txt` and `notes\photo-list.txt`, and 4 sidecars. **Identical.** Sidecars are compared after normalizing their `Saved:` time and each run's own output folder in `Unpacked to:`.
6. **Other cases:**
   - `--help` exits 0 with the usage.
   - `run` without `--profile` exits 2 with "run needs --profile <site>".
   - `profiles` lists `127.0.0.1:<port>  ok  …`.
   - An unknown site exits 3 with "No site profile for nowhere.test. Saved profiles: 127.0.0.1:<port>."
   - Reopening the window shows both runs in the History.

## The installer

- **Contents:** `npm run dist` builds `release\\Vestigium Setup 0.1.0.exe` (NSIS 3, x64, per user, about 109 MB). 7-Zip lists its payload `$PLUGINSDIR\\app-64.7z`, which contains `Vestigium.exe`, `vestigium.cmd`, `resources\\app.asar`, and `resources\\app.asar.unpacked\\…\\better-sqlite3\\prebuilds\\win32-x64.node` (the only native binary).
- **`npm run test:package`** extracts that payload into a temporary folder (exactly the files an install gets) and runs it:
  - `Vestigium.exe` starts with a fresh profile and opens its window, with `app.isPackaged` true. It browses to the demo list, and the profile gets `vestigium.sqlite` and `logs`, so the packaged native module loads.
  - `vestigium.cmd --help` exits 0. `vestigium.cmd profiles` exits 0 ("No site profiles yet").
  - `vestigium.cmd run --profile nowhere.test --url http://…/list?x=1 --max-pages 1` exits 3 with the readable message. That is a URL followed by more options, which only works thanks to the shim's `--`.

### What was not verified, and how to do it

- **No clean-machine install yet.** Nothing was installed into this machine's user account: a silent per-user install would have created shortcuts on your real desktop and Start menu. Windows Sandbox (a clean, disposable Windows) is not enabled here, and enabling it needs administrator rights and a reboot. To check on a clean machine:
  1. Enable Windows Sandbox: Settings → System → Optional features → More Windows features → "Windows Sandbox", then reboot.
  2. Start Windows Sandbox and copy `release\\Vestigium Setup 0.1.0.exe` into it.
  3. Run the installer. SmartScreen warns, because it is unsigned: choose "More info" → "Run anyway".
  4. Start Vestigium from the Start menu: the window should open. In a terminal: `"%LOCALAPPDATA%\\Programs\\vestigium\\vestigium.cmd" --help`.
- **Not code-signed.** There is no certificate, so SmartScreen warns on first run.

## Bugs found by this milestone's tests

- **The CLI died silently with −1 when `--url` was followed by more options.**
  - **Root cause:** Electron's CVE-2018-1000006 guard (`shell/app/command_line_args.cc`) refuses to start when any argument follows a URL-like one, unless `--` comes first.
  - **How it was found:** narrowed by replaying the command from Node and from bash, by argument and by argument order, then confirmed in Electron's source. An earlier suspicion of timing was tested and ruled out.
  - **The fix:** every launcher passes `--` first, and the parser skips it.
- **"Done" appeared before the sidecar was written** (found by the milestone 8 full run, fixed in its commit): jobs now stay "verifying" until unpacking and the sidecar are finished.
- **`npm install` and the native SQLite binary:** installing electron-builder made npm 11 skip unapproved install scripts, `better-sqlite3`'s among them. It is harmless here, because better-sqlite3 13 loads a prebuilt Node-API binary (`prebuilds/win32-x64.node`) that works under Electron; the unit tests passed after the install. `build/Release` was never used.

## Changed behavior worth knowing

- **New:**
  - The `src/main/cli/` command line, with `npm run cli`.
  - `electron-builder.yml`, `build/icon.png` (generated by `npm run icon`), `build/vestigium.cmd`, `npm run dist`, and `npm run test:package` with its own Playwright config.
- **The tray icon** is drawn at any size; the same mark is the app and installer icon.
- **Dependencies:**
  - `express`, `yazl`, `react` and `react-dom` moved to dev dependencies. Runtime dependencies are now only `better-sqlite3` and `zod`.
  - `electron-builder` 26.15.3 was added, pinned exactly.
- **Shutdown** exits with the command's exit code in CLI mode.

## Known limits

- **The installer is unsigned**, and the clean-machine install is a manual step (above).
- **Leftover file:** Electron's inert `default_app.asar` is copied from the development Electron.
- **Windows x64 only.**
- **One process per profile:** the CLI cannot run while the window is open with the same profile (exit 3; set `VESTIGIUM_USER_DATA` for another profile).
- **When a run needs a person,** the CLI opens the window and waits up to 15 minutes, like the app.
