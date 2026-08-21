// The rules governing who may be granted, demoted or removed.
//
// Pure functions over plain values, because the interesting cases are the ones
// that must never happen — removing the last owner, demoting the last owner —
// and those deserve tests that do not need a database to express.

const ROLES = ['owner', 'admin'];

// Deliberately permissive: the authority on whether an address exists is
// Google, at sign-in. This only rejects input that is obviously not an email.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateGrant({ email, role }) {
  const normalised = normaliseEmail(email);
  if (!normalised) {
    return { error: 'An email address is required', status: 400 };
  }
  if (!EMAIL_PATTERN.test(normalised)) {
    return { error: `That does not look like an email address: ${email}`, status: 400 };
  }
  if (!ROLES.includes(role)) {
    return { error: `role must be one of: ${ROLES.join(', ')}`, status: 400 };
  }
  return { email: normalised, role };
}

// `existing` is the current record for that email (or null), `ownerCount` the
// number of owners right now.
function validateRoleChange({ existing, newRole, ownerCount }) {
  if (!existing) {
    return { error: 'No such administrator', status: 404 };
  }
  if (!ROLES.includes(newRole)) {
    return { error: `role must be one of: ${ROLES.join(', ')}`, status: 400 };
  }
  if (existing.role === newRole) {
    return { noop: true };
  }
  // Demoting the only owner would leave nobody able to manage people — the
  // portal would still work, but its access list would be frozen forever.
  if (existing.role === 'owner' && newRole !== 'owner' && ownerCount <= 1) {
    return { error: 'Cannot demote the last owner — promote another owner first', status: 409 };
  }
  return { ok: true };
}

// Same shape as validateRoleChange's last-owner guard, for the separate
// bookOwner flag: revoking the last book owner would leave nobody able to
// touch the shop catalog, or to re-grant the flag to anyone else, short of
// a site owner stepping in from the Administrators tab.
function validateBookOwnerChange({ existing, newValue, bookOwnerCount }) {
  if (!existing) {
    return { error: 'No such administrator', status: 404 };
  }
  const current = Boolean(existing.bookOwner);
  const next = Boolean(newValue);
  if (current === next) {
    return { noop: true };
  }
  if (current && !next && bookOwnerCount <= 1) {
    return { error: 'Cannot remove the last book owner — grant it to someone else first', status: 409 };
  }
  return { ok: true };
}

function validateRemoval({ existing, actorEmail, ownerCount }) {
  if (!existing) {
    return { error: 'No such administrator', status: 404 };
  }
  if (existing.role === 'owner' && ownerCount <= 1) {
    return { error: 'Cannot remove the last owner — promote another owner first', status: 409 };
  }
  // Removing yourself is allowed once another owner exists, but it ends your
  // own session, so it is worth the client confirming rather than surprising
  // someone mid-task.
  if (normaliseEmail(actorEmail) === normaliseEmail(existing.email)) {
    return { ok: true, selfRemoval: true };
  }
  return { ok: true };
}

module.exports = {
  validateGrant,
  validateRoleChange,
  validateBookOwnerChange,
  validateRemoval,
  normaliseEmail,
  ROLES
};
