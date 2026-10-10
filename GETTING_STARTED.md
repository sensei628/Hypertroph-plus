# Getting started — hypertroph+ status & how to run everything

One page to answer "where is this project, and how do I actually run it?".
For deeper detail see [`README.md`](./README.md), [`MOBILE.md`](./MOBILE.md),
[`DESKTOP.md`](./DESKTOP.md), and [`DATA_LICENSES.md`](./DATA_LICENSES.md).

hypertroph+ is an **offline-first nutrition + hypertrophy training tracker**.
There is **one codebase** (`src/`) shared by every target:

| Target | Shell | Database store | Status |
| --- | --- | --- | --- |
| Web / PWA | browser | `localStorage` | ✅ done, installable offline |
| Android | Capacitor | app-private file (Filesystem) | ✅ code + CI (APK/AAB) |
| iOS | Capacitor | app-private file (Filesystem) | ✅ code; build needs macOS/Xcode |
| Windows desktop | Electron | file in `%APPDATA%` (+ auto-update) | ✅ code + CI (installer) |

No backend, no account, no telemetry. All data stays on the device.

## Current status

**Done**
- SQLite schema v1 + migrations v2–v7, seeded foods/exercises, integrity rules
  (snapshot-on-log, unknown ≠ zero) — covered by **66 tests**.
- Nutrition loop (search → log → diary → daily totals) and training loop
  (workout → exercise → sets → PR → finish), dashboard, weekly volume, settings.
- Mobile-first responsive UI, command palette, PWA (offline service worker).
- Native shells: Capacitor (`android/`, `ios/`) and Electron (`electron/`).
- Portable backup/restore (`.sqlite`) on every platform.
- Desktop **auto-update** from GitHub Releases.
- CI: GitHub Pages deploy, Android APK/AAB build, Windows desktop build.
- Release tag `v0.1.0` cut — triggers the Android + Desktop build workflows.

**Not done yet (planned)**
- FTS5 search / larger packaged data packs (search is currently a `LIKE` scan).
- Code signing + notarization (Windows SmartScreen warning; macOS auto-update).
- Custom app icon (currently the Electron/Capacitor default).
- Renderer code-splitting (single ~1 MB JS chunk).

## Prerequisites

- **Node 20+** and npm. (Verified locally with Node 24.)
- Everything (web + tests + desktop packaging) works with just Node + npm.
- **Local Android build** additionally needs **Java 21** + **Android SDK** (or
  Android Studio). **Local iOS build** needs **macOS + Xcode**.
- Windows note: the PowerShell `npm` shim may be blocked by execution policy —
  use `npm.cmd ...`, or run binaries from `node_modules\.bin\`.

## 1. Web app (fastest path)

```powershell
npm.cmd install
npm.cmd run dev         # http://localhost:5173
```

Other everyday commands:

```powershell
npm.cmd run build       # typecheck + data-compliance + production build -> dist/
npm.cmd run preview     # serve the production build
npm.cmd run test        # 66 unit + integration tests (vitest)
npm.cmd run typecheck   # tsc --noEmit
npm.cmd run data:compliance   # verifies bundled data licensing
```

Pushing to `main` also auto-deploys to **GitHub Pages** (`.github/workflows/deploy.yml`).

## 2. Windows desktop (Electron)

```powershell
npm.cmd install             # first run downloads Electron (~100 MB)
npm.cmd run desktop:start   # build the web bundle + launch the app
npm.cmd run desktop:dist    # build an installer into .\release (no publish)
npm.cmd run desktop:release # build + publish to GitHub Releases (needs GH_TOKEN)
```

Output: `release\hypertrophplus-0.1.0-setup.exe` plus `latest.yml` (the update
manifest).

- **Where data lives:** `%APPDATA%\hypertroph+\hypertroph.db`
- **Updates:** installed copies poll GitHub Releases, download in the background,
  and install on next quit. Settings → *App updates* shows the version + a manual
  *Check for updates* button. **Auto-update only works for released versions** —
  build one with a `v*` tag (see §5).

## 3. Android / iOS (Capacitor)

```powershell
npm.cmd run cap:sync        # build web bundle + copy into android/ and ios/
npm.cmd run mobile:android  # build + open the Android project (needs Android Studio/SDK)
npm.cmd run mobile:ios      # build + open the iOS project (needs macOS/Xcode)
```

Don't want to install the SDKs locally? Use CI: the **Build Android** workflow
produces an installable debug **APK** and an unsigned release **AAB** (§5).

- **Where data lives:** app-private data dir (`hypertroph.db` via Capacitor
  Filesystem); not user-visible without root.

## 4. Backups (any platform)

Settings → **Backup & restore**.

- **Export backup** writes the full SQLite image as
  `hypertroph-backup-YYYY-MM-DD.sqlite` (share sheet on mobile, download on
  web/desktop).
- **Import backup** validates the file (SQLite header, integrity check, required
  tables, foreign keys) *before* replacing the current data, then reloads.
- Backups are interchangeable between web, mobile, and desktop.

## 5. Building releases (what makes updates live)

Both native workflows run on **manual dispatch** and on **`v*` tags**
(`.github/workflows/build-android.yml`, `.github/workflows/build-desktop.yml`).

```powershell
# cut a release (already done once as v0.1.0)
git tag -a v0.1.1 -m "hypertroph+ v0.1.1"
git push origin v0.1.1
```

On a tag, the workflows publish to the matching **GitHub Release**:

- Windows: `hypertrophplus-<version>-setup.exe` + `latest.yml` (drives auto-update)
- Android: debug `.apk` + release `.aab`

Check progress in the repo's **Actions** tab. `v0.1.0` was cut from commit
`33d1de4`.

> Bumping the app version: edit `version` in `package.json` before tagging.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `npm` not recognized / policy error | Use `npm.cmd` (PowerShell shim blocked). |
| `npm ci` fails in CI with lock mismatch | Run `npm.cmd install --package-lock-only` and commit `package-lock.json`. |
| "chunks larger than 500 kB" build warning | Cosmetic; code-splitting is a planned optimization. |
| Reference food catalog empty | Ref pack needs `DecompressionStream` (iOS ≥ 16.4, modern Android WebView, current browsers). |
| Desktop installer shows SmartScreen warning | Expected until the app is code-signed. |
| macOS auto-update does nothing | Requires Apple code signing + notarization. |
| Android build can't find SDK 36 | Install platform 36 / build-tools 36, or use CI. |

## Repo map

```
src/                  the app (domain, data, ui) — shared by all targets
  data/storage.ts     platform database store (web / native file / desktop file)
  data/db.ts          schema + migrations + persistence entry points
  data/backup.ts      validated export/import
  desktop.ts          Electron bridge typing
db/schema.sql         schema v1 (+ migrations v2–v7 in db.ts)
electron/             Windows desktop shell (main + preload)
android/  ios/        Capacitor native projects
public/               reference data pack, PWA icons/manifest/service worker
tests/                vitest suites
.github/workflows/    deploy (Pages), build-android, build-desktop
```
