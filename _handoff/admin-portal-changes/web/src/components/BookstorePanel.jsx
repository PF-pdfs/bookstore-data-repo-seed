import { useEffect, useMemo, useState } from 'react';
import {
  getStagingProducts,
  getLiveProducts,
  saveStagingProducts,
  publishBookstoreCatalog,
  uploadProductImage,
  getBookOwners,
  setBookOwner
} from '../api.js';
import { useAuth } from '../auth.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';

// Two files, one panel: everything above the Publish bar edits the draft
// (products.staging.json), and Publish copies that draft over the live file
// the checkout Worker actually reads. Nothing here touches this app's own
// database — see server/routes/bookstore.js.
//
// The field set is closed on purpose — name, price, an optional struck-through
// "was" price, weight, photos, section, an optional badge, a description, a
// list of detail tags, an in-stock flag, and a product code — and the server
// rebuilds every product from exactly those keys. What IS meant to be rearranged is order: sections show in the
// shop in the order of the section list, products in the order of the product
// list within their section, and a product's first photo is its cover. All
// three have move controls.
//
// Uploads commit to the repo the moment a file is picked, so a preview can
// read straight from raw.githubusercontent rather than holding bytes in the
// browser until Save.
const RAW_BASE = 'https://raw.githubusercontent.com/PF-pdfs/bookstore-data-repo-seed/main/';

const MAX_IMAGES = 8; // both caps match the server's own
const MAX_SECTIONS = 12;

const UNSECTIONED = '__none__'; // only ever a UI key; saved as an empty string

const EMPTY_PRODUCT = {
  id: '',
  name: '',
  price: '',
  mrp: '',
  weight: '',
  images: [],
  section: '',
  badge: '',
  description: '',
  details: [],
  inStock: true
};

const MAX_DETAILS = 10;

// Offered, not enforced: these are the labels a book buyer actually looks for,
// and a shop where one product says "Pages" and the next says "No. of pages"
// reads as two shops.
const DETAIL_PRESETS = [
  'Author',
  'Publisher',
  'ISBN',
  'Pages',
  'Binding',
  'Language',
  'Edition',
  'Published',
  'Dimensions',
  'Subjects covered',
  'Includes'
];

// Free text, but offered as a list: a shelf where every badge is spelled
// differently stops reading as a system and starts reading as noise.
const BADGE_PRESETS = ['Bestseller', 'New', 'Limited stock', 'Best value', 'Exam special'];

function imageUrl(path) {
  if (!path) return '';
  return /^https?:\/\//.test(path) ? path : RAW_BASE + path;
}

// The JSON stores numbers; the form holds strings while someone is midway
// through typing "12." or has emptied the box. These two convert at the edges
// so an in-progress edit never becomes NaN in the saved file. `image` is the
// older single-photo shape — read here, never written back.
function toForm(product) {
  const images = Array.isArray(product.images)
    ? product.images.filter(Boolean)
    : product.image
      ? [product.image]
      : [];
  return {
    ...EMPTY_PRODUCT,
    ...product,
    images,
    section: product.section || '',
    badge: product.badge || '',
    inStock: product.inStock !== false,
    description: product.description || '',
    details: Array.isArray(product.details) ? product.details.map((d) => ({ ...d })) : [],
    mrp: !product.mrp ? '' : String(product.mrp),
    price: product.price === undefined || product.price === null ? '' : String(product.price),
    weight: product.weight === undefined || product.weight === null ? '' : String(product.weight)
  };
}

function toJson(product) {
  return {
    id: product.id.trim(),
    name: product.name.trim(),
    price: Number(product.price),
    mrp: product.mrp === '' ? 0 : Number(product.mrp),
    weight: Number(product.weight),
    badge: (product.badge || '').trim(),
    inStock: product.inStock !== false,
    description: (product.description || '').trim(),
    details: product.details
      .filter((d) => d.label.trim() && d.value.trim())
      .map((d) => ({ label: d.label.trim(), value: d.value.trim() })),
    images: product.images.filter(Boolean),
    section: (product.section || '').trim()
  };
}

const rupees = (value) =>
  Number.isFinite(Number(value)) && value !== ''
    ? `₹${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
    : '₹—';

// What the customer sees on the sticker, and the number that makes the strike
// -through worth having. Rounded down: claiming 25% off when it is 24.6% is
// the kind of small lie a screenshot can catch.
function discountPercent(price, mrp) {
  const p = Number(price);
  const m = Number(mrp);
  if (!Number.isFinite(p) || !Number.isFinite(m) || m <= p || p < 0) return 0;
  return Math.floor(((m - p) / m) * 100);
}

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

// Section ids are never typed — they are derived from the title once, when the
// section is created, and then left alone. A title is a label a customer
// reads; the id is what every product in it points at, so renaming "Bundles"
// must not silently re-home its products.
function slugify(title, taken) {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'section';
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}-${n++}`;
  return candidate;
}

