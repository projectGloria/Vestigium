# Ad blocking verification

Feature added after milestone 9: network-level ad, tracker and ad-popup blocking in browser tabs (see `docs/ARCHITECTURE.md`, "Ad blocking").

Verified on Windows 11 Enterprise LTSC 2024 (10.0.26100) on 24 October 2026 with Node 26.8.1, Electron 45.0.0, Playwright 1.64.1 and `@ghostery/adblocker` 2.20.1. The bundled lists were fetched on 23 October 2026: 14 lists, 5.7 MB, 120,242 network filters.

**Status:** the tests pass. On the real site the user named, banners, ad networks on the lists and trackers are blocked. A popunder whose domain no list knew yet still opened (see "Real app" below). That is a known limit, not a passing result.

## Engine cost (bundled lists, network filters only)

```text
parse ms 457
serialize ms 9 bytes 4722553
deserialize ms 7
```

## `npm run typecheck` and `npm test`

```text
> tsc --noEmit
ℹ tests 78
ℹ pass 78
ℹ fail 0
ℹ skipped 0
  65 passed (21.5s)
  ok  1 tests\electron\adblock.spec.ts:12:1 › ads and popunders are blocked by default; the setting turns blocking off and on (3.4s)
  ok  2 tests\electron\adblock.spec.ts:43:1 › a recording on an ad page contains only the page's own steps and replays with the download (4.7s)
  ok  3 tests\electron\adblock.spec.ts:62:1 › the bundled lists load on a fresh profile and are cached for the next start (5.0s)
  49 passed (8.4m)
EXIT 0
```

The 46 Electron specs that existed before ran with the real bundled lists (120,242 filters) and still pass.

New tests:
- `tests/app-unit/ad-blocker.test.ts` covers:
  - what is blocked and what is left alone: the site itself, the download queue, top-level pages, exception rules;
  - `data:` stubs for redirect filters;
  - cosmetic rules being ignored;
  - the bundle → cache → newer-bundle order, and a corrupt cache;
  - no lists at all;
  - the weekly refresh, including a failed list and an error page served as a list.
- `tests/electron/adblock.spec.ts` checks the demo `/ads` page in the real app:
  - with blocking on, the banner script, its popunder and an inline-opened ad popup are all blocked;
  - turned off in the settings panel, the ad and the popunder come back;
  - a recording on the page contains no popup and replays with its download;
  - a fresh profile loads the bundle and the next start reads the cache.
- `tests/package/package.spec.ts` checks that the installer ships `resources\filter-lists` and that the packaged app loads more than 50,000 filters. The installer was not rebuilt for this change.

## Real app: misskon.com

`artifacts/adblock/check-misskon.mts` drives the built app (isolated temporary profile, refresh off). It opens https://misskon.com/, waits 6 s, clicks the page twice, then repeats with blocking off. "Hosts loaded" lists resource-timing entries, which include requests that were blocked.

```text
== ON (default)
title: MissKon.com – Daily Hottie with High Quality
hosts loaded: a.magsrv.com, bankingbloatedcaptive.com, cdn.ouo.io, fonts.googleapis.com, improperscrubbedvendor.com, misskon.com, misskon.disqus.com, quzvujanb.in, sacwumsf.com, static.cloudflareinsights.com, www.googletagmanager.com
ExoClick slots: unprocessed, unprocessed, unprocessed
tabs before/after two clicks: 1 -> 2 misskon.com, displayendpointstarring.com
adblock status: {"enabled":true,"filters":120242,"listsUpdated":"2026-10-23T21:49:43.251Z","blocked":10}

== OFF
title: X-Level Yeha (예하) x Miho (미호): Memories (195 photos) – MissKon.com
hosts loaded: a.magsrv.com, bankingbloatedcaptive.com, cdn.ouo.io, fonts.googleapis.com, improperscrubbedvendor.com, misskon.com, misskon.disqus.com, s.magsrv.com, static.cloudflareinsights.com, www.google-analytics.com, www.googletagmanager.com, z6v2p9a8.bkcdn.net
ExoClick slots: true, true, true
tabs before/after two clicks: 2 -> 3 misskon.com, misskon.com, displayendpointstarring.com
```

The engine's verdicts on the hosts that showed up:

```text
quzvujanb.in script false
sacwumsf.com script true
displayendpointstarring.com main_frame false
```

What this shows:
- **Blocked:** ExoClick (all three slots stay unprocessed), the two known popunder networks, `sacwumsf.com`, ouo.io's link wrapper, Google Analytics, Tag Manager and Cloudflare Insights.
- **Not blocked:** the site's own inline loader tried `quzvujanb.in`, which no list knows yet, and a popunder opened to `displayendpointstarring.com`, also unknown. Network filtering cannot stop a first-party inline script, and lists lag behind domains that are days or hours old.

## Found while testing on the real site (24 October 2026)

The user's run on misskon.com → ouo.io stopped at the last step. Its log showed two bugs that the ad blocker did not cause:

1. **A run clicked a captcha button.** ouo.io's first "Get Link" button is the invisible reCAPTCHA trigger (`.g-recaptcha`), with the same id (`#btn-main`) and name as the plain "Get Link" on the countdown page after it. Teaching skipped the captcha click, as designed. On replay, after the person pressed Resume, the step recorded on the countdown page matched the captcha button and pressed it (`Step 3/4 done: Click button "Get Link" (in popup-1) (matched testid: #btn-main)`). The real "Get Link" was never pressed, and the download step timed out. Fix: `resolveTarget` refuses any target inside a captcha widget ("not-ready"), so the run pauses for the person until the page has moved past the captcha.
2. **A run stopped by closing the window was not saved to History** (`The run could not be saved to the history: The database connection is not open`). Shutdown aborted the run but closed the database before the run had finished. Fix: shutdown awaits `runner.stopAndSettle(5000)` before the database closes.

Each new test was run without its fix and failed, and passes with the fix:
- `human.spec.ts` "a short link whose first button is the captcha…" (demo `item?variant=shortlink`). Without the fix: `expect(received).not.toBeNull() / Received: null`. The run pressed the captcha itself and never paused.
- `human.spec.ts` "closing the app during a run saves that run to the history…". Without the fix: `Expected - 6 / Received + 1`. History was empty.

### `npm run typecheck` and `npm test` after both fixes

```text
> tsc --noEmit
ℹ tests 78
ℹ pass 78
ℹ fail 0
  65 passed (23.1s)
  ok  1 tests\electron\adblock.spec.ts:12:1 › ads and popunders are blocked by default; the setting turns blocking off and on (3.6s)
  ok  2 tests\electron\adblock.spec.ts:43:1 › a recording on an ad page contains only the page's own steps and replays with the download (5.6s)
  ok  3 tests\electron\adblock.spec.ts:62:1 › the bundled lists load on a fresh profile and are cached for the next start (5.4s)
  ok 22 tests\electron\human.spec.ts:96:1 › a short link whose first button is the captcha: the run never presses it, even after Resume (13.9s)
  ok 24 tests\electron\human.spec.ts:170:1 › closing the app during a run saves that run to the history before the database closes (7.4s)
  51 passed (9.0m)
EXIT 0
```

Not re-run on ouo.io itself: getting past its captcha needs a person.
