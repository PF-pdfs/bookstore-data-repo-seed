const BASE = '/api/books';

// Every call now needs the admin bearer token. Rather than thread authFetch
// through every component, the AuthProvider registers it here once — it also
// handles refreshing an expired token and retrying.
let authFetch = (path, options) => fetch(path, options);

export function setAuthFetch(fn) {
  authFetch = fn;
}

async function handle(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  return authFetch(path, { ...options, headers });
}

function queryString(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, value);
    }
  });
  return query.toString() ? `?${query}` : '';
}

// --- Books -----------------------------------------------------------------

export function listBooks() {
  return request(BASE).then(handle);
}

export function getBook(bookId) {
  return request(`${BASE}/${bookId}`).then(handle);
}

// Live-fetched from GitHub, not stored — see the route's own comment for why.
export function getBookSource(bookId, { fileId, kind }) {
  return request(`${BASE}/${bookId}/source${queryString({ fileId, kind })}`).then(handle);
}

// The parsed question + matched solution, rendered like kb-website does —
// see the route's own comment for why this takes {fileId, year, questionNum}
// rather than the ordinal kb-website's equivalent endpoint uses.
export function getBookQuestion(bookId, { fileId, year, questionNum }) {
  return request(`${BASE}/${bookId}/question${queryString({ fileId, year, questionNum })}`).then(handle);
}

// The subjects the parser actually supports, so the form cannot offer one the
// server would reject.
export function listSubjects() {
  return request(`${BASE}/subjects`).then(handle);
}

export function registerBook(payload) {
  return request(BASE, { method: 'POST', body: JSON.stringify(payload) }).then(handle);
}

// Starts a run and returns immediately, like syncAllBooks below: a per-book
// re-sync now pulls the book's current Overleaf content into GitHub first, and
// waiting on that CI run is far longer than a request can be held open.
export function syncBook(bookId) {
  return request(`${BASE}/${bookId}/sync`, { method: 'POST' }).then(handle);
}

export function getBookSyncStatus(bookId) {
  return request(`${BASE}/${bookId}/sync`).then(handle);
}

// Starts a run and returns immediately — syncing a whole catalogue takes far
// longer than a request can be held open, so progress is polled instead.
export function syncAllBooks() {
  return request(`${BASE}/sync-all`, { method: 'POST' }).then(handle);
}

export function getSyncAllStatus() {
  return request(`${BASE}/sync-all`).then(handle);
}

export function downloadFixesXlsx(bookId, type, filename) {
  return downloadCsv(`${BASE}/${bookId}/fixes.xlsx?type=${type}`, filename);
}

export function setOverleafLinks(bookId, { overleafQuestionUrl, overleafSolutionUrl }) {
  return request(`${BASE}/${bookId}/overleaf-links`, {
    method: 'PATCH',
    body: JSON.stringify({ overleafQuestionUrl, overleafSolutionUrl })
  }).then(handle);
}

export function setBookKind(bookId, bookKind) {
  return request(`${BASE}/${bookId}/book-kind`, {
    method: 'PATCH',
    body: JSON.stringify({ bookKind })
  }).then(handle);
}

// Live-fetched from the Image-Pipeline repo, not stored — same reasoning as
// getBookSource above. Owner-only for a parent/main book; the server enforces
// that, this just surfaces whatever it returns (200 with the text, or 403).
// kind: 'questions' (default) or 'solutions' -- the two are separate
// Overleaf/GitHub projects with their own generated main.tex each.
export function getMainTex(bookId, kind = 'questions') {
  return request(`${BASE}/${bookId}/main-tex${queryString({ kind })}`).then(handle);
}

export function deleteBook(bookId) {
  return request(`${BASE}/${bookId}`, { method: 'DELETE' }).then((res) => {
    if (!res.ok && res.status !== 204) {
      throw new Error(`Delete failed (${res.status})`);
    }
  });
}

// CSV upload posts raw text, so it sets its own content type.
export function uploadVideosCsv(bookId, text) {
  return request(`${BASE}/${bookId}/videos.csv`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    body: text
  }).then(handle);
}

// A download has to carry the token too, so it is fetched and turned into a
// blob rather than being a plain <a href> the browser fetches unauthenticated.
export async function downloadCsv(path, filename) {
  const res = await request(path);
  if (!res.ok) {
    // The server sends a real reason for the common cases — e.g. "No
    // 'image' warnings for this book — nothing to generate" — which used to
    // be discarded here and replaced with a bare status code. Every caller
    // now has an actual message worth showing instead of failing silently.
    const data = await res.clone().json().catch(() => ({}));
    throw new Error(data.error || `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- Website banners ---------------------------------------------------------

const BANNERS_BASE = '/api/website-banners';

export function getWebsiteBanners() {
  return request(BANNERS_BASE).then(handle);
}

export function saveWebsiteBanners(banners) {
  return request(BANNERS_BASE, { method: 'PUT', body: JSON.stringify({ banners }) }).then(handle);
}

// Raw image bytes with their own content type, same reasoning as
// uploadVideosCsv above — cheaper than base64-in-JSON and matches what the
// server's express.raw() middleware expects.
export function uploadBannerImage(file) {
  return request(`${BANNERS_BASE}/image?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file
  }).then(handle);
}

