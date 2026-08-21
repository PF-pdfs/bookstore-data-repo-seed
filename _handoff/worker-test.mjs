/**
 * Razorpay -> Courier Karo order-creation bridge, with failure alerting.
 * Deploy as a Cloudflare Worker (free tier). No server to manage.
 *
 * WHAT THIS DOES
 * 1. Razorpay calls this URL the instant a customer pays.
 * 2. We verify the call genuinely came from Razorpay (signature check).
 * 3. We check we haven't already processed this exact payment before
 *    (protects against Razorpay occasionally delivering the same
 *    webhook twice, which would otherwise create two shipments).
 * 4. We read the customer's name/phone/address from the payment, and
 *    sanity-check it before anything gets booked against it.
 * 5. We look up the weight of whatever was bought from the LIVE catalog
 *    published by the admin portal's Bookstore tab (see CATALOG below).
 * 6. We call Courier Karo's create-order API to book the shipment.
 * 7. We email the CUSTOMER their order confirmation, with tracking.
 * 8. If ANYTHING in steps 3-6 can't complete (unknown product, bad
 *    address, Courier Karo's API rejects the order, etc.) we email every
 *    address in ALERT_EMAILS immediately, and also WhatsApp you if you've
 *    turned that on, so nothing is ever silently missed.
 *
 * ------------------------------------------------------------------
 * WHAT CHANGED IN THIS VERSION (and what you must check)
 * ------------------------------------------------------------------
 *
 * 1. PRODUCT WEIGHTS NOW COME FROM THE ADMIN PORTAL, NOT THIS FILE.
 *    The old hardcoded PRODUCT_CATALOG object is now only a last-resort
 *    fallback (FALLBACK_CATALOG below). The live source is:
 *      https://pf-pdfs.github.io/bookstore-data-repo-seed/products.json
 *    which is what the Bookstore tab in the StudyHub admin portal
 *    publishes. Adding a book no longer means editing this Worker.
 *
 *    >>> CRITICAL: the lookup is BY PRODUCT NAME, and the name in the
 *    admin portal must match the product name on your Razorpay page
 *    EXACTLY (case and spacing are normalised, nothing else is). If they
 *    drift apart, the payment still succeeds but no shipment is created
 *    and you get an alert naming both the unmatched name and every name
 *    the catalog does know. Keep them in sync.
 *
 * 2. THE CUSTOMER NOW GETS A CONFIRMATION EMAIL.
 *    Sent only after Courier Karo confirms the booking, so it can carry
 *    the real AWB tracking number. Sent from CUSTOMER_EMAIL_FROM, which
 *    must be on your verified Resend domain (store.prepfusion.in) - the
 *    old shared onboarding@resend.dev sender can only deliver to your own
 *    address, never to a customer.
 *
 * 3. ADDRESS DETAILS ARE VALIDATED BEFORE A SHIPMENT IS BOOKED.
 *    Phone numbers are normalised (+91, spaces and dashes are stripped)
 *    rather than rejected. But a genuinely unusable pincode or phone now
 *    stops the booking and alerts you instead, because a parcel booked to
 *    a bad pincode costs more to fix than one booked a few minutes late
 *    by hand.
 *
 * 4. WHAT DID *NOT* CHANGE: signature verification, the duplicate-payment
 *    KV guard, the owner failure-alert path, and the amount charged
 *    (still Razorpay's own payment.amount - this Worker has never set
 *    prices and still doesn't).
 *
 * ------------------------------------------------------------------
 * ONE-TIME SETUP YOU NEED TO DO (in order):
 * ------------------------------------------------------------------
 *
 * A) In Razorpay Dashboard -> your Payment Page / Store editor:
 *    Add these as required custom checkout fields (Razorpay already
 *    collects Name, Email, and Phone by default):
 *      - Full Address (text)
 *      - City (text)
 *      - State (text)
 *      - Pincode (text)
 *
 *    >>> Set the Pincode field's validation to exactly 6 digits, and the
 *    phone field to a 10-digit Indian mobile, IN RAZORPAY. This Worker
 *    now checks both, but it only ever sees them after the customer has
 *    already paid - the only place a customer can be told to fix a typo
 *    before paying is Razorpay's own form.
 *
 * B) In the Cloudflare dashboard, on this Worker's page, go to
 *    Settings -> Bindings -> Add -> KV Namespace. Create a namespace
 *    (any name, e.g. "processed-payments") and bind it to the variable
 *    name PROCESSED_PAYMENTS. This is required regardless of whether
 *    you use WhatsApp - it's what prevents duplicate shipments, and it
 *    now also caches the product catalog.
 *
 * C) Get a free Resend.com API key (dashboard -> API Keys -> Create),
 *    and verify your sending domain (done: store.prepfusion.in).
 *
 * D) OPTIONAL - WhatsApp alerts. If you want these too:
 *      - Message the CallMeBot WhatsApp number "I allow callmebot to
 *        send me messages" (see callmebot.com for the current number).
 *      - It replies with your personal apikey within ~2 minutes.
 *      - Fill in WHATSAPP_CALLMEBOT_PHONE and _APIKEY below, and set
 *        ENABLE_WHATSAPP_ALERTS to true.
 *    If you'd rather skip WhatsApp entirely, leave ENABLE_WHATSAPP_ALERTS
 *    as false - email alerts alone still fully protect you.
 *
 * E) In Razorpay Dashboard -> Settings -> Webhooks -> Add New Webhook:
 *      - Webhook URL: your deployed Worker URL
 *      - Set a Secret (any strong random string)
 *      - Active events - tick these, and only these:
 *          payment.captured          REQUIRED. The one that books shipments.
 *          payment.failed            Logged only. A UPI retry can send this
 *                                    and THEN payment.captured for the same
 *                                    order, so it is never treated as final.
 *          refund.created            Alerts you, and names the AWB to cancel
 *          refund.processed          if a shipment was already booked.
 *          refund.failed             Alerts you - the customer is owed money
 *                                    and has not received it.
 *          payment.dispute.*         Chargebacks. Alerted loudly: these have
 *                                    a DEADLINE and lose by default.
 *          payment.downtime.started  Explains a sudden stop in sales that is
 *          payment.downtime.resolved not a bug on our side.
 *
 *      - Do NOT tick order.paid: it fires alongside payment.captured for the
 *        same money. (This Worker ignores it anyway, so ticking it is
 *        harmless - just pointless traffic against the 5s response budget.)
 *      - Subscriptions, invoices, settlements, payment links, fund accounts
 *        and rewards events do not apply to this shop.
 *
 *    Also set an Alert Email Address on the webhook itself: Razorpay emails
 *    it if deliveries fail continuously for 24 hours, at which point they
 *    DISABLE the webhook. That email is the backstop for the one failure
 *    this Worker cannot report on its own - being down.
 *
 * F) Fill in ALL the values in the CONFIG block below, then deploy.
 *
 * G) IMPORTANT: after your first real (or test) payment, check
 *    Razorpay Dashboard -> Settings -> Webhooks -> your webhook's
 *    delivery log to see the ACTUAL payload Razorpay sent, and adjust
 *    the field names in extractCustomerDetails() below if they don't
 *    match what you see.
 *
 * H) STILL OPEN, unchanged from before: confirm with Courier Karo what
 *    value they expect in `payment_option` for an order that's already
 *    been paid (their docs only showed a "cod" example). This script
 *    still sends whatever PAYMENT_OPTION_VALUE is set to - update it
 *    once they confirm, before going live.
 * ------------------------------------------------------------------
 */

// ==================== CONFIG - FILL THESE IN ====================

// Keep your existing values for all of these - they are unchanged.
const RAZORPAY_WEBHOOK_SECRET = "YOUR_RAZORPAY_WEBHOOK_SECRET";
const COURIER_KARO_API_KEY = "YOUR_COURIER_KARO_API_KEY";
const COURIER_KARO_STORE_URL = "YOUR_COURIER_KARO_STORE_URL";
const PAYMENT_OPTION_VALUE = "prepaid"; // see note (H) above
const RESEND_API_KEY = "YOUR_RESEND_API_KEY";

// NEW - the storefront's Razorpay credentials, for CREATING orders. This is
// a different credential from RAZORPAY_WEBHOOK_SECRET above (which can only
// verify incoming webhooks): generate a Key ID + Key Secret pair in
// Razorpay Dashboard -> Settings -> API Keys. Better still, move the secret
// into a Worker secret (wrangler secret put) instead of this constant.
const RAZORPAY_KEY_ID = "YOUR_RAZORPAY_KEY_ID";
const RAZORPAY_KEY_SECRET = "YOUR_RAZORPAY_KEY_SECRET";

// The shop freezes itself - maintenance page, no ordering, no paying - once
// this many orders have been accepted in one UTC day. Why 300: Cloudflare
// KV's FREE tier allows 1,000 writes/day, and an order costs up to 3 (the
// order counter at checkout, then the claim + result in the webhook), so 300
// keeps a comfortable margin - abandoned checkouts burn a counter write too.
// The UTC day boundary is 5:30 AM IST, which is when the quota resets.
// On the Workers Paid plan ($5/mo, unlimited writes) this becomes a purely
// business choice - raise it to whatever you like.
const DAILY_ORDER_LIMIT = 300;

// Where product photos are served from - the same GitHub Pages site the
// catalog itself lives on.
const PAGES_BASE = "https://pf-pdfs.github.io/bookstore-data-repo-seed/";
const SHOP_NAME = "PrepFusion Bookstore";

