// Production wiring only: read the environment, seed the first owner if the
// allowlist is empty, and start listening. Everything else lives in app.js so
// the same app can be built in tests with in-memory stores.

const { createApp } = require('./app');
const { configFromEnv } = require('./config');
const adminStore = require('./store/adminStore');
const adminSessionStore = require('./store/adminSessionStore');
const kbStore = require('./store/kbStore');
const backupOrchestrator = require('./backupOrchestrator');
const { listSubjects } = require('./parsing/adapters');
const mongo = require('./store/mongo');

const config = configFromEnv();
const app = createApp({ stores: { admins: adminStore, adminSessions: adminSessionStore }, config });

const port = process.env.PORT || 4001;

// Connect before listening so a bad MONGODB_URI fails loudly at startup
// instead of turning every request into a 500.
mongo
  .ensureIndexes()
  .then(async () => {
    // The code is the source of truth for which subjects exist; this pushes
    // that list into the collection the public site reads, so adding or
    // removing a subject needs no manual database edit.
    const subjects = listSubjects().map(({ key, label }) => ({ key, label }));
    const dropped = await kbStore.writeSubjects(subjects);
    console.log(
      `Subjects synced: ${subjects.map((s) => s.label).join(', ')}` +
        (dropped ? ` (${dropped} removed)` : '')
    );

    // A book whose subject was removed is not deleted — that would be a
    // startup silently destroying content — but it is invisible on the site,
    // so it must not pass unnoticed either.
    const orphans = await kbStore.findOrphanedBooks(subjects.map((s) => s.key));
    for (const book of orphans) {
      console.warn(
        `WARNING: "${book.label || book._id}" is filed under the unknown subject ` +
          `"${book.subject}" — it will not appear on the site. Re-register it, or restore the subject.`
      );
    }

    if (config.bootstrapOwner) {
      const seeded = await adminStore.bootstrapOwner(config.bootstrapOwner, new Date().toISOString());
      if (seeded) {
        console.log(`Seeded the first owner: ${seeded.email}`);
      }
    }
    const owners = await adminStore.countOwners();
    if (owners === 0) {
      console.warn('WARNING: there are no owners — nobody can manage administrator access.');
    }

    if (config.bootstrapBookOwner) {
      const seededBookOwner = await adminStore.bootstrapBookOwner(config.bootstrapBookOwner, new Date().toISOString());
      if (seededBookOwner) {
        console.log(`Seeded the first book owner: ${seededBookOwner.email}`);
      }
    }

    // Every per-book Re-sync now goes through this token. Failing at the first
    // Re-sync with a 403 is a confusing way to learn it was never set, and this
    // is the one moment where saying so costs nothing.
    if (backupOrchestrator.config().usingFallbackToken) {
      console.warn(
        'WARNING: BACKUP_ORCHESTRATOR_GITHUB_TOKEN is not set — falling back to GITHUB_TOKEN, which is ' +
          'scoped to the content repos and will almost certainly be refused "Actions: write" on the ' +
          'backup orchestrator. Re-sync will fail until a token with that permission is set.'
      );
    }

    // Same reasoning as the token warning above: the nightly playlist sync
    // would otherwise fail every course with the same message at 01:45, where
    // nobody is watching.
    if (!process.env.YOUTUBE_API_KEY) {
      console.warn(
        'WARNING: YOUTUBE_API_KEY is not set — Study Hub playlist auto-sync will fail for every course. ' +
          'Needs a Google Cloud API key with YouTube Data API v3 enabled.'
      );
    }

    app.listen(port, () => {
      const providers = Object.keys(config.providers);
      console.log(
        `kb-ingest API listening on http://localhost:${port} ` +
          `(db: ${mongo.databaseName()}, auth: ${providers.length ? providers.join(', ') : 'DISABLED'})`
      );
      if (providers.includes('google')) {
        const base = config.apiBaseUrl || `http://localhost:${port}`;
        console.log(`Authorised redirect URI must be: ${base}/api/auth/google/callback`);
      }
    });
  })
  .catch((error) => {
    console.error('Failed to start:', error.message);
    process.exit(1);
  });
