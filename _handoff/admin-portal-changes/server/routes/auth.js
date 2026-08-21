const express = require('express');
const { createVerifier, challengeFor, createState } = require('../auth/pkce');
const { decodeIdToken, validateIdTokenClaims } = require('../auth/providers');
const { AuthError } = require('../auth/errors');

// Distinct cookie names from kb-website's. Cookies ignore port numbers, so on
// localhost the two apps share a cookie jar — reusing the names would have the
// admin session and the public session overwrite each other.
const OAUTH_COOKIE = 'pf_admin_oauth';
const REFRESH_COOKIE = 'pf_admin_refresh';
const COOKIE_PATH = '/api/auth';

function createAuthRouter({ stores, config, tokens, refreshService, requireAdmin, now = Date.now }) {
  const router = express.Router();
  const providers = config.providers;

  function cookieOptions(maxAgeMs) {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: Boolean(config.secureCookies),
      path: COOKIE_PATH,
      maxAge: maxAgeMs
    };
  }

  function callbackUrl(req, providerId) {
    const base = config.apiBaseUrl || `${req.protocol}://${req.get('host')}`;
    return `${base}/api/auth/${providerId}/callback`;
  }

  function appRedirect(params) {
    const url = new URL(config.appUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  function publicAdmin(admin) {
    return {
      email: admin.email,
      name: admin.name || null,
      avatarUrl: admin.avatarUrl || null,
      role: admin.role,
      isOwner: admin.role === 'owner',
      isBookOwner: Boolean(admin.bookOwner),
      assignedBooks: admin.assignedBooks || []
    };
  }

  // The access token identifies an admin by email — that is the key the
  // allowlist uses, and the only identity that matters here.
  function accessTokenFor(admin) {
    return tokens.signAccessToken({
      id: admin.email,
      email: admin.email,
      name: admin.name || admin.email,
      roles: [admin.role],
      assignedBooks: admin.assignedBooks || [],
      bookOwner: admin.bookOwner
    });
  }

  router.get('/:provider/start', (req, res) => {
    const provider = providers[req.params.provider];
    if (!provider) {
      res.status(404).json({ error: `Unknown provider: ${req.params.provider}` });
      return;
    }

    const verifier = createVerifier();
    const state = createState();

    res.cookie(
      OAUTH_COOKIE,
      tokens.signStateToken({ state, verifier, provider: provider.id }),
      cookieOptions(config.oauthStateTtlSeconds * 1000)
    );

    const url = new URL(provider.authorizeUrl);
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', callbackUrl(req, provider.id));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', provider.scope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challengeFor(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'select_account');

    res.redirect(302, url.toString());
  });

  router.get('/:provider/callback', async (req, res) => {
    const provider = providers[req.params.provider];
    if (!provider) {
      res.status(404).json({ error: `Unknown provider: ${req.params.provider}` });
      return;
    }

    if (req.query.error) {
      res.clearCookie(OAUTH_COOKIE, { path: COOKIE_PATH });
      res.redirect(302, appRedirect({ auth_error: String(req.query.error) }));
      return;
    }

    const stateCookie = req.cookies ? req.cookies[OAUTH_COOKIE] : null;
    if (!stateCookie) {
      res.status(400).json({ error: 'Missing OAuth state cookie; the login may have expired' });
      return;
    }

    let transaction;
    try {
      transaction = tokens.verifyStateToken(stateCookie);
    } catch (error) {
      res.status(400).json({ error: 'OAuth state is invalid or expired' });
      return;
    }

    if (!req.query.state || req.query.state !== transaction.state) {
      res.status(400).json({ error: 'OAuth state mismatch' });
      return;
    }
    if (transaction.provider !== provider.id) {
      res.status(400).json({ error: 'OAuth state was issued for a different provider' });
      return;
    }

    res.clearCookie(OAUTH_COOKIE, { path: COOKIE_PATH });

    if (!req.query.code) {
      res.status(400).json({ error: 'No authorization code returned' });
      return;
    }

    let tokenResponse;
    try {
      tokenResponse = await exchangeCode({
        provider,
        code: String(req.query.code),
        verifier: transaction.verifier,
        redirectUri: callbackUrl(req, provider.id)
      });
    } catch (error) {
      res.status(error.code === 'provider_rejected' ? 401 : 502).json({
        error: error.message,
        code: error.code
      });
      return;
    }

    let profile;
    try {
      const claims = decodeIdToken(tokenResponse.id_token);
      validateIdTokenClaims(claims, provider, now());
      profile = provider.profileFromClaims(claims);
    } catch (error) {
      const authError = error instanceof AuthError ? error : new AuthError('invalid_id_token', 'Bad id_token');
      res.status(401).json({ error: authError.message, code: authError.code });
      return;
    }

    if (!profile.emailVerified) {
      res.status(403).json({
        error: 'Your provider account has no verified email address',
        code: 'email_unverified'
      });
      return;
    }

    // The authorisation decision. Authenticating with Google proves who you
    // are; it grants nothing here. Only the allowlist does.
    const admin = await stores.admins.findByEmail(profile.email);
    if (!admin) {
      res.redirect(302, appRedirect({ auth_error: 'not_authorised', email: profile.email }));
      return;
    }

    const timestamp = new Date(now()).toISOString();
    await stores.admins.recordLogin(admin.email, {
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      at: timestamp
    });

    const { token } = await refreshService.issue(admin.email);
    res.cookie(REFRESH_COOKIE, token, cookieOptions(config.refreshTtlDays * 24 * 60 * 60 * 1000));
    res.redirect(302, appRedirect({ signed_in: '1' }));
  });

  router.post('/refresh', async (req, res) => {
    const token = req.cookies ? req.cookies[REFRESH_COOKIE] : null;
    if (!token) {
      res.status(401).json({ error: 'No session', code: 'unauthenticated' });
      return;
    }

    let rotated;
    try {
      rotated = await refreshService.rotate(token);
    } catch (error) {
      const code = error instanceof AuthError ? error.code : 'invalid_token';
      res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      res.status(401).json({ error: 'Session is no longer valid', code });
      return;
    }

    // Re-checked on every refresh, so revoking someone's access takes effect
    // within one access-token lifetime rather than waiting for their refresh
    // token to expire weeks later.
    const admin = await stores.admins.findByEmail(rotated.record.userId);
    if (!admin) {
      await refreshService.revokeFamily(rotated.record.familyId);
      res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      res.status(403).json({ error: 'Your administrator access has been removed', code: 'not_admin' });
      return;
    }

    res.cookie(REFRESH_COOKIE, rotated.token, cookieOptions(config.refreshTtlDays * 24 * 60 * 60 * 1000));
    res.json({
      accessToken: accessTokenFor(admin),
      expiresIn: config.accessTtlSeconds,
      user: publicAdmin(admin)
    });
  });

  router.post('/logout', async (req, res) => {
    const token = req.cookies ? req.cookies[REFRESH_COOKIE] : null;
    await refreshService.revoke(token);
    res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
    res.status(204).end();
  });

  router.get('/me', requireAdmin, async (req, res) => {
    const admin = await stores.admins.findByEmail(req.user.email);
    if (!admin) {
      res.status(403).json({ error: 'Your administrator access has been removed', code: 'not_admin' });
      return;
    }
    res.json(publicAdmin(admin));
  });

  return router;
}

async function exchangeCode({ provider, code, verifier, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    redirect_uri: redirectUri,
    code_verifier: verifier
  });

  let response;
  try {
    response = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body
    });
  } catch (error) {
    throw new AuthError('provider_unreachable', `Could not reach ${provider.id}: ${error.message}`, 502);
  }

  if (response.status >= 500) {
    throw new AuthError('provider_unavailable', `${provider.id} token endpoint failed`, 502);
  }
  if (!response.ok) {
    throw new AuthError('provider_rejected', 'Authorization code was rejected', 401);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new AuthError('provider_unavailable', 'Token endpoint returned unreadable JSON', 502);
  }
}

module.exports = { createAuthRouter, OAUTH_COOKIE, REFRESH_COOKIE, COOKIE_PATH };
