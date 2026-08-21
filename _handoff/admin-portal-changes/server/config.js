// Turns environment variables into the config createApp expects. Separate from
// index.js so the shape is one readable thing, and so tests can build an
// equivalent object without touching process.env.

const crypto = require('crypto');

function readProviders(env) {
  const providers = {};
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) {
    providers.google = {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET
    };
  }
  return providers;
}

function readJwtSecret(env, warn) {
  if (env.ADMIN_JWT_SECRET) {
    return env.ADMIN_JWT_SECRET;
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('ADMIN_JWT_SECRET must be set in production');
  }
  warn(
    'ADMIN_JWT_SECRET is not set — using a random per-process secret. ' +
      'Admins will be signed out on every restart. Set it in .env to fix.'
  );
  return crypto.randomBytes(32).toString('base64url');
}

function configFromEnv(env = process.env, warn = console.warn) {
  const providers = readProviders(env);

  if (Object.keys(providers).length === 0) {
    warn(
      'No OAuth provider configured (set GOOGLE_OAUTH_CLIENT_ID and ' +
        'GOOGLE_OAUTH_CLIENT_SECRET) — nobody can sign in to the admin portal.'
    );
  }
  if (!env.ADMIN_BOOTSTRAP_OWNER) {
    warn('ADMIN_BOOTSTRAP_OWNER is not set — if the admins collection is empty, nobody can sign in.');
  }
  if (!env.BOOKSTORE_BOOTSTRAP_OWNER) {
    warn(
      'BOOKSTORE_BOOTSTRAP_OWNER is not set — nobody starts with Bookstore access; ' +
        'a site owner can still grant it from the Administrators tab.'
    );
  }

  return {
    jwtSecret: readJwtSecret(env, warn),
    // A distinct audience from the public site's, so a reader's access token
    // can never be presented here as an admin token.
    issuer: env.ADMIN_AUTH_ISSUER || 'prepfusion-admin',
    audience: env.ADMIN_AUTH_AUDIENCE || 'prepfusion-ingest',
    accessTtlSeconds: Number(env.ADMIN_ACCESS_TTL_SECONDS || 900),
    refreshTtlDays: Number(env.ADMIN_REFRESH_TTL_DAYS || 7),
    oauthStateTtlSeconds: Number(env.ADMIN_OAUTH_STATE_TTL_SECONDS || 300),
    appUrl: env.ADMIN_APP_URL || 'http://localhost:5173',
    // Required in dev: the Vite dev server proxies /api here, so without it the
    // redirect_uri would be derived from the proxied Host and Google would
    // reject it as unregistered.
    apiBaseUrl: env.ADMIN_API_BASE_URL || null,
    secureCookies: env.NODE_ENV === 'production',
    bootstrapOwner: env.ADMIN_BOOTSTRAP_OWNER || null,
    // Separate from bootstrapOwner: this grants Bookstore access, not full
    // site ownership — see adminStore.bootstrapBookOwner for why the two
    // bootstraps are independent.
    bootstrapBookOwner: env.BOOKSTORE_BOOTSTRAP_OWNER || null,
    providers,
    syncCronToken: env.SYNC_CRON_TOKEN || null
  };
}

module.exports = { configFromEnv };
