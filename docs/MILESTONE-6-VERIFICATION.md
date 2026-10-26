# Milestone 6 verification

**Definition of done (plan §15):** "Killing the app mid-download and reopening resumes the queue and partial files; the dead link doesn't block the rest."

Verified on Windows on 23 October 2026 with Node 26.8.1, Electron 45.0.0, Playwright 1.64.1.

## Actual command output

```text
> vestigium@0.1.0 typecheck
> tsc --noEmit

> vestigium@0.1.0 test
> npm run test:unit && npm run test:demo && npm run test:e2e

> vestigium@0.1.0 test:unit
> node scripts/test-unit.mjs
ℹ tests 59
ℹ pass 59
ℹ fail 0
ℹ duration_ms 3182.4531

> vestigium@0.1.0 test:demo
> playwright test --config playwright.config.ts
Running 59 tests using 4 workers
  59 passed (19.1s)

> vestigium@0.1.0 test:e2e
> npm run build && playwright test --config playwright.electron.config.ts
out/main/app.cjs  159.59 kB
out/preload/index.cjs      3.33 kB
out/preload/recorder.cjs  57.69 kB
Running 36 tests using 1 worker
  ok  7 tests\electron\downloads.spec.ts:22:1 › killing the app mid-download and reopening it resumes the queue and the partial file (13.6s)
  ok  8 tests\electron\downloads.spec.ts:57:1 › a dead download link marks its item and never blocks the rest; a second run skips what is already downloaded (12.6s)
  ok  9 tests\electron\downloads.spec.ts:92:1 › the queue UI pauses, resumes and shows files; downloads behind a login, from popups and with odd names work (10.2s)
  36 passed (5.7m)
```

The full transcript is kept locally in `artifacts/m6-tests.txt` (ignored by git).

## Acceptance evidence (real built app, `tests/electron/downloads.spec.ts`)

