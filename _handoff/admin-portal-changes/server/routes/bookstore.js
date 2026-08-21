// Book-owner-only — a permission distinct from site owner/admin (see
// server/auth/middleware.js's requireBookOwner and adminRules.js's
// validateBookOwnerChange). An ordinary site owner does not get this for
// free; only whoever has been explicitly granted it can touch the catalog,
// so who can change what customers are charged is a deliberately narrower
// list than who can run the rest of the portal. Book owners can grant or
// revoke the flag on each other (the /owners routes below); a site owner can
// also grant it from the Administrators tab as a bootstrap/recovery path.
//
// Edits the bookstore's product catalog, which lives as JSON in a
// separate public repo (PF-pdfs/bookstore-data-repo-seed) published via
// GitHub Pages. The Cloudflare Worker that runs checkout reads the live file
// straight from Pages — this portal never sits in the path of a customer's
// purchase, and none of this touches Mongo. Same live-fetch-on-open,
// nothing-persisted-here philosophy as the Website Banner tab (see
// routes/websiteBanners.js), with one addition it doesn't have: a staging
// copy.
//
// Two files, deliberately:
//   products.staging.json — the only file this panel's editor ever writes
//   products.json         — what the Worker actually reads; only Publish
//                           overwrites it, verbatim, from staging
// so a half-finished edit can never reach a live payment flow. Publish is a
// copy, never a merge.
//
// Units, the single most dangerous thing to get wrong here: `price` is whole
// rupees (the Worker multiplies by 100 itself for Razorpay's paise API) and
// `weight` is kilograms (what Courier Karo's "Product Weight (kg)" field
// expects). Not paise, not grams.
//
// The shop is grouped into sections — Bundles, Single books, and whatever else
// gets added — held as their own ordered list. Products stay one flat array
// with a `section` pointing at a section id, rather than nesting products
// inside sections: the Worker's price and weight lookups are by product id and
// have no interest in grouping, so nesting would make every one of them walk
// two levels for nothing. A product whose section is blank (or points at a
// section that was deleted) is uncategorised, and the shop shows it last.
//
// `mrp` is the struck-through "was" price and `badge` a short shelf label
// ("Bestseller", "New") — presentation, not money: the customer is always
// charged `price`, and mrp only has to be higher than it or the discount it
// implies would be a lie. Both are optional; 0 and '' mean "show neither".
//
// Copy comes in two halves on purpose. `description` is the pitch — prose, a
// paragraph or two. `details` is the facts — an ordered list of label/value
// pairs (Pages: 480, Binding: Paperback) the shop renders as tags rather than
// sentences, because a buyer scanning for the page count should not have to
// read a paragraph to find it, and because a free-text blob cannot be laid
// out consistently across products.
//
// `inStock` is the one flag with teeth: false means the shop shows the product
// but refuses to sell it. It is a field rather than "just delete the product"
// because a sold-out title that comes back should not lose its photos, copy
// and reviews-worth of setup — and because deleting it would break the links
// customers already have.
//
// The product shape is deliberately closed: id, name, price, mrp, weight,
// images, section, badge, description, details, inStock. sanitizeProduct
// rebuilds every product from exactly those keys, so an extra
// field cannot arrive from the editor (or from a hand-edit on GitHub) and
// silently become something the Worker has to reason about. Order matters in
// both arrays — products render in file order, and images[0] is the cover.
// `image` is still written alongside `images` as a mirror of the cover, so a
// reader that only wants one photo (the checkout page's product row) doesn't
// have to know the array exists.
//
// Reuses LANDING_SITE_GITHUB_TOKEN rather than minting a separate credential:
// both this repo and prepfusion-landing (which that token already writes to,
// see websiteBanners.js) live under the same PF-pdfs org, and the token has
// been granted Contents: read+write there specifically for this. Falls back
// to GITHUB_TOKEN for the same reason websiteBanners.js does — a missing
// dedicated token should name the real cause instead of a confusing 403 deep
// in a GitHub error body.

const express = require('express');
const sharp = require('sharp');
const { getFileContents, putFileContents } = require('../github/client');
const { validateBookOwnerChange, normaliseEmail } = require('../adminRules');

const OWNER = 'PF-pdfs';
const REPO = 'bookstore-data-repo-seed';
const BRANCH = 'main';
const LIVE_PATH = 'products.json';
const STAGING_PATH = 'products.staging.json';
const IMAGE_DIR = 'images';
// A product page with more than this many photos is a different problem than
// a missing one; the cap exists so a stuck upload loop cannot grow the file
// the Worker fetches on every checkout render.
const MAX_IMAGES = 8;
const MAX_SECTIONS = 12;
const MAX_BADGE = 24;
const MAX_DESCRIPTION = 1200;
const MAX_DETAILS = 10;
const MAX_DETAIL_LABEL = 40;
const MAX_DETAIL_VALUE = 120;

