# Storefront design — "Razorpay only for payment"

**Status: NOT BUILT. This is a design, not a description of anything that
exists.** Everything else in this handoff describes working, tested code;
this file is the plan for the one piece that hasn't been started.

Written up because it kept getting explained in conversation and lost.
If you hand this project to anyone (or any model) later, this is the file
that says what the shop is supposed to be.

---

## The confusion this resolves

There are **three different Razorpay products**, and they're easy to mix
up. I conflated two of them earlier in this project, so, plainly:

| Razorpay product | Who hosts the page | Where the address is collected |
|---|---|---|
| **Payment Pages / Store** ← *live today* | Razorpay | Razorpay's form |
| **Payment Links** | Razorpay | Razorpay's form |
| **Orders API + Checkout.js** ← *the plan below* | **You** | **Your form** |

The first two are no-code products where Razorpay hosts everything: the
product listing, the address fields, and the payment. That's why nothing
is double-entered today — there's only one form, and it isn't yours. It's
also why the admin panel's photos/sections/descriptions have nowhere to
appear: Razorpay's Store keeps its own separate product list.

The third is the standard e-commerce pattern and what this document
designs: **your** storefront, with Razorpay reduced to the card/UPI step
only.

---

## Where it gets hosted, and why

**Cloudflare. Not GitHub Pages.**

GitHub Pages has exactly one job in this system — serving
`products.json` — and that does not change. It is a static file host: it
serves files from a repo and cannot execute code or hold a secret.

The storefront needs a server for one specific reason: **creating a
Razorpay order requires the Razorpay `Key Secret`**, which must never
reach the browser. That rules GitHub Pages out for the checkout half.

Two workable shapes on Cloudflare — pick either:

- **A) One Worker, two routes** *(simplest — recommended)*
  The existing Worker gains a `GET /` that serves the shop HTML and a
  `POST /create-order`. The webhook it already handles stays untouched
  on its own route. One deploy, one project, one place to look.
- **B) Cloudflare Pages + Worker**
  The shop page is a Cloudflare Pages project (Cloudflare's own static
  host — *different thing* from GitHub Pages), calling the Worker for
  order creation. Slightly cleaner separation, one more moving part, and
  a cross-origin call to configure.

Splitting *static page on GitHub Pages + orders on Cloudflare* is
possible but adds a cross-origin hop for no benefit. Don't.

---

## The three pieces

### 1. The storefront page

Serves HTML that renders `products.json` — the same file the webhook
already reads, and the same file the Bookstore admin tab publishes. No
new data source, no database.

What it renders (all of which the admin panel already manages, and none
of which has an audience today):

- Sections, in the admin panel's order (Bundles, Single books, …)
- Products within each section, in their set order
- `images[]` as a gallery, `images[0]` as the cover
- `price`, and `mrp` struck through with a computed `% off` when set
- `badge` ("Bestseller"), `description`, and `details[]` as spec tags
- `inStock: false` → shown but not buyable
- **"Free shipping"** — never `weight`, which is admin-only

The animated mock built earlier in this conversation
(`bookstore-customer-journey.html`) is a faithful visual reference for
all of the above.

**Cache the catalog fetch** (Cloudflare `cacheTtl`, or reuse the same
KV-cache approach the webhook already uses). Don't hit GitHub Pages once
per visitor.

### 2. The order-creation endpoint

`POST /create-order` on the Worker. Takes the product id and the
customer's delivery details from your form; returns a Razorpay
`order_id` for the browser to hand to Checkout.js.

It must, server-side:

1. Re-read `products.json` and **look the price up from the catalog** —
   never trust an amount sent by the browser. Anyone can edit a form
   field; the price must come from the server's own copy.
2. Refuse the order if `inStock` is false, or the product id is unknown.
3. Validate the delivery details — **reuse `validateShippingDetails()`
   from `worker/worker.js`**, which already checks 6-digit pincodes and
   10-digit Indian mobiles and is already unit-tested. This is where that
   validation finally does real good, because here it runs *before*
   payment, so the customer can be told to fix a typo.
4. Call Razorpay's Orders API with `amount = price * 100`
   (**paise** — this is where that rupees-to-paise conversion finally
   applies; it does not exist anywhere in the current Worker).
5. Pass the delivery details as `notes` on the order.

