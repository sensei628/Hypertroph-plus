# Data import tooling

Repeatable, offline-first pipelines that build the **read-only reference database**
bundled with hypertroph+. No API keys, no runtime network calls.

The app ships a single reference DB asset built here:

- `public/hypertroph-ref.sqlite.gz` — gzipped SQLite, loaded + decompressed in the
  browser at startup (`DecompressionStream`) and opened with sql.js.
- `build/hypertroph-ref.sqlite` — the uncompressed build artifact (git-ignored
  intermediate; kept out of `public/` so it is never shipped in `dist/`).

## USDA FoodData Central

Source: <https://fdc.nal.usda.gov/> · Downloads: <https://fdc.nal.usda.gov/download-datasets.html>
License: **Public domain / CC0** (US Government work).

```powershell
# 1. Download the official bulk JSON archives (git-ignored cache)
npm run data:download:usda

# 2. Build the reference DB + gzip asset
npm run data:build:usda

# 3. Verify counts + a sample search
npm run data:verify
```

Datasets imported (verified by `data:verify`):

| Version id | Type | Release |
|---|---|---|
| `usda_foundation_2026-04-30` | Foundation | 2026-04-30 |
| `usda_sr_legacy_2018-04` | SR Legacy | 2018-04 |
| `usda_fndds_2021-2023` | Survey (FNDDS) | 2021-2023 |

### Import guarantees

- **Bulk, not per-food** — consumes the official archives; never loops the API.
- **Idempotent / resumable** — re-running a `--version` replaces only that dataset.
- **Provenance** — every row carries `source_id` + `dataset_version_id`.
- **Unknown ≠ zero** — missing amounts are stored as `NULL`.
- **Original units preserved** — `g | mg | µg | kcal | kJ | IU`.
- **No record merging** — distinct foods keep distinct `fdc_id`s.

### Nutrients

`nutrients.json` maps official FDC nutrient ids to an app code + role
(energy / macro / lipid / vitamin / mineral / other). Unmapped nutrients are still
imported with `role = 'other'`; nothing is dropped.

## Free Exercise DB

Source: <https://github.com/yuhonas/free-exercise-db> · License: **The Unlicense** (public domain).

Generates `db/exercises.sql`, which is committed and applied as a schema migration
(so both fresh and existing user DBs get the catalogue).

```powershell
# 1. Download the catalogue JSON (git-ignored cache)
npm run data:download:exercises

# 2. Generate db/exercises.sql
npm run data:build:exercises
```

The importer maps the source muscle/equipment vocabulary onto the app's taxonomy
(unmapped muscles are added as new app muscles rather than misattributed).

## Field-level importer

For a single archive (used by the orchestrator, also callable directly):

```powershell
node tools/import/import-usda.mjs `
  --in  <FDC-json-file> --out build/hypertroph-ref.sqlite `
  --datatype "Foundation" --release 2026-04-30 --version usda_foundation_2026-04-30
```

## Scope

hypertroph+ imports **public-domain / CC0 data only**. Today that means USDA
FoodData Central (CC0 1.0) for foods and Free Exercise DB (The Unlicense) for
exercises. App-authored data (seed foods/exercises, taxonomies) lives in `db/seed.sql`.

Copyrighted food-composition databases (e.g. ICMR-NIN IFCT/RDA, FSANZ
AUSNUT/AFCD/NUTTAB) are **not supported and not importable** — no loaders, no
templates. This keeps the project free of redistribution restrictions. See
`DATA_LICENSES.md`.

See the root `README.md` "Data & licensing" section for status and attribution.
