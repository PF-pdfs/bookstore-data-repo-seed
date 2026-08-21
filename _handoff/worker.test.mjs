import { test } from 'node:test';
import assert from 'node:assert';
import {
  normalisePhone,
  validateShippingDetails,
  findProduct,
  normaliseName,
  knownProductNames,
  extractCustomerDetails
} from './worker-test.mjs';

// The real catalog shape, as published by the admin portal.
const LIVE = {
  sections: [{ id: 'bundles', title: 'Bundles' }],
  products: [
    { id: 'ee-bundle', name: 'EE Complete Bundle', price: 1499, mrp: 0, weight: 1.2, inStock: true },
    { id: 'cs-formula', name: 'CS Formula Handbook', price: 349, mrp: 499, weight: 0.4, inStock: false }
  ]
};

test('phone normalisation accepts the forms real customers type', () => {
  assert.equal(normalisePhone('9876543210'), '9876543210');
  assert.equal(normalisePhone('+91 98765 43210'), '9876543210');
  assert.equal(normalisePhone('+919876543210'), '9876543210');
  assert.equal(normalisePhone('098765-43210'), '9876543210');
  assert.equal(normalisePhone('  9876 543 210 '), '9876543210');
  assert.equal(normalisePhone(''), '');
});

test('product lookup matches by name, ignoring case and spacing', () => {
  assert.equal(findProduct(LIVE, 'EE Complete Bundle').weight, 1.2);
  assert.equal(findProduct(LIVE, '  ee   complete bundle  ').weight, 1.2);
  assert.equal(findProduct(LIVE, 'ee-bundle').weight, 1.2, 'also accepts the product code');
});

test('product lookup refuses a near-miss rather than guessing', () => {
  assert.equal(findProduct(LIVE, 'EE Bundle'), null);
  assert.equal(findProduct(LIVE, ''), null);
  assert.equal(findProduct(LIVE, 'Something Else Entirely'), null);
});

test('a loaded catalog never falls through to a stale hardcoded weight', () => {
  // "Book Title One" exists in FALLBACK_CATALOG but not in the live one.
  assert.equal(findProduct(LIVE, 'Book Title One'), null);
});

test('fallback catalog is used only when the live catalog is missing', () => {
  const viaFallback = findProduct(null, 'Book Title One');
  assert.equal(viaFallback.weight, 0.3);
  assert.equal(viaFallback.source, 'fallback');
  assert.equal(findProduct(LIVE, 'EE Complete Bundle').source, 'live');
});

test('sold-out state is surfaced, not hidden', () => {
  assert.equal(findProduct(LIVE, 'CS Formula Handbook').inStock, false);
  assert.equal(findProduct(LIVE, 'EE Complete Bundle').inStock, true);
});

test('a product with a broken weight is treated as unknown', () => {
  const broken = { products: [{ id: 'x', name: 'X', weight: 0 }] };
  assert.equal(findProduct(broken, 'X'), null);
  const missing = { products: [{ id: 'y', name: 'Y' }] };
  assert.equal(findProduct(missing, 'Y'), null);
});

test('known product names are listed for the alert email', () => {
  assert.deepEqual(knownProductNames(LIVE), ['EE Complete Bundle', 'CS Formula Handbook']);
  assert.ok(knownProductNames(null).includes('EE Complete Bundle'), 'falls back when catalog is null');
});

const goodCustomer = {
  name: 'Anish Saha',
  email: 'anish@example.com',
  phone: '9876543210',
  address: '221B Baker Street',
  city: 'Kolkata',
  state: 'West Bengal',
  pincode: '700001'
};

test('a complete, valid address passes', () => {
  assert.deepEqual(validateShippingDetails(goodCustomer), []);
});

test('a bad pincode is caught', () => {
  const problems = validateShippingDetails({ ...goodCustomer, pincode: '70001' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /pincode/i);
  // Indian pincodes never start with 0.
  assert.equal(validateShippingDetails({ ...goodCustomer, pincode: '070001' }).length, 1);
});

test('a bad phone is caught', () => {
  assert.match(validateShippingDetails({ ...goodCustomer, phone: '123456789' })[0], /mobile/i);
  // Indian mobiles start 6-9.
  assert.match(validateShippingDetails({ ...goodCustomer, phone: '5876543210' })[0], /mobile/i);
});

test('missing fields are each reported', () => {
  const problems = validateShippingDetails({ ...goodCustomer, name: '', city: '', address: '' });
  assert.equal(problems.length, 3);
});

test('a malformed email is reported, since no confirmation could be sent', () => {
  assert.match(validateShippingDetails({ ...goodCustomer, email: 'not-an-email' })[0], /email/i);
  assert.match(validateShippingDetails({ ...goodCustomer, email: '' })[0], /email/i);
});

test('customer extraction normalises the phone and strips pincode noise', () => {
  const c = extractCustomerDetails({
    email: 'buyer@example.com',
    contact: '+91 98765 43210',
    notes: { name: ' Anish ', address: ' 221B Baker St ', city: 'Kolkata', state: 'WB', pincode: '700 001' }
  });
  assert.equal(c.phone, '9876543210');
  assert.equal(c.pincode, '700001');
  assert.equal(c.name, 'Anish');
  assert.equal(c.address, '221B Baker St');
  assert.deepEqual(validateShippingDetails(c), [], 'a real-world messy entry still books');
});

test('Razorpay capitalised field names are also read', () => {
  const c = extractCustomerDetails({
    email: 'buyer@example.com',
    contact: '9876543210',
    notes: { 'Full Address': '221B Baker St', City: 'Kolkata', State: 'WB', Pincode: '700001' }
  });
  assert.equal(c.address, '221B Baker St');
  assert.equal(c.city, 'Kolkata');
  assert.equal(c.pincode, '700001');
});
