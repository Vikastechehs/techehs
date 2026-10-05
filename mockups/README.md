# TECH EHS page mockups

Mockups for the 98 product and service pages listed in the "Product Pages URL GSO Status" sheet, all on one shared design system.

- `index.html`: directory of all pages (open this first)
- `pages/*.html`: one mockup per live URL (`software/permit-to-work-software` → `pages/software__permit-to-work-software.html`)
- `assets/style.css`, `assets/app.js`: shared design system
- `data/NN.json`: page content (NN = Sr. No. from the sheet)
- `_build/`: `pages.csv` (URL list), `SCHEMA.md` (content schema/rules), `validate.py`, `build.py`

Rebuild after editing content: `python3 _build/validate.py && python3 _build/build.py`

Figures marked `*` are placeholders and must be replaced with verified data before going live.