| Scenario | How | Result |
| --- | --- | --- |
| **Kill mid-download, reopen** | A 4 MB file throttled to 500 KB/s, started by clicking its link. At more than 1 MB, the whole process tree is hard-killed (`taskkill /T /F`, nothing saves), then the app is relaunched on the same profile. | The log shows `Resuming the download queue: 1 download (1 interrupted by the last shutdown).` and `Resuming "generated.bin" at …`. The job ends `done` with 4,194,304 of 4,194,304 bytes in `downloads\127.0.0.1\generated.bin`. Its SHA-256 equals the server's bytes, so the second half was appended at exactly the right offset. The demo server's only completed `/files/large` response is a **206** (the range request). The parts folder is empty afterwards. Screenshot `queue-downloading.png` shows 1.3 of 4.0 MB, 457 KB/s and 7 s left before the kill. |
| **Dead link in a crawl** | Teach one item on `/list?dead=3` (item 3's download link returns 404), then run one page. | Item 3 fails at once with `The download link led to an error page (HTTP 404) instead of a file.` The run is `done` in about 13 s, not after a 60 s timeout. Loop result: `Opened 9 items; 1 failed ("Field Notes 03": …)`. The queue finishes 9 downloads (one file on disk, 8 identical copies recorded as such). The item is marked `no_download`. |
| **Second run** | Same workflow again. | `All 1 item failed (9 already downloaded). First: …`. The 9 downloaded items are not even opened; only the item without a download is tried again. |
| **Queue UI** | A throttled file, then a login, odd names and a popup. | **Pause** in the row: `Paused` with part of the file kept. **Resume**: `Resuming "generated.bin" at …`, then `Done`, and a **Show** button appears. A file behind the demo login downloads (without the session's cookies the host would send its login page, which fails the HTML check). `CON<notes>:"draft"\|?*.zip` becomes `CON_notes___draft____.zip` and is recorded as identical to an earlier file. The Unicode name `İstanbul-雪-مرحبا.zip` is kept. A download that a popup on the second origin starts by itself is queued and completed. Screenshot `queue-panel.png`. |
| **Crawl of 47 items** (`items.spec.ts`) | Teach one item, Run. | 47 download results. The queue finishes 47 jobs: one `field-notes.zip` on disk, 46 recorded as identical copies (every demo item serves the same ZIP bytes). |

### Unit tests (`tests/app-unit/downloads.test.ts`, against a real demo server)

- **Names:** RFC 5987 `filename*` wins over `filename`; quoted, plain and ISO-8859-1 forms work; the order is Content-Disposition, then the URL, then Chromium's suggestion, then the title plus a MIME extension. Windows rules covered: invalid characters, reserved names, trailing dots, the bidi-override trick, 150 characters without splitting surrogate pairs, `(2)`/`(3)` collisions.
- **Transfer:**
  - A whole file, then a Range resume that continues a 100 KB part exactly.
  - No Range support: restarts from zero.
  - Stale If-Range: the server sends the whole file; nothing is spliced.
  - A complete part (416, `*/size` equals the offset): no re-download.
  - A part longer than the file: restart.
  - Classified failures: 404 dead, 410 expired, a `text/html` error page, a refused connection (retryable).
  - Aborted mid-stream: the part keeps its bytes, and the next attempt resumes at that offset.
- **Verification:**
  - A two-entry ZIP (deflated and stored) passes.
  - One flipped byte: "checksum does not match".
  - A truncated archive: "no end record".
  - Empty, wrong size and a disguised HTML page all fail.
  - A RAR file: signature only.
- **Queue:**
  - Dead, large, ZIP and two more copies of the same ZIP under odd names: the dead link fails alone (item `no_download`), the copies point at the first file, the parts folder ends empty, and the batch ends with `Download queue finished: 4 downloaded, 1 failed.`
  - Done items are skipped; Force downloads again into `field-notes (2).zip`.
  - **Crash recovery:** job left `running` with a partial part → next start resumes and the bytes are exact.
  - Pause keeps the part, cancel deletes it, retry works.
  - Pause all holds new jobs until Resume all.
  - Low disk space pauses with a readable message and resumes.
  - An expired token is renewed through the resolve hook, and the download completes.

## Changed behavior worth knowing

- **Files are now really downloaded.** Chromium's own download is cancelled at `will-download` and re-fetched by the queue through `session.fetch` on the browser session (`credentials: 'include'` is required, or Electron blocks cookies).
- **Teaching records a download, it does not save it.** Run the workflow to download.
- **A download step now fails fast** when its click leads to an HTTP error page, and that failure is not retried by `onFail: retry`. Before, a dead link cost 60 s, or 180 s with retries.
- **`did-navigate` now passes the HTTP status** through `TabManager` hooks.
- **New pieces:** settings `downloads` (folder, concurrency, retries, force); `AppState.downloads`; IPC `downloadControl`, `downloadSettings`, `downloadFolderChoose`, `downloadFolderOpen` and `downloadShow`.
- **Database:** migration 002 adds expression indexes. Items and download jobs are validated with strict schemas on every read and write.
- **Tests:** the demo list gained `dead=N`. Electron tests set `VESTIGIUM_DOWNLOADS` so nothing is written to the real Downloads folder. The Electron fixture accepts `demoOptions`.
- **Test-harness finding:** `app.process()` from Playwright's Electron launcher is *not* the Electron browser process on Windows; it is a launcher whose child is the real app. Killing it left the app running, still downloading and still holding the single-instance lock, so every relaunch exited at once. A probe listed the surviving processes, which is how this was found. Crash tests now kill the whole tree.
- **Item-crawl tests:**
  - The 47-item test now asserts on the queue (47 done, one file on disk) instead of counting log lines. The extra download log lines push early entries out of the 200 that the shell keeps.
  - The broken-item test turns on Force for its second run, because the first run's items are now genuinely downloaded and would be skipped.

## Known limits

- **Single-use links** (and downloads that need a POST) fail, because the queue requests the URL a second time.
- **Expired links are renewed only while no run is active**, because one runner drives the browser. During a run the job fails with its "expired" message until **Retry**.
- **RAR and 7z** archives are recognized by signature, not test-extracted. Encrypted ZIP entries are checked for structure only until their password is known (milestone 7).
- **No filename templates, sidecar files or auto-extraction yet** (milestone 7). Files go to `<folder>\<site host>\`.
- **Identical-content dedupe is on by default.** Sites that serve the same bytes under different names keep one file. **Force** turns this off.
- **Run history:** only the latest run is shown. Download history is persistent, in the Queue tab.
