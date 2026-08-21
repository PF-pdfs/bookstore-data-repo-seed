# Bookstore — status & handoff

As of 2026-08-21. **Read this whole file before touching anything.** It is
written so a different AI session, or a human, can pick this up cold.

---

## Status

| Piece | State |
|---|---|
| Admin portal (Bookstore tab, Book Owner permission, shop settings) | **Done, committed and pushed** to `PF-study-hub/PrepFusion-StudyHub-AdminsPortal`. Live once Render redeploys. |
| Data repo + GitHub Pages | **Live** at `PF-pdfs/bookstore-data-repo-seed`, seeded with the real 5-product catalog and covers. |
| Storefront + cart + checkout (this repo's `worker.js`) | **Written and tested — NOT deployed.** |
| Webhook: shipments, emails, failure handling, Razorpay events | **Written and tested — NOT deployed.** |
| Resend sending domain | **Done** — `store.prepfusion.in` verified. |
| Razorpay account wiring (keys, webhook config, test purchase) | **Not started — the next concrete step.** |

**Tested, not proven.** 15 unit tests + 148 end-to-end checks pass against
the exact `worker.js` in this repo (`node --test worker.test.mjs` and
`node worker.e2e.mjs`, no wrangler or network needed). That is not the
same as working in production — one real test-mode purchase through
Razorpay is still the actual gate. Do that before anything goes live.

---

## Read in this order

1. **This file** — the map.
2. **`worker.js`** — the code. Read its top-of-file comment block first;
   it has the full setup checklist (steps A–H).
3. **`FAILURE-MODES.md`** — every payment-path failure mode, what happens,
   what's tested. Read before deploying, not after something breaks.
4. **`storefront-design.md`** — why the storefront is shaped the way it
   is (three Razorpay products exist; this uses Orders API + Checkout.js,
   not the hosted Payment Page that was live before this work started).
5. **`QUESTIONS-FOR-RAZORPAY.md`** — mostly already answered by fetching
   Razorpay's own docs (see below); kept for the few genuinely open items.

---

## What exists and what doesn't (don't assume from an old context)

- There is **no separate checkout page product on Razorpay's side anymore
  in design** — this Worker's `GET /` **is** the storefront now. If you
  see references to "Razorpay's Payment Page/Store," that's the *old*
  setup this work replaces; check `storefront-design.md`'s table if
  confused about which Razorpay product does what.
- **Prices in the live catalog are ₹1**, deliberately, for test purchases.
  Real prices get set from the admin portal's Bookstore tab — **never**
  edit `products.json` by hand for that; the portal validates things a
  hand-edit won't (e.g. a "was" price that isn't actually higher).
- **Weights are estimates** from a print QC report's spine widths, not a
  scale. Correct them in the Bookstore tab before real shipping rates
  matter — Courier Karo bills against this number.
- **NexusX Volume 1 and 2 are ONE product** (`id: "nexusx"`), not two —
  sold as a set, four cover images, combined weight. Don't re-split them
  without being told to.
- **`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` do not exist yet anywhere.**
  These are new, needed only for `/create-order`, and are different from
  `RAZORPAY_WEBHOOK_SECRET` (which already existed and only verifies
  incoming webhooks). Generate them in Razorpay Dashboard → Settings →
  API Keys.
- **`SUPPORT_EMAIL` is set** to `bookstore.prepfusion@gmail.com` — a real,
  human-read inbox, confirmed by the person running this project. Not a
  placeholder.

---

## The two-brake freeze design (why it exists)

The owner explicitly asked: if Cloudflare's free KV write quota is at
risk of running out, the shop must refuse new orders rather than silently
fail mid-checkout. Two independent brakes, both checked on every page
load and every `/create-order` call:

1. **`settings.storeOpen`** (admin panel switch) — manual, for planned
   maintenance. Off = maintenance page, no ordering.
2. **`DAILY_ORDER_LIMIT = 300`** (constant in `worker.js`) — automatic.
   Free-tier KV allows 1,000 writes/day; an order costs up to 3 writes,
   so 300 leaves a wide margin. Counted at `/create-order` (so abandoned
   checkouts count too, since they also burn KV writes), resets at 00:00
   UTC — which is also when Cloudflare's quota resets.

