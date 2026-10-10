# hypertroph+ — Mobile (Android & iOS)

This document describes the native mobile build of hypertroph+. The mobile app is the
**same application** as the web base model, wrapped in a native shell — the tracking logic,
schema, calculations and UI are unchanged. Only the on-device byte store and a few native
integrations differ.

## 1. Approach and why

| Option | Reuse | Verdict |
|---|---|---|
| **Capacitor wrapper** (chosen) | ~100% of the React UI, TypeScript domain logic, SQLite schema, tests | Chosen — preserves every workflow and formula, is fully offline, and adds no backend |
| Flutter rewrite | 0% code reuse; every calculation + schema re-implemented | Rejected — would discard tested logic and risk changing behavior |
| React Native rewrite | Domain logic reusable, UI + data layer rewritten | Rejected — unnecessary cost/risk for no functional gain |

Capacitor loads the bundled `dist/` build inside a native WebView. Because the app was already
offline-first (client-side SQLite via `sql.js`, bundled food/exercise catalogs, no network
calls), the conversion is thin: a native file store replaces `localStorage`, and backup/restore
uses the OS share sheet / file picker.

## 2. Preserved behavior (unchanged)

- All nutrition workflows: food search → portion/grams → log to a meal → daily totals vs targets.
- All training workflows: plans/routines, start workout, log sets (load/reps/RIR), e1RM, PRs,
  volume load, weekly working-set volume by muscle.
- Every formula and unit rule (`src/domain/*`): fixed-point nutrient math
  (`amount_milli = amount × 1000`), snapshot-on-log, unknown ≠ 0, Epley e1RM, kg/lb↔g.
- The SQLite schema v1 + migrations v2–v7 (`db/schema.sql`, `src/data/db.ts`), including the
  nutrient **snapshot** integrity guarantee.
- The React UI, keyboard/command palette, and visual identity.

## 3. What changed for mobile (and why)

| Change | File(s) | Reason |
|---|---|---|
| Platform storage adapter: real on-device file under Capacitor, `localStorage` on web | `src/data/storage.ts` | `localStorage` is quota-capped and fragile; a private SQLite file is durable and backup-able. Same `persist()`/`loadDatabase()` API, so the repository was not touched. |
| Debounced native writes + flush on background/close | `src/data/storage.ts`, `src/ui/App.tsx` | Coalesce large writes; guarantee nothing is lost when the app is backgrounded. |
| Portable backup export/import with validation | `src/data/backup.ts`, Settings UI | Local-only data needs a recovery path. Imports are validated (header, `integrity_check`, required tables, foreign keys) **before** overwriting live data. |
| Capacitor config + native projects | `capacitor.config.ts`, `android/`, `ios/` | Native shells for both platforms. |
| PWA layer (manifest, service worker, icons, mobile-first CSS) | `public/*`, `index.html`, `src/styles.css`, `src/ui/App.tsx` | Installable web + touch layout; harmless in the native shell. |

No calculation, table, column, or workflow was altered.

## 4. Architecture

```
src/domain/*        pure TS business logic (nutrition + hypertrophy)      unit-tested, unchanged
src/data/db.ts      schema/seed/migrations + persistence entry points
src/data/storage.ts platform byte store: Capacitor FS (native) | localStorage (web)
src/data/backup.ts  export/import + validation (SQLite image)
src/data/repository.ts  DataPort + SqliteRepository                      unchanged
src/ui/*            React UI                                             unchanged
android/  ios/      Capacitor native projects (generated)
capacitor.config.ts  appId app.hypertrophplus, webDir dist, https scheme
```

## 5. Data model & migrations

Schema is defined in `db/schema.sql`; runtime migrations v2–v7 live in `src/data/db.ts`
(`MIGRATIONS`). Migrations are idempotent, versioned in `schema_migrations`, wrapped in
transactions, run with `foreign_keys` disabled only where a table rebuild requires it, and
verified afterwards with `PRAGMA foreign_key_check`. Backups record the schema version so an
older backup restores cleanly and re-migrates forward on next launch.

Timestamps are UTC epoch-ms; nutrient amounts are integer ×1000; `NULL` means unknown.

## 6. Backup & recovery

- **Export:** Settings → *Backup & restore* → **Export backup**. Native: writes
  `hypertroph-backup-YYYY-MM-DD.sqlite` to the app cache and opens the OS share sheet (save to
  Files/Drive/etc.). Web: downloads the file.
- **Import:** *Import backup…* → pick a `.sqlite` file. It is validated first; on success the
  app replaces the on-device database and reloads. Invalid files are rejected with a message
  and never overwrite data.