> **`notes` is the contract between this piece and the existing
> webhook.** Whatever key names you set here must match what
> `extractCustomerDetails()` (worker.js, ~line 496) reads, or shipments
> will start failing the address check. Verified against the current
> code, it accepts:
>
> | Field | Keys accepted in `notes` |
> |---|---|
> | Name | `name` |
> | Phone | `phone` (falls back to Razorpay's own `payment.contact`) |
> | Address | `address` or `Full Address` |
> | City | `city` or `City` |
> | State | `state` or `State` |
> | Pincode | `pincode` or `Pincode` |
>
> Email is *not* read from `notes` — it comes from `payment.email`,
> which Razorpay sets from Checkout.js. The product name comes from
> `notes.product_name`, falling back to `payment.description`; whichever
> you send **must exactly match the product's `name` in the admin
> panel**, or the shipment won't auto-book.
>
> Use the lowercase keys for anything new; the capitalised variants
> exist only to match Razorpay's Payment Pages custom-field labels.

**New credential required:** a Razorpay **Key ID + Key Secret** pair
(Razorpay Dashboard → Settings → API Keys). This is *not*
`RAZORPAY_WEBHOOK_SECRET`, which only verifies incoming webhooks and
cannot create an order. Store the Key Secret as a Worker **secret**, not
a constant in the source.

### 3. Razorpay Checkout.js

The payment overlay, opened by the storefront after step 2 returns an
order id.

- **`prefill`** it with name/email/phone so the customer doesn't retype
  what your form already collected.
- It has **no address fields** — that's why your form collects the
  address and step 2 passes it through as `notes`.
- On success it fires the same `payment.captured` webhook that already
  exists.

---

## What does not change

The entire post-payment path is already built and tested and is
untouched by this work:

`payment.captured` → signature check → duplicate-payment guard →
catalog weight lookup → Courier Karo booking → customer confirmation
email with AWB tracking.

This design only changes what happens **before** payment.

---

## Open questions to settle before building

- **Cart, or one product at a time? DECIDED: a real cart, one payment.**
  The customer adds several books, pays **once** for the cart total
  (computed server-side from the catalog - never from the browser), and
  one shipment is booked for the whole order. No double payments, no
  double delivery charges.

  What that decision commits to - three places change together, and the
  webhook half is **not yet built** (the current worker.js is still
  single-item):

  1. `POST /create-order` (storefront piece 2) totals the cart
     server-side - looking each product's price up from the catalog,
     never trusting an amount from the browser - creates ONE Razorpay
     order for the total, and stores the full cart (ids, names,
     quantities) in `notes` as JSON.
  2. The **webhook** stops reading a single `product_name` and instead
     walks the cart from `notes`, looking up a weight per line item.
  3. The **Courier Karo payload** sends a real `items` array with
     quantities - which their API supports (their own docs show two
     products in one call), the current Worker just never used it.

  Since the storefront and the cart-aware webhook ship together, the
  single-item assumption in today's worker.js is fine until then - it
  matches how Razorpay's hosted Store (live today) actually behaves.
- **Where does it live?** **DECIDED: `store.prepfusion.in`.** Already
  yours, already the verified Resend sending domain, and already where
  the confirmation email is sent from - so the shop, the sender address
  and the branding all line up.
- **Payment failure / abandoned checkout.** What the customer sees if
  they close the Razorpay overlay, and whether you care about tracking
  abandoned attempts.
- **Option A or B** from the hosting section above.

## Rough shape of the work

Not an estimate to hold anyone to, but the honest ordering:

1. Storefront page rendering the catalog (the biggest visible chunk, and
   independently testable — it's just a page reading a public JSON file).
2. `POST /create-order` + the Razorpay key wiring (the security-sensitive
   part: price from server, validation before payment).
3. Checkout.js integration and the end-to-end test purchase.

Steps 2 and 3 touch money and should be tested with Razorpay in **test
mode** against a **preview** Worker before anything goes live — the same
rule as the webhook work.

---

## Admin-controlled post-purchase message and email text

**Asked: can the "thanks, now visit go.prepfusion.in" popup and the
wording of the confirmation email be edited from the admin panel, rather
than living in code?**

**Yes — and it fits the existing plumbing with no new infrastructure.**
The catalog file already flows admin panel → GitHub Pages → Worker, and
it's already a JSON object with top-level keys (`sections`, `products`).
A third key carries settings the same way:

```json
{
  "sections": [ ... ],
  "products": [ ... ],
  "settings": {
    "postPurchaseHeading": "Thanks for your order!",
    "postPurchaseBody": "While your books ship, start your course.",
    "postPurchaseCtaLabel": "Go to my courses",
    "postPurchaseCtaUrl": "https://go.prepfusion.in",
    "emailIntro": "Thanks for your order - it's confirmed and on its way.",
    "emailSignoff": "- PrepFusion"
  }
}
```

Both consumers read from the same published file, so one edit + Publish
in the Bookstore tab updates both surfaces at once.

### The two halves have very different build costs

**The email text: buildable today, independent of the storefront.**
Nothing about it needs the storefront to exist. It's:

- a small "Shop settings" section in the Bookstore tab (a few text
  fields, alongside the existing product editor),
- validation in `server/routes/bookstore.js` (same closed-field
  discipline as products — a fixed set of known keys, length caps),
- the Worker reading `catalog.settings` with the current hardcoded
  strings as fallbacks.

Worth doing whether or not the storefront gets built.

**The post-purchase popup: needs the storefront.** A popup shown after
payment has to be shown *by a page you control*. Razorpay's hosted Store
finishes on Razorpay's own page, so there's nothing of yours to render
it. Two options:

- **Today, without the storefront:** Razorpay's own dashboard has a
  post-payment redirect / callback URL setting for Payment Pages. That
  gets a customer to `go.prepfusion.in`, but it's configured *in
  Razorpay*, not from your admin panel, and it's a plain redirect rather
  than a designed confirmation screen.
- **With the storefront (pieces 1–3 above):** the confirmation screen is
  your page, so it renders the heading/body/CTA straight from
  `settings` — fully admin-editable, exactly as asked.

### Guardrails worth having if this gets built

- **Validate `postPurchaseCtaUrl` as an `https://` URL** server-side.
  It's rendered as a link to customers who just paid; a typo'd or
  malformed URL is a dead end at the worst possible moment.
- **Keep the fields closed**, same as products: a fixed, known set of
  keys the server rebuilds from scratch, so nothing arbitrary reaches
  either the email template or the page.
- **Never interpolate raw settings into the email's HTML** without
  escaping — the Worker already has `escapeHtml()` for exactly this.
- **Keep code fallbacks for every field.** If `settings` is missing or a
  field is blank, the current hardcoded wording should still send. An
  order confirmation must never fail to go out because a text field was
  left empty.

**Status: designed, not built.** Say the word and the email-settings half
can be done on its own, ahead of any storefront decision.