Both are tested (`worker.e2e.mjs` scenarios 19–20). On Cloudflare's Paid
Workers plan ($5/mo, unlimited KV writes) `DAILY_ORDER_LIMIT` becomes a
pure business choice, not a technical necessity — raise it freely.

---

## Razorpay facts verified against their real docs this session

Fetched directly from `razorpay.com/docs`, not assumed:

- Failed webhook deliveries retry with **exponential backoff for 24
  hours**, then the webhook is **disabled** and Razorpay **emails the
  webhook's configured Alert Email Address**. **This must be set** — it's
  the only backstop for "the Worker is down and can't alert anyone
  itself," which is documented in `FAILURE-MODES.md` as the one gap code
  can't close.
- Razorpay expects a webhook response within **5 seconds** — the
  catalog-fetch timeout inside the webhook was tightened to 3s to protect
  that budget with margin.
- Delivery is **at-least-once** (duplicates happen) — already handled by
  the claim/dedup design in `FAILURE-MODES.md`.
- `payment.failed` **can be followed by `payment.captured`** for the same
  order (a UPI customer retrying) — so it is logged only, never treated
  as final. Tested (scenario 25).
- `order.paid` fires **alongside** `payment.captured` for the same money
  — deliberately ignored, or every order would book twice. Tested
  (scenario 30).

All Razorpay event types the account can send were reviewed; the ones
that matter to a physical-goods shop are wired up (`payment.failed`,
`refund.*`, `payment.dispute.*`, `payment.downtime.*`) — see the setup
comment block at the top of `worker.js`, step E, for exactly which
checkboxes to tick in the Razorpay dashboard.

---

## What's actually left — in order

1. **Restore secrets in `worker.js`'s CONFIG block** (see the file's own
   header comment) and add the two new Razorpay API keys.
2. **Deploy to a Cloudflare Worker preview environment.** Not production.
3. **Point a Razorpay webhook at it**, tick the events listed in the
   setup comment (step E), set a webhook secret, and **set the Alert
   Email Address**.
4. **One real or test-mode purchase, end to end.** Confirm: shop page
   loads with real covers, cart totals correctly, Razorpay Checkout opens
   pre-filled, payment succeeds, Courier Karo books with the right
   weight, confirmation email arrives with the right items/price/AWB.
5. Deliberately break something (rename a product, feed a bad pincode)
   and confirm the alert paths still fire — the regression check.
6. **Weigh the physical books**, correct weights in the Bookstore tab.
7. **Set real prices** once testing is done — currently all ₹1.
8. Point `store.prepfusion.in` at the deployed Worker.
9. Promote to production only after all of the above.

Not urgent, but worth knowing about: a Track Order page (Courier Karo's
API supports it, unused so far), and automated reconciliation of Razorpay
payments against booked shipments (currently a manual weekly check — see
`FAILURE-MODES.md`'s "the one gap code cannot close").

---

## Files in this repo

| File | What it is |
|---|---|
| `worker.js` | The whole Worker: storefront, checkout, webhook. Read its top comment block first. |
| `worker.test.mjs` | 15 unit tests over pure logic (phone/pincode validation, cart parsing, product lookup). |
| `worker.e2e.mjs` | 148 end-to-end checks — every payment-path scenario, every Razorpay event, the freeze switch, all outbound calls stubbed. |
| `worker-test.mjs` | A copy of `worker.js` with one line appended to export internals for testing. **Re-copy it if you edit `worker.js`**, or the tests check stale code. |
| `FAILURE-MODES.md` | The payment-path safety audit: every failure mode, what's tested, KV limits researched against Cloudflare's docs, the one gap code can't close. |
| `QUESTIONS-FOR-RAZORPAY.md` | A few items their docs didn't answer — paste-ready for a support email. |
| `storefront-design.md` | Why the storefront is shaped this way — the three-Razorpay-products confusion this resolves, hosting choice (Cloudflare, not GitHub Pages), the `notes` contract with the webhook. |
| `admin-portal-changes/` | Reference copy of what changed in the admin portal — already committed and pushed there; nothing here needs re-applying. |

## Run the tests

```bash
node --test worker.test.mjs
node worker.e2e.mjs
```

Both are plain Node, no install beyond what the repo already needs
(nothing — they have zero dependencies), no wrangler, no network calls
(everything is stubbed).
