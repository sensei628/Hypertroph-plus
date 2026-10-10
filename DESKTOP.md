# hypertroph+ — Desktop (Windows)

The desktop build is the **same application** as the web PWA and the mobile
(Android/iOS) builds, packaged as a native Windows app with **Electron**. There
is no second codebase: the tracking logic, SQLite schema, calculations, tests,
and UI are identical. Only the shell around the web bundle differs.

## Why Electron

| Option | Verdict |
| --- | --- |
| **Electron** (chosen) | Wraps the existing web bundle as-is. `electron-updater` + GitHub Releases is the standard, proven way to push **updates into already-installed apps**. Windows/macOS/Linux from one codebase. Trade-off: larger installer (~90 MB). |
| Tauri 2 | Much smaller, has a built-in updater, but adds a Rust toolchain and separate signing infrastructure — a larger departure for no functional gain here. |
| Capacitor Electron | The official Capacitor Electron platform is stuck at `@capacitor/electron@2.x` (Capacitor 2 era) and is **incompatible with Capacitor 8**. Not viable. |

## What is preserved

- All of `src/` (repository, schema/migrations v1–v7, nutrition math, workout
  planning), all tests, and the entire UI are unchanged.
- The `DataPort` / `SqliteRepository` abstraction is untouched.
- Backup export/import works exactly as on the other platforms.

## What is different on desktop

1. **Storage** (`src/data/storage.ts` → `DesktopDbStorage`): the SQLite image is
   written to a real file in the OS user-data directory via IPC instead of
   `localStorage`. Writes are debounced (200 ms) and coalesced; the main process
   writes to a temp file and atomically renames it, so a crash mid-write cannot
   corrupt the database.
2. **Loading** (`electron/main.cjs`): the bundle is served from a privileged
   custom scheme (`app://hypertroph/…`) rather than `file://`. This is required
   because the renderer `fetch()`es the USDA reference pack and loads the sql.js
   WASM — Chromium refuses to `fetch()` `file://` URLs. Relative asset paths
   (Vite `base: './'`) resolve correctly under this scheme, and directory
   traversal outside `dist/` is rejected.
3. **Auto-update** (`electron/main.cjs` + `electron-builder.yml`): described
   below.
4. **Settings UI**: a desktop-only **App updates** card shows the version,
   update status, and a manual *Check for updates* button.
5. **Service worker**: registration is skipped in the desktop shell (assets are
   local; a SW would only add cache-staleness risk).

## Architecture

```
electron/main.cjs     main process: window, app:// protocol, IPC db file, autoUpdater
electron/preload.cjs  contextBridge -> window.desktop (isolated world, sandboxed)
dist/                 the built web bundle (shared with PWA + mobile)
src/desktop.ts        typed bridge + window.desktop declaration
```

Security posture: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`. The renderer only ever sees the small `window.desktop` surface
(load/save/reset DB, check updates, app info, update events).

## Data & storage locations

The database is `hypertroph.db` in `app.getPath('userData')`:

- Windows: `%APPDATA%\hypertroph+\hypertroph.db`
- macOS: `~/Library/Application Support/hypertroph+/hypertroph.db`
- Linux: `~/.config/hypertroph+/hypertroph.db`

`Export backup` / `Import backup` in Settings write/read the same `.sqlite`
format as every other platform, so backups move freely between desktop, mobile,
and web.

## Auto-update (updates into already-installed software)

The desktop app is designed to update itself after it has been installed:

1. CI (`.github/workflows/build-desktop.yml`) builds the installer and, on a
   `v*` tag, publishes it to **GitHub Releases** together with `latest.yml`
   (the update manifest `electron-updater` reads).
2. A running app checks the configured release channel shortly after launch
   (`publish` in `electron-builder.yml` → `sensei628/Hypertroph-plus`).
3. On a new version it **auto-downloads in the background** and shows progress
   in Settings → *App updates*.
4. The update **installs on the next quit** (`autoInstallOnAppQuit`). Users can
   also trigger a check manually from Settings.

**Signing caveat (important for smooth updates):**

- **Windows:** NSIS updates work unsigned, but users see a SmartScreen warning
  on first install. A code-signing certificate removes the warning and is
  recommended before wide distribution.
- **macOS:** silent auto-update **requires** code signing + notarization
  (Apple Developer Program, ~$99/yr). Unsigned macOS builds can be built but
  auto-update will not apply cleanly.

## Build & run

```bash
npm install                 # installs electron + electron-builder (first run downloads Electron)

npm run desktop:start       # build the web bundle and launch the app (dev)
npm run desktop:dist        # build an installer in ./release (no publish)
npm run desktop:release     # build + publish to GitHub Releases (needs GH_TOKEN)
```

Output: `release/hypertrophplus-<version>-setup.exe` (NSIS installer), plus
`release/latest.yml` for the updater.

## CI

`.github/workflows/build-desktop.yml` runs on `workflow_dispatch` and on `v*`
tags. On a tag it publishes the installer + `latest.yml` to GitHub Releases so
installed apps receive the update automatically; on manual runs it just uploads
build artifacts.

## Known limitations

- Installer is ~90 MB (Electron runtime). The bundled renderer-only deps
  (`@capacitor/*`, `react`, `react-dom`, `sql.js`) are excluded from the
  package, but the Chromium/Node runtime dominates the size.
- No custom app icon yet (defaults to the Electron icon). Provide `.ico` +
  icons to `build/` to brand it.
- Renderer bundle is a single ~1 MB JS chunk (same as web); code-splitting is a
  possible follow-up.
- Only Windows is configured. macOS/Linux targets are a small addition to
  `electron-builder.yml` (`--mac` / `--linux`) but macOS needs Apple signing.

## Deliverables status

| Deliverable | Status |
| --- | --- |
| Native Windows desktop app, same app/logic/UI | ✅ |
| Real on-disk database with atomic writes | ✅ |
| Portable backup/restore (shared `.sqlite` format) | ✅ |
| Auto-update into already-installed apps | ✅ (code + CI; needs a `v*` tag release) |
| Manual "check for updates" in Settings | ✅ |
| CI producing installers + update manifest | ✅ |
| Code signing / notarization | ⚠️ deferred (needs certificates) |
| Custom app icon | ⚠️ deferred |

## Honest testing status

Verified on this machine: TypeScript typecheck, Web build, and the full test
suite (66 tests) pass, and the desktop code paths are structured to reuse the
tested renderer unchanged. **The Electron app was not launched and no installer
was produced here** — this environment has no display and the Electron/NSIS
build is intended to run in CI (Windows) as configured. First real validation
happens when the `Build Desktop (Windows)` workflow runs or you run
`npm run desktop:start` / `npm run desktop:dist` locally.
