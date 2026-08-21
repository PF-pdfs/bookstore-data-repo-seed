// The allowlist of people who may sign in to the admin portal.
//
// Keyed by email rather than by provider id, so someone can be granted access
// before they have ever signed in — you add a colleague's address and it works
// the first time they arrive. Emails are lowercased on the way in and out:
// Google treats addresses case-insensitively and so must we, or "Abhi@…" and
// "abhi@…" become two different admins.

const { collection, COLLECTIONS } = require('./mongo');

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function toAdmin(doc) {
  if (!doc) {
    return null;
  }
  const { _id, ...rest } = doc;
  return { email: _id, ...rest };
}

async function findByEmail(email) {
  const admins = await collection(COLLECTIONS.admins);
  return toAdmin(await admins.findOne({ _id: normaliseEmail(email) }));
}

async function list() {
  const admins = await collection(COLLECTIONS.admins);
  const rows = await admins.find({}).sort({ role: 1, _id: 1 }).toArray();
  return rows.map(toAdmin);
}

async function countOwners() {
  const admins = await collection(COLLECTIONS.admins);
  return admins.countDocuments({ role: 'owner' });
}

async function upsert({ email, role, addedBy, at }) {
  const admins = await collection(COLLECTIONS.admins);
  const _id = normaliseEmail(email);
  await admins.updateOne(
    { _id },
    {
      $set: { role },
      // Only stamped the first time, so re-granting does not rewrite history.
      $setOnInsert: { addedBy: addedBy || null, addedAt: at }
    },
    { upsert: true }
  );
  return findByEmail(_id);
}

async function setRole(email, role) {
  const admins = await collection(COLLECTIONS.admins);
  const result = await admins.updateOne({ _id: normaliseEmail(email) }, { $set: { role } });
  return result.matchedCount > 0;
}

// A book owner is an existing admin with one extra flag — not a third portal
// role. It grants access to the Bookstore tab independent of owner/admin,
// so an ordinary site owner does not automatically get to touch the shop
// catalog just by being an owner; only whoever has this flag does.
async function setBookOwner(email, bookOwner) {
  const admins = await collection(COLLECTIONS.admins);
  const result = await admins.updateOne({ _id: normaliseEmail(email) }, { $set: { bookOwner: Boolean(bookOwner) } });
  return result.matchedCount > 0;
}

async function countBookOwners() {
  const admins = await collection(COLLECTIONS.admins);
  return admins.countDocuments({ bookOwner: true });
}

// Empty array = unrestricted (see server/bookAccess.js) — the default, and
// what removing every book from the picker returns to.
async function setAssignedBooks(email, bookIds) {
  const admins = await collection(COLLECTIONS.admins);
  const result = await admins.updateOne(
    { _id: normaliseEmail(email) },
    { $set: { assignedBooks: [...new Set(bookIds)] } }
  );
  return result.matchedCount > 0;
}

async function remove(email) {
  const admins = await collection(COLLECTIONS.admins);
  const result = await admins.deleteOne({ _id: normaliseEmail(email) });
  return result.deletedCount > 0;
}

// Recorded on sign-in so an owner can see who is actually using the portal,
// and pick up the name/avatar Google gives us.
async function recordLogin(email, { name, avatarUrl, at }) {
  const admins = await collection(COLLECTIONS.admins);
  await admins.updateOne(
    { _id: normaliseEmail(email) },
    { $set: { lastLoginAt: at, name: name || null, avatarUrl: avatarUrl || null } }
  );
}

// Creates the very first owner when the collection is empty. Deliberately a
// no-op once anyone exists: this is a bootstrap, not a permanent backdoor, so
// the env var cannot be used later to re-grant access to a removed account.
async function bootstrapOwner(email, at) {
  if (!normaliseEmail(email)) {
    return null;
  }
  const admins = await collection(COLLECTIONS.admins);
  if ((await admins.countDocuments({}, { limit: 1 })) > 0) {
    return null;
  }
  await admins.insertOne({
    _id: normaliseEmail(email),
    role: 'owner',
    addedBy: 'bootstrap',
    addedAt: at
  });
  return findByEmail(email);
}

// Same shape as bootstrapOwner, but keyed on "no book owner yet" rather than
// "no admin yet" — the two collections it's seeding overlap (a book owner is
// still a row in `admins`) but the empty conditions are independent, so this
// runs after bootstrapOwner and does not care whether that one fired.
// Deliberately a no-op once any book owner exists, same reasoning as
// bootstrapOwner: a bootstrap, not a standing backdoor a removed book owner
// could be silently re-granted through.
//
// If the target email has no admin record at all yet, one is created here
// with the least privilege that still lets them sign in ('admin', not
// 'owner') — being the book owner is meant to be additive on top of an
// ordinary account, not a shortcut to full site ownership.
async function bootstrapBookOwner(email, at) {
  const normalised = normaliseEmail(email);
  if (!normalised) {
    return null;
  }
  const admins = await collection(COLLECTIONS.admins);
  if ((await admins.countDocuments({ bookOwner: true }, { limit: 1 })) > 0) {
    return null;
  }
  await admins.updateOne(
    { _id: normalised },
    {
      $set: { bookOwner: true },
      $setOnInsert: { role: 'admin', addedBy: 'bootstrap', addedAt: at }
    },
    { upsert: true }
  );
  return findByEmail(normalised);
}

module.exports = {
  findByEmail,
  list,
  countOwners,
  upsert,
  setRole,
  setBookOwner,
  countBookOwners,
  setAssignedBooks,
  remove,
  recordLogin,
  bootstrapOwner,
  bootstrapBookOwner,
  normaliseEmail
};