// --- Bookstore products (owner only) ----------------------------------------
//
// Two copies of the catalog live in PF-pdfs/bookstore-data-repo-seed:
// a draft this panel edits, and the live file the checkout Worker reads.
// `sha` round-trips through every call so a second admin editing at the same
// time gets a conflict instead of silently overwriting. A catalog is
// `sections` (the shop's shelves, in order) plus a flat `products` array whose
// entries name their section. Price is rupees, weight is kilograms — see
// server/routes/bookstore.js.

const BOOKSTORE_BASE = '/api/bookstore';

export function getStagingProducts() {
  return request(`${BOOKSTORE_BASE}/staging`).then(handle);
}

export function getLiveProducts() {
  return request(`${BOOKSTORE_BASE}/live`).then(handle);
}

export function saveStagingProducts(products, sections, sha) {
  return request(`${BOOKSTORE_BASE}/staging`, {
    method: 'PUT',
    body: JSON.stringify({ products, sections, sha })
  }).then(handle);
}

export function publishBookstoreCatalog(stagingSha, liveSha) {
  return request(`${BOOKSTORE_BASE}/publish`, {
    method: 'POST',
    body: JSON.stringify({ stagingSha, liveSha })
  }).then(handle);
}

// Raw image bytes with their own content type, same as uploadBannerImage
// above — cheaper than base64-in-JSON and matches the server's express.raw().
export function uploadProductImage(file) {
  return request(`${BOOKSTORE_BASE}/image?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file
  }).then(handle);
}

// Book owners managing each other — only existing admin accounts can be
// granted this (see the route's own comment for why).
export function getBookOwners() {
  return request(`${BOOKSTORE_BASE}/owners`).then(handle);
}

export function setBookOwner(email, bookOwner) {
  return request(`${BOOKSTORE_BASE}/owners/${encodeURIComponent(email)}`, {
    method: 'PATCH',
    body: JSON.stringify({ bookOwner })
  }).then(handle);
}

// --- Analytics -------------------------------------------------------------

export function listReportedQuestions(params = {}) {
  return request(`/api/reports/questions${queryString(params)}`).then(handle);
}

export function listRatedQuestions(params = {}) {
  return request(`/api/reports/ratings${queryString(params)}`).then(handle);
}

export function getReportSummary() {
  return request('/api/reports/summary').then(handle);
}

export function downloadDifficultyMismatches() {
  return downloadCsv('/api/reports/difficulty-mismatches.xlsx', 'prepfusion-difficulty-mismatches.xlsx');
}

// --- Contributions — the site's footer "Report an error" queue --------------
// Free-form reports about the site or a book PDF, scoped to any depth of the
// library or to nothing at all. Every admin sees the whole queue: most rows
// name no book, so the per-book assignment the rest of the portal uses would
// hide exactly the ones that most need looking at.

export function listContributions(params = {}) {
  return request(`/api/contributions${queryString(params)}`).then(handle);
}

export function getContribution(id) {
  return request(`/api/contributions/${encodeURIComponent(id)}`).then(handle);
}

// Marks rather than deletes, unlike resolving a per-question report. Only a
// change to resolved/dismissed notifies the reporter.
export function setContributionStatus(id, { status, adminMessage }) {
  return request(`/api/contributions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, adminMessage })
  }).then(handle);
}

// --- Resolutions (owner only) — who resolved what, and when -----------------

export function listResolutions() {
  return request('/api/reports/resolutions').then(handle);
}

// --- User Analytics (owner only) --------------------------------------------

export function getUserAnalyticsOverview({ days } = {}) {
  return request(`/api/user-analytics/overview${queryString({ days })}`).then(handle);
}

export function listAnalyticsUsers({ search, page, pageSize } = {}) {
  return request(`/api/user-analytics/users${queryString({ search, page, pageSize })}`).then(handle);
}

export function getAnalyticsUserDetail(userId) {
  return request(`/api/user-analytics/users/${encodeURIComponent(userId)}`).then(handle);
}

export function getStudentTrackProgress() {
  return request('/api/user-analytics/progress').then(handle);
}

export function getHighFreeZeroPremiumSignal({ minFreeLectures } = {}) {
  return request(`/api/user-analytics/signals/high-free-zero-premium${queryString({ minFreeLectures })}`).then(handle);
}

export function getPremiumEngagementSignal() {
  return request('/api/user-analytics/signals/premium-engagement').then(handle);
}

// --- DB health (owner only) --------------------------------------------

export function getDbHealthStats() {
  return request('/api/user-analytics/db-stats').then(handle);
}

export function getQuestionReports(params) {
  return request(`/api/reports/question${queryString(params)}`).then(handle);
}

// adminMessage travels in the body, not the query string — everything else in
// params is the resource key (type/bookId/fileId/year/questionNum).
export function resolveQuestionReports({ adminMessage, ...params }) {
  return request(`/api/reports/question${queryString(params)}`, {
    method: 'DELETE',
    body: JSON.stringify({ adminMessage: adminMessage || '' })
  }).then(handle);
}