// Mirrors the server's validateProduct, so the reason a save would be refused
// shows up on the card instead of as a 400 after pressing the button.
function problemWith(product, all) {
  const id = product.id.trim();
  if (!id) return 'Needs a product code.';
  if (!SLUG.test(id)) return 'Product code: lowercase letters, numbers, dots or dashes only.';
  if (all.filter((p) => p.id.trim() === id).length > 1) return `Another product already uses the code "${id}".`;
  if (!product.name.trim()) return 'Needs a name.';
  const price = Number(product.price);
  if (product.price === '' || !Number.isFinite(price) || price < 0) return 'Needs a price in rupees.';
  const weight = Number(product.weight);
  if (product.weight === '' || !Number.isFinite(weight) || weight <= 0) return 'Needs a shipping weight in kg.';
  if (product.mrp !== '') {
    const mrp = Number(product.mrp);
    if (!Number.isFinite(mrp) || mrp <= 0) return 'The "was" price must be a number, or left empty.';
    if (mrp <= price) return 'The "was" price has to be higher than the price you actually charge.';
  }
  if ((product.badge || '').trim().length > 24) return 'Badge is longer than 24 characters.';
  if ((product.description || '').trim().length > 1200) return 'Description is longer than 1200 characters.';
  if (product.details.length > MAX_DETAILS) return `At most ${MAX_DETAILS} detail tags.`;
  // A half-filled row is almost always a row someone abandoned, and saving it
  // would put an empty tag on the shelf.
  if (product.details.some((d) => Boolean(d.label.trim()) !== Boolean(d.value.trim()))) {
    return 'Every detail tag needs both a label and a value — or delete the row.';
  }
  if (product.images.length > MAX_IMAGES) return `At most ${MAX_IMAGES} photos per product.`;
  return null;
}

function moved(list, index, dir) {
  const target = index + dir;
  if (target < 0 || target >= list.length) return list;
  const next = list.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

// The photo strip. First photo is the cover — moving one to the front is how
// you change which photo the shop leads with, so there is no separate "make
// cover" control to keep in sync with the ordering.
function PhotoStrip({ images, uploading, onReorder, onDelete, onAdd }) {
  return (
    <div className="bs-photos">
      {images.map((path, i) => (
        <figure key={`${path}-${i}`} className={`bs-thumb${i === 0 ? ' is-cover' : ''}`}>
          <img src={imageUrl(path)} alt="" />
          {i === 0 && <figcaption>Cover</figcaption>}
          <div className="bs-thumb-tools">
            <button
              type="button"
              className="ghost bs-thumb-btn"
              onClick={() => onReorder(i, -1)}
              disabled={i === 0}
              title="Move this photo earlier"
              aria-label={`Move photo ${i + 1} earlier`}
            >
              ‹
            </button>
            <button
              type="button"
              className="ghost bs-thumb-btn"
              onClick={() => onReorder(i, 1)}
              disabled={i === images.length - 1}
              title="Move this photo later"
              aria-label={`Move photo ${i + 1} later`}
            >
              ›
            </button>
            <button
              type="button"
              className="danger bs-thumb-btn"
              onClick={() => onDelete(i)}
              title="Delete this photo"
              aria-label={`Delete photo ${i + 1}`}
            >
              ✕
            </button>
          </div>
        </figure>
      ))}

      {images.length < MAX_IMAGES && (
        <label className={`bs-addphoto${uploading ? ' is-busy' : ''}`}>
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onAdd} disabled={uploading} />
          <span>{uploading ? 'Uploading…' : images.length ? '+ Add photo' : '+ Add the first photo'}</span>
        </label>
      )}
    </div>
  );
}

// Label/value rows rather than one free-text box: the shop renders these as
// tags, so they have to stay two fields all the way through.
function DetailRows({ details, onChange }) {
  const setAt = (i, next) => onChange(details.map((d, j) => (j === i ? next : d)));

  return (
    <div className="bs-details">
      {details.map((d, i) => (
        <div className="bs-detail-row" key={i}>
          <input
            type="text"
            className="bs-detail-label"
            value={d.label}
            list="bs-detail-labels"
            maxLength={40}
            placeholder="Pages"
            onChange={(e) => setAt(i, { ...d, label: e.target.value })}
            aria-label={`Detail ${i + 1} label`}
          />
          <input
            type="text"
            value={d.value}
            maxLength={120}
            placeholder="480"
            onChange={(e) => setAt(i, { ...d, value: e.target.value })}
            aria-label={`Detail ${i + 1} value`}
          />
          <button
            type="button"
            className="danger ba-icon"
            onClick={() => onChange(details.filter((_, j) => j !== i))}
            title="Delete this detail"
            aria-label={`Delete detail ${i + 1}`}
          >
            ✕
          </button>
        </div>
      ))}
      <datalist id="bs-detail-labels">
        {DETAIL_PRESETS.map((label) => (
          <option key={label} value={label} />
        ))}
      </datalist>
      {details.length < MAX_DETAILS && (
        <button type="button" className="ghost bs-detail-add" onClick={() => onChange([...details, { label: '', value: '' }])}>
          + Add detail
        </button>
      )}
    </div>
  );
}

