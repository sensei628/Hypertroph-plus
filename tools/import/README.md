# Data import tooling

Repeatable, offline-first pipelines that build the **read-only reference database**
bundled with hypertroph+. No API keys, no runtime network calls.

The app ships a single reference DB asset built here:

- `public/hypertroph-ref.sqlite.gz` — gzipped SQLite, loaded + decompressed in the
  browser at startup (`DecompressionStream`) and opened with sql.js.
- `public/hypertroph-ref.sqlite` — the uncompressed build artifact (git-ignored).

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

## Field-level importer

For a single archive (used by the orchestrator, also callable directly):

```powershell
node tools/import/import-usda.mjs `
  --in  <FDC-json-file> --out public/hypertroph-ref.sqlite `
  --datatype "Foundation" --release 2026-04-30 --version usda_foundation_2026-04-30
```

## Other datasets (loaders)

Tracked in the project roadmap. Each loader consumes the **official file you
provide** and never fabricates values:

- **IFCT 2017** (Indian, ICMR-NIN) — structured food + nutrient import.
- **AUSNUT / AFCD** (Australia) — subject to Food Standards Australia NZ data-use terms.
- **Indian RDA/EAR** (ICMR-NIN) — reference table loader feeding `rda_refs`.

See the root `README.md` "Data & licensing" section for status and attribution.
