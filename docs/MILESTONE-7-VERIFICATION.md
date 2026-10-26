# Milestone 7 verification

**Definition of done (plan §15):** "Password and metadata from item pages end up in the sidecar file; archive extraction works."

Verified on Windows on 23 October 2026 with Node 26.8.1, Electron 45.0.0, Playwright 1.64.1, 7-Zip installed at `C:\Program Files\7-Zip`.

## Actual command output

```text
> vestigium@0.1.0 typecheck
> tsc --noEmit

> vestigium@0.1.0 test
> npm run test:unit && npm run test:demo && npm run test:e2e

> vestigium@0.1.0 test:unit
> node scripts/test-unit.mjs
✔ ZipCrypto and AES-256 archives made by 7-Zip unpack with the password, byte for byte (154.5973ms)
✔ 7z archives unpack through 7-Zip when it is installed (password checked), and are kept as they are otherwise (203.7485ms)
✔ the queue places an AES archive by template, unpacks it with the item password, deletes it and writes the sidecar (1440.5244ms)
ℹ tests 67
ℹ pass 67
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 5553.7967

> vestigium@0.1.0 test:demo
> playwright test --config playwright.config.ts
  ok 13 tests\e2e\metadata.spec.ts:29:3 › item facts are read from a list layout, with each password label (504ms)
  ok 14 tests\e2e\metadata.spec.ts:29:3 › item facts are read from a table layout, with each password label (515ms)
  ok 15 tests\e2e\metadata.spec.ts:29:3 › item facts are read from a inline layout, with each password label (517ms)
  ok 16 tests\e2e\metadata.spec.ts:43:1 › labels match case-insensitively; unlisted labels and hidden text are ignored (379ms)
  63 passed (18.7s)

> vestigium@0.1.0 test:e2e
> npm run build && playwright test --config playwright.electron.config.ts
out/main/app.cjs  182.40 kB
out/preload/index.cjs      3.45 kB
out/preload/recorder.cjs  60.54 kB
Running 38 tests using 1 worker
  ok 20 tests\electron\metadata.spec.ts:17:1 › a crawl saves each item's details in its sidecar and unpacks each archive with the password from its page (6.7s)
  38 passed (5.8m)
```

The full transcript is kept locally in `artifacts/m7-tests.txt` (ignored by git).

## Acceptance evidence (real built app, `tests/electron/metadata.spec.ts`)

**Setup:** teach one item on `/list?variant=aes`, where every item serves a password-protected AES-256 ZIP made by 7-Zip. The run is limited to five items, and the options are set in the Queue tab's **Download options**:
- File names: `{site}/{tag}/{title}.{ext}`
- Archives: "Unpack, then delete the archive"
- Force on, because the demo serves identical bytes for every item, which identical-file dedupe would otherwise store once.

