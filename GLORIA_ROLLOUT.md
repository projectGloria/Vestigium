# GloriaSetup rollout

Vestigium is an Electron app. The release workflow builds it, packs `release/win-unpacked` with GloriaSetup and attaches `Vestigium_<version>_x64-setup.exe` to the tag's release.

## Please

- Confirm the `WINDOWS_PFX_BASE64` and `WINDOWS_PFX_PASSWORD` secrets exist. Without them the setup is unsigned.
- Confirm the data folder. `gloria.toml` lists only `%APPDATA%\Vestigium` (Electron userData, from `app.setName('Vestigium')`). Downloaded files go to the user's downloads folder and are deliberately not listed.
- The icon is `build/icon.png` (256x256, already tracked), since the repo has no .ico. The packer accepts a png of that size.
- The version in `gloria.toml` is 0.1.0 (from package.json). The catalog says 0.1.5. The release tag overrides it at pack time.
- `legacy_names = ["Vestigium"]` matches the old electron-builder NSIS install (productName). Check that migration of an old install works.
- Nothing was built locally. `electron-builder --win dir` uses `electronDist: node_modules/electron/dist`. Check the first tag run, and that `vestigium.cmd` and `resources/filter-lists` end up in the packed folder.
- `needs_webview2` is false because Electron bundles Chromium, so no bootstrapper is downloaded.
- There was no CI workflow before, so no old installer step was removed. `npm run dist` (NSIS) still exists for local use.