// Where FAILURE ALERTS go (to you). Unchanged.
const ALERT_EMAIL_FROM = "PrepFusion Store <alerts@store.prepfusion.in>";
const ALERT_EMAILS = ["you@example.com"];

// NEW: where the CUSTOMER's order confirmation is sent from. Must be on
// the verified domain - a customer will never receive mail sent from
// Resend's shared onboarding@resend.dev sender, and it fails silently.
//
// >>> THIS IS A SEND-ONLY ADDRESS. Nothing receives mail at it.
// Checked on 21 Aug 2026: store.prepfusion.in has no MX record, so a
// customer who hits Reply gets a bounce. (The MX that does exist, on
// send.store.prepfusion.in, is Resend/SES's bounce-feedback channel -
// not a mailbox.) That is fine and intended - see SUPPORT_EMAIL below
// for how customers are given a route back.
const CUSTOMER_EMAIL_FROM = "PrepFusion Store <orders@store.prepfusion.in>";

// Where customers are told to write if something's wrong.
//
// >>> MUST be a mailbox that genuinely exists and is read by a human.
// Checked on 21 Aug 2026: neither prepfusion.in nor store.prepfusion.in
// has any MX record, so as of writing there is NO address on either
// domain that can receive mail. Until that changes, put a real inbox
// here - your Gmail is fine - or set up Cloudflare Email Routing (free,
// and your DNS is already there) to forward something like
// orders@store.prepfusion.in to a real inbox.
//
// Leave it as "" and the confirmation email simply won't invite a reply,
// which is better than inviting one into a black hole.
//
// Set to the shop's dedicated Gmail inbox (decided 21 Aug 2026) - a real,
// human-read mailbox, so Reply-To and the "questions?" line are back on.
const SUPPORT_EMAIL = "bookstore.prepfusion@gmail.com";

// Alerting: WhatsApp is optional. Leave ENABLE_WHATSAPP_ALERTS as false
// to skip it entirely - email alone still covers you.
const ENABLE_WHATSAPP_ALERTS = false;
const WHATSAPP_CALLMEBOT_PHONE = "91XXXXXXXXXX"; // your number, country code, no + or spaces
const WHATSAPP_CALLMEBOT_APIKEY = "YOUR_CALLMEBOT_APIKEY";

// The live catalog published by the admin portal's Bookstore tab.
const CATALOG_URL = "https://pf-pdfs.github.io/bookstore-data-repo-seed/products.json";
// Cached inside the SAME KV namespace the duplicate-payment guard uses -
// a payment id is a 14-char hex string, so a "bookstore:" prefix can
// never collide with one.
const CATALOG_KV_KEY = "bookstore:catalog";
// Written against a payment id the moment we're about to book, and replaced
// by the AWB on success. Seeing this value on a retry means a previous
// delivery died mid-booking - see the branch that handles it.
const BOOKING_CLAIM = "booking_in_progress";
// GitHub Pages is fast and this is on the paid-customer path, so a slow
// fetch should fall through to the cache rather than hold the webhook open.
// 3s, not more: Razorpay expects a webhook response within 5 SECONDS
// (verified against their docs, Aug 2026) - past that it times out and
// re-delivers, and while our claim/dedup makes that safe, it can raise a
// false "verify this order" alert if the retry lands mid-flight. Keeping
// the slowest optional step short protects the whole budget.
const CATALOG_FETCH_TIMEOUT_MS = 3000;

// Last resort only. Used if GitHub Pages is unreachable AND the KV cache
// is empty (i.e. essentially never, after the first successful order).
// It exists so a GitHub outage on day one cannot stop shipments; it is
// NOT the place to add new products any more - do that in the admin
// portal's Bookstore tab.
const FALLBACK_CATALOG = {
  "EE Complete Bundle": { weight: 1.2 },
  "EC Complete Bundle": { weight: 1.2 },
  "Book Title One": { weight: 0.3 },
  "Book Title Two": { weight: 0.35 },
};

// ==================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      // The storefront. Everything a customer browses is this one page.
      if (url.pathname === "/") return renderShop(env);
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "POST" && url.pathname === "/create-order") {
      return handleCreateOrder(request, env);
    }

    if (request.method === "POST") {
      // Any other POST is treated as the Razorpay webhook - deliberately
      // path-agnostic, so whatever URL is already configured in the Razorpay
      // dashboard keeps working without an edit there.
      return handleWebhook(request, env);
    }

    return new Response("Method not allowed", { status: 405 });
  },
};

