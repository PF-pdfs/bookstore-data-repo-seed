// Issues and verifies the two JWTs we mint ourselves — the access token the
// SPA sends on every call, and the short-lived state token that binds an
// in-flight OAuth transaction to the browser that started it — plus the
// opaque refresh tokens.
//
// Refresh tokens are deliberately NOT JWTs: they must be revocable, and a
// self-contained token cannot be taken back before it expires.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { AuthError } = require('./errors');

const ALGORITHM = 'HS256';

function createTokenService({
  jwtSecret,
  issuer,
  audience,
  accessTtlSeconds,
  oauthStateTtlSeconds,
  now = Date.now
}) {
  if (!jwtSecret) {
    throw new Error('createTokenService requires a jwtSecret');
  }

  function seconds() {
    return Math.floor(now() / 1000);
  }

  // exp/iat are set explicitly rather than via the `expiresIn` option so the
  // injected clock governs them — jsonwebtoken's own option reads the real one.
  function sign(payload, ttlSeconds) {
    const issuedAt = seconds();
    return jwt.sign({ ...payload, iat: issuedAt, exp: issuedAt + ttlSeconds }, jwtSecret, {
      algorithm: ALGORITHM
    });
  }

  function verify(token, expectedType) {
    if (typeof token !== 'string' || !token) {
      throw new AuthError('invalid_token', 'No token supplied');
    }
    let claims;
    try {
      claims = jwt.verify(token, jwtSecret, {
        // Pinning the algorithm is what stops "alg: none" and HS/RS confusion:
        // never let the token's own header choose how it is verified.
        algorithms: [ALGORITHM],
        issuer,
        audience,
        clockTimestamp: seconds()
      });
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw new AuthError('token_expired', 'Token has expired');
      }
      throw new AuthError('invalid_token', 'Token is not valid');
    }
    // A state token must never be usable as an access token, or a half-finished
    // login would authenticate someone.
    if (claims.typ !== expectedType) {
      throw new AuthError('invalid_token', `Expected a ${expectedType} token`);
    }
    return claims;
  }

  return {
    signAccessToken(user) {
      return sign(
        {
          typ: 'access',
          sub: user.id,
          email: user.email,
          name: user.name,
          roles: user.roles || ['user'],
          assignedBooks: user.assignedBooks || [],
          // Independent of roles: Bookstore access is a flag on an existing
          // admin, not a third role value — see server/adminRules.js.
          bookOwner: Boolean(user.bookOwner),
          iss: issuer,
          aud: audience
        },
        accessTtlSeconds
      );
    },

    verifyAccessToken(token) {
      return verify(token, 'access');
    },

    signStateToken({ state, verifier, provider }) {
      return sign(
        { typ: 'state', state, verifier, provider, iss: issuer, aud: audience },
        oauthStateTtlSeconds
      );
    },

    verifyStateToken(token) {
      return verify(token, 'state');
    },

    // Opaque, high-entropy, and only ever stored as a hash: a dump of the
    // refreshTokens collection must not yield usable sessions.
    generateRefreshToken() {
      const token = crypto.randomBytes(48).toString('base64url');
      return { token, hash: this.hashRefreshToken(token) };
    },

    hashRefreshToken(token) {
      // Plain SHA-256 rather than a password KDF: these are 384-bit random
      // values, so there is no dictionary to attack and no need to slow it.
      return crypto.createHash('sha256').update(token).digest('hex');
    }
  };
}

module.exports = { createTokenService, ALGORITHM };
