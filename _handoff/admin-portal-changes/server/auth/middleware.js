// Access gates for the admin portal.
//
// Unlike kb-website — where browsing is open and only writes need a user —
// nothing here is public. Every API route sits behind requireAdmin, and the
// people-management routes behind requireOwner on top of that.

const { AuthError } = require('./errors');

const ROLES = ['owner', 'admin'];

function bearerFrom(req) {
  const header = req.get('authorization') || '';
  const [scheme, ...rest] = header.split(' ');
  if (!/^Bearer$/i.test(scheme)) {
    return null;
  }
  const token = rest.join(' ').trim();
  return token || null;
}

function toPublicUser(claims) {
  const roles = claims.roles || [];
  return {
    id: claims.sub,
    email: claims.email,
    name: claims.name,
    roles,
    // An owner can do everything an admin can, plus manage people.
    role: roles.includes('owner') ? 'owner' : 'admin',
    isOwner: roles.includes('owner'),
    // Bookstore access, independent of owner/admin — see adminRules.js. An
    // owner does NOT get this for free; it has to be granted explicitly, same
    // as a book owner does not get owner's other powers for free.
    isBookOwner: Boolean(claims.bookOwner),
    // Empty = unrestricted (see server/bookAccess.js). Carried on the access
    // token like roles are, so a change takes effect within one token
    // lifetime via /refresh — same pattern admin removal already relies on.
    assignedBooks: claims.assignedBooks || []
  };
}

function createRequireAdmin(tokens) {
  return function requireAdmin(req, res, next) {
    const token = bearerFrom(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication required', code: 'unauthenticated' });
      return;
    }

    let claims;
    try {
      claims = tokens.verifyAccessToken(token);
    } catch (error) {
      const authError = error instanceof AuthError ? error : new AuthError('invalid_token', 'Token is not valid');
      // token_expired is reported distinctly so the client refreshes rather
      // than bouncing the user back to a sign-in screen.
      res.status(401).json({ error: authError.message, code: authError.code });
      return;
    }

    const user = toPublicUser(claims);
    // A token carrying no recognised role is not an admin token. The callback
    // refuses to mint one, but this also stops a hand-crafted token that
    // somehow verified from counting as access.
    if (!user.roles.some((role) => ROLES.includes(role))) {
      res.status(403).json({ error: 'Not an administrator', code: 'not_admin' });
      return;
    }

    req.user = user;
    next();
  };
}

// Layered on top of requireAdmin, never used alone — it reads req.user.
function requireOwner(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required', code: 'unauthenticated' });
    return;
  }
  if (!req.user.isOwner) {
    res.status(403).json({ error: 'Only an owner can do that', code: 'owner_required' });
    return;
  }
  next();
}

// Gates the Bookstore catalog specifically. Deliberately NOT satisfied by
// isOwner — the whole point of this flag is that site ownership does not by
// itself carry the ability to change what customers are charged; only
// whoever holds this flag can.
function requireBookOwner(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required', code: 'unauthenticated' });
    return;
  }
  if (!req.user.isBookOwner) {
    res.status(403).json({ error: 'Only a book owner can do that', code: 'book_owner_required' });
    return;
  }
  next();
}

module.exports = { createRequireAdmin, requireOwner, requireBookOwner, bearerFrom, toPublicUser, ROLES };