async function handleWebhook(request, env) {
    const rawBody = await request.text();

    // TEMPORARY - DEBUG ONLY. Shows us exactly what Razorpay actually
    // sends, since the docs don't cover the Store product's cart/line-item
    // format. Remove this line once we've confirmed the payload shape.
    // NOTE: this writes the customer's full name, phone and address into
    // the Worker's logs - worth removing on that basis alone once you no
    // longer need it.
    console.log("RAW WEBHOOK BODY:", rawBody);

    const signature = request.headers.get("X-Razorpay-Signature");
    const expectedSignature = await hmacSha256Hex(RAZORPAY_WEBHOOK_SECRET, rawBody);
    if (!signature || signature !== expectedSignature) {
      return new Response("Invalid signature", { status: 401 });
    }

    // Guarded deliberately. The signature already proved this came from
    // Razorpay, so a body we cannot read means their payload shape changed
    // under us. Left unguarded that throws, returns 5xx, and Razorpay retries
    // the same unreadable body on a schedule - failing identically every time,
    // silently, until it gives up and the order is simply lost. Returning 200
    // stops the pointless retries; the alert is what actually saves the order.
    let payment;
    try {
      const payload = JSON.parse(rawBody);

      // Events other than payment.captured are handled here, cheaply, and
      // answered 200 so Razorpay stops. Razorpay publishes a long event list
      // (subscriptions, invoices, settlements, payment links, rewards); the
      // ones below are the ones that can actually change what this shop must
      // do. Everything else falls through to the "Ignored" line and costs
      // nothing - deliberately, because subscribing to a chatty event you
      // then ignore still spends the 5-second response budget.
      //
      // NONE of these write to KV. The daily KV write quota is what the
      // shop's freeze mechanism protects, so informational events must not
      // eat into the same budget as real orders.
      const other = await handleOtherEvent(payload, env);
      if (other) return other;

      if (payload.event !== "payment.captured") {
        return new Response("Ignored", { status: 200 });
      }
      payment = payload.payload.payment.entity;
      if (!payment || !payment.id) throw new Error("no payment entity id in payload");
    } catch (err) {
      await alert(
        env,
        `A Razorpay webhook arrived with a VALID SIGNATURE but a payload this Worker could ` +
          `not read: ${err.message}\n\n` +
          `This usually means Razorpay changed their payload shape. A payment may have been ` +
          `taken with NO shipment booked - check Razorpay's dashboard for recent payments and ` +
          `reconcile them against Courier Karo.\n\n` +
          `Raw body:\n${rawBody.slice(0, 2000)}`
      );
      return new Response("Unreadable payload - alerted", { status: 200 });
    }

    // --- Duplicate-delivery protection ---
    const alreadyProcessed = await env.PROCESSED_PAYMENTS.get(payment.id);

    // A previous delivery claimed this payment and never finished. We cannot
    // know from here whether Courier Karo actually received that booking, so
    // the one thing we must NOT do is book again and risk two parcels. Ask a
    // human, once, and close it off.
    if (alreadyProcessed === BOOKING_CLAIM) {
      const told = await alert(
        env,
        `Payment ${payment.id} was mid-booking when a previous webhook delivery stopped ` +
          `unexpectedly, and Razorpay has now retried it.

` +
          `NOT re-booked automatically, because it is impossible to tell from here whether ` +
          `Courier Karo already created the shipment - and booking twice would send two parcels ` +
          `for one payment.

` +
          `PLEASE CHECK the Courier Karo dashboard for order RZP-${payment.order_id || payment.id}:
` +
          `  - If a shipment EXISTS, nothing more to do.
` +
          `  - If it does NOT, create it manually.

` +
          `Customer: ${customerSummary(payment)}`
      );
      // Only close it off if the question actually reached someone. If not,
      // leave the claim in place so the next retry asks again - the claim is
      // what prevents a double-booking, so keeping it is the safe direction.
      if (!told) return new Response("Interrupted booking, and alerting failed - retry please", { status: 500 });
      await env.PROCESSED_PAYMENTS.put(payment.id, "interrupted_needs_check", { expirationTtl: 60 * 60 * 24 * 30 });
      return new Response("Interrupted booking - human asked to verify", { status: 200 });
    }

    if (alreadyProcessed) {
      console.log(`Payment ${payment.id} already processed - skipping duplicate delivery.`);
      return new Response("Already processed", { status: 200 });
    }

    const customer = extractCustomerDetails(payment);
    const catalog = await getProductCatalog(env);
    const settings = (catalog && catalog.settings) || {};

    // Line items come from one of two places. Orders created by the
    // storefront carry the whole cart in notes.cart (ids, quantities, and
    // the unit price actually charged - written server-side at order
    // creation, so a catalog edit between order and webhook cannot rewrite
    // it). Orders from Razorpay's hosted Store carry a single product name.
    const cart = parseCartNotes(customer.notes);
    let lineItems; // [{ id, name, qty, price, weight }]
    let itemsLabel;

    if (cart) {
      lineItems = [];
      const missing = [];
      const soldOut = [];
      for (const entry of cart) {
        const product =
          catalog && Array.isArray(catalog.products) ? catalog.products.find((p) => p.id === entry.id) : null;
        if (!product || !Number.isFinite(Number(product.weight)) || Number(product.weight) <= 0) {
          missing.push(entry.id);
          continue;
        }
        if (product.inStock === false) soldOut.push(product.name);
        lineItems.push({
          id: product.id,
          name: product.name,
          qty: entry.qty,
          price: entry.price,
          weight: Number(product.weight),
        });
      }

      if (missing.length > 0 || lineItems.length === 0) {
        const told = await alert(
          env,
          `Cart for payment ${payment.id} references product ids the catalog does not know: ` +
            `${missing.join(", ") || "(cart parsed empty)"}. Payment succeeded but NO shipment was ` +
            `created.\n\n` +
            `Ids the catalog knows: ${
              catalog && Array.isArray(catalog.products) ? catalog.products.map((p) => p.id).join(", ") : "(catalog failed to load)"
            }\n\n` +
            `A product was probably deleted from the Bookstore tab between this order being placed ` +
            `and paid. Restore it (or note its weight) and create the shipment manually in Courier Karo.`
        );
        if (!told) return new Response("Unknown cart product, and alerting failed - retry please", { status: 500 });
        await env.PROCESSED_PAYMENTS.put(payment.id, "unknown_product", { expirationTtl: 60 * 60 * 24 * 30 });
        return new Response("Unknown cart product - alerted", { status: 200 });
      }

      if (soldOut.length > 0) {
        await alert(
          env,
          `Heads up: payment ${payment.id} includes item(s) the catalog now marks SOLD OUT: ` +
            `${soldOut.join(", ")}. The shipment is being booked as normal - check you actually ` +
            `have stock.`
        );
      }

      // The storefront computed the total server-side, so these should always
      // agree. A mismatch means something genuinely strange happened (partial
      // capture, currency surprise) - ship anyway (Razorpay's amount is what
      // was really paid) but say so.
      const cartTotal = lineItems.reduce((sum, i) => sum + i.price * i.qty, 0);
      if (Math.abs(cartTotal - payment.amount / 100) > 1) {
        await alert(
          env,
          `Amount mismatch on payment ${payment.id}: cart says Rs. ${cartTotal}, Razorpay captured ` +
            `Rs. ${payment.amount / 100}. Shipping anyway - Razorpay's number is what was actually ` +
            `paid - but this should never happen; worth a look.`
        );
      }

      itemsLabel = lineItems.map((i) => `${i.name} x ${i.qty}`).join(", ");
    } else {
      // --- Legacy single-product path (Razorpay hosted Store) ---
      const purchasedProductName = customer.notes.product_name || payment.description || "";
      const productInfo = findProduct(catalog, purchasedProductName);

      if (!productInfo) {
        const told = await alert(
          env,
          `Unrecognised product for payment ${payment.id}: "${purchasedProductName}". ` +
            `Payment succeeded but NO shipment was created.\n\n` +
            `The catalog currently knows these product names:\n` +
            `${knownProductNames(catalog).map((n) => `  - ${n}`).join("\n") || "  (none - the catalog failed to load)"}\n\n` +
            `Fix: open the Bookstore tab in the admin portal and make sure a product's ` +
            `name matches the Razorpay product name exactly, then Publish. ` +
            `Create this shipment manually in Courier Karo for now.`
        );
        // Only close this off if you were actually told. If the alert failed
        // too, leave no marker and hand Razorpay a 5xx so it retries - another
        // delivery is another chance to reach you. Nothing has been booked at
        // this point, so a retry is completely safe.
        if (!told) return new Response("Unknown product, and alerting failed - retry please", { status: 500 });
        await env.PROCESSED_PAYMENTS.put(payment.id, "unknown_product", { expirationTtl: 60 * 60 * 24 * 30 });
        return new Response("Unknown product - alerted", { status: 200 });
      }

      // Someone bought something the catalog says is sold out. We cannot
      // un-sell it - they have already paid - so this ships as normal and
      // you get told, rather than the order being quietly held up.
      if (productInfo.inStock === false) {
        await alert(
          env,
          `Heads up: "${purchasedProductName}" was bought (payment ${payment.id}) while the ` +
            `catalog has it marked SOLD OUT. The shipment is being booked as normal - ` +
            `check you actually have stock, and either restock or take it off sale.`
        );
      }

      lineItems = [
        {
          id: purchasedProductName.replace(/\s+/g, "_").toUpperCase(),
          name: purchasedProductName,
          qty: 1,
          price: payment.amount / 100,
          weight: productInfo.weight,
        },
      ];
      itemsLabel = purchasedProductName;
    }

    // --- Sanity-check the delivery details before booking anything ---
    const addressProblems = validateShippingDetails(customer);
    if (addressProblems.length > 0) {
      const told = await alert(
        env,
        `Delivery details look wrong for payment ${payment.id} - NO shipment was created, ` +
          `because booking a courier against a bad address costs more to unpick than ` +
          `re-entering it by hand.\n\n` +
          `Problems:\n${addressProblems.map((p) => `  - ${p}`).join("\n")}\n\n` +
          `What the customer entered:\n` +
          `  Name:    ${customer.name || "(blank)"}\n` +
          `  Phone:   ${customer.phone || "(blank)"}\n` +
          `  Email:   ${customer.email || "(blank)"}\n` +
          `  Address: ${customer.address || "(blank)"}\n` +
          `  City:    ${customer.city || "(blank)"}\n` +
          `  State:   ${customer.state || "(blank)"}\n` +
          `  Pincode: ${customer.pincode || "(blank)"}\n` +
          `  Items:   ${itemsLabel}\n\n` +
          `Contact them, then create the shipment manually in Courier Karo.`
      );
      // Same reasoning as the unknown-product branch above: nothing is booked
      // yet, so if we couldn't reach you, let Razorpay retry rather than
      // quietly filing the order away where nobody will see it.
      if (!told) return new Response("Invalid address, and alerting failed - retry please", { status: 500 });
      await env.PROCESSED_PAYMENTS.put(payment.id, "invalid_address", { expirationTtl: 60 * 60 * 24 * 30 });
      return new Response("Invalid delivery details - alerted", { status: 200 });
    }

    const orderId = `RZP-${payment.order_id || payment.id}`;

    const courierKaroPayload = {
      a_order_id: orderId,
      t_name: customer.name,
      t_email: customer.email,
      t_phone: customer.phone,
      t_pincode: customer.pincode,
      t_address: customer.address,
      t_city: customer.city,
      t_state: customer.state,
      invoice_number: payment.id,
      payment_option: PAYMENT_OPTION_VALUE,
      order_created_date: new Date().toISOString().slice(0, 19).replace("T", " "),
      // One entry per cart line, real quantities - Courier Karo's API takes
      // multiple items per order (their docs book two products in one call).
      // Weights are kilograms straight from the catalog: the same numbers the
      // Bookstore tab shows, which is why that field is labelled kg there and
      // never shown to customers.
      items: lineItems.map((item) => ({
        a_product_id: String(item.id).replace(/\s+/g, "_").toUpperCase(),
        a_order_id: orderId,
        name: item.name,
        qty: String(item.qty),
        product_cost: String(item.price),
        weight: String(item.weight),
      })),
    };

    // Claim this payment BEFORE calling Courier Karo, not after.
    //
    // Why: if the Worker dies between a SUCCESSFUL booking and the marker
    // being written (a KV hiccup, a CPU limit, an evicted isolate), Razorpay
    // retries, finds no marker, and books a SECOND shipment for one payment.
    // Two parcels, one order, and nothing to tell you it happened. Claiming
    // first closes that window: a retry now finds the claim and asks a human
    // instead of shipping twice.
    //
    // The cost of this ordering is the opposite, much cheaper failure: if the
    // Worker dies BEFORE Courier Karo received anything, the retry still
    // refuses to auto-book. That's why the retry path alerts loudly rather
    // than silently skipping - see the BOOKING_CLAIM branch near the top.
    try {
      await env.PROCESSED_PAYMENTS.put(payment.id, BOOKING_CLAIM, { expirationTtl: 60 * 60 * 24 * 30 });
    } catch (err) {
      // Almost always one of two things: KV is having a moment, or the free
      // tier's daily write quota is exhausted. Either way the claim is what
      // makes booking safe to retry, so booking without it risks duplicate
      // shipments. Refuse to book, say so plainly, and let Razorpay retry -
      // by which time the quota may have reset.
      await alert(
        env,
        `Could not reserve payment ${payment.id} before booking: ${err.message}\n\n` +
          `NO shipment was booked, deliberately - without this reservation a retry could ` +
          `create a duplicate shipment.\n\n` +
          `The usual cause is the Cloudflare KV daily write quota being exhausted (the free ` +
          `tier is metered in writes per day). Check the Workers KV dashboard. Razorpay will ` +
          `retry this webhook, so it may resolve itself once the quota resets - but reconcile ` +
          `this payment against Courier Karo to be sure.\n\n` +
          `Customer: ${customerSummary(payment)}`
      );
      return new Response("Could not reserve payment - retry please", { status: 500 });
    }

    let ckResult;
    try {
      const ckResponse = await fetch("https://courierkaro.com/callback/store/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": COURIER_KARO_API_KEY,
          "store-url": COURIER_KARO_STORE_URL,
        },
        body: JSON.stringify(courierKaroPayload),
      });
      ckResult = await ckResponse.json();

      // Courier Karo's docs show only a success response for this endpoint
      // - no documented error/failure shape. This check (non-2xx, or a
      // `status` that isn't literally "success") is a safe generic guess,
      // not a verified one: if a real failure ever comes back with, say,
      // HTTP 200 and status:"failed" with different casing, this still
      // catches it via the ok-but-not-success branch, but the exact wording
      // in ckResult on failure (for a better alert message) is unconfirmed.
      if (!ckResponse.ok || ckResult.status !== "success") {
        throw new Error(`Courier Karo responded with: ${JSON.stringify(ckResult)}`);
      }
    } catch (err) {
      const told = await alert(
        env,
        `Courier Karo shipment creation FAILED for payment ${payment.id} (order ${orderId}). ` +
          `Error: ${err.message}\n\n` +
          `IMPORTANT - CHECK BEFORE RE-CREATING: this branch also catches a dropped connection ` +
          `or an unreadable reply, so it is possible Courier Karo DID create the shipment and we ` +
          `simply never saw the response. Look for order ${orderId} in the Courier Karo dashboard ` +
          `first; only create it manually if it isn't already there.\n\n` +
          `Customer: ${customer.name}, ${customer.phone}\n${customer.address}, ${customer.city}, ${customer.state} ${customer.pincode}\n` +
          `Items: ${itemsLabel}`
      );
      // Mark processed anyway - we don't want Razorpay retrying forever;
      // the alert above is what gets this order fixed, manually.
      //
      // Unless the alert ALSO failed. Then nobody knows this order exists, so
      // release the claim and hand back a 5xx: Razorpay retrying is the only
      // remaining chance of anyone finding out. Courier Karo rejected the
      // booking, so there is no shipment to duplicate.
      if (!told) {
        await env.PROCESSED_PAYMENTS.delete(payment.id);
        return new Response("Courier Karo failed, and alerting failed - retry please", { status: 500 });
      }
      await env.PROCESSED_PAYMENTS.put(payment.id, "failed", { expirationTtl: 60 * 60 * 24 * 30 });
      return new Response("Courier Karo failed - alerted", { status: 200 });
    }

    // `awb_no` is confirmed against Courier Karo's own API docs' sample
    // response for this exact endpoint - not a guess. This guard is just
    // cheap insurance against an API change or an edge-case response
    // shape: booking has already succeeded at this point regardless of
    // whether the field is present, so a missing one should never turn a
    // successful shipment into a failed request, or show a customer the
    // literal word "undefined".
    const awb = ckResult.awb_no;
    if (!awb) {
      await alert(
        env,
        `Shipment for payment ${payment.id} (order ${orderId}) was booked by Courier Karo, but their ` +
          `response didn't include the "awb_no" field this Worker expects for tracking. The shipment is ` +
          `very likely fine - only the tracking-number lookup failed.\n\n` +
          `Raw Courier Karo response:\n${JSON.stringify(ckResult, null, 2)}\n\n` +
          `Find the real field name in the response above (or the AWB directly in the Courier Karo ` +
          `dashboard for this order) and update the \`ckResult.awb_no\` reference in worker.js if the ` +
          `field is called something else.`
      );
    }

    // Upgrade the claim to the finished record. A missing awb still gets a
    // placeholder, purely so this stays a dedup marker - the alert above, not
    // this string, is the record of what actually happened.
    //
    // DELIBERATELY NON-FATAL, for a specific reason: Cloudflare KV allows only
    // ONE WRITE PER SECOND TO THE SAME KEY (on the paid plan as well as the
    // free one), and this is the second write to this payment's key, separated
    // from the claim by nothing but the Courier Karo round-trip - frequently
    // under a second. Letting a rate-limited write throw here would turn a
    // completely successful order into a 5xx, make Razorpay retry it, and fire
    // a "check this manually" alarm about an order that was actually fine.
    //
    // Failing to write it costs little: the claim is already in place, so a
    // retry still cannot double-book. Worst case is that a later duplicate
    // delivery asks you to verify an order that had in fact succeeded.
    try {
      await env.PROCESSED_PAYMENTS.put(payment.id, awb || "booked_awb_unknown", { expirationTtl: 60 * 60 * 24 * 30 });
    } catch (err) {
      console.error(`Could not record finished state for ${payment.id} (claim still stands):`, err.message);
    }

    // The customer's confirmation. Deliberately last, and deliberately
    // unable to fail the request: the shipment is already booked, so an
    // email problem is worth an alert to you but must never turn into a
    // non-200 that makes Razorpay retry the whole webhook.
    try {
      await sendCustomerConfirmation({
        customer,
        items: lineItems,
        amountPaid: payment.amount / 100,
        orderId,
        awb, // may be falsy - sendCustomerConfirmation omits the tracking section rather than print "undefined"
        settings,
      });
    } catch (err) {
      await alert(
        env,
        `Shipment for payment ${payment.id} (order ${orderId}${awb ? `, AWB ${awb}` : ""}) was ` +
          `booked successfully, but the CUSTOMER CONFIRMATION EMAIL to ${customer.email} ` +
          `failed: ${err.message}\n\n` +
          `The order itself is fine - the customer just hasn't been told. Worth emailing ` +
          `them by hand.`
      );
    }

    console.log(`Shipment created${awb ? `: AWB ${awb}` : " (awb_no missing from response - see alert)"} for order ${orderId}`);
    return new Response("OK", { status: 200 });
}