function ProductCard({
  product,
  position,
  count,
  sections,
  isNew,
  problem,
  uploading,
  onChange,
  onMove,
  onRemove,
  onAddPhoto,
  onReorderPhoto,
  onDeletePhoto
}) {
  const set = (field) => (e) => onChange({ ...product, [field]: e.target.value });
  const cover = product.images[0];
  const off = discountPercent(product.price, product.mrp);

  return (
    <li className={`bs-card${problem ? ' is-invalid' : ''}${product.inStock ? '' : ' is-soldout'}`}>
      <div className="bs-shot">
        {cover ? <img src={imageUrl(cover)} alt="" /> : <span className="bs-shot-empty">No photo yet</span>}
        <span className="bs-order">#{position + 1}</span>
      </div>

      <div className="bs-body">
        <header className="bs-card-head">
          <div className="bs-card-title">
            <strong>{product.name.trim() || 'Untitled product'}</strong>
            <div className="bs-pricing">
              <span className="bs-price-tag">{rupees(product.price)}</span>
              {off > 0 && (
                <>
                  <s className="bs-was">{rupees(product.mrp)}</s>
                  <span className="bs-off">{off}% off</span>
                </>
              )}
              {product.badge.trim() && <span className="bs-badge">{product.badge.trim()}</span>}
              {!product.inStock && <span className="bs-soldout">Sold out</span>}
            </div>
          </div>
          <div className="bs-card-tools">
            <button
              type="button"
              className="ghost ba-icon"
              onClick={() => onMove(-1)}
              disabled={position === 0}
              title="Show this product earlier in its section"
              aria-label="Move product earlier"
            >
              ↑
            </button>
            <button
              type="button"
              className="ghost ba-icon"
              onClick={() => onMove(1)}
              disabled={position === count - 1}
              title="Show this product later in its section"
              aria-label="Move product later"
            >
              ↓
            </button>
            <button
              type="button"
              className="danger ba-icon"
              onClick={onRemove}
              title="Remove this product"
              aria-label="Remove product"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="bs-field">
          <span className="bs-field-label">
            Photos
            <em className="bs-count-chip">
              {product.images.length}/{MAX_IMAGES}
            </em>
          </span>
          <PhotoStrip
            images={product.images}
            uploading={uploading}
            onAdd={onAddPhoto}
            onReorder={onReorderPhoto}
            onDelete={onDeletePhoto}
          />
          <span className="bs-hint">The first photo is the one the shop leads with — use ‹ › to change which.</span>
        </div>

        <label className="bs-field">
          <span className="bs-field-label">Name</span>
          <input type="text" value={product.name} onChange={set('name')} placeholder="e.g. EE Complete Bundle" />
          <span className="bs-hint">Exactly what the customer sees on the checkout page.</span>
        </label>

        <div className="bs-pair">
          <label className="bs-field">
            <span className="bs-field-label">Price (₹)</span>
            <input
              type="number"
              min="0"
              step="1"
              inputMode="decimal"
              value={product.price}
              onChange={set('price')}
              placeholder="1499"
            />
            <span className="bs-hint">Whole rupees — what the card is charged.</span>
          </label>
          <label className="bs-field">
            <span className="bs-field-label">
              Was (₹) <em className="bs-locked">optional</em>
            </span>
            <input
              type="number"
              min="0"
              step="1"
              inputMode="decimal"
              value={product.mrp}
              onChange={set('mrp')}
              placeholder="1999"
            />
            <span className="bs-hint">
              {off > 0 ? `Shows struck through, with "${off}% off".` : 'Shown struck through beside the price.'}
            </span>
          </label>
        </div>

        <label className="bs-check">
          <input
            type="checkbox"
            checked={product.inStock}
            onChange={(e) => onChange({ ...product, inStock: e.target.checked })}
          />
          <span>
            In stock
            <em className="bs-hint">
              {product.inStock
                ? 'Customers can buy this right now.'
                : 'Still listed, but the shop will not let anyone buy it.'}
            </em>
          </span>
        </label>

        <div className="bs-pair">
          <label className="bs-field">
            <span className="bs-field-label">Weight (kg)</span>
            <input
              type="number"
              min="0"
              step="0.1"
              inputMode="decimal"
              value={product.weight}
              onChange={set('weight')}
              placeholder="1.2"
            />
            <span className="bs-hint">Kilograms — books the courier. Customers never see this.</span>
          </label>
          <label className="bs-field">
            <span className="bs-field-label">
              Badge <em className="bs-locked">optional</em>
            </span>
            <input
              type="text"
              value={product.badge}
              onChange={set('badge')}
              list="bs-badges"
              maxLength={24}
              placeholder="e.g. Bestseller"
            />
            <datalist id="bs-badges">
              {BADGE_PRESETS.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
            <span className="bs-hint">A small label on the shop's card. Leave empty for none.</span>
          </label>
        </div>

        <label className="bs-field">
          <span className="bs-field-label">
            Description <em className="bs-locked">optional</em>
          </span>
          <textarea
            rows={3}
            value={product.description}
            onChange={set('description')}
            maxLength={1200}
            placeholder="What this is and who it's for — a short paragraph the shop shows under the photos."
          />
          <span className="bs-hint">The pitch. Keep facts like page count in the detail tags below instead.</span>
        </label>

        <div className="bs-field">
          <span className="bs-field-label">
            Details
            <em className="bs-count-chip">
              {product.details.length}/{MAX_DETAILS}
            </em>
          </span>
          <DetailRows details={product.details} onChange={(details) => onChange({ ...product, details })} />
          <span className="bs-hint">Shown as tags — Pages · 480, Binding · Paperback — not as a paragraph.</span>
        </div>

        <label className="bs-field">
          <span className="bs-field-label">Section</span>
          <select value={product.section} onChange={set('section')}>
            <option value="">No section (shown last)</option>
            {sections.map((sec) => (
              <option key={sec.id} value={sec.id}>
                {sec.title}
              </option>
            ))}
          </select>
          <span className="bs-hint">Moving it here moves the card to that section's shelf.</span>
        </label>

        <label className="bs-field">
          <span className="bs-field-label">
            Product code {!isNew && <em className="bs-locked">fixed once created</em>}
          </span>
          <input type="text" value={product.id} onChange={set('id')} readOnly={!isNew} placeholder="e.g. ee-bundle" />
          <span className="bs-hint">
            {isNew
              ? 'A short id the checkout system uses internally. Lowercase, no spaces.'
              : 'Renaming would break orders already in flight — remove the product and add a new one instead.'}
          </span>
        </label>

        {problem && <p className="error bs-problem">{problem}</p>}
      </div>
    </li>
  );
}

// A plain-language diff of draft vs live, so Publish is never a leap of
// faith — especially for price changes, which are the ones that cost money
// when they are wrong.
function changesBetween(liveCatalog, draftCatalog) {
  const live = liveCatalog.products;
  const draft = draftCatalog.products;
  const liveById = new Map(live.map((p) => [p.id, p]));
  const draftById = new Map(draft.map((p) => [p.id, p]));
  const liveSections = new Map(liveCatalog.sections.map((s) => [s.id, s.title]));
  const draftSections = new Map(draftCatalog.sections.map((s) => [s.id, s.title]));
  const changes = [];

  for (const [id, title] of draftSections) {
    if (!liveSections.has(id)) changes.push({ kind: 'added', text: `Section "${title}"` });
    else if (liveSections.get(id) !== title) {
      changes.push({ kind: 'changed', text: `Section renamed: "${liveSections.get(id)}" → "${title}"` });
    }
  }
  for (const [id, title] of liveSections) {
    if (!draftSections.has(id)) changes.push({ kind: 'removed', text: `Section "${title}"` });
  }
  const sharedSectionOrder = (list, other) => list.filter((s) => other.has(s.id)).map((s) => s.id).join();
  if (sharedSectionOrder(liveCatalog.sections, draftSections) !== sharedSectionOrder(draftCatalog.sections, liveSections)) {
    changes.push({ kind: 'changed', text: 'The order the sections appear in has changed' });
  }

  for (const p of draft) {
    const before = liveById.get(p.id);
    if (!before) {
      changes.push({ kind: 'added', text: `${p.name} — new, at ${rupees(p.price)}` });
      continue;
    }
    const bits = [];
    if (before.name !== p.name) bits.push(`renamed from "${before.name}"`);
    if (Number(before.price) !== Number(p.price)) bits.push(`price ${rupees(before.price)} → ${rupees(p.price)}`);
    if (Number(before.mrp || 0) !== Number(p.mrp || 0)) {
      bits.push(
        p.mrp
          ? `"was" price ${rupees(p.mrp)} (${discountPercent(p.price, p.mrp)}% off)`
          : 'the struck-through "was" price removed'
      );
    }
    if ((before.inStock !== false) !== (p.inStock !== false)) {
      bits.push(p.inStock ? 'back in stock' : 'marked sold out');
    }
    if ((before.description || '') !== (p.description || '')) {
      bits.push(p.description ? 'description edited' : 'description removed');
    }
    if (JSON.stringify(before.details || []) !== JSON.stringify(p.details || [])) {
      bits.push(`details ${(before.details || []).length} → ${p.details.length} tag${p.details.length === 1 ? '' : 's'}`);
    }
    if ((before.badge || '') !== (p.badge || '')) {
      bits.push(p.badge ? `badge "${p.badge}"` : 'badge removed');
    }
    if (Number(before.weight) !== Number(p.weight)) bits.push(`weight ${before.weight}kg → ${p.weight}kg`);
    if ((before.section || '') !== (p.section || '')) {
      const from = liveSections.get(before.section || '') || 'no section';
      const to = draftSections.get(p.section || '') || 'no section';
      bits.push(`moved from ${from} to ${to}`);
    }
    const beforeImages = before.images || (before.image ? [before.image] : []);
    if (JSON.stringify(beforeImages) !== JSON.stringify(p.images)) {
      bits.push(
        beforeImages.length === p.images.length
          ? 'photos reordered or replaced'
          : `photos ${beforeImages.length} → ${p.images.length}`
      );
    }
    if (bits.length) changes.push({ kind: 'changed', text: `${p.name} — ${bits.join(', ')}` });
  }
  for (const p of live) {
    if (!draftById.has(p.id)) changes.push({ kind: 'removed', text: `${p.name} — removed from the shop` });
  }

  // Order is what the shop renders in, so a pure reshuffle is a real change
  // and has to show up here — otherwise Publish would sit disabled after it.
  const liveOrder = live.map((p) => p.id).filter((id) => draftById.has(id));
  const draftOrder = draft.map((p) => p.id).filter((id) => liveById.has(id));
  if (liveOrder.join() !== draftOrder.join()) {
    changes.push({ kind: 'changed', text: 'The order products appear in has changed' });
  }
  return changes;
}

// Book-owner-only self-service — the whole reason this tab exists behind a
// permission narrower than isOwner. Anyone who can see this tab already IS a
// book owner, so this list is symmetric: every book owner can grant or
// revoke the flag on any other, the same shape as the Administrators tab's
// owner/admin toggle. Only existing admin accounts show up here — someone
// with no portal login at all cannot use the flag regardless of who has it.
function BookOwners() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busyEmail, setBusyEmail] = useState(null);
  const [open, setOpen] = useState(false);

  const load = () => {
    setError('');
    getBookOwners()
      .then(setData)
      .catch((e) => setError(e.message));
  };

  useEffect(load, []);

  const toggle = async (owner) => {
    setBusyEmail(owner.email);
    setError('');
    try {
      await setBookOwner(owner.email, !owner.bookOwner);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyEmail(null);
    }
  };

  const owners = (data && data.owners) || [];
  const bookOwnerCount = (data && data.bookOwnerCount) || 0;

  return (
    <div className="bs-owners">
      <button type="button" className="ghost bs-owners-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide' : 'Manage'} book owners
        {data && ` (${bookOwnerCount})`}
      </button>

      {open && (
        <div className="bs-owners-body">
          <p className="muted small">
            Only a book owner can see or edit this tab. Granting it here works on anyone who already has
            an administrator account — add them in the Administrators tab first if they don't yet.
          </p>
          {error && <p className="error">{error}</p>}
          {!data && !error && <p className="muted">Loading…</p>}
          {owners.length > 0 && (
            <ul className="bs-owners-list">
              {owners.map((o) => {
                const isLast = o.bookOwner && bookOwnerCount <= 1;
                const isSelf = user && o.email === user.email;
                return (
                  <li key={o.email}>
                    <span className="bs-owners-email">
                      {o.name ? `${o.name} ` : ''}
                      <span className="muted small">{o.email}</span>
                      {isSelf && <span className="tag"> you</span>}
                    </span>
                    <button
                      type="button"
                      className={o.bookOwner ? undefined : 'ghost'}
                      disabled={busyEmail === o.email || isLast}
                      title={isLast ? 'Grant it to someone else first' : ''}
                      onClick={() => toggle(o)}
                    >
                      {o.bookOwner ? 'Book owner' : 'Grant'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// Book-owner-only. The shop's product catalog, edited here and pushed as a
// commit to the public data repo the Cloudflare checkout Worker reads.
export default function BookstorePanel() {
  const [products, setProducts] = useState(null);
  const [sections, setSections] = useState([]);
  const [stagingSha, setStagingSha] = useState(null);
  const [original, setOriginal] = useState('');
  const [live, setLive] = useState(null);
  const [liveSha, setLiveSha] = useState(null);

  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [justPublished, setJustPublished] = useState(false);
  const [uploadingId, setUploadingId] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removeSection, setRemoveSection] = useState(null);
  const [confirmPublish, setConfirmPublish] = useState(false);

  const load = () => {
    setLoadError('');
    Promise.all([getStagingProducts(), getLiveProducts()])
      .then(([staging, liveCatalog]) => {
        const list = (staging.products || []).map(toForm);
        setProducts(list);
        setSections(staging.sections || []);
        setStagingSha(staging.sha);
        setOriginal(JSON.stringify({ products: list, sections: staging.sections || [] }));
        setLive({ products: liveCatalog.products || [], sections: liveCatalog.sections || [] });
        setLiveSha(liveCatalog.sha);
      })
      .catch((e) => setLoadError(e.message));
  };

  useEffect(load, []);

  const dirty = products !== null && JSON.stringify({ products, sections }) !== original;
  const problems = useMemo(() => (products ? products.map((p) => problemWith(p, products)) : []), [products]);
  const hasProblem = problems.some(Boolean);

  // Compared against the last saved draft, not the in-progress edits: an
  // unsaved change is not something Publish could push anyway.
  const savedDraft = useMemo(() => {
    if (!original) return { products: [], sections: [] };
    try {
      const parsed = JSON.parse(original);
      return { products: parsed.products.map(toJson), sections: parsed.sections };
    } catch (error) {
      return { products: [], sections: [] };
    }
  }, [original]);
  const changes = useMemo(() => (live ? changesBetween(live, savedDraft) : []), [live, savedDraft]);

  // One shelf per section, in section order, plus a trailing shelf for
  // anything uncategorised — including products pointing at a section that
  // was deleted, which the shop also shows last.
  const shelves = useMemo(() => {
    if (!products) return [];
    const known = new Set(sections.map((s) => s.id));
    const out = sections.map((sec) => ({ ...sec, key: sec.id, items: [] }));
    const byId = new Map(out.map((s) => [s.id, s]));
    const loose = { id: '', key: UNSECTIONED, title: 'No section', items: [] };
    products.forEach((product, index) => {
      const target = product.section && known.has(product.section) ? byId.get(product.section) : loose;
      target.items.push({ product, index });
    });
    return loose.items.length ? [...out, loose] : out;
  }, [products, sections]);

  const touch = () => setJustSaved(false);

  const replaceAt = (index, next) => {
    touch();
    setProducts((list) => list.map((p, i) => (i === index ? next : p)));
  };

  // Products live in one flat array; "move down inside this section" means
  // swapping with the next product that shares the section, wherever it
  // happens to sit in that array.
  const moveProduct = (index, dir) => {
    touch();
    setProducts((list) => {
      const section = list[index].section || '';
      const siblings = list.map((p, i) => ({ p, i })).filter(({ p }) => (p.section || '') === section);
      const at = siblings.findIndex(({ i }) => i === index);
      const swapWith = siblings[at + dir];
      if (!swapWith) return list;
      const next = list.slice();
      [next[index], next[swapWith.i]] = [next[swapWith.i], next[index]];
      return next;
    });
  };

  const addProduct = (section) => {
    touch();
    setProducts((list) => [...list, { ...EMPTY_PRODUCT, images: [], section, _new: true }]);
  };

  const addSection = () => {
    touch();
    const taken = new Set(sections.map((s) => s.id));
    setSections((list) => [...list, { id: slugify('New section', taken), title: '' }]);
  };

  const renameSection = (index, title) => {
    touch();
    setSections((list) => list.map((s, i) => (i === index ? { ...s, title } : s)));
  };

  const moveSection = (index, dir) => {
    touch();
    setSections((list) => moved(list, index, dir));
  };

  // Deleting a section never deletes products — they fall back to the
  // uncategorised shelf, which is recoverable; a delete that also removed
  // stock would not be.
  const deleteSection = (id) => {
    touch();
    setSections((list) => list.filter((s) => s.id !== id));
    setProducts((list) => list.map((p) => (p.section === id ? { ...p, section: '' } : p)));
    setRemoveSection(null);
  };

  const addPhoto = (index) => async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setUploadingId(index);
    setSaveError('');
    try {
      const { path } = await uploadProductImage(file);
      // Read from state rather than the closed-over product: an upload takes
      // long enough that the same card may have been edited meanwhile.
      setProducts((list) =>
        list.map((p, i) => (i === index ? { ...p, images: [...p.images, path].slice(0, MAX_IMAGES) } : p))
      );
      touch();
    } catch (err) {
      setSaveError(`Photo upload failed — ${err.message}`);
    } finally {
      setUploadingId(null);
    }
  };

  const reorderPhoto = (index) => (photoIndex, dir) =>
    replaceAt(index, { ...products[index], images: moved(products[index].images, photoIndex, dir) });

  // Deleting here only drops the reference from this product. The file stays
  // in the repo — cheap, and it means an accidental delete followed by a
  // reload (before saving) does not need a re-upload.
  const deletePhoto = (index) => (photoIndex) =>
    replaceAt(index, { ...products[index], images: products[index].images.filter((_, i) => i !== photoIndex) });

  const save = async () => {
    setSaving(true);
    setSaveError('');
    try {
      const payload = products.map(toJson);
      const cleanSections = sections.map((s) => ({ id: s.id, title: s.title.trim() }));
      const result = await saveStagingProducts(payload, cleanSections, stagingSha);
      setStagingSha(result.sha || stagingSha);
      // Re-derived from the saved payload rather than kept as typed, so the
      // draft-vs-live diff compares numbers with numbers.
      const normalised = payload.map(toForm);
      setProducts(normalised);
      setSections(cleanSections);
      setOriginal(JSON.stringify({ products: normalised, sections: cleanSections }));
      setJustSaved(true);
      setJustPublished(false);
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    setConfirmPublish(false);
    setPublishing(true);
    setPublishError('');
    try {
      const result = await publishBookstoreCatalog(stagingSha, liveSha);
      setLiveSha(result.sha || liveSha);
      setLive(savedDraft);
      setJustPublished(true);
      setJustSaved(false);
    } catch (err) {
      setPublishError(err.message);
    } finally {
      setPublishing(false);
    }
  };

  const emptyTitle = sections.some((s) => !s.title.trim());

  if (loadError) {
    return (
      <section className="card bookstore-admin">
        <div className="section-head">
          <h2>Bookstore</h2>
        </div>
        <p className="error">{loadError}</p>
        <button type="button" onClick={load}>
          Try again
        </button>
      </section>
    );
  }

  return (
    <section className="card bookstore-admin">
      <div className="section-head">
        <h2>Bookstore</h2>
        {products && (
          <span className="bs-count">
            {products.length} product{products.length === 1 ? '' : 's'} in {sections.length} section
            {sections.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <p className="card-sub">
        The printed books and bundles customers can buy, grouped into the shelves they appear under in the shop —
        Bundles, single books, and whatever else you add. Sections and the products inside them show in the order
        set here; use ↑ and ↓ to change it. Everything is saved as a <strong>draft</strong>: the shop keeps selling
        the old catalog until you press <strong>Publish</strong>, which takes about a minute to go live.
      </p>

      <BookOwners />

      {!products && <p className="muted">Loading…</p>}

      {products && (
        <>
          {shelves.length === 0 && (
            <p className="muted bs-empty">Nothing in the shop yet. Add a section below, then put products in it.</p>
          )}

          {shelves.map((shelf, shelfIndex) => (
            <div key={shelf.key} className={`bs-shelf${shelf.key === UNSECTIONED ? ' is-loose' : ''}`}>
              <div className="bs-shelf-head">
                {shelf.key === UNSECTIONED ? (
                  <div className="bs-shelf-name">
                    <strong>No section</strong>
                    <span className="bs-hint">
                      These still sell — the shop lists them after every section. Pick a section on the card to
                      shelve them.
                    </span>
                  </div>
                ) : (
                  <>
                    <label className="bs-shelf-name">
                      <span className="bs-field-label">Section name</span>
                      <input
                        type="text"
                        value={shelf.title}
                        onChange={(e) => renameSection(shelfIndex, e.target.value)}
                        placeholder="e.g. Bundles"
                      />
                    </label>
                    <div className="bs-card-tools">
                      <button
                        type="button"
                        className="ghost ba-icon"
                        onClick={() => moveSection(shelfIndex, -1)}
                        disabled={shelfIndex === 0}
                        title="Show this section higher up the shop"
                        aria-label="Move section up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="ghost ba-icon"
                        onClick={() => moveSection(shelfIndex, 1)}
                        disabled={shelfIndex === sections.length - 1}
                        title="Show this section lower down the shop"
                        aria-label="Move section down"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="danger ba-icon"
                        onClick={() => setRemoveSection(shelf)}
                        title="Remove this section"
                        aria-label="Remove section"
                      >
                        ✕
                      </button>
                    </div>
                  </>
                )}
                <span className="bs-count-chip">
                  {shelf.items.length} product{shelf.items.length === 1 ? '' : 's'}
                </span>
              </div>

              {shelf.items.length === 0 ? (
                <p className="muted small bs-shelf-empty">Nothing on this shelf yet.</p>
              ) : (
                <ul className="bs-grid">
                  {shelf.items.map(({ product, index }, position) => (
                    <ProductCard
                      key={index}
                      product={product}
                      position={position}
                      count={shelf.items.length}
                      sections={sections}
                      isNew={Boolean(product._new) || !live || !live.products.some((l) => l.id === product.id)}
                      problem={problems[index]}
                      uploading={uploadingId === index}
                      onChange={(next) => replaceAt(index, next)}
                      onMove={(dir) => moveProduct(index, dir)}
                      onRemove={() => setRemoveTarget(index)}
                      onAddPhoto={addPhoto(index)}
                      onReorderPhoto={reorderPhoto(index)}
                      onDeletePhoto={deletePhoto(index)}
                    />
                  ))}
                </ul>
              )}

              {shelf.key !== UNSECTIONED && (
                <button type="button" className="ghost bs-add-in" onClick={() => addProduct(shelf.id)}>
                  + Add product to {shelf.title.trim() || 'this section'}
                </button>
              )}
            </div>
          ))}

          <div className="bs-bar">
            <div className="bs-bar-end">
              <button type="button" className="ghost" onClick={addSection} disabled={sections.length >= MAX_SECTIONS}>
                + Add section
              </button>
              <button type="button" className="ghost" onClick={() => addProduct(sections[0] ? sections[0].id : '')}>
                + Add product
              </button>
            </div>
            <div className="bs-bar-end">
              {saveError && <span className="error bs-status">{saveError}</span>}
              {!saveError && hasProblem && (
                <span className="bs-status bs-status-warn">Fix the highlighted products before saving.</span>
              )}
              {!saveError && !hasProblem && emptyTitle && (
                <span className="bs-status bs-status-warn">Every section needs a name.</span>
              )}
              {!saveError && !hasProblem && !emptyTitle && justSaved && (
                <span className="bs-status bs-status-ok">Draft saved — not live yet.</span>
              )}
              {!saveError && !hasProblem && !emptyTitle && !justSaved && dirty && (
                <span className="bs-status">Unsaved changes.</span>
              )}
              <button
                type="button"
                onClick={save}
                disabled={saving || !dirty || hasProblem || emptyTitle || uploadingId !== null}
              >
                {saving ? 'Saving…' : 'Save draft'}
              </button>
            </div>
          </div>

          <div className="bs-publish">
            <div className="bs-publish-head">
              <h3>Live in the shop</h3>
              <span className={`status-badge status-${changes.length ? 'open' : 'resolved'}`}>
                {changes.length ? `${changes.length} change${changes.length === 1 ? '' : 's'} waiting` : 'Up to date'}
              </span>
            </div>

            {changes.length === 0 ? (
              <p className="muted small">The shop is selling exactly what the draft says. Nothing to publish.</p>
            ) : (
              <ul className="bs-changes">
                {changes.map((c, i) => (
                  <li key={i} className={`bs-change bs-change-${c.kind}`}>
                    <span className="bs-change-kind">
                      {c.kind === 'added' ? 'New' : c.kind === 'removed' ? 'Removed' : 'Changed'}
                    </span>
                    {c.text}
                  </li>
                ))}
              </ul>
            )}

            {dirty && changes.length > 0 && (
              <p className="bs-status bs-status-warn">
                You have unsaved edits — save the draft first, or they won't be part of this publish.
              </p>
            )}
            {publishError && <p className="error">{publishError}</p>}
            {justPublished && <p className="bs-status bs-status-ok">Published — live in the shop within a minute.</p>}

            <div className="bs-publish-foot">
              <span className="muted small">
                Publishing replaces the live catalog with the saved draft, exactly as shown above.
              </span>
              <button
                type="button"
                onClick={() => setConfirmPublish(true)}
                disabled={publishing || dirty || changes.length === 0}
              >
                {publishing ? 'Publishing…' : 'Publish to the shop'}
              </button>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        title="Remove this product?"
        message="It stays in the shop until you publish. Orders already placed are unaffected."
        confirmLabel="Remove"
        danger
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          setProducts((list) => list.filter((_, i) => i !== removeTarget));
          setRemoveTarget(null);
          touch();
        }}
      />

      <ConfirmDialog
        open={removeSection !== null}
        title={removeSection ? `Remove the "${removeSection.title || 'untitled'}" section?` : ''}
        message={
          removeSection && removeSection.items.length
            ? `Its ${removeSection.items.length} product${removeSection.items.length === 1 ? '' : 's'} are not deleted — they move to "No section" and keep selling until you shelve them somewhere else.`
            : 'The section is empty, so nothing else changes.'
        }
        confirmLabel="Remove section"
        danger
        onCancel={() => setRemoveSection(null)}
        onConfirm={() => deleteSection(removeSection.id)}
      />

      <ConfirmDialog
        open={confirmPublish}
        title="Publish to the shop?"
        message="This makes the draft the live catalog immediately — real customers will be charged these prices within about a minute."
        confirmLabel="Publish"
        onCancel={() => setConfirmPublish(false)}
        onConfirm={publish}
      />
    </section>
  );
}