| Item | Password label on the page | Result |
| --- | --- | --- |
| Field Notes 01 | `Password:` | `downloads\127.0.0.1\Landscape\Field Notes 01\notes\readme.txt` and `photo-list.txt` match the archived text byte for byte, and the archive is deleted. `Field Notes 01_info.txt` reads: `Title: Field Notes 01`, `Password: vestigium-demo`, then `Author`, `Tags`, `Date`, `Page: …/item/1?variant=aes`, `Unpacked to: …`. |
| Field Notes 02 | `Pass:` | Same, under `Architecture\`. The sidecar's second line is `Pass: vestigium-demo`. |
| Field Notes 03 | `Unzip password:` | Same, under `Portrait\`. The sidecar line is `Unzip password: vestigium-demo`. The queue row shows "Unpacked 2 files into …" and "Details: Author, Tags, Date, Unzip password". |
| Field Notes 04 | `Şifre:` (Turkish) | Same, under `Landscape\`. The sidecar line is `Şifre: vestigium-demo`. |
| Field Notes 05 | none | The archive is kept as `Architecture\Field Notes 05.zip`. Its note reads "Not unpacked: The archive is password-protected, and the item page showed no password." Its sidecar still lists Author, Tags and Date, and no password. |

The log has `Item details: Title, Author, Tags, Date…` five times (labels only), and **no log line contains the password**. Screenshot: `queue-unpacked.png`.

A manual download from `/item/4?meta=table` (details in a table, not a definition list) writes `field-notes_info.txt` starting with `Title: Field Notes 04`, `Şifre: vestigium-demo`, `Author: Author 4`, `Tags: Landscape`, `Date: 2026-10-04`.

### Page-side capture (`tests/e2e/metadata.spec.ts`, production recorder core in Chromium)

- **Layouts:** items 1–5 each in three layouts (definition list, table, inline "Label: value" lines) yield exactly Author, Tags and Date, plus the password under that item's own label, and no password for item 5.
- **Matching:** labels match case-insensitively and are keyed by the configured spelling.
- **Hidden text:** a hidden `Model: …` paragraph is ignored, and a visible one is read.

### Unit tests

- **`archive.test.ts`:**
  - **ZipCrypto and AES-256 ZIPs made by 7-Zip** unpack byte for byte. This checks the decryption against an independent encoder.
  - **Wrong or missing passwords** are reported as such and leave no folder behind.
  - **Zip-slip** (`../evil.txt`, patched into a real ZIP) is skipped with a note while `good.txt` is unpacked. Absolute and drive paths are refused, and names are sanitized.
  - **A bomb** whose directory claims 10 bytes stops with "is larger than the archive says". A declared total above the allowed space is refused.
  - **`.7z`:** unpacked through the installed 7-Zip, and a wrong password is detected. Without 7-Zip the archive is kept, with "Install 7-Zip to unpack 7Z archives". The 7-Zip case ran here; it skips itself on machines without 7-Zip.
- **`metadata-files.test.ts`:**
  - **Metadata:** page facts become metadata, and the password is found under English, Turkish, French and Russian labels, but not under "Passage".
  - **Templates:** `{site}/{tag}/{title}.{ext}`, missing values, and "Unzip password" → `{unzip_password}` all resolve. A title containing `../../evil/x` stays one file name, `{name}.exe` keeps `.zip`, and invalid templates are rejected.
  - **Sidecar:** the line order is right and the BOM is present.
  - **The queue end to end:** an AES archive is placed by template, unpacked with the item's password, deleted, and gets a sidecar. A wrong password keeps the archive and records why. Neither password appears in the log.

## Changed behavior worth knowing

- **Item details are captured automatically:**
  - **In runs:** when each item page opens.
  - **For manual downloads:** from the page the download came from.
  - **What gets stored:** `Item.metadata`. Labels are configurable under **Download options → Details to capture**.
- **New settings:** `downloads.template` (default `{site}/{filename}`, the milestone 6 layout), `downloads.sidecar` (on), `downloads.extract` (`off`; plan §5 calls unpacking optional), and `metadata.labels`.
- **The default number of parallel downloads is now 3** (plan §4). Milestone 6 had 2.
- **The job document gains optional fields:** `sidecarPath`, `extractedTo`, `extractNote` and `details` (labels only). Milestone 6 documents stay valid.
- **New IPC command:** `metadataLabels`.
- **Demo site:**
  - `/files/encrypted`, `/files/aes` and `/files/sevenzip` serve 7-Zip-made protected archives.
  - `/list?variant=…` passes a download variant to every item.
  - `/item/N?meta=table|inline` shows the details in other layouts.
  - A `.gitattributes` marks archives as binary.
- **A shutdown hang, found by this milestone's first full run.** Two crawl tests hung at app close, and the app reported `This database connection is busy executing a query`.
  - **The chain:** the first shutdown step's DB write threw "busy". `attempt()` logged the failure, but the log's change hook was still attached, so the log write built a state snapshot. That read the DB again and threw from inside the catch handler, rejecting the whole shutdown promise. The window's close stayed prevented forever.
  - **The fix:**
    - The change hook is detached first.
    - Shutdown log writes can no longer throw out of a step.
    - A `finally` block always quits.
    - The close and quit handlers only call `preventDefault()` and start shutdown with `setImmediate`, on a fresh stack.
  - **Not proven:** the trigger. Most likely, Playwright's `app.quit()` arrives through the inspector in the middle of other work, and the synchronous `before-quit` handler then re-entered the database. Either way, a quit can no longer hang the app.
- **Expectation updates:** three milestone 5/6 tests list download folders exactly, and now also expect the `_info.txt` sidecars (sidecars are on by default).
- **A bug found by the new test:** the inline "Label: value" rule matched a wrapper `<div>` around several labelled lines, so "Author" swallowed the rest of the block. The rule now requires one rendered line.

## Known limits

- **7z and RAR need 7-Zip installed.** Without it they are kept as downloaded, with a note. ZIP entries using bzip2, LZMA or Deflate64 are skipped with a note.
- **Duplicates get no sidecar.** A file identical to one already saved gets no sidecar of its own (the first file's sidecar stays).
- **Details are found by label.** A password shown with no label needs that phrase added to "Details to capture".
- **Non-ASCII ZipCrypto passwords** are read as UTF-8. Archives from tools that used a legacy code page may not open with such a password.
- **The Queue panel is cramped** once Download options are open (the bottom panel is fixed at 208 px). Milestone 8 is the UI-polish milestone.