// ------------------------------------------------------------------
// Catalog
// ------------------------------------------------------------------

/**
 * The live product catalog, as published by the admin portal's Bookstore
 * tab. Cached in KV so that a GitHub Pages hiccup during a customer's
 * purchase falls back to the last known-good copy instead of losing the
 * order. Returns null only if the fetch fails AND nothing was ever
 * cached - callers then fall back to FALLBACK_CATALOG.
 */
async function getProductCatalog(env) {
  try {
    const res = await fetch(CATALOG_URL, {
      signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
    const catalog = await res.json();
    if (!catalog || !Array.isArray(catalog.products)) {
      throw new Error("catalog JSON has no products array");
    }
    // Cache the good copy, but ONLY when it actually changed. Rewriting an
    // identical catalog on every order burned a KV write per order for no
    // benefit - and KV's free tier is metered in writes per day, so that was
    // a third of the daily order ceiling spent on re-storing the same bytes.
    //
    // Not awaited-and-failed-on either: a caching problem must never stop an
    // order that already has the catalog it needs.
    try {
      const serialised = JSON.stringify(catalog);
      const cached = await env.PROCESSED_PAYMENTS.get(CATALOG_KV_KEY);
      if (cached !== serialised) {
        await env.PROCESSED_PAYMENTS.put(CATALOG_KV_KEY, serialised);
      }
    } catch (err) {
      console.error("Could not cache catalog in KV:", err.message);
    }
    return catalog;
  } catch (err) {
    console.error("Live catalog unavailable, falling back to cache:", err.message);
    try {
      const cached = await env.PROCESSED_PAYMENTS.get(CATALOG_KV_KEY);
      if (cached) return JSON.parse(cached);
    } catch (cacheErr) {
      console.error("Cached catalog unreadable:", cacheErr.message);
    }
    return null;
  }
}

// Razorpay's product name and the catalog's product name are typed by
// people in two different systems, so they are compared with case and
// surrounding/repeated whitespace ignored. Nothing else is normalised -
// "EE Bundle" and "EE Complete Bundle" are different products, and
// guessing between them is not this script's job.
function normaliseName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Finds a product by the name Razorpay reported. Falls back to the
 * built-in FALLBACK_CATALOG if the live catalog could not be loaded at
 * all. Returns an object with at least { weight }, or null.
 */
function findProduct(catalog, razorpayProductName) {
  const wanted = normaliseName(razorpayProductName);
  if (!wanted) return null;

  if (catalog && Array.isArray(catalog.products)) {
    const match =
      catalog.products.find((p) => normaliseName(p.name) === wanted) ||
      // Also accept the product code, in case a Razorpay page is set up
      // with the id rather than the display name.
      catalog.products.find((p) => normaliseName(p.id) === wanted);
    if (match && Number.isFinite(Number(match.weight)) && Number(match.weight) > 0) {
      return { weight: Number(match.weight), inStock: match.inStock !== false, source: "live" };
    }
    // A live catalog that loaded but has no match is a definitive "no" -
    // do not silently fall through to a stale hardcoded weight.
    return null;
  }

  const fallback = Object.entries(FALLBACK_CATALOG).find(([name]) => normaliseName(name) === wanted);
  if (fallback) {
    console.warn(`Using FALLBACK_CATALOG weight for "${razorpayProductName}" - live catalog was unavailable.`);
    return { weight: fallback[1].weight, inStock: true, source: "fallback" };
  }
  return null;
}

function knownProductNames(catalog) {
  if (catalog && Array.isArray(catalog.products)) {
    return catalog.products.map((p) => p.name).filter(Boolean);
  }
  return Object.keys(FALLBACK_CATALOG);
}

// ------------------------------------------------------------------
// Customer details
// ------------------------------------------------------------------

// One-line customer summary for alerts, safe to call before the full
// extract/validate step has run.
function customerSummary(payment) {
  const n = payment.notes || {};
  const parts = [
    n.name || payment.email || "(no name)",
    payment.contact || n.phone || "(no phone)",
    n.address || n["Full Address"] || "(no address)",
    n.pincode || n["Pincode"] || "(no pincode)",
  ];
  return parts.join(", ");
}

// The storefront writes the cart into notes.cart as compact JSON:
// [[productId, qty, unitPriceRupees], ...] - written server-side at order
// creation, so it reflects what was actually charged even if the catalog
// changes before the webhook fires. Anything malformed returns null and the
// webhook falls back to the legacy single-product path.
function parseCartNotes(notes) {
  if (!notes || typeof notes.cart !== "string" || !notes.cart.trim()) return null;
  try {
    const raw = JSON.parse(notes.cart);
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const items = [];
    for (const row of raw) {
      if (!Array.isArray(row) || row.length < 3) return null;
      const [id, qty, price] = row;
      if (typeof id !== "string" || !id) return null;
      const q = Number(qty);
      const unit = Number(price);
      if (!Number.isInteger(q) || q < 1 || q > 20) return null;
      if (!Number.isFinite(unit) || unit < 0) return null;
      items.push({ id, qty: q, price: unit });
    }
    return items;
  } catch (err) {
    return null;
  }
}

function extractCustomerDetails(payment) {
  const notes = payment.notes || {};
  return {
    name: String(notes.name || payment.email || "Customer").trim(),
    email: String(payment.email || "").trim(),
    // Normalised, not rejected: "+91 98765 43210" and "098765 43210" are
    // the same real number as "9876543210", and a customer who typed one
    // of those has not made a mistake worth failing an order over.
    phone: normalisePhone(notes.phone || payment.contact || ""),
    address: String(notes.address || notes["Full Address"] || "").trim(),
    city: String(notes.city || notes["City"] || "").trim(),
    state: String(notes.state || notes["State"] || "").trim(),
    pincode: String(notes.pincode || notes["Pincode"] || "").replace(/\D/g, ""),
    notes,
  };
}

function normalisePhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

/**
 * Returns a list of human-readable problems, empty if the details are
 * usable. This runs AFTER payment - it cannot stop a bad address being
 * entered, only stop a parcel being booked against one. The place to
 * catch a typo before money moves is Razorpay's own checkout form
 * validation (see setup step A).
 */
function validateShippingDetails(c) {
  const problems = [];
  if (!c.name) problems.push("No name given.");
  if (!c.address) problems.push("No street address given.");
  if (!c.city) problems.push("No city given.");
  if (!c.state) problems.push("No state given.");
  // Indian pincodes are exactly 6 digits and never start with 0.
  if (!/^[1-9][0-9]{5}$/.test(c.pincode)) {
    problems.push(`Pincode "${c.pincode || "(blank)"}" is not a valid 6-digit Indian pincode.`);
  }
  // Indian mobile numbers are 10 digits starting 6-9. Checked after
  // normalisePhone has already stripped +91 / 0 / spaces.
  if (!/^[6-9][0-9]{9}$/.test(c.phone)) {
    problems.push(`Phone "${c.phone || "(blank)"}" is not a valid 10-digit Indian mobile number.`);
  }
  // Not fatal on its own - the courier does not need it - but the
  // customer cannot be told anything without it, so it is worth flagging.
  if (!c.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) {
    problems.push(`Email "${c.email || "(blank)"}" is missing or malformed - no confirmation can be sent.`);
  }
  return problems;
}

// ------------------------------------------------------------------
// Email
// ------------------------------------------------------------------

const rupees = (n) => `Rs. ${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * The customer's order confirmation. Every number in here comes from the
 * payment itself (what they were actually charged) and from the Courier
 * Karo booking that just succeeded - never from the live catalog, so a
 * price edit published between the sale and this email cannot rewrite
 * what the customer sees they paid.
 */
async function sendCustomerConfirmation({ customer, items, amountPaid, orderId, awb, settings }) {
  if (!customer.email) throw new Error("customer has no email address");

  // The wording is admin-editable from the Bookstore tab's Shop settings,
  // with hardcoded fallbacks so an order confirmation NEVER fails to send
  // (or sends half-empty) just because a settings field was left blank.
  const st = settings || {};
  const intro = String(st.emailIntro || "").trim() || "Thanks for your order - it's confirmed and on its way.";
  const signoff = String(st.emailSignoff || "").trim() || "- PrepFusion";
  const ctaUrl = String(st.postPurchaseCtaUrl || "").trim() || "https://go.prepfusion.in";
  const ctaLabel = String(st.postPurchaseCtaLabel || "").trim() || "Start learning on our courses page";

  const addressBlock = [customer.address, `${customer.city}, ${customer.state} ${customer.pincode}`]
    .filter(Boolean)
    .join("\n");

  // Only offered when there is a mailbox that can actually receive it -
  // an unanswerable "just reply to this email" is worse than saying
  // nothing, because the customer thinks they've been heard.
  const contactLine = SUPPORT_EMAIL
    ? `Any questions, just reply to this email or write to ${SUPPORT_EMAIL}.\n\n`
    : "";

  // Omitted, not shown as "undefined", when Courier Karo's response didn't
  // have the field this Worker expects for it (see the alert sent in
  // that case in fetch()).
  const trackingBlockText = awb
    ? `Tracking number (AWB): ${awb}\n` +
      `Track it at https://courierkaro.com once the courier scans it in - ` +
      `that usually takes a few hours.\n\n`
    : `Your tracking number will follow separately once the courier picks this up.\n\n`;

  const itemLines = items
    .map((item) => `  ${item.name} x ${item.qty} - ${rupees(item.price * item.qty)}`)
    .join("\n");

  const text =
    `Hi ${customer.name},\n\n` +
    `${intro}\n\n` +
    `Order: ${orderId}\n` +
    `Items:\n${itemLines}\n` +
    `Paid: ${rupees(amountPaid)}\n` +
    `Delivery: Free\n\n` +
    trackingBlockText +
    `Shipping to:\n${customer.name}\n${addressBlock}\n${customer.phone}\n\n` +
    `While your books ship: ${ctaLabel}\n${ctaUrl}\n\n` +
    contactLine +
    `${signoff}\n`;

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f2f5fa;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#0a1020;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;padding:28px;">
      <h1 style="margin:0 0 6px;font-size:20px;">Order confirmed</h1>
      <p style="margin:0 0 20px;color:#475a78;font-size:14px;">Hi ${escapeHtml(customer.name)} - ${escapeHtml(intro)}</p>

      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        ${items
          .map(
            (item) => `<tr>
          <td style="padding:8px 0;border-bottom:1px solid #dde4f0;">${escapeHtml(item.name)} &times; ${item.qty}</td>
          <td style="padding:8px 0;border-bottom:1px solid #dde4f0;text-align:right;">${rupees(item.price * item.qty)}</td>
        </tr>`
          )
          .join("")}
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #dde4f0;color:#1d6b33;">Delivery</td>
          <td style="padding:8px 0;border-bottom:1px solid #dde4f0;text-align:right;color:#1d6b33;">Free</td>
        </tr>
        <tr>
          <td style="padding:10px 0;font-weight:700;">Paid</td>
          <td style="padding:10px 0;text-align:right;font-weight:700;">${rupees(amountPaid)}</td>
        </tr>
      </table>

      <div style="margin:18px 0;padding:14px;background:#e2ecfd;border-radius:10px;font-size:14px;">
        ${
          awb
            ? `<div style="font-weight:700;margin-bottom:4px;">Tracking number</div>
        <div style="font-family:monospace;font-size:15px;">${escapeHtml(awb)}</div>
        <div style="margin-top:6px;color:#1c46bd;font-size:12.5px;">
          Track at courierkaro.com once the courier scans it in - usually a few hours.
        </div>`
            : `<div style="color:#1c46bd;">Your tracking number will follow separately once the courier picks this up.</div>`
        }
      </div>

      <div style="margin:0 0 18px;text-align:center;">
        <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#14307f;color:#ffffff;text-decoration:none;border-radius:999px;padding:12px 26px;font-weight:700;font-size:14px;">${escapeHtml(ctaLabel)}</a>
      </div>

      <div style="font-size:13px;color:#475a78;line-height:1.6;">
        <div style="font-weight:700;color:#0a1020;margin-bottom:4px;">Shipping to</div>
        ${escapeHtml(customer.name)}<br>
        ${escapeHtml(customer.address)}<br>
        ${escapeHtml(customer.city)}, ${escapeHtml(customer.state)} ${escapeHtml(customer.pincode)}<br>
        ${escapeHtml(customer.phone)}
      </div>

      <p style="margin:20px 0 0;font-size:12.5px;color:#4f6080;">
        Order ${escapeHtml(orderId)}${
          SUPPORT_EMAIL
            ? ` &middot; Questions? Reply to this email or write to ${escapeHtml(SUPPORT_EMAIL)}.`
            : ""
        }
      </p>
    </div>
  </body>
</html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: CUSTOMER_EMAIL_FROM,
      to: [customer.email],
      // Omitted entirely when there's no real inbox: a Reply-To pointing
      // at an address with no MX record just bounces the customer's reply.
      ...(SUPPORT_EMAIL ? { reply_to: SUPPORT_EMAIL } : {}),
      subject: `Your PrepFusion order is confirmed (${orderId})`,
      text,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend customer email failed: ${res.status} ${await res.text()}`);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ------------------------------------------------------------------
// Alerting (to you, not the customer)
// ------------------------------------------------------------------

// Sends the alert to every configured email, and to WhatsApp if enabled.
// Failures here are only logged (not re-thrown) so an alerting problem
// never blocks the webhook response back to Razorpay.
// Returns true if AT LEAST ONE channel actually delivered. Callers use that
// to decide whether it's safe to swallow a failure: an order that failed AND
// couldn't be reported is the one genuinely dangerous state in this whole
// system - money taken, nothing shipped, nobody told - so callers deliberately
// let Razorpay retry rather than returning 200 on a failed alert.
async function alert(env, message) {
  const tasks = [sendEmailAlert(message)];
  if (ENABLE_WHATSAPP_ALERTS) tasks.push(sendWhatsAppAlert(message));

  const results = await Promise.allSettled(tasks);
  results.forEach((r) => {
    if (r.status === "rejected") console.error("Alert delivery failed:", r.reason);
  });
  return results.some((r) => r.status === "fulfilled");
}

async function sendEmailAlert(message) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: ALERT_EMAIL_FROM,
      to: ALERT_EMAILS, // Resend accepts an array - every address gets it
      subject: "PrepFusion Store: shipment needs manual attention",
      text: message,
    }),
  });
  if (!res.ok) throw new Error(`Resend email send failed: ${res.status} ${await res.text()}`);
}

async function sendWhatsAppAlert(message) {
  const url =
    `https://api.callmebot.com/whatsapp.php?phone=${WHATSAPP_CALLMEBOT_PHONE}` +
    `&text=${encodeURIComponent("PrepFusion Store alert:\n" + message)}` +
    `&apikey=${WHATSAPP_CALLMEBOT_APIKEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CallMeBot WhatsApp send failed: ${res.status}`);
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(signatureBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}


// ------------------------------------------------------------------
// Other webhook events
// ------------------------------------------------------------------

// Returns a Response if this event was handled here, or null to let the
// caller carry on (payment.captured, or an event we deliberately ignore).
async function handleOtherEvent(payload, env) {
  const event = payload.event;
  const entity = (name) => (payload.payload && payload.payload[name] && payload.payload[name].entity) || null;

  // --- Failed payment: INFORMATIONAL ONLY --------------------------------
  // Razorpay's docs are explicit that a UPI customer who retries can produce
  // payment.failed and THEN payment.captured for the same order. Treating a
  // failure as final would therefore act on orders that are about to
  // succeed, so this only logs. Card typos are common; alerting on each one
  // would train you to ignore the alerts that matter.
  if (event === "payment.failed") {
    const p = entity("payment");
    console.log(
      `payment.failed ${p && p.id}: ${(p && p.error_description) || "no description"} ` +
        `(${(p && p.error_reason) || "no reason"}) - informational; a UPI retry may still succeed.`
    );
    return new Response("Noted", { status: 200 });
  }

  // --- Refunds -----------------------------------------------------------
  // Unlike a failed payment, a refund is final and may mean a parcel should
  // not ship. The Worker cannot cancel a Courier Karo booking itself (their
  // documented API has no cancel endpoint), so this is a prompt for a human -
  // and it says whether a shipment actually exists, so nobody goes hunting
  // for one that was never booked.
  if (event === "refund.created" || event === "refund.processed" || event === "refund.failed") {
    const r = entity("refund");
    const paymentId = r && r.payment_id;
    const marker = paymentId ? await env.PROCESSED_PAYMENTS.get(paymentId) : null;
    const looksLikeAwb = marker && marker.length > 6 && /^[A-Za-z0-9]+$/.test(marker) && marker !== BOOKING_CLAIM;

    if (event === "refund.failed") {
      await alert(
        env,
        `A REFUND FAILED for payment ${paymentId} (${r ? "Rs. " + r.amount / 100 : "amount unknown"}).\n\n` +
          `The customer is expecting their money back and has not received it. Check the refund in the ` +
          `Razorpay dashboard and retry it - this one needs handling promptly.`
      );
      return new Response("Refund failure noted", { status: 200 });
    }

    await alert(
      env,
      `A refund was ${event === "refund.created" ? "created" : "processed"} for payment ${paymentId} ` +
        `(${r ? "Rs. " + r.amount / 100 : "amount unknown"}).\n\n` +
        (looksLikeAwb
          ? `A shipment WAS booked for it - AWB ${marker}. If it has not left yet, cancel it in the Courier ` +
            `Karo dashboard so you are not paying to ship a refunded order.`
          : `No shipment appears to have been booked (marker: ${marker || "none"}), so there is probably ` +
            `nothing to cancel - worth a quick check anyway.`)
    );
    return new Response("Refund noted", { status: 200 });
  }

  // --- Disputes / chargebacks -------------------------------------------
  // The highest-stakes events here: money is being taken back, and a dispute
  // carries a DEADLINE to submit evidence. Always alerted, never silent.
  if (event && event.startsWith("payment.dispute.")) {
    const d = entity("dispute");
    const stage = event.slice("payment.dispute.".length);
    const amount = d ? "Rs. " + d.amount / 100 : "amount unknown";
    const urgent = stage === "created" || stage === "action_required";
    await alert(
      env,
      `${urgent ? "ACTION NEEDED - " : ""}Payment dispute ${stage.toUpperCase()} for payment ` +
        `${(d && d.payment_id) || "unknown"} (${amount}).\n\n` +
        (urgent
          ? `A dispute has a DEADLINE${d && d.respond_by ? ` - respond by ${d.respond_by}` : ""}. Open the ` +
            `Razorpay dashboard and submit evidence (order confirmation, AWB, delivery proof) before it ` +
            `expires, or the amount is lost by default.\n\n`
          : "") +
        `Reason: ${(d && d.reason_description) || (d && d.reason_code) || "not given"}`
    );
    return new Response("Dispute noted", { status: 200 });
  }

  // --- Payment method downtime ------------------------------------------
  // Useful because it explains a sudden stop in sales that is nothing to do
  // with this code - UPI or a card network being down, not a bug to hunt.
  if (event === "payment.downtime.started" || event === "payment.downtime.resolved") {
    const d = entity("payment.downtime");
    const method = (d && d.method) || "a payment method";
    await alert(
      env,
      event === "payment.downtime.started"
        ? `Razorpay reports DOWNTIME on ${method}${d && d.instrument ? ` (${JSON.stringify(d.instrument)})` : ""}. ` +
          `Customers using it may be unable to pay for a while. Nothing is broken on our side - no action ` +
          `needed unless it drags on.`
        : `Razorpay reports ${method} downtime is RESOLVED - payments should be flowing normally again.`
    );
    return new Response("Downtime noted", { status: 200 });
  }

  // order.paid deliberately falls through to "Ignored": it fires alongside
  // payment.captured for the same money, and handling both would double-book
  // every order. payment.captured is the one this shop acts on.
  return null;
}

// ------------------------------------------------------------------
// Storefront
// ------------------------------------------------------------------

const rupeeFmt = (n) => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });

