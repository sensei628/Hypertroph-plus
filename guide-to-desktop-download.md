# Downloading & updating hypertroph+ on your devices

hypertroph+ is one app with several ways to install it. Pick the one that fits
each device. **No account, no backend — all your data stays on the device.**

| Device | What to install | Where |
| --- | --- | --- |
| Any phone / tablet / PC | **Web app (PWA)** — installs from the browser | https://sensei628.github.io/Hypertroph-plus/ |
| Windows PC | **Desktop app** (offline, real on-disk DB, self-updating) | [Releases](https://github.com/sensei628/Hypertroph-plus/releases) |
| Android phone / tablet | **APK** (offline, app-private DB) | [Releases](https://github.com/sensei628/Hypertroph-plus/releases) / [Actions artifacts](https://github.com/sensei628/Hypertroph-plus/actions) |

---

## 1. Web app / PWA (works on every device — start here)

1. Open **https://sensei628.github.io/Hypertroph-plus/** in Chrome, Edge, or
   Safari.
2. Install it so it runs like a native app and works offline:
   - **Android (Chrome):** ⋮ menu → **Install app** / **Add to Home screen**.
   - **iPhone/iPad (Safari):** Share → **Add to Home Screen**.
   - **Windows/macOS (Chrome/Edge):** the **Install** icon in the address bar.
3. Launch it from your home screen / app list. It opens full-screen and works
   offline after the first load.

**Updating:** you don't have to do anything — the app checks for a newer
published version on launch and shows a notice (see §4). When one is available,
open **Settings → App updates → Reload to update**. The new version loads on the
next revisit.

---

## 2. Windows desktop app (offline, real database, auto-update)

The desktop app stores your database in a real file and updates itself.

1. Go to the **[latest release](https://github.com/sensei628/Hypertroph-plus/releases/latest)**.
2. Under **Assets**, download **`hypertrophplus-<version>-setup.exe`**.
3. Run the installer. Because the app is not code-signed yet, Windows
   SmartScreen may warn — click **More info → Run anyway**. Choose an install
   folder, then finish.
4. Launch **hypertroph+** from the Start menu or desktop.

- **Where your data lives:** `%APPDATA%\hypertroph+\hypertroph.db`
- **Portable backup:** Settings → **Backup & restore** → Export/Import
  (`.sqlite`). Backups move freely between desktop, web, and mobile.

**Updating:** automatic. On launch the app checks GitHub Releases, downloads a
newer version in the background, and installs it **the next time you quit**.
You can also force a check in **Settings → App updates → Check for updates**;
the card shows progress and **what's changed** in the new version.

> Note: never uninstall to "get the latest" — just relaunch and let it update, or
> use the button. Your database is separate from the app files and is preserved.

---

## 3. Android

1. On your phone, open the **[latest release](https://github.com/sensei628/Hypertroph-plus/releases/latest)**
   and download the **`.apk`** under Assets.
   - If a release only lists the `.exe`, download the APK from the
     [Actions artifacts](https://github.com/sensei628/Hypertroph-plus/actions)
     of the latest **Build Android** run instead.
2. Allow installing from your browser when prompted (Android Settings →
   **Install unknown apps** for your browser).
3. Open the downloaded `.apk` and install.
4. Launch **hypertroph+**.

- **Where your data lives:** the app's private data folder
  (`hypertroph.db`); not visible without root.
- **Updating:** the app checks for a newer release on launch and offers a
  **Download APK** button in **Settings → App updates** (together with
  "what's changed"). Download the newer APK and install it over the existing
  app — the build is self-signed with a stable identity and each release bumps
  the Android `versionCode`, so it upgrades in place. Your data is preserved.

---

## 4. How "Check for updates" and "what's changed" work

Open **Settings → App updates**:

- **Installed version** — what you're running now.
- **Check for updates** — asks the release server for the newest version.
  - On **desktop**, the native updater downloads it and installs on quit.
  - On **web/mobile**, you get a **Reload to update** button (web) and a
    **Download desktop app** / **Release notes** link.
- **What's changed in `<version>`** — the changelog for the newest release is
  shown right in the card once an update is detected, so you always know what
  changed before you apply it.

The app also checks quietly once per launch and raises a short notification if a
newer version exists.

---

## 5. For the maintainer: publishing an update

The update button/changelog read from **GitHub Releases**, so shipping an update
means publishing a release. A helper script does the whole thing:

```powershell
npm.cmd install
node tools/release.mjs            # patch bump, e.g. 0.1.0 -> 0.1.1
node tools/release.mjs minor     # 0.1.0 -> 0.2.0
node tools/release.mjs --dry-run # preview without changing anything
```

That bumps `package.json`, commits, tags `v<version>`, and pushes. The tag
triggers CI, which:

- builds the **Windows installer + `latest.yml`** (the auto-update manifest) and
  the **Android APK/AAB**, and
- attaches them to the matching **GitHub Release**, with **release notes
  generated from the commits** (grouped into Features / Fixes / Performance /
  … by `tools/changelog.mjs`) — those notes are exactly what the app shows as
  "what's changed".

Watch progress in the **Actions** tab; grab the result from **Releases**.

> **One-time setup you may still want:** a Windows code-signing certificate
> (removes the SmartScreen warning) and an app icon. Both are optional.
