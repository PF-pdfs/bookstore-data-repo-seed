// End-to-end simulation of the Worker's webhook, with every outbound call
// stubbed. Proves the whole path runs: signature -> dedup -> catalog ->
// validation -> Courier Karo -> customer email, plus each failure branch.
import worker from './worker-test.mjs';
import crypto from 'node:crypto';

const SECRET = 'YOUR_RAZORPAY_WEBHOOK_SECRET'; // matches the const in the file

const CATALOG = {
  sections: [{ id: 'bundles', title: 'Bundles' }],
  products: [
    { id: 'ee-bundle', name: 'EE Complete Bundle', price: 1499, weight: 1.2, inStock: true },
    { id: 'cs-formula', name: 'CS Formula Handbook', price: 349, weight: 0.4, inStock: false }
  ]
};

function makeEnv({ failPutAfter = null } = {}) {
  const store = new Map();
  let puts = 0;
  let limit = failPutAfter;
  return {
    kvStore: store,
    // The Worker dying is a one-off; the retry runs on a healthy isolate with
    // working KV. This lets a scenario simulate that recovery.
    recoverKv() {
      limit = null;
    },
    PROCESSED_PAYMENTS: {
      async get(k) {
        return store.has(k) ? store.get(k) : null;
      },
      async put(k, v) {
        puts++;
        // Simulates the isolate dying / KV failing at a chosen moment.
        if (limit !== null && puts > limit) throw new Error('KV unavailable');
        store.set(k, v);
      },
      async delete(k) {
        store.delete(k);
      }
    }
  };
}

function makeRequest(body, { signature } = {}) {
  const sig = signature ?? crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return new Request('https://worker.example/', {
    method: 'POST',
    headers: { 'X-Razorpay-Signature': sig },
    body
  });
}

function makeGetRequest(path = '/') {
  return new Request('https://worker.example' + path, { method: 'GET' });
}

function makeOrderRequest(body) {
  return new Request('https://worker.example/create-order', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const GOOD_CUSTOMER = {
  name: 'Anish Saha',
  email: 'buyer@example.com',
  phone: '+91 98765 43210',
  address: '221B Baker Street',
  city: 'Kolkata',
  state: 'West Bengal',
  pincode: '700001'
};

function paymentBody(overrides = {}) {
  return JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_ABC123',
          order_id: 'order_XYZ789',
          amount: 149900,
          email: 'buyer@example.com',
          contact: '+91 98765 43210',
          description: 'EE Complete Bundle',
          notes: {
            name: 'Anish Saha',
            address: '221B Baker Street',
            city: 'Kolkata',
            state: 'West Bengal',
            pincode: '700001'
          },
          ...overrides
        }
      }
    }
  });
}