function bookstoreToken() {
  return process.env.LANDING_SITE_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
}

// Repo filenames only — strips any path separators/traversal and keeps just
// the stem, since this becomes a GitHub Contents API path segment. No
// extension from the upload: compressImage always outputs .jpg, so the two
// need to agree. Same shape as websiteBanners.js's helper, kept local rather
// than shared so the two panels' upload rules can drift apart without
// surprising each other.
function sanitizeFilename(name) {
  const base = String(name || 'product').split(/[/\\]/).pop();
  const stem =
    base.replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'product';
  return `${Date.now()}-${stem}.jpg`;
}

// Product shots show at postage-stamp size on the checkout page and a few
// hundred pixels in this panel, so 1200px is generous. The point, as with
// banners, is that a 2MB phone photo never becomes something a customer's
// browser has to download mid-purchase.
async function compressImage(buffer) {
  return sharp(buffer)
    .rotate() // applies EXIF orientation, then the metadata itself is dropped below
    .resize({ width: 1200, withoutEnlargement: true })
    .flatten({ background: '#ffffff' }) // JPEG has no transparency; product shots read best on white
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

// Photos are an ordered list; the first is the cover. Accepts the older
// single-`image` shape too, so a catalog written before this panel grew a
// gallery (or hand-edited to one photo) still loads instead of erroring.
// Returns null — not [] — when the field is present but the wrong type, so a
// malformed list is a validation failure rather than a silent wipe.
function imagesOf(p) {
  if (Array.isArray(p.images)) {
    if (!p.images.every((i) => typeof i === 'string')) return null;
    return p.images.map((i) => i.trim()).filter(Boolean);
  }
  if (p.images !== undefined) return null;
  if (typeof p.image === 'string') return p.image.trim() ? [p.image.trim()] : [];
  if (p.image !== undefined) return null;
  return [];
}

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

function validateSections(sections) {
  if (!Array.isArray(sections)) return 'sections must be an array';
  if (sections.length > MAX_SECTIONS) return `at most ${MAX_SECTIONS} sections`;
  const seen = new Set();
  for (const sec of sections) {
    if (!sec || typeof sec !== 'object') return 'each section must be an object';
    if (typeof sec.id !== 'string' || !SLUG.test(sec.id.trim())) {
      return `"${sec && sec.id}" is not a valid section id — use lowercase letters, numbers, dots or dashes`;
    }
    if (typeof sec.title !== 'string' || !sec.title.trim()) return `section "${sec.id}" needs a title`;
    const id = sec.id.trim();
    if (seen.has(id)) return `two sections share the id "${id}" — ids must be unique`;
    seen.add(id);
  }
  return null;
}

function validateProduct(p) {
  if (!p || typeof p !== 'object') return 'each product must be an object';
  if (typeof p.id !== 'string' || !p.id.trim()) return 'every product needs an id';
  if (!SLUG.test(p.id.trim())) {
    return `"${p.id}" is not a valid id — use lowercase letters, numbers, dots or dashes`;
  }
  if (typeof p.name !== 'string' || !p.name.trim()) return `product "${p.id}" needs a name`;
  // Rupees, not paise.
  if (typeof p.price !== 'number' || !Number.isFinite(p.price) || p.price < 0) {
    return `product "${p.id}" needs a price in rupees (a number, 0 or more)`;
  }
  // Kilograms, not grams.
  if (typeof p.weight !== 'number' || !Number.isFinite(p.weight) || p.weight <= 0) {
    return `product "${p.id}" needs a weight in kg (a number above 0)`;
  }
  // Optional, but if given it has to make the discount honest.
  if (p.mrp !== undefined && p.mrp !== null && p.mrp !== 0) {
    if (typeof p.mrp !== 'number' || !Number.isFinite(p.mrp) || p.mrp <= 0) {
      return `product "${p.id}" has an invalid "was" price`;
    }
    if (p.mrp <= p.price) {
      return `product "${p.id}": the "was" price must be higher than the price actually charged`;
    }
  }
  if (p.badge !== undefined && typeof p.badge !== 'string') return `product "${p.id}" has an invalid badge`;
  if (typeof p.badge === 'string' && p.badge.trim().length > MAX_BADGE) {
    return `product "${p.id}": badge is longer than ${MAX_BADGE} characters`;
  }
  if (p.inStock !== undefined && typeof p.inStock !== 'boolean') return `product "${p.id}" has an invalid stock flag`;
  if (p.description !== undefined && typeof p.description !== 'string') {
    return `product "${p.id}" has an invalid description`;
  }
  if (typeof p.description === 'string' && p.description.trim().length > MAX_DESCRIPTION) {
    return `product "${p.id}": description is longer than ${MAX_DESCRIPTION} characters`;
  }
  if (p.details !== undefined) {
    if (!Array.isArray(p.details)) return `product "${p.id}" has an invalid details list`;
    if (p.details.length > MAX_DETAILS) return `product "${p.id}" has more than ${MAX_DETAILS} detail tags`;
    for (const d of p.details) {
      if (!d || typeof d !== 'object') return `product "${p.id}" has an invalid detail tag`;
      if (typeof d.label !== 'string' || !d.label.trim()) return `product "${p.id}": every detail tag needs a label`;
      if (typeof d.value !== 'string' || !d.value.trim()) {
        return `product "${p.id}": the "${d.label}" tag needs a value`;
      }
      if (d.label.trim().length > MAX_DETAIL_LABEL || d.value.trim().length > MAX_DETAIL_VALUE) {
        return `product "${p.id}": the "${d.label}" tag is too long`;
      }
    }
  }
  const images = imagesOf(p);
  if (images === null) return `product "${p.id}" has an invalid photo list`;
  if (images.length > MAX_IMAGES) return `product "${p.id}" has more than ${MAX_IMAGES} photos`;
  if (p.section !== undefined && typeof p.section !== 'string') return `product "${p.id}" has an invalid section`;
  return null;
}

// Validates the whole catalog, not just the products: a product pointing at a
// section that does not exist would render into a heading the shop never
// draws, which reads to a customer as a missing book.
function validateCatalog(products, sections) {
  const sectionProblem = validateSections(sections);
  if (sectionProblem) return sectionProblem;
  if (!Array.isArray(products)) return 'products must be an array';
  const sectionIds = new Set(sections.map((sec) => sec.id.trim()));
  const seen = new Set();
  for (const p of products) {
    const problem = validateProduct(p);
    if (problem) return problem;
    const id = p.id.trim();
    if (seen.has(id)) return `two products share the id "${id}" — ids must be unique`;
    seen.add(id);
    const section = (p.section || '').trim();
    if (section && !sectionIds.has(section)) {
      return `product "${id}" is in a section that does not exist ("${section}")`;
    }
  }
  return null;
}

function sanitizeProduct(p) {
  const images = imagesOf(p) || [];
  return {
    id: p.id.trim(),
    name: p.name.trim(),
    price: p.price,
    mrp: typeof p.mrp === 'number' && Number.isFinite(p.mrp) && p.mrp > p.price ? p.mrp : 0,
    weight: p.weight,
    badge: (p.badge || '').trim().slice(0, MAX_BADGE),
    // Absent means in stock: a catalog written before this flag existed was, by
    // definition, selling everything in it.
    inStock: p.inStock !== false,
    description: (p.description || '').trim(),
    details: Array.isArray(p.details)
      ? p.details
          .filter((d) => d && String(d.label || '').trim() && String(d.value || '').trim())
          .map((d) => ({ label: d.label.trim().slice(0, MAX_DETAIL_LABEL), value: d.value.trim().slice(0, MAX_DETAIL_VALUE) }))
      : [],
    images,
    image: images[0] || '',
    section: (p.section || '').trim()
  };
}

function sanitizeSection(sec) {
  return { id: sec.id.trim(), title: sec.title.trim() };
}

async function readCatalog(path, token) {
  const file = await getFileContents(OWNER, REPO, BRANCH, path, token);
  const parsed = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  return {
    sections: Array.isArray(parsed.sections) ? parsed.sections : [],
    products: Array.isArray(parsed.products) ? parsed.products : [],
    sha: file.sha
  };
}

// Sections first in the file, because that is the order the shop reads them
// in and a human opening products.json on GitHub should see the shape of the
// shop before the inventory.
function serialize(products, sections) {
  const body = { sections: sections.map(sanitizeSection), products: products.map(sanitizeProduct) };
  return Buffer.from(`${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

function createBookstoreRouter({ requireBookOwner, stores }) {
  const router = express.Router();
  router.use(requireBookOwner);

  // Lets a book owner see who else holds the flag and grant/revoke it —
  // scoped to existing admin accounts only, since anyone without one cannot
  // sign in to use it regardless. This is the self-service path; a site
  // owner has an equivalent one from the Administrators tab (PATCH
  // /api/admins/:email/book-owner) as a bootstrap/recovery route.
  router.get('/owners', async (req, res, next) => {
    try {
      const admins = await stores.admins.list();
      res.json({
        owners: admins.map((a) => ({ email: a.email, name: a.name || null, bookOwner: Boolean(a.bookOwner) })),
        bookOwnerCount: admins.filter((a) => a.bookOwner).length,
        you: req.user.email
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/owners/:email', async (req, res, next) => {
    const email = normaliseEmail(req.params.email);
    try {
      const existing = await stores.admins.findByEmail(email);
      const bookOwnerCount = await stores.admins.countBookOwners();
      const verdict = validateBookOwnerChange({ existing, newValue: (req.body || {}).bookOwner, bookOwnerCount });

      if (verdict.error) {
        res.status(verdict.status).json({ error: verdict.error });
        return;
      }
      if (verdict.noop) {
        res.json({ email, bookOwner: Boolean(existing.bookOwner) });
        return;
      }

      await stores.admins.setBookOwner(email, req.body.bookOwner);
      res.json({ email, bookOwner: Boolean(req.body.bookOwner) });
    } catch (error) {
      next(error);
    }
  });

  // What the editor loads. `sha` goes back out with every save so two admins
  // editing at once get a conflict rather than one silently clobbering the
  // other.
  router.get('/staging', async (req, res, next) => {
    try {
      const { products, sections, sha } = await readCatalog(STAGING_PATH, bookstoreToken());
      res.json({ products, sections, sha });
    } catch (error) {
      next(error);
    }
  });

  // Read-only: what customers are actually being charged right now, for
  // comparison against staging before publishing.
  router.get('/live', async (req, res, next) => {
    try {
      const { products, sections, sha } = await readCatalog(LIVE_PATH, bookstoreToken());
      res.json({ products, sections, sha });
    } catch (error) {
      next(error);
    }
  });

  router.put('/staging', async (req, res, next) => {
    const { products, sections = [], sha } = req.body || {};
    const validationError = validateCatalog(products, sections);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }
    if (!sha) {
      res
        .status(400)
        .json({ error: 'Missing sha — reload the tab and try again (someone else may have saved in between).' });
      return;
    }
    try {
      const result = await putFileContents(
        OWNER,
        REPO,
        BRANCH,
        STAGING_PATH,
        serialize(products, sections),
        `Update bookstore draft catalog (via admin portal — ${req.user.email})`,
        bookstoreToken(),
        sha
      );
      res.json({ ok: true, sha: result.content && result.content.sha });
    } catch (error) {
      if (error.statusCode === 409) {
        res.status(409).json({
          error: 'Someone else saved these products while you were editing. Reload the tab and redo your changes.'
        });
        return;
      }
      next(error);
    }
  });

  // Copies staging over live, verbatim. Both shas are checked: `stagingSha`
  // against what staging holds right now (so nobody can publish a version
  // they never saw — someone may have saved since this tab loaded), and
  // `liveSha` by GitHub itself on the write.
  router.post('/publish', async (req, res, next) => {
    const { stagingSha, liveSha } = req.body || {};
    if (!stagingSha || !liveSha) {
      res.status(400).json({ error: 'Missing sha — reload the tab and try again.' });
      return;
    }
    try {
      const token = bookstoreToken();
      const staging = await readCatalog(STAGING_PATH, token);
      if (staging.sha !== stagingSha) {
        res.status(409).json({
          error: 'The draft changed since this tab loaded it. Reload and check what changed before publishing.'
        });
        return;
      }
      // Validated again on the way out rather than trusted from the save that
      // wrote it: this is the call that puts numbers in front of a real
      // payment flow, and the file is editable on GitHub directly too.
      const validationError = validateCatalog(staging.products, staging.sections);
      if (validationError) {
        res.status(400).json({ error: `The draft is not publishable — ${validationError}` });
        return;
      }
      const result = await putFileContents(
        OWNER,
        REPO,
        BRANCH,
        LIVE_PATH,
        serialize(staging.products, staging.sections),
        `Publish bookstore catalog (via admin portal — ${req.user.email})`,
        token,
        liveSha
      );
      res.json({ ok: true, sha: result.content && result.content.sha });
    } catch (error) {
      if (error.statusCode === 409) {
        res.status(409).json({
          error: 'The live catalog changed since this tab loaded it. Reload and try publishing again.'
        });
        return;
      }
      next(error);
    }
  });

  // Raw image bytes, same as the banner uploader — express.raw() in app.js
  // already accepts these content types. Commits on pick, so the preview can
  // read from raw.githubusercontent instead of holding bytes in the browser
  // until save.
  router.post('/image', async (req, res, next) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      res.status(400).json({ error: 'No image data received' });
      return;
    }
    const filePath = `${IMAGE_DIR}/${sanitizeFilename(req.query.name)}`;
    try {
      const compressed = await compressImage(req.body);
      const token = bookstoreToken();
      // Timestamp-prefixed names mean this is only ever a fresh create, but
      // check anyway — cheap, and correct if that ever changes.
      let sha;
      try {
        const existing = await getFileContents(OWNER, REPO, BRANCH, filePath, token);
        sha = existing.sha;
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
      await putFileContents(OWNER, REPO, BRANCH, filePath, compressed, `Add product image ${filePath}`, token, sha);
      res.json({ path: filePath, bytes: compressed.length });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createBookstoreRouter, OWNER, REPO, BRANCH, LIVE_PATH, STAGING_PATH };