// One key per UTC day. The UTC boundary is deliberate: Cloudflare's KV
// daily write quota resets on the UTC day, so the order counter and the
// quota it protects tick over together (00:00 UTC = 5:30 AM IST).
function orderCountKey() {
  return "orders:" + new Date().toISOString().slice(0, 10);
}

async function orderCountToday(env) {
  try {
    const v = await env.PROCESSED_PAYMENTS.get(orderCountKey());
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    // If the count is unreadable, assume open: refusing all sales over a KV
    // read hiccup is worse than briefly not enforcing a soft limit.
    console.error("Could not read order counter:", err.message);
    return 0;
  }
}

// Read-increment-write, not atomic - KV has no atomic increment, so two
// simultaneous checkouts can under-count by one. Fine for what this is: a
// soft brake with a wide margin below the hard quota, not bookkeeping.
async function bumpOrderCount(env) {
  try {
    const key = orderCountKey();
    const current = await orderCountToday(env);
    await env.PROCESSED_PAYMENTS.put(key, String(current + 1), { expirationTtl: 60 * 60 * 48 });
  } catch (err) {
    console.error("Could not bump order counter:", err.message);
  }
}

async function shopIsFrozen(env, settings) {
  if (settings && settings.storeOpen === false) return "closed";
  if ((await orderCountToday(env)) >= DAILY_ORDER_LIMIT) return "limit";
  return null;
}

