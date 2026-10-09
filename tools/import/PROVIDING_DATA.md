# Providing official datasets to hypertroph+

hypertroph+ never fabricates nutrient values or reference recommendations. Only
official source files are imported, and every row keeps its provenance + license.

## Already bundled (no action needed)
- **USDA FoodData Central** — public domain / CC0. Built by `npm run data:build:usda`.

## You provide these (official files)
Place files anywhere and reply with the path, or drop them in the git-ignored
cache folders below. A loader will be written/matched to the exact format.

| Dataset | Official source | Accept (formats) | Cache folder |
|---|---|---|---|
| ICMR-NIN RDA & EAR 2020 | nin.res.in | PDF, or `templates/rda.template.csv` | `tools/import/.cache/rda/` |
| IFCT 2017 | nin.res.in (`IFCT2017.pdf`) | PDF (parsed), or `templates/ifct.template.csv` | `tools/import/.cache/ifct/` |
| AUSNUT / AFCD | foodstandards.gov.au | official XLSX/CSV | `tools/import/.cache/ausnut/` |

## Canonical CSV columns (if you transcribe from a PDF)
- **RDA/EAR** — `templates/rda.template.csv`:
  `nutrient_code,ref_type,age_min,age_max,sex,life_stage,amount,unit,source_doc,pub_year,page_ref,notes`
- **IFCT** — `templates/ifct.template.csv`:
  `ifct_code,name,group,part,energy_kcal,protein_g,fat_g,carb_g,fiber_g,calcium_mg,iron_mg,zinc_mg,vit_c_mg,folate_ug,vit_a_ug,sodium_mg,potassium_mg`

Leave a cell blank when a value is not in the source — it is stored as `NULL`
(unknown), never `0`.

## Licensing
- USDA: public domain — safe to bundle.
- FSANZ (AUSNUT/AFCD) and ICMR-NIN (IFCT/RDA): copyrighted. Loaders are committed;
  redistribution of the *data* inside a public repo is only done if the terms allow.
  Otherwise the data is imported locally at build time and stays out of git.
