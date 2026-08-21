// Builds the Express app from injected dependencies, so tests can boot the
// real app with in-memory stores and a fake OAuth provider. index.js is now
// only the production wiring.
//
// The shape of this file IS the access-control policy: everything under /api
// except /api/auth requires an admin, and /api/admins requires an owner.

const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');

const booksRouter = require('./routes/books');
const reportsRouter = require('./routes/reports');
const contributionsRouter = require('./routes/contributions');
const assetsRouter = require('./routes/assets');
const { createAuthRouter } = require('./routes/auth');
const { createAdminsRouter } = require('./routes/admins');
const { createUserAnalyticsRouter } = require('./routes/userAnalytics');
const { createBroadcastsRouter } = require('./routes/broadcasts');
const { createWebsiteBannersRouter } = require('./routes/websiteBanners');
const { createBookstoreRouter } = require('./routes/bookstore');
const { createAdminInboxRouter } = require('./routes/adminInbox');
const { createCoursesRouter, triggerSyncAll: triggerCourseSyncAll } = require('./routes/courses');
const { createTokenService } = require('./auth/tokens');
const { createRefreshService } = require('./auth/refreshTokens');
const { createRequireAdmin, requireOwner, requireBookOwner } = require('./auth/middleware');
const { resolveProviders } = require('./auth/providers');
const { requireCronToken } = require('./auth/cronToken');
const mongo = require('./store/mongo');

function createApp({ stores, config: rawConfig, now = Date.now }) {
  const app = express();

  const config = { ...rawConfig, providers: resolveProviders(rawConfig.providers) };

  app.use(express.json());
  app.use(cookieParser());
  // Video-link CSVs are posted back as raw text; a whole book's worth of rows
  // comfortably exceeds the default body limit.
  app.use(express.text({ type: 'text/csv', limit: '10mb' }));
  // Banner images are posted as raw bytes (not base64-in-JSON) — cheaper on
  // the wire and above express.json()'s 100kb default, which a photo-sized
  // upload would blow through.
  app.use(express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '8mb' }));

  const tokens = createTokenService({
    jwtSecret: config.jwtSecret,
    issuer: config.issuer,
    audience: config.audience,
    accessTtlSeconds: config.accessTtlSeconds,
    oauthStateTtlSeconds: config.oauthStateTtlSeconds,
    now
  });

  const refreshService = createRefreshService({
    store: stores.adminSessions,
    tokens,
    refreshTtlDays: config.refreshTtlDays,
    now
  });

  const requireAdmin = createRequireAdmin(tokens);

  // Unauthenticated on purpose: it reports only liveness, and a monitor must
  // be able to reach it.
  app.get('/health', async (req, res) => {
    let db = false;
    try {
      db = await mongo.ping();
    } catch (error) {
      db = false;
    }
    res.json({
      ok: db,
      hasToken: Boolean(process.env.GITHUB_TOKEN),
      // Reused, not a dedicated var — see server/routes/bookstore.js.
      hasBookstoreToken: Boolean(process.env.LANDING_SITE_GITHUB_TOKEN || process.env.GITHUB_TOKEN),
      db: db ? 'up' : 'down',
      database: mongo.databaseName()
    });
  });

  app.use('/api/auth', createAuthRouter({ stores, config, tokens, refreshService, requireAdmin, now }));

  // Cron-only, token-authenticated, deliberately outside the requireAdmin
  // gate below: a scheduled GitHub Action has no admin session to present.
  // Mirrors the response shape of POST /api/books/sync-all.
  app.post('/api/cron/books/sync-all', requireCronToken(config.syncCronToken), async (req, res) => {
    try {
      const { started, status } = await booksRouter.triggerSyncAll('cron');
      if (!started) {
        res.status(409).json({ error: 'A sync is already running.', code: 'sync_in_progress', ...status });
        return;
      }
      res.status(202).json(status);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

  // Same cron-token gate as the book sync above, and deliberately the same
  // token: both endpoints can only start a sync, so one secret guarding two
  // equally low-privilege triggers is not a widening of what a leak would buy.
  app.post('/api/cron/courses/sync-all', requireCronToken(config.syncCronToken), async (req, res) => {
    try {
      const { started, status } = await triggerCourseSyncAll('cron');
      if (!started) {
        res.status(409).json({ error: 'A course sync is already running.', code: 'sync_in_progress', ...status });
        return;
      }
      res.status(202).json(status);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

  // Registered before the requireAdmin gate below on purpose: an <img src>
  // request can't carry the Authorization header authFetch attaches to
  // every other call, and this is the same content the public site already
  // serves without auth (see kb-website's server/routes/assets.js), so
  // there's nothing to protect by gating it here.
  app.use('/api/assets', assetsRouter);

  // Everything below is admin-only. requireAdmin is mounted as its own layer
  // rather than per-route so a future route cannot be added unprotected by
  // forgetting to wrap it.
  app.use('/api', requireAdmin);
  app.use('/api/admins', createAdminsRouter({ stores, requireOwner, refreshService, now }));
  app.use('/api/user-analytics', createUserAnalyticsRouter({ requireOwner }));
  app.use('/api/broadcasts', createBroadcastsRouter({ requireOwner, now }));
  app.use('/api/website-banners', createWebsiteBannersRouter({ requireOwner }));
  app.use('/api/bookstore', createBookstoreRouter({ requireBookOwner, stores }));
  app.use('/api/admin-inbox', createAdminInboxRouter({ requireOwner, now }));
  app.use('/api/courses', createCoursesRouter({ requireOwner }));
  app.use('/api/books', booksRouter);
  app.use('/api/reports', reportsRouter);
  // Every admin, not just owners, and deliberately not book-scoped — see the
  // router's own header for why.
  app.use('/api/contributions', contributionsRouter);

  // Serve the built admin UI in production; in dev, run `npm run dev` inside web/ separately.
  const webDist = path.join(__dirname, '..', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get('*', (req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).json({ error: error.message });
  });

  return app;
}

module.exports = { createApp };