- **Limitation:** data is device-local. If the device is lost or the app is uninstalled without
  an exported backup, records cannot be recovered. Export regularly.

## 7. Dependencies & licenses

| Package | License | Use |
|---|---|---|
| react, react-dom | MIT | UI |
| sql.js | MIT (embeds SQLite, public domain) | SQLite engine (WASM) |
| @capacitor/core, /cli, /android, /ios, /app, /filesystem, /share | MIT | Native shell + file/share/lifecycle |
| vite, @vitejs/plugin-react, vitest | MIT | Build/test (dev) |
| typescript | Apache-2.0 | Type-checking (dev) |

Bundled data: USDA FoodData Central (CC0 1.0), Free Exercise DB (The Unlicense), app-authored
data. Full register: [`DATA_LICENSES.md`](./DATA_LICENSES.md). No paid or copyleft dependencies.

## 8. Build & run

Prerequisites: Node 20+ and `npm`. Native builds additionally need **Android Studio + Android
SDK** (Android) and **Xcode + macOS** (iOS). Capacitor 8 targets a recent Android SDK / iOS.

```bash
npm install            # install JS deps
npm run build          # typecheck + compliance + vite build -> dist/
npm run cap:add:android   # once: generate android/ (already committed here)
npm run cap:add:ios       # once: generate ios/     (already committed here)
npm run cap:sync          # build + copy dist + plugin config into both platforms
```

Run on a device/emulator:

```bash
npm run mobile:android   # build + sync + open Android Studio
npm run mobile:ios       # build + sync + open Xcode (macOS only)
```

The whole app ships inside the binary and works in airplane mode with no server. The WebView
uses the `https` scheme for a secure origin (so `sql.js` WASM behaves like the web build).

### Release builds

- **Android:** Android Studio → *Build → Generate Signed Bundle/APK*, or Gradle
  `./gradlew bundleRelease` after configuring a signing key. Install the `.apk`/`.aab`.
- **iOS:** Xcode → *Product → Archive* → distribute. Requires an Apple Developer account for
  TestFlight/App Store.
- Run `npm run cap:sync` after every web change so the native projects pick up the new `dist/`.

## 9. Testing status (honest)

Verified in this environment (Windows, Node 24, no Android SDK / no macOS):

- `tsc --noEmit` — clean.
- `vitest run` — **66/66 tests pass** (9 files), including a new `tests/backup.test.ts`
  covering restore-file validation and rejection of non-backup files.
- `vite build` — succeeds; compliance check passes.
- `cap sync` — web assets + 3 plugins copied into both `android/` and `ios/`.

**Not** verified here (no toolchain available): actual compilation of the Android/iOS apps and
any run on an emulator or physical device. These must be done on a machine with Android
Studio/Xcode before release. Do not treat the mobile build as device-tested yet.

## 10. Known limitations / unresolved

- **iOS `DecompressionStream`:** the 14 MB gzipped USDA reference pack is unpacked with
  `DecompressionStream`, available in Android WebView and iOS ≥ 16.4. On older iOS the reference
  catalog won't load (the app still runs with local foods). Consider targeting iOS ≥ 16.4 or
  shipping an uncompressed pack if older iOS is required.
- **Service worker in the native shell:** registration also happens under Capacitor. It is
  harmless (assets are bundled) but adds a cache layer; could be disabled for native later.
- **No native file picker plugin:** import uses the WebView's `<input type="file">`, which is
  sufficient but not a fully native picker.
- **Large single JS chunk** (~1 MB) — same as the web build; consider code-splitting later.
- End-to-end device, background/restore, and large-screen/rotation testing still pending.

## 11. Costs

Free and open-source throughout. No backend, cloud DB, or paid API. Only optional store costs
apply: Google Play (one-time US$25) and Apple Developer Program (US$99/year) if you publish to
the stores; sideloading/local builds are free.

## 12. Definition-of-done status

| Requirement | Status |
|---|---|
| Existing functionality preserved | Yes — logic/schema/UI unchanged; 66 tests green |
| Runs on Android & iOS | Scaffolded + synced; **not yet device-built/tested** (no toolchain here) |
| Core features offline | Yes — bundled assets, local SQLite, no network |
| Data stored locally | Yes — on-device SQLite file, no account/server |
| Persists across restarts/updates | Yes — file-backed store + schema migrations |
| No paid server/cloud | Yes |
| Regression tests for calculations | Yes (existing suites) + new backup-validation tests |
| Critical bugs resolved | None known; remaining items are device-build verification |
| Build/maintain docs | This document + README |
```
