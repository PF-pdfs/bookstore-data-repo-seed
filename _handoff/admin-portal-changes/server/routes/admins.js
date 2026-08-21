const express = require('express');
const {
  validateGrant,
  validateRoleChange,
  validateBookOwnerChange,
  validateRemoval,
  normaliseEmail
} = require('../adminRules');

// Owner-only. Everything here changes who can reach the portal, so it sits
// behind requireOwner in addition to the requireAdmin gate the whole API has.
function createAdminsRouter({ stores, requireOwner, refreshService, now = Date.now }) {
  const router = express.Router();

  router.use(requireOwner);

  router.get('/', async (req, res, next) => {
    try {
      const admins = await stores.admins.list();
      res.json({
        admins,
        // The UI disables "remove"/"demote" on the last owner rather than
        // letting someone discover the rule by hitting a 409.
        ownerCount: admins.filter((a) => a.role === 'owner').length,
        bookOwnerCount: admins.filter((a) => a.bookOwner).length,
        you: req.user.email
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    const { email, role, error, status } = validateGrant(req.body || {});
    if (error) {
      res.status(status).json({ error });
      return;
    }
    try {
      const admin = await stores.admins.upsert({
        email,
        role,
        addedBy: req.user.email,
        at: new Date(now()).toISOString()
      });
      res.status(201).json(admin);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:email', async (req, res, next) => {
    const email = normaliseEmail(req.params.email);
    try {
      const existing = await stores.admins.findByEmail(email);
      const ownerCount = await stores.admins.countOwners();
      const verdict = validateRoleChange({ existing, newRole: (req.body || {}).role, ownerCount });

      if (verdict.error) {
        res.status(verdict.status).json({ error: verdict.error });
        return;
      }
      if (verdict.noop) {
        res.json(existing);
        return;
      }

      await stores.admins.setRole(email, req.body.role);
      res.json(await stores.admins.findByEmail(email));
    } catch (error) {
      next(error);
    }
  });

  // Narrows which books this admin sees at all — Books tab, and every
  // report/rating/warning tied to a book. Empty array = unrestricted (see
  // server/bookAccess.js). Owners are never restricted by this.
  router.patch('/:email/books', async (req, res, next) => {
    const email = normaliseEmail(req.params.email);
    const bookIds = (req.body || {}).bookIds;
    if (!Array.isArray(bookIds) || !bookIds.every((id) => typeof id === 'string')) {
      res.status(400).json({ error: 'bookIds must be an array of strings' });
      return;
    }
    try {
      const existing = await stores.admins.findByEmail(email);
      if (!existing) {
        res.status(404).json({ error: 'No such administrator' });
        return;
      }
      await stores.admins.setAssignedBooks(email, bookIds);
      res.json(await stores.admins.findByEmail(email));
    } catch (error) {
      next(error);
    }
  });

  // A site owner's escape hatch for granting/revoking Bookstore access —
  // book owners can also manage each other from inside the Bookstore tab
  // itself (see server/routes/bookstore.js), but this route means a lost or
  // never-configured BOOKSTORE_BOOTSTRAP_OWNER never turns into a lockout:
  // an owner can always seed the first one.
  router.patch('/:email/book-owner', async (req, res, next) => {
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
        res.json(existing);
        return;
      }

      await stores.admins.setBookOwner(email, req.body.bookOwner);
      res.json(await stores.admins.findByEmail(email));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:email', async (req, res, next) => {
    const email = normaliseEmail(req.params.email);
    try {
      const existing = await stores.admins.findByEmail(email);
      const ownerCount = await stores.admins.countOwners();
      const verdict = validateRemoval({ existing, actorEmail: req.user.email, ownerCount });

      if (verdict.error) {
        res.status(verdict.status).json({ error: verdict.error });
        return;
      }

      await stores.admins.remove(email);
      // Kill their sessions immediately rather than leaving a refresh token
      // valid until it expires. /refresh re-checks the allowlist too, so this
      // is belt and braces — but it makes revocation instant.
      await refreshService.revokeAllForUser(email);

      res.json({ removed: email, selfRemoval: Boolean(verdict.selfRemoval) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createAdminsRouter };
