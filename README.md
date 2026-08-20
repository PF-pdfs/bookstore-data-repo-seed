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

## Access

Written to by the admin portal's `LANDING_SITE_GITHUB_TOKEN` — the same
fine-grained PAT that already commits to `PF-pdfs/prepfusion-landing` for
the Website Banner tab, reused here rather than minting a separate one,
since both repos live under the same `PF-pdfs` org. No repo-specific env
var needed.

**That token's repository access list must include this repo with
Contents: Read and write** — Settings on the token (not this repo) →
Repository access. A read-only or missing grant here is a 403 on every
save from the Bookstore tab, even though the tab loads fine (reads still
work).

## Remaining setup

- [x] GitHub Pages — `https://pf-pdfs.github.io/bookstore-data-repo-seed/products.json`
      is live.
- [ ] Confirm the token above actually has write access to this specific
      repo, not just read (see "Access").