// Records every outbound call so each scenario can assert on them.
function installFetchStub({ courierKaroOk = true, catalogOk = true, courierKaroAwbField = 'awb_no', resendOk = true, catalogBody = null, razorpayOk = true } = {}) {
  const calls = { catalog: 0, courierKaro: [], resend: [], razorpay: [] };
  globalThis.fetch = async (url, options = {}) => {
    const href = typeof url === 'string' ? url : url.url;

    if (href.includes('pf-pdfs.github.io')) {
      calls.catalog++;
      if (!catalogOk) return new Response('nope', { status: 503 });
      return new Response(JSON.stringify(catalogBody || CATALOG), { status: 200 });
    }
    if (href.includes('api.razorpay.com')) {
      calls.razorpay.push(JSON.parse(options.body));
      if (!razorpayOk) return new Response(JSON.stringify({ error: { description: 'nope' } }), { status: 401 });
      return new Response(JSON.stringify({ id: 'order_new123', amount: JSON.parse(options.body).amount, currency: 'INR' }), { status: 200 });
    }
    if (href.includes('courierkaro.com')) {
      calls.courierKaro.push(JSON.parse(options.body));
      if (!courierKaroOk) {
        return new Response(JSON.stringify({ status: 'error', message: 'bad pincode' }), { status: 400 });
      }
      // Simulates Courier Karo's real response using a DIFFERENT tracking
      // field name than the Worker assumes - the exact "docs never
      // confirmed this" scenario this test exists to cover.
      const body = { status: 'success', [courierKaroAwbField]: 'AWB999888777' };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (href.includes('api.resend.com')) {
      calls.resend.push(JSON.parse(options.body));
      // Simulates Resend down / bad key / quota exceeded - the case where we
      // cannot even tell the owner that something went wrong.
      if (!resendOk) return new Response('service unavailable', { status: 503 });
      return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 });
    }
    throw new Error(`Unexpected outbound call: ${href}`);
  };
  return calls;
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : ` -- ${detail}`}`);
}

// ---------------------------------------------------------------- 1
{
  const env = makeEnv();
  const calls = installFetchStub();
  const res = await worker.fetch(makeRequest(paymentBody()), env);

  check('happy path returns 200', res.status === 200, `got ${res.status}`);
  check('Courier Karo was booked once', calls.courierKaro.length === 1, `${calls.courierKaro.length} calls`);

  const ck = calls.courierKaro[0];
  check('weight came from the LIVE catalog (1.2 kg)', ck.items[0].weight === '1.2', ck.items[0].weight);
  check('amount charged came from Razorpay, not the catalog', ck.items[0].product_cost === '1499', ck.items[0].product_cost);
  check('phone was normalised for the courier', ck.t_phone === '9876543210', ck.t_phone);
  check('pincode passed through', ck.t_pincode === '700001', ck.t_pincode);

  check('exactly one email was sent (the customer confirmation)', calls.resend.length === 1, `${calls.resend.length}`);
  const mail = calls.resend[0];
  check('confirmation went TO the customer', mail.to[0] === 'buyer@example.com', JSON.stringify(mail.to));
  check('confirmation sent FROM the verified domain', mail.from.includes('store.prepfusion.in'), mail.from);
  check('confirmation carries the AWB tracking number', mail.text.includes('AWB999888777'), 'missing AWB');
  check('confirmation shows what was actually paid', mail.text.includes('1,499'), 'missing amount');
  check('confirmation does NOT leak the shipping weight', !mail.text.includes('1.2 kg'), 'weight leaked to customer');
  check('confirmation promises free delivery', /Delivery: Free/.test(mail.text), 'missing free shipping line');
  // SUPPORT_EMAIL is now the shop's real Gmail inbox, so replies are
  // invited and routed there.
  check('Reply-To points at the shop Gmail', mail.reply_to === 'bookstore.prepfusion@gmail.com', `reply_to=${mail.reply_to}`);
  check('email invites replies to the real inbox', mail.text.includes('bookstore.prepfusion@gmail.com'), 'inbox not mentioned');
  check('email carries the courses link by default', mail.text.includes('https://go.prepfusion.in'), 'default CTA missing');

  check('payment recorded in KV as the AWB', env.kvStore.get('pay_ABC123') === 'AWB999888777', env.kvStore.get('pay_ABC123'));
  check('catalog was cached in KV', env.kvStore.has('bookstore:catalog'), 'not cached');
}

// ---------------------------------------------------------------- 2
{
  const env = makeEnv();
  installFetchStub();
  await worker.fetch(makeRequest(paymentBody()), env);
  const calls2 = installFetchStub();
  const res = await worker.fetch(makeRequest(paymentBody()), env);

  check('duplicate delivery returns 200', res.status === 200, `${res.status}`);
  check('duplicate books NO second shipment', calls2.courierKaro.length === 0, `${calls2.courierKaro.length}`);
  check('duplicate sends NO second email', calls2.resend.length === 0, `${calls2.resend.length}`);
}

// ---------------------------------------------------------------- 3
{
  const env = makeEnv();
  const calls = installFetchStub();
  const res = await worker.fetch(makeRequest(paymentBody(), { signature: 'deadbeef' }), env);

  check('forged signature is rejected with 401', res.status === 401, `${res.status}`);
  check('forged request books nothing', calls.courierKaro.length === 0, `${calls.courierKaro.length}`);
}

// ---------------------------------------------------------------- 4
{
  const env = makeEnv();
  const calls = installFetchStub();
  const body = paymentBody({ description: 'A Book Nobody Added Yet', notes: {
    name: 'Anish Saha', address: '221B', city: 'Kolkata', state: 'WB', pincode: '700001'
  } });
  const res = await worker.fetch(makeRequest(body), env);

  check('unknown product still returns 200 (no Razorpay retry storm)', res.status === 200, `${res.status}`);
  check('unknown product books nothing', calls.courierKaro.length === 0, `${calls.courierKaro.length}`);
  check('unknown product alerts the owner', calls.resend.length === 1, `${calls.resend.length}`);
  check(
    'alert lists the names the catalog does know',
    calls.resend[0].text.includes('EE Complete Bundle'),
    'alert did not list known names'
  );
  check('alert goes to the owner, not the customer', calls.resend[0].to[0] !== 'buyer@example.com', JSON.stringify(calls.resend[0].to));
}

// ---------------------------------------------------------------- 5
{
  const env = makeEnv();
  const calls = installFetchStub();
  const body = paymentBody({
    notes: { name: 'Anish Saha', address: '221B', city: 'Kolkata', state: 'WB', pincode: '70001' }
  });
  const res = await worker.fetch(makeRequest(body), env);

  check('bad pincode returns 200', res.status === 200, `${res.status}`);
  check('bad pincode books NO shipment', calls.courierKaro.length === 0, `${calls.courierKaro.length}`);
  check('bad pincode alerts the owner', calls.resend.length === 1, `${calls.resend.length}`);
  check('alert names the actual problem', /pincode/i.test(calls.resend[0].text), 'no pincode mention');
  check('alert includes the customer details to fix by hand', calls.resend[0].text.includes('Anish Saha'), 'missing details');
}

// ---------------------------------------------------------------- 6
{
  const env = makeEnv();
  const calls = installFetchStub({ courierKaroOk: false });
  const res = await worker.fetch(makeRequest(paymentBody()), env);

  check('Courier Karo failure returns 200', res.status === 200, `${res.status}`);
  check('Courier Karo failure alerts the owner', calls.resend.length === 1, `${calls.resend.length}`);
  check('failure alert is the OWNER alert, not a customer email', calls.resend[0].subject.includes('manual attention'), calls.resend[0].subject);
  check('failed payment marked processed so Razorpay stops retrying', env.kvStore.get('pay_ABC123') === 'failed', env.kvStore.get('pay_ABC123'));
}

// ---------------------------------------------------------------- 7
{
  const env = makeEnv();
  // Warm the cache with a good fetch, then break GitHub Pages entirely.
  installFetchStub();
  await worker.fetch(makeRequest(paymentBody()), env);

  const calls = installFetchStub({ catalogOk: false });
  const res = await worker.fetch(makeRequest(paymentBody({ id: 'pay_SECOND' })), env);

  check('GitHub Pages outage still returns 200', res.status === 200, `${res.status}`);
  check('outage still books the shipment from the KV cache', calls.courierKaro.length === 1, `${calls.courierKaro.length}`);
  check('cached catalog gave the right weight', calls.courierKaro[0]?.items[0].weight === '1.2', calls.courierKaro[0]?.items[0].weight);
}

// ---------------------------------------------------------------- 8
{
  const env = makeEnv();
  const calls = installFetchStub();
  const body = paymentBody({ description: 'CS Formula Handbook', amount: 34900 });
  const res = await worker.fetch(makeRequest(body), env);

  check('sold-out item still ships (customer already paid)', calls.courierKaro.length === 1, `${calls.courierKaro.length}`);
  check('sold-out item warns the owner as well as confirming to the customer', calls.resend.length === 2, `${calls.resend.length}`);
  check('sold-out warning mentions stock', calls.resend.some((m) => /SOLD OUT/i.test(m.text || '')), 'no stock warning');
  check('customer still got their confirmation', calls.resend.some((m) => (m.to || [])[0] === 'buyer@example.com'), 'customer not emailed');
  check('response is 200', res.status === 200, `${res.status}`);
}

// ---------------------------------------------------------------- 9
// Courier Karo's real success response uses a different tracking-number
// field than the Worker assumes (`awb_no`). The order must not become a
// failure over this, and the customer must never see "undefined".
{
  const env = makeEnv();
  const calls = installFetchStub({ courierKaroAwbField: 'tracking_id' }); // NOT awb_no
  const res = await worker.fetch(makeRequest(paymentBody()), env);

  check('unrecognised tracking field still returns 200', res.status === 200, `${res.status}`);
  check('shipment still counted as booked', calls.courierKaro.length === 1, `${calls.courierKaro.length}`);
  check('owner is alerted about the field-name mismatch', calls.resend.length === 2, `${calls.resend.length} emails (want 2: alert + confirmation)`);

  const ownerAlert = calls.resend.find((m) => (m.to || [])[0] !== 'buyer@example.com');
  const customerMail = calls.resend.find((m) => (m.to || [])[0] === 'buyer@example.com');

  check('owner alert names the missing field', ownerAlert && /awb_no/.test(ownerAlert.text), 'alert does not mention awb_no');
  check('owner alert includes the raw Courier Karo response to find the real field', ownerAlert && ownerAlert.text.includes('tracking_id'), 'raw response not included');
  check('customer still got a confirmation despite the missing AWB', Boolean(customerMail), 'customer not emailed');
  check('customer email does NOT show the literal word "undefined"', customerMail && !customerMail.text.includes('undefined'), 'literal undefined leaked to customer');
  check(
    'customer email says tracking will follow, instead of a broken number',
    customerMail && /tracking number will follow/i.test(customerMail.text),
    'missing the fallback tracking line'
  );
  check(
    'payment still recorded in KV so a duplicate webhook is ignored',
    env.kvStore.get('pay_ABC123') === 'booked_awb_unknown',
    env.kvStore.get('pay_ABC123')
  );
}

// ================= PAYMENT-PATH SAFETY SCENARIOS =================
// Everything below covers states where money has already moved. The rule being
// verified throughout: never take a payment and end up with either (a) no
// shipment and nobody told, or (b) two shipments for one payment.

// ---------------------------------------------------------------- 10
// Courier Karo fails AND the alert cannot be delivered. Previously this
// returned 200 and filed the order away: money taken, nothing shipped, nobody
// told, no retry. The worst outcome in the whole system.
{
  const env = makeEnv();
  const calls = installFetchStub({ courierKaroOk: false, resendOk: false });
  const res = await worker.fetch(makeRequest(paymentBody()), env);

  check('CK fails + alert fails => 5xx so Razorpay RETRIES', res.status >= 500, `${res.status}`);
  check('the alert was at least attempted', calls.resend.length >= 1, `${calls.resend.length}`);
  check(
    'payment NOT marked processed, so a retry can try again',
    !env.kvStore.has('pay_ABC123'),
    `marker=${env.kvStore.get('pay_ABC123')}`
  );
}

// ---------------------------------------------------------------- 11
// Unknown product AND alert undeliverable. Nothing was booked, so a retry is
// free, and it is the only remaining chance of anyone finding out.
{
  const env = makeEnv();
  installFetchStub({ resendOk: false });
  const res = await worker.fetch(makeRequest(paymentBody({ description: 'Not In The Catalog' })), env);

  check('unknown product + alert fails => 5xx for retry', res.status >= 500, `${res.status}`);
  check('nothing filed away that would block the retry', !env.kvStore.has('pay_ABC123'), 'marker was written');
}

// ---------------------------------------------------------------- 12
// THE DUPLICATE-SHIPMENT RACE. The Worker claims the payment, then dies
// mid-booking (isolate killed, CPU limit - a hard stop this harness simulates
// by seeding KV in exactly the state such a death leaves behind: the claim
// written, nothing else). Razorpay retries. Without claim-before-booking a
// retry would book a SECOND shipment: two parcels for one payment, silently.
{
  const env = makeEnv();
  env.kvStore.set('pay_ABC123', 'booking_in_progress');

  const retry = installFetchStub();
  const res2 = await worker.fetch(makeRequest(paymentBody()), env);

  check('RETRY DOES NOT BOOK A SECOND SHIPMENT', retry.courierKaro.length === 0, `${retry.courierKaro.length} bookings`);
  check('retry returns 200', res2.status === 200, `${res2.status}`);
  check('retry alerts a human to verify manually', retry.resend.length === 1, `${retry.resend.length}`);
  check(
    'that alert names the order to look up',
    retry.resend[0] && retry.resend[0].text.includes('RZP-order_XYZ789'),
    'order id missing from alert'
  );
  check(
    'alert is explicit that it did NOT re-book',
    retry.resend[0] && /NOT re-booked automatically/i.test(retry.resend[0].text),
    'alert does not explain the non-action'
  );
  check(
    'payment closed off so retries stop repeating the same question',
    env.kvStore.get('pay_ABC123') === 'interrupted_needs_check',
    `marker=${env.kvStore.get('pay_ABC123')}`
  );
}

// ---------------------------------------------------------------- 13
// Interrupted booking where the alert ALSO fails: keep the claim (so a double
// booking still cannot happen) but 5xx so the question gets asked again.
{
  const env = makeEnv({ failPutAfter: 2 });
  installFetchStub();
  try {
    await worker.fetch(makeRequest(paymentBody()), env);
  } catch (err) {
    /* expected */
  }

  env.recoverKv();
  const retry = installFetchStub({ resendOk: false });
  const res = await worker.fetch(makeRequest(paymentBody()), env);

  check('interrupted + alert fails => 5xx for retry', res.status >= 500, `${res.status}`);
  check('still books nothing', retry.courierKaro.length === 0, `${retry.courierKaro.length}`);
  check(
    'claim retained, so a later retry still cannot double-book',
    env.kvStore.get('pay_ABC123') === 'booking_in_progress',
    `marker=${env.kvStore.get('pay_ABC123')}`
  );
}

// ---------------------------------------------------------------- 14
// Valid signature, unexpected payload shape (e.g. Razorpay changes format).
// Unguarded this threw, 5xx'd, and Razorpay retried the same unreadable body
// until it gave up, silently losing the order.
{
  const env = makeEnv();
  const calls = installFetchStub();
  const weird = JSON.stringify({ event: 'payment.captured', payload: { payment: {} } });
  const res = await worker.fetch(makeRequest(weird), env);

  check('unreadable payload returns 200 (stops a pointless retry loop)', res.status === 200, `${res.status}`);
  check('unreadable payload alerts the owner', calls.resend.length === 1, `${calls.resend.length}`);
  check('alert includes the raw body for diagnosis', calls.resend[0] && calls.resend[0].text.includes('Raw body'), 'raw body missing');
  check('nothing was booked', calls.courierKaro.length === 0, `${calls.courierKaro.length}`);
}

// ---------------------------------------------------------------- 15
// Malformed JSON with a valid signature gets the same protection.
{
  const env = makeEnv();
  const calls = installFetchStub();
  const res = await worker.fetch(makeRequest('{ not json at all'), env);

  check('malformed JSON does not throw unhandled', res.status === 200, `${res.status}`);
  check('malformed JSON alerts the owner', calls.resend.length === 1, `${calls.resend.length}`);
}

// ---------------------------------------------------------------- 16
// A non-payment.captured event stays a cheap no-op.
{
  const env = makeEnv();
  const calls = installFetchStub();
  const other = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_X' } } } });
  const res = await worker.fetch(makeRequest(other), env);

  check('unrelated events are ignored with 200', res.status === 200, `${res.status}`);
  check(
    'unrelated events book nothing and send nothing',
    calls.courierKaro.length === 0 && calls.resend.length === 0,
    'side effects occurred'
  );
}

// ---------------------------------------------------------------- 17
// Cloudflare KV allows ONE WRITE PER SECOND TO THE SAME KEY, on the paid plan
// as well as the free one. This Worker writes the payment's key twice - the
// claim, then the result - separated only by the Courier Karo round-trip,
// which is often well under a second. A rate-limited second write must NOT
// turn a perfectly successful order into a failure.
{
  // failPutAfter: 2 => catalog write and claim write succeed; the write that
  // records the result is rejected, exactly as a same-key rate limit would.
  const env = makeEnv({ failPutAfter: 2 });
  const calls = installFetchStub();
  const res = await worker.fetch(makeRequest(paymentBody()), env);

  check('rate-limited final write still returns 200', res.status === 200, `${res.status}`);
  check('the shipment was booked exactly once', calls.courierKaro.length === 1, `${calls.courierKaro.length}`);
  check(
    'the customer still got their confirmation',
    calls.resend.some((m) => (m.to || [])[0] === 'buyer@example.com'),
    'customer was not emailed'
  );
  check(
    'no false "check this manually" alarm was raised',
    !calls.resend.some((m) => /NOT re-booked automatically/i.test(m.text || '')),
    'a successful order triggered a false alarm'
  );
  check(
    'the claim remains, so a retry still cannot double-book',
    env.kvStore.get('pay_ABC123') === 'booking_in_progress',
    `marker=${env.kvStore.get('pay_ABC123')}`
  );
}

// ================= STOREFRONT SCENARIOS =================

// ---------------------------------------------------------------- 18
// The shop page itself: rendered from the live catalog, shows the
// merchandising, never shows the weight.
{
  const env = makeEnv();
  installFetchStub();
  const res = await worker.fetch(makeGetRequest('/'), env);
  const html = await res.text();

  check('GET / returns the shop', res.status === 200, `${res.status}`);
  check('shop shows the product name', html.includes('EE Complete Bundle'), 'product missing');
  check('shop promises free shipping', html.includes('Free shipping'), 'free shipping missing');
  check('shop NEVER mentions weight', !/\bkg\b/i.test(html), 'weight leaked to the shop');
  check('sold-out product is marked, not hidden', html.includes('Sold out'), 'sold-out state missing');
  check('Razorpay checkout script is loaded', html.includes('checkout.razorpay.com'), 'checkout.js missing');
  check('unknown GET paths 404', (await worker.fetch(makeGetRequest('/nope'), env)).status === 404, 'no 404');
}

// ---------------------------------------------------------------- 19
// The admin panel's storeOpen switch closes the whole shop.
{
  const env = makeEnv();
  installFetchStub({ catalogBody: { ...CATALOG, settings: { storeOpen: false, maintenanceMessage: 'Back tomorrow!' } } });
  const res = await worker.fetch(makeGetRequest('/'), env);
  const html = await res.text();

  check('closed shop serves the maintenance page', res.status === 503, `${res.status}`);
  check('maintenance page shows the admin message', html.includes('Back tomorrow!'), 'custom message missing');
  const order = await worker.fetch(makeOrderRequest({ items: [{ id: 'ee-bundle', qty: 1 }], customer: GOOD_CUSTOMER }), env);
  check('closed shop refuses to create orders too', order.status === 503, `${order.status}`);
}

// ---------------------------------------------------------------- 20
// The daily order limit freezes the shop before the KV quota can be hit.
{
  const env = makeEnv();
  installFetchStub();
  env.kvStore.set('orders:' + new Date().toISOString().slice(0, 10), '300');

  const page = await worker.fetch(makeGetRequest('/'), env);
  check('at the daily limit, the shop shows maintenance', page.status === 503, `${page.status}`);
  const order = await worker.fetch(makeOrderRequest({ items: [{ id: 'ee-bundle', qty: 1 }], customer: GOOD_CUSTOMER }), env);
  const body = await order.json();
  check('at the daily limit, ordering is refused', order.status === 503, `${order.status}`);
  check('the refusal says nothing was charged', /nothing was charged/i.test(body.error || ''), body.error);
}

// ---------------------------------------------------------------- 21
// Order creation: prices come from the SERVER's catalog, never the browser.
{
  const env = makeEnv();
  const calls = installFetchStub();
  const res = await worker.fetch(
    makeOrderRequest({
      // A tampering attempt: the browser claims the bundle costs 1 rupee.
      items: [{ id: 'ee-bundle', qty: 2, price: 1 }],
      customer: GOOD_CUSTOMER
    }),
    env
  );
  const data = await res.json();

  check('create-order succeeds', res.status === 200, `${res.status} ${JSON.stringify(data)}`);
  check('ONE Razorpay order for the whole cart', calls.razorpay.length === 1, `${calls.razorpay.length}`);
  check(
    'amount is the catalog price x qty in paise - browser price IGNORED',
    calls.razorpay[0].amount === 299800,
    `${calls.razorpay[0].amount}`
  );
  check('cart rides the notes for the webhook', calls.razorpay[0].notes.cart === JSON.stringify([['ee-bundle', 2, 1499]]), calls.razorpay[0].notes.cart);
  check('address rides the notes with the contract keys', calls.razorpay[0].notes.pincode === '700001', 'pincode missing');
  check('phone is normalised in the notes', calls.razorpay[0].notes.phone === '9876543210', calls.razorpay[0].notes.phone);
  check('response hands the browser the order id and key id', data.orderId === 'order_new123' && Boolean(data.keyId), JSON.stringify(data));
  check(
    'order counter incremented',
    env.kvStore.get('orders:' + new Date().toISOString().slice(0, 10)) === '1',
    env.kvStore.get('orders:' + new Date().toISOString().slice(0, 10))
  );
}

// ---------------------------------------------------------------- 22
// Order creation refusals - each BEFORE any money moves.
{
  const env = makeEnv();
  const calls = installFetchStub();

  const unknown = await worker.fetch(makeOrderRequest({ items: [{ id: 'not-a-book', qty: 1 }], customer: GOOD_CUSTOMER }), env);
  check('unknown product id is refused', unknown.status === 400, `${unknown.status}`);

  const sold = await worker.fetch(makeOrderRequest({ items: [{ id: 'cs-formula', qty: 1 }], customer: GOOD_CUSTOMER }), env);
  const soldBody = await sold.json();
  check('sold-out product is refused at checkout', sold.status === 400, `${sold.status}`);
  check('the refusal names the product', (soldBody.error || '').includes('CS Formula Handbook'), soldBody.error);

  const badPin = await worker.fetch(
    makeOrderRequest({ items: [{ id: 'ee-bundle', qty: 1 }], customer: { ...GOOD_CUSTOMER, pincode: '70001' } }),
    env
  );
  const badPinBody = await badPin.json();
  check('bad pincode is caught BEFORE payment', badPin.status === 400, `${badPin.status}`);
  check('the customer is told what to fix', /pincode/i.test(JSON.stringify(badPinBody.problems || badPinBody.error)), JSON.stringify(badPinBody));

  check('no Razorpay order was created for any refusal', calls.razorpay.length === 0, `${calls.razorpay.length}`);
  check('no counter burned on refusals', !env.kvStore.has('orders:' + new Date().toISOString().slice(0, 10)), 'counter written');
}

// ---------------------------------------------------------------- 23
// The webhook's cart path: several items, real quantities, one shipment.
{
  const env = makeEnv();
  const calls = installFetchStub();
  const body = paymentBody({
    amount: 299800 + 34900,
    notes: {
      name: 'Anish Saha',
      phone: '9876543210',
      address: '221B Baker Street',
      city: 'Kolkata',
      state: 'West Bengal',
      pincode: '700001',
      cart: JSON.stringify([['ee-bundle', 2, 1499], ['cs-formula', 1, 349]])
    }
  });
  const res = await worker.fetch(makeRequest(body), env);

  check('cart webhook returns 200', res.status === 200, `${res.status}`);
  check('ONE Courier Karo booking for the whole cart', calls.courierKaro.length === 1, `${calls.courierKaro.length}`);
  const items = calls.courierKaro[0].items;
  check('booking carries both line items', items.length === 2, `${items.length}`);
  check('quantities are real, not hardcoded 1', items[0].qty === '2' && items[1].qty === '1', JSON.stringify(items.map((i) => i.qty)));
  check('weights per item from the catalog (kg)', items[0].weight === '1.2' && items[1].weight === '0.4', JSON.stringify(items.map((i) => i.weight)));
  check('unit prices from the cart snapshot', items[0].product_cost === '1499' && items[1].product_cost === '349', JSON.stringify(items.map((i) => i.product_cost)));

  const mail = calls.resend.find((m) => (m.to || [])[0] === 'buyer@example.com');
  check('confirmation lists both items with quantities', mail && mail.text.includes('x 2') && mail.text.includes('CS Formula Handbook'), 'items missing from email');
  check('confirmation totals what was actually paid', mail && mail.text.includes('3,347'), 'total wrong');
  // cs-formula is marked sold out in the catalog: the shipment goes ahead
  // (they paid), and the owner gets a stock warning.
  check('owner warned about the sold-out line item', calls.resend.some((m) => /SOLD OUT/i.test(m.text || '')), 'no stock warning');
}

// ---------------------------------------------------------------- 24
// Admin-edited wording flows from the catalog settings into the email.
{
  const env = makeEnv();
  const calls = installFetchStub({
    catalogBody: {
      ...CATALOG,
      settings: {
        storeOpen: true,
        emailIntro: 'Custom intro from the admin panel.',
        emailSignoff: '- Team PrepFusion',
        postPurchaseCtaLabel: 'Open your courses',
        postPurchaseCtaUrl: 'https://courses.example.in'
      }
    }
  });
  const res = await worker.fetch(makeRequest(paymentBody()), env);
  const mail = calls.resend.find((m) => (m.to || [])[0] === 'buyer@example.com');

  check('settings email intro is used', mail && mail.text.includes('Custom intro from the admin panel.'), 'intro not applied');
  check('settings signoff is used', mail && mail.text.includes('- Team PrepFusion'), 'signoff not applied');
  check('settings CTA link is used', mail && mail.text.includes('https://courses.example.in'), 'cta not applied');
  check('response is 200', res.status === 200, `${res.status}`);
}

// ---------------------------------------------------------------- 25
// payment.failed is informational only. Razorpay's docs warn a UPI retry can
// send payment.failed and THEN payment.captured for the same order, so a
// failure must not be treated as final - and must not cost a KV write, since
// the daily write quota is what the whole freeze mechanism protects.
{
  const env = makeEnv();
  const calls = installFetchStub();
  const body = JSON.stringify({
    event: 'payment.failed',
    payload: { payment: { entity: { id: 'pay_FAIL1', error_description: 'card declined', error_reason: 'payment_failed' } } }
  });
  const res = await worker.fetch(makeRequest(body), env);

  check('payment.failed returns 200', res.status === 200, `${res.status}`);
  check('payment.failed books nothing', calls.courierKaro.length === 0, `${calls.courierKaro.length}`);
  check('payment.failed does not email anyone', calls.resend.length === 0, `${calls.resend.length}`);
  check('payment.failed costs NO kv write (protects the quota)', env.kvStore.size === 0, `${env.kvStore.size} keys written`);

  // The same order then succeeds on retry - it must behave like any normal sale.
  const ok = await worker.fetch(makeRequest(paymentBody()), env);
  check('a later success for the same customer still books', calls.courierKaro.length === 1, `${calls.courierKaro.length}`);
  check('and returns 200', ok.status === 200, `${ok.status}`);
}

// ---------------------------------------------------------------- 26
// A refund IS final, so it alerts - and says whether a shipment exists.
{
  const env = makeEnv();
  installFetchStub();
  await worker.fetch(makeRequest(paymentBody()), env); // book a real shipment first

  const calls = installFetchStub();
  const refund = JSON.stringify({
    event: 'refund.created',
    payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_ABC123', amount: 149900 } } }
  });
  const res = await worker.fetch(makeRequest(refund), env);

  check('refund returns 200', res.status === 200, `${res.status}`);
  check('refund alerts the owner', calls.resend.length === 1, `${calls.resend.length}`);
  check('refund alert names the AWB to cancel', calls.resend[0].text.includes('AWB999888777'), 'AWB missing');
  check('refund alert tells you to cancel the shipment', /cancel it/i.test(calls.resend[0].text), 'no cancel instruction');
}

// ---------------------------------------------------------------- 27
// A refund for a payment that never shipped says so, rather than sending
// someone hunting for a shipment that does not exist.
{
  const env = makeEnv();
  const calls = installFetchStub();
  const refund = JSON.stringify({
    event: 'refund.created',
    payload: { refund: { entity: { id: 'rfnd_2', payment_id: 'pay_NEVER', amount: 100 } } }
  });
  const res = await worker.fetch(makeRequest(refund), env);

  check('refund with no shipment returns 200', res.status === 200, `${res.status}`);
  check('and says there is probably nothing to cancel', /nothing to cancel/i.test(calls.resend[0].text), calls.resend[0].text.slice(0, 120));
}

// ---------------------------------------------------------------- 28
// Disputes are the highest-stakes event: money is being taken back, and
// there is a deadline that loses by default if missed.
{
  const env = makeEnv();
  const calls = installFetchStub();
  const body = JSON.stringify({
    event: 'payment.dispute.created',
    payload: {
      dispute: {
        entity: {
          id: 'disp_1',
          payment_id: 'pay_ABC123',
          amount: 149900,
          reason_description: 'Product not received',
          respond_by: '2026-09-01'
        }
      }
    }
  });
  const res = await worker.fetch(makeRequest(body), env);

  check('dispute returns 200', res.status === 200, `${res.status}`);
  check('dispute alerts the owner', calls.resend.length === 1, `${calls.resend.length}`);
  const text = calls.resend[0].text;
  check('dispute alert is marked ACTION NEEDED', /ACTION NEEDED/.test(text), 'not marked urgent');
  check('dispute alert names the deadline', text.includes('2026-09-01'), 'deadline missing');
  check('dispute alert gives the reason', text.includes('Product not received'), 'reason missing');
  check('dispute costs no KV write', env.kvStore.size === 0, `${env.kvStore.size}`);
}

// ---------------------------------------------------------------- 29
// A lost dispute is reported, but without the urgent framing - there is no
// longer a deadline to hit.
{
  const env = makeEnv();
  const calls = installFetchStub();
  const body = JSON.stringify({
    event: 'payment.dispute.lost',
    payload: { dispute: { entity: { id: 'disp_2', payment_id: 'pay_X', amount: 50000 } } }
  });
  await worker.fetch(makeRequest(body), env);

  check('lost dispute alerts', calls.resend.length === 1, `${calls.resend.length}`);
  check('lost dispute is not framed as actionable', !/ACTION NEEDED/.test(calls.resend[0].text), 'wrongly urgent');
}

// ---------------------------------------------------------------- 30
// order.paid must NOT be acted on - it fires alongside payment.captured for
// the same money, so handling both would book every order twice.
{
  const env = makeEnv();
  const calls = installFetchStub();
  const body = JSON.stringify({
    event: 'order.paid',
    payload: { order: { entity: { id: 'order_XYZ789', amount: 149900 } } }
  });
  const res = await worker.fetch(makeRequest(body), env);

  check('order.paid returns 200', res.status === 200, `${res.status}`);
  check('order.paid books NOTHING (no double-booking)', calls.courierKaro.length === 0, `${calls.courierKaro.length}`);
  check('order.paid emails nobody', calls.resend.length === 0, `${calls.resend.length}`);
}

// ---------------------------------------------------------------- 31
// Downtime notices explain a sales drop that is not our bug.
{
  const env = makeEnv();
  const calls = installFetchStub();
  const body = JSON.stringify({
    event: 'payment.downtime.started',
    payload: { 'payment.downtime': { entity: { id: 'down_1', method: 'upi' } } }
  });
  await worker.fetch(makeRequest(body), env);

  check('downtime alerts', calls.resend.length === 1, `${calls.resend.length}`);
  check('downtime alert names the method', calls.resend[0].text.includes('upi'), 'method missing');
  check('downtime alert says nothing is broken our side', /nothing is broken on our side/i.test(calls.resend[0].text), 'no reassurance');
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILURES:');
  failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
  process.exitCode = 1;
}