function maintenanceHtml(settings) {
  const message =
    (settings && String(settings.maintenanceMessage || "").trim()) ||
    "We're taking a short break - the shop will be back soon. Nothing has been charged.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(SHOP_NAME)} - back soon</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a1020;color:#f2f6ff;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;padding:24px;text-align:center}
.card{max-width:420px}h1{font-size:26px;margin:0 0 10px}p{color:#a9b8d6;line-height:1.6;margin:0}</style></head>
<body><div class="card"><h1>${escapeHtml(SHOP_NAME)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

async function renderShop(env) {
  const catalog = await getProductCatalog(env);
  if (!catalog || !Array.isArray(catalog.products)) {
    return new Response(maintenanceHtml(null), {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const settings = catalog.settings || {};
  if (await shopIsFrozen(env, settings)) {
    return new Response(maintenanceHtml(settings), {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(shopHtml(catalog), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function productImageUrl(path) {
  if (!path) return "";
  return /^https?:\/\//.test(path) ? path : PAGES_BASE + path;
}

// The whole shop as one server-rendered page. Everything printed here comes
// from the catalog the admin panel publishes; every string is escaped on the
// way in. Deliberately never shown: weight (admin-side only - the page says
// Free shipping instead) and anything not in the catalog's closed field set.
function shopHtml(catalog) {
  const settings = catalog.settings || {};
  const sections = Array.isArray(catalog.sections) ? catalog.sections : [];
  const products = catalog.products.filter((p) => p && p.id && p.name);

  const shelves = sections.map((sec) => ({
    title: sec.title,
    items: products.filter((p) => (p.section || "") === sec.id),
  }));
  const loose = products.filter((p) => !sections.some((sec) => sec.id === (p.section || "")));
  if (loose.length) shelves.push({ title: "More", items: loose });

  const productCard = (p) => {
    const images = Array.isArray(p.images) && p.images.length ? p.images : p.image ? [p.image] : [];
    const off = p.mrp && p.mrp > p.price ? Math.floor(((p.mrp - p.price) / p.mrp) * 100) : 0;
    const details = Array.isArray(p.details) ? p.details : [];
    const sold = p.inStock === false;
    return `<article class="p${sold ? " sold" : ""}" data-id="${escapeHtml(p.id)}">
      <div class="shot">
        ${images[0] ? `<img class="cover" src="${escapeHtml(productImageUrl(images[0]))}" alt="${escapeHtml(p.name)}" loading="lazy">` : `<div class="noimg">No photo</div>`}
        ${p.badge ? `<span class="badge">${escapeHtml(p.badge)}</span>` : ""}
        ${sold ? `<span class="soldtag">Sold out</span>` : ""}
      </div>
      ${
        images.length > 1
          ? `<div class="thumbs">${images
              .map((img, i) => `<img src="${escapeHtml(productImageUrl(img))}" class="${i === 0 ? "on" : ""}" alt="" loading="lazy" onclick="swapCover(this)">`)
              .join("")}</div>`
          : ""
      }
      <div class="body">
        <h3>${escapeHtml(p.name)}</h3>
        <div class="pricing">
          <span class="price">${rupeeFmt(p.price)}</span>
          ${off ? `<s>${rupeeFmt(p.mrp)}</s><span class="off">${off}% off</span>` : ""}
        </div>
        <div class="ship">Free shipping across India</div>
        ${p.description ? `<p class="desc">${escapeHtml(p.description)}</p>` : ""}
        ${
          details.length
            ? `<div class="tags">${details.map((d) => `<span class="tag"><b>${escapeHtml(d.label)}</b>${escapeHtml(d.value)}</span>`).join("")}</div>`
            : ""
        }
        <button class="buy" ${sold ? "disabled" : ""} onclick="addToCart('${escapeHtml(p.id)}')">${sold ? "Sold out" : "Add to cart"}</button>
      </div>
    </article>`;
  };

  const shelvesHtml = shelves
    .filter((s) => s.items.length)
    .map(
      (s) => `<section class="shelf"><h2>${escapeHtml(s.title)}</h2><div class="grid">${s.items
        .map(productCard)
        .join("")}</div></section>`
    )
    .join("");

  // Only what the cart needs, and only for buyable products - prices here
  // are display-only; the server recomputes everything at /create-order.
  const clientCatalog = products
    .filter((p) => p.inStock !== false)
    .map((p) => ({ id: p.id, name: p.name, price: p.price }));

  const successHeading = String(settings.postPurchaseHeading || "").trim() || "Order confirmed!";
  const successBody =
    String(settings.postPurchaseBody || "").trim() ||
    "Thanks for shopping with PrepFusion. Your books are on their way - the confirmation email has your tracking details.";
  const ctaLabel = String(settings.postPurchaseCtaLabel || "").trim() || "Go to my courses";
  const ctaUrl = String(settings.postPurchaseCtaUrl || "").trim() || "https://go.prepfusion.in";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(SHOP_NAME)}</title>
<style>
:root{--paper:#f2f5fa;--card:#fff;--ink:#0a1020;--soft:#475a78;--faint:#4f6080;--line:#dde4f0;--brand:#14307f;--accent-ink:#7a4200;--warm:#fdeccf;--ok:#1d6b33;--okbg:#dff3e4;--bad:#b3261e;--badbg:#fdf1f0;--info:#1c46bd;--infobg:#e2ecfd;--chip:#e9eef7}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:400 15px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif}
header{position:sticky;top:0;z-index:20;background:var(--brand);color:#fff;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}
header h1{font-size:18px;margin:0}
.cartbtn{background:#fff;color:var(--brand);border:0;border-radius:999px;padding:8px 16px;font-weight:700;cursor:pointer}
.wrap{max-width:1080px;margin:0 auto;padding:20px 16px 80px}
.shelf h2{font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);border-bottom:2px solid var(--line);padding-bottom:6px;margin:28px 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}
.p{background:var(--card);border:1.5px solid var(--line);border-radius:16px;overflow:hidden;display:flex;flex-direction:column}
.p.sold .cover{filter:grayscale(.85);opacity:.7}
.shot{position:relative;aspect-ratio:3/4;background:var(--chip)}
.shot .cover{width:100%;height:100%;object-fit:cover;display:block}
.noimg{display:grid;place-items:center;height:100%;color:var(--faint);font-size:13px}
.badge{position:absolute;top:10px;left:10px;background:var(--infobg);color:var(--info);font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:3px 9px;border-radius:999px}
.soldtag{position:absolute;top:10px;right:10px;background:var(--badbg);color:var(--bad);font-size:10.5px;font-weight:700;text-transform:uppercase;padding:3px 9px;border-radius:999px}
.thumbs{display:flex;gap:6px;padding:8px 10px 0}
.thumbs img{width:40px;height:40px;object-fit:cover;border-radius:6px;border:2px solid transparent;cursor:pointer}
.thumbs img.on{border-color:var(--brand)}
.body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:8px;flex:1}
.body h3{margin:0;font-size:15.5px}
.pricing{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.price{font-size:17px;font-weight:800;color:var(--accent-ink)}
.pricing s{color:var(--faint);font-size:13px}
.off{background:var(--okbg);color:var(--ok);font-size:10.5px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:999px}
.ship{color:var(--ok);font-size:12px;font-weight:600}
.desc{margin:0;color:var(--soft);font-size:13px}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{display:inline-flex;flex-direction:column;background:var(--chip);border-radius:8px;padding:4px 8px;font-size:11px}
.tag b{font-size:8.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint)}
.buy{margin-top:auto;background:var(--brand);color:#fff;border:0;border-radius:10px;padding:10px;font-weight:700;font-size:14px;cursor:pointer}
.buy:disabled{background:var(--chip);color:var(--faint);cursor:default}
.drawer{position:fixed;inset:0;background:rgba(10,16,32,.55);display:none;z-index:30}
.drawer.open{display:block}
.panel{position:absolute;right:0;top:0;bottom:0;width:min(420px,100%);background:var(--card);padding:20px;overflow-y:auto;display:flex;flex-direction:column}
.panel h2{margin:0 0 14px;font-size:18px}
.line{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);font-size:14px}
.qty{display:flex;align-items:center;gap:8px}
.qty button{width:26px;height:26px;border-radius:8px;border:1.5px solid var(--line);background:var(--card);cursor:pointer;font-weight:700}
.total{display:flex;justify-content:space-between;font-weight:800;font-size:16px;padding:14px 0}
label{display:block;font-size:12px;font-weight:600;color:var(--soft);margin:10px 0 4px}
input{width:100%;padding:9px 11px;border:1.5px solid var(--line);border-radius:9px;font-size:14px}
input.bad{border-color:var(--bad);background:var(--badbg)}
.err{color:var(--bad);font-size:12px;min-height:15px;margin-top:4px}
.pay{width:100%;background:var(--brand);color:#fff;border:0;border-radius:10px;padding:12px;font-weight:700;font-size:15px;cursor:pointer;margin-top:14px}
.pay:disabled{opacity:.5}
.muted{color:var(--faint);font-size:12px}
.success{position:fixed;inset:0;background:var(--paper);display:none;place-items:center;z-index:40;padding:24px;text-align:center}
.success.open{display:grid}
.success .tick{width:64px;height:64px;border-radius:999px;background:var(--okbg);color:var(--ok);display:grid;place-items:center;font-size:30px;margin:0 auto 14px}
.success h2{margin:0 0 8px}.success p{color:var(--soft);max-width:420px;margin:0 auto 18px}
.cta{display:inline-block;background:var(--brand);color:#fff;text-decoration:none;border-radius:999px;padding:12px 26px;font-weight:700}
</style>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
</head>
<body>
<header><h1>${escapeHtml(SHOP_NAME)}</h1><button class="cartbtn" onclick="openCart()">Cart (<span id="cart-count">0</span>)</button></header>
<div class="wrap">${shelvesHtml || '<p class="muted">Nothing on the shelves yet - check back soon.</p>'}</div>

<div class="drawer" id="drawer" onclick="if(event.target===this)closeCart()">
  <div class="panel">
    <h2>Your cart</h2>
    <div id="cart-lines"></div>
    <div class="total"><span>Total</span><span id="cart-total">₹0</span></div>
    <div class="muted">Free shipping across India</div>
    <div id="form">
      <label>Full name</label><input id="f-name" autocomplete="name">
      <label>Email</label><input id="f-email" type="email" autocomplete="email">
      <label>Phone</label><input id="f-phone" inputmode="numeric" autocomplete="tel">
      <label>Address</label><input id="f-address" autocomplete="street-address">
      <label>City</label><input id="f-city" autocomplete="address-level2">
      <label>State</label><input id="f-state" autocomplete="address-level1">
      <label>Pincode</label><input id="f-pincode" inputmode="numeric" autocomplete="postal-code">
      <div class="err" id="form-err"></div>
      <button class="pay" id="paybtn" onclick="checkout()">Pay securely</button>
      <p class="muted" style="margin-top:10px">Payments handled by Razorpay. Card details never touch this site.</p>
    </div>
  </div>
</div>

<div class="success" id="success">
  <div>
    <div class="tick">✓</div>
    <h2>${escapeHtml(successHeading)}</h2>
    <p>${escapeHtml(successBody)}</p>
    <a class="cta" href="${escapeHtml(ctaUrl)}">${escapeHtml(ctaLabel)}</a>
  </div>
</div>

<script>
var CATALOG = ${JSON.stringify(clientCatalog)};
var cart = {}; // id -> qty
function byId(id){ return CATALOG.find(function(p){ return p.id === id; }); }
function fmt(n){ return "₹" + Number(n).toLocaleString("en-IN"); }
function addToCart(id){ if(!byId(id)) return; cart[id] = (cart[id]||0)+1; renderCart(); openCart(); }
function setQty(id, q){ if(q<=0) delete cart[id]; else cart[id]=Math.min(q,20); renderCart(); }
function cartTotal(){ var t=0; Object.keys(cart).forEach(function(id){ var p=byId(id); if(p) t+=p.price*cart[id]; }); return t; }
function renderCart(){
  var lines = document.getElementById("cart-lines"); lines.innerHTML = "";
  var count = 0;
  Object.keys(cart).forEach(function(id){
    var p = byId(id); if(!p) return; count += cart[id];
    var row = document.createElement("div"); row.className = "line";
    var name = document.createElement("span"); name.textContent = p.name + " - " + fmt(p.price);
    var qty = document.createElement("span"); qty.className = "qty";
    var minus = document.createElement("button"); minus.textContent = "-"; minus.onclick = function(){ setQty(id, cart[id]-1); };
    var n = document.createElement("span"); n.textContent = cart[id];
    var plus = document.createElement("button"); plus.textContent = "+"; plus.onclick = function(){ setQty(id, cart[id]+1); };
    qty.appendChild(minus); qty.appendChild(n); qty.appendChild(plus);
    row.appendChild(name); row.appendChild(qty); lines.appendChild(row);
  });
  document.getElementById("cart-count").textContent = count;
  document.getElementById("cart-total").textContent = fmt(cartTotal());
  document.getElementById("paybtn").disabled = count === 0;
}
function openCart(){ document.getElementById("drawer").classList.add("open"); }
function closeCart(){ document.getElementById("drawer").classList.remove("open"); }
function swapCover(el){
  var card = el.closest(".p");
  card.querySelector(".cover").src = el.src;
  card.querySelectorAll(".thumbs img").forEach(function(t){ t.classList.remove("on"); });
  el.classList.add("on");
}
function val(id){ return document.getElementById(id).value.trim(); }
// Mirrors the server's checks so typos are caught BEFORE any money moves -
// the server re-validates everything regardless.
function localProblems(){
  var problems = [];
  var mark = function(id, bad){ document.getElementById(id).classList.toggle("bad", !!bad); };
  var name = val("f-name"), email = val("f-email"), addr = val("f-address"), city = val("f-city"), state = val("f-state");
  var phone = val("f-phone").replace(/\\D/g, "");
  if (phone.length === 12 && phone.indexOf("91") === 0) phone = phone.slice(2);
  if (phone.length === 11 && phone.indexOf("0") === 0) phone = phone.slice(1);
  var pin = val("f-pincode").replace(/\\D/g, "");
  mark("f-name", !name); if(!name) problems.push("name");
  mark("f-email", !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)); if(problems.indexOf("email")<0 && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) problems.push("a valid email");
  mark("f-phone", !/^[6-9][0-9]{9}$/.test(phone)); if(!/^[6-9][0-9]{9}$/.test(phone)) problems.push("a 10-digit mobile number");
  mark("f-address", !addr); if(!addr) problems.push("address");
  mark("f-city", !city); if(!city) problems.push("city");
  mark("f-state", !state); if(!state) problems.push("state");
  mark("f-pincode", !/^[1-9][0-9]{5}$/.test(pin)); if(!/^[1-9][0-9]{5}$/.test(pin)) problems.push("a 6-digit pincode");
  return problems;
}
async function checkout(){
  var errEl = document.getElementById("form-err");
  errEl.textContent = "";
  var missing = localProblems();
  if (missing.length){ errEl.textContent = "Please fill in: " + missing.join(", "); return; }
  var btn = document.getElementById("paybtn");
  btn.disabled = true; btn.textContent = "One moment...";
  try {
    var res = await fetch("/create-order", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: Object.keys(cart).map(function(id){ return { id: id, qty: cart[id] }; }),
        customer: {
          name: val("f-name"), email: val("f-email"), phone: val("f-phone"),
          address: val("f-address"), city: val("f-city"), state: val("f-state"), pincode: val("f-pincode")
        }
      })
    });
    var data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || "Could not start the payment - please try again."; return; }
    var rzp = new Razorpay({
      key: data.keyId,
      order_id: data.orderId,
      amount: data.amount,
      currency: data.currency,
      name: ${JSON.stringify(SHOP_NAME)},
      prefill: { name: data.name, email: data.email, contact: data.phone },
      handler: function(){ closeCart(); document.getElementById("success").classList.add("open"); },
      modal: { ondismiss: function(){} }
    });
    rzp.open();
  } catch (e) {
    errEl.textContent = "Network problem - nothing was charged. Please try again.";
  } finally {
    btn.disabled = false; btn.textContent = "Pay securely";
  }
}
renderCart();
</script>
</body></html>`;
}

// ------------------------------------------------------------------
// Order creation (the storefront's checkout endpoint)
// ------------------------------------------------------------------

// Everything money-shaped is decided HERE, server-side: prices come from the
// live catalog, never from the browser (a form field is editable by anyone);
// stock and the daily limit are checked before Razorpay is ever contacted;
// and the delivery details are validated while the customer can still fix
// them - the one place in the whole system that is possible.
async function handleCreateOrder(request, env) {
  const json = (obj, status) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ error: "Bad request" }, 400);
  }

  const catalog = await getProductCatalog(env);
  if (!catalog || !Array.isArray(catalog.products)) {
    return json({ error: "The shop is temporarily unavailable - nothing was charged. Please try again shortly." }, 503);
  }
  const settings = catalog.settings || {};

  const frozen = await shopIsFrozen(env, settings);
  if (frozen) {
    return json(
      {
        error:
          frozen === "limit"
            ? "We've hit today's order limit - the shop reopens tomorrow morning. Nothing was charged."
            : "The shop is temporarily closed. Nothing was charged.",
        frozen: true,
      },
      503
    );
  }

  // --- Cart ---
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length < 1 || rawItems.length > 8) {
    // 8 distinct products also keeps the cart JSON safely inside Razorpay's
    // 256-character-per-note limit.
    return json({ error: "Your cart looks empty or too large - please review it and try again." }, 400);
  }
  const lineItems = [];
  for (const entry of rawItems) {
    const id = entry && typeof entry.id === "string" ? entry.id : "";
    const qty = entry ? Number(entry.qty) : NaN;
    if (!id || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      return json({ error: "Your cart looks out of date - please refresh the page and try again." }, 400);
    }
    const product = catalog.products.find((p) => p.id === id);
    if (!product) {
      return json({ error: "One of the items in your cart is no longer available - please refresh the page." }, 400);
    }
    if (product.inStock === false) {
      return json({ error: `"${product.name}" has just sold out - please remove it from your cart.` }, 400);
    }
    const price = Number(product.price);
    if (!Number.isFinite(price) || price < 0) {
      return json({ error: "The shop is temporarily unavailable - please try again shortly." }, 503);
    }
    lineItems.push({ id: product.id, name: product.name, qty, price });
  }

  // --- Customer, validated BEFORE any money moves ---
  const c = body.customer || {};
  const customer = {
    name: String(c.name || "").trim(),
    email: String(c.email || "").trim(),
    phone: normalisePhone(c.phone || ""),
    address: String(c.address || "").trim(),
    city: String(c.city || "").trim(),
    state: String(c.state || "").trim(),
    pincode: String(c.pincode || "").replace(/\D/g, ""),
  };
  const problems = validateShippingDetails(customer);
  if (problems.length > 0) {
    return json({ error: "Please check your delivery details: " + problems.join(" "), problems }, 400);
  }

  const totalRupees = lineItems.reduce((sum, i) => sum + i.price * i.qty, 0);
  const amountPaise = Math.round(totalRupees * 100);
  if (amountPaise <= 0) return json({ error: "Your cart total is empty." }, 400);

  // --- Create the Razorpay order ---
  const notes = {
    name: customer.name,
    phone: customer.phone,
    address: customer.address,
    city: customer.city,
    state: customer.state,
    pincode: customer.pincode,
    // Compact on purpose: Razorpay caps each note value at 256 characters.
    cart: JSON.stringify(lineItems.map((i) => [i.id, i.qty, i.price])),
  };

  let order;
  try {
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ amount: amountPaise, currency: "INR", notes }),
    });
    order = await res.json();
    if (!res.ok || !order || !order.id) {
      console.error("Razorpay order creation failed:", JSON.stringify(order));
      return json({ error: "Could not start the payment - nothing was charged. Please try again." }, 502);
    }
  } catch (err) {
    console.error("Razorpay order creation error:", err.message);
    return json({ error: "Could not start the payment - nothing was charged. Please try again." }, 502);
  }

  // Counted at checkout, deliberately: abandoned checkouts burn KV quota
  // too, and this counter's whole job is protecting that quota.
  await bumpOrderCount(env);

  return json(
    {
      orderId: order.id,
      amount: amountPaise,
      currency: "INR",
      keyId: RAZORPAY_KEY_ID,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
    },
    200
  );
}

export { normalisePhone, validateShippingDetails, findProduct, normaliseName, knownProductNames, extractCustomerDetails, parseCartNotes, FALLBACK_CATALOG };