// --- Study Hub (owner only) --------------------------------------------------

export function listCourses() {
  return request('/api/courses').then(handle);
}

export function getCourse(courseKey) {
  return request(`/api/courses/${encodeURIComponent(courseKey)}`).then(handle);
}

export function updateCourse(courseKey, fields) {
  return request(`/api/courses/${encodeURIComponent(courseKey)}`, {
    method: 'PATCH',
    body: JSON.stringify(fields)
  }).then(handle);
}

export function moveLecture(courseKey, { lectureId, fromChapter, toChapter }) {
  return request(`/api/courses/${encodeURIComponent(courseKey)}/move-lecture`, {
    method: 'POST',
    body: JSON.stringify({ lectureId, fromChapter, toChapter })
  }).then(handle);
}

// Refused server-side unless the chapter is already empty.
export function removeEmptyChapter(courseKey, chapterName) {
  return request(
    `/api/courses/${encodeURIComponent(courseKey)}/chapters/${encodeURIComponent(chapterName)}`,
    { method: 'DELETE' }
  ).then(handle);
}

// dryRun returns the same diff without writing it — the "see what would
// happen before turning auto-sync on" path.
export function syncCourseNow(courseKey, { dryRun = false } = {}) {
  return request(
    `/api/courses/${encodeURIComponent(courseKey)}/sync${dryRun ? '?dryRun=1' : ''}`,
    { method: 'POST' }
  ).then(handle);
}

export function syncAllCourses() {
  return request('/api/courses/sync-all', { method: 'POST' }).then(handle);
}

export function getCourseSyncAllStatus() {
  return request('/api/courses/sync-all').then(handle);
}

// --- Administrators (owner only) -------------------------------------------

export function listAdmins() {
  return request('/api/admins').then(handle);
}

export function grantAdmin({ email, role }) {
  return request('/api/admins', { method: 'POST', body: JSON.stringify({ email, role }) }).then(handle);
}

export function setAdminRole(email, role) {
  return request(`/api/admins/${encodeURIComponent(email)}`, {
    method: 'PATCH',
    body: JSON.stringify({ role })
  }).then(handle);
}

export function removeAdmin(email) {
  return request(`/api/admins/${encodeURIComponent(email)}`, { method: 'DELETE' }).then(handle);
}

export function setAdminBooks(email, bookIds) {
  return request(`/api/admins/${encodeURIComponent(email)}/books`, {
    method: 'PATCH',
    body: JSON.stringify({ bookIds })
  }).then(handle);
}

// Owner-only escape hatch for granting/revoking Bookstore access — the
// self-service version book owners use on each other lives below, scoped
// under /api/bookstore instead.
export function setAdminBookOwner(email, bookOwner) {
  return request(`/api/admins/${encodeURIComponent(email)}/book-owner`, {
    method: 'PATCH',
    body: JSON.stringify({ bookOwner })
  }).then(handle);
}

// --- Inbox / Broadcasts (owner only) ----------------------------------------

export function listBroadcasts() {
  return request('/api/broadcasts').then(handle);
}

export function getAudienceFacets() {
  return request('/api/broadcasts/audience-facets').then(handle);
}

export function previewAudienceCount(audience) {
  return request('/api/broadcasts/audience-count', {
    method: 'POST',
    body: JSON.stringify(audience || {})
  }).then(handle);
}

export function sendBroadcast({ title, body, url, audience }) {
  return request('/api/broadcasts', {
    method: 'POST',
    body: JSON.stringify({ title, body, url, audience })
  }).then(handle);
}

export function revokeBroadcast(broadcastId) {
  return request(`/api/broadcasts/${encodeURIComponent(broadcastId)}`, { method: 'DELETE' }).then(handle);
}

// --- Team Inbox (owner -> admins) -------------------------------------------

export function listAdminInboxMessages() {
  return request('/api/admin-inbox').then(handle);
}

export function sendAdminInboxMessage({ title, body, url, recipientEmails }) {
  return request('/api/admin-inbox', {
    method: 'POST',
    body: JSON.stringify({ title, body, url, recipientEmails })
  }).then(handle);
}

export function revokeAdminInboxMessage(adminBroadcastId) {
  return request(`/api/admin-inbox/${encodeURIComponent(adminBroadcastId)}`, { method: 'DELETE' }).then(handle);
}

export function getMyInbox() {
  return request('/api/admin-inbox/mine').then(handle);
}

export function markMyInboxRead() {
  return request('/api/admin-inbox/mine/read', { method: 'POST' }).then(handle);
}

export function markMyInboxItemRead(id) {
  return request(`/api/admin-inbox/mine/${encodeURIComponent(id)}/read`, { method: 'POST' }).then(handle);
}

// Deletes the notification outright — once dismissed it's gone, not just
// marked read, so it stops taking up space in the collection.
export function dismissMyInboxItem(id) {
  return request(`/api/admin-inbox/mine/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((res) => {
    if (!res.ok && res.status !== 204) {
      throw new Error(`Dismiss failed (${res.status})`);
    }
  });
}
