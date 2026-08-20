# bookstore-data-repo-seed

The public data source for the PrepFusion bookstore catalog. Served over
GitHub Pages; the Cloudflare checkout Worker reads `products.json` from
here directly. Edited day-to-day through the **Bookstore** tab in the
admin portal (PrepFusion-StudyHub-AdminsPortal), not by hand — the panel
validates everything (rupees not paise, kg not grams, unique ids, a "was"
price that's actually higher than the price) before it commits here.

## Files

- `products.json` — the **live** catalog real customers see and get
  charged. Only the admin panel's "Publish" button should change this.
- `products.staging.json` — the **draft** the admin panel edits. Starts
  identical to `products.json`; they diverge as soon as someone edits a
  draft.
- `images/` — product photos, uploaded from the admin panel. Committed as
  compressed JPEGs, timestamp-prefixed filenames.

Both JSON files currently hold one **placeholder** product (the EE
Complete Bundle, with its real price and weight but no photo, section, or
description yet) so the admin panel has something to load. Replace it —
or add the rest of the real catalog — from inside the panel; that's
faster and safer than hand-editing this JSON.

## Remaining setup

This repo exists and is seeded, but two things still need doing before
the admin panel's Bookstore tab will work:

1. **Enable GitHub Pages** — Settings → Pages → Deploy from branch →
   `main` → `/ (root)`. Then confirm `products.json` loads at its Pages
   URL in a browser (likely
   `https://pf-pdfs.github.io/bookstore-data-repo-seed/products.json`).
2. **Create a fine-grained GitHub PAT**, scoped to *only this repo*,
   with **Contents: read and write**. Add it to the admin portal's Render
   service (`kb-ingest` → Environment) as `BOOKSTORE_REPO_TOKEN`.

Once both are done, the Bookstore tab loads and saves against this repo.
