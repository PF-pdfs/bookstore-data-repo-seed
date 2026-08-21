import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import AppHeader from './components/AppHeader.jsx';
import BookForm from './components/BookForm.jsx';
import BookList from './components/BookList.jsx';
import AnalyticsPanel from './components/AnalyticsPanel.jsx';
import ContributionsPanel from './components/ContributionsPanel.jsx';
import AdminsPanel from './components/AdminsPanel.jsx';
import UserAnalyticsPanel from './components/UserAnalyticsPanel.jsx';
import DbHealthPanel from './components/DbHealthPanel.jsx';
import BroadcastPanel from './components/BroadcastPanel.jsx';
import TeamInboxPanel from './components/TeamInboxPanel.jsx';
import GuidePanel from './components/GuidePanel.jsx';
import WhatsNewPanel from './components/WhatsNewPanel.jsx';
import ResolutionsPanel from './components/ResolutionsPanel.jsx';
import SyncAllButton from './components/SyncAllButton.jsx';
import StudyHubPanel from './components/StudyHubPanel.jsx';
import WebsiteBannerPanel from './components/WebsiteBannerPanel.jsx';
import BookstorePanel from './components/BookstorePanel.jsx';
import { listBooks, registerBook, downloadCsv } from './api.js';
import { useAuth } from './auth.jsx';

// Mirrors AppHeader's own tab labels exactly, so the page-head heading and
// the nav's highlighted tab always say the same thing.
const TAB_TITLES = {
  books: 'Books',
  analytics: 'Book Analytics',
  contributions: 'Reported errors',
  'user-analytics': 'User Analytics',
  inbox: 'Inbox',
  'study-hub': 'Study Hub',
  'website-banner': 'Website Banner',
  bookstore: 'Bookstore',
  'team-inbox': 'Team Inbox',
  resolved: 'Resolved',
  admins: 'Administrators',
  'db-health': 'DB health',
  guide: 'Guide',
  'whats-new': "What's new"
};

export default function App() {
  const { isOwner, isBookOwner, user } = useAuth();
  const assignedCount = (user && user.assignedBooks && user.assignedBooks.length) || 0;
  const [searchParams, setSearchParams] = useSearchParams();

  // Owner-only tabs mirror AppHeader's own gating, so a non-owner landing on
  // ?tab=admins (typed directly, or a stale bookmark from before they lost
  // owner access) falls back to the first tab rather than rendering nothing.
  //
  // 'whats-new' is deliberately NOT in AppHeader's nav list — it has no tab
  // button at all, only a direct ?tab=whats-new link (e.g. a Team Inbox
  // broadcast). It still needs to be here, or that link would fall back to
  // the first tab instead of rendering the page it's pointing at.
  const tabKeys = useMemo(
    () => [
      'books',
      'analytics',
      // Every admin, not owners only: most rows in this queue name no book,
      // so the assignment model the rest of the portal leans on cannot scope
      // it, and site feedback is not per-book editorial work.
      'contributions',
      ...(isOwner ? ['user-analytics', 'inbox', 'study-hub', 'website-banner'] : []),
      // Bookstore access is its own permission, not implied by isOwner — see
      // useAuth's isBookOwner and server/auth/middleware.js's requireBookOwner.
      ...(isBookOwner ? ['bookstore'] : []),
      'team-inbox',
      ...(isOwner ? ['resolved', 'admins', 'db-health'] : []),
      'guide',
      'whats-new'
    ],
    [isOwner, isBookOwner]
  );
  const tab = tabKeys.includes(searchParams.get('tab')) ? searchParams.get('tab') : tabKeys[0];
  const setTab = (next) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [bookSearch, setBookSearch] = useState('');
  const [bookSubject, setBookSubject] = useState('');

  const refresh = async () => {
    try {
      const data = await listBooks();
      setBooks(data);
      setLoadError('');
    } catch (error) {
      setLoadError(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleRegister = async (payload) => {
    setSubmitting(true);
    setSubmitError('');
    try {
      await registerBook(payload);
      await refresh();
      return true;
    } catch (error) {
      setSubmitError(error.message);
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const totalQuestions = books.reduce((sum, b) => sum + (b.questionCount || 0), 0);
  const totalWarnings = books.reduce((sum, b) => sum + (b.warningCount || 0), 0);

  // Subjects come from the books themselves rather than /api/books/subjects —
  // that endpoint lists every subject the parser supports, not just the ones
  // with a book registered, which would leave empty options in the filter.
  const bookSubjects = [...new Set(books.map((b) => b.subject).filter(Boolean))].sort();
  const hasBookFilters = Boolean(bookSearch || bookSubject);
  const filteredBooks = books.filter((b) => {
    if (bookSubject && b.subject !== bookSubject) return false;
    if (bookSearch) {
      const q = bookSearch.toLowerCase();
      const haystack = [b.label, b.bookId, b.domain, b.branch, b.repo?.name].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  return (
    <>
      <AppHeader tab={tab} onTab={setTab} />

      <div className="app">
        <div className="page-head">
          <div>
            <h1>{TAB_TITLES[tab] || 'Knowledge base'}</h1>
            {/* Book-specific copy, so it only makes sense on the tab it was
                written for — every other tab just gets its heading. */}
            {tab === 'books' && (
              <p className="lede">
                Register a GitHub repo of LaTeX question banks, sync it into the shared knowledge base,
                and watch what readers report back.
              </p>
            )}
          </div>

          {/* Only where the counts are actually about what's on screen: Books
              (the table below IS these books) and Book Analytics (every
              report/rating on that tab is scoped to the same catalogue).
              Elsewhere — User Analytics, Team Inbox, Resolved, Admins, DB
              health, Guide — the numbers are true but irrelevant, and were
              taking up header space on every single tab for no reason. */}
          {(tab === 'books' || tab === 'analytics') && (
            <div className="statbox">
              <div>
                <b>{totalQuestions}</b>
                <span>Questions</span>
              </div>
              <div className={totalWarnings > 0 ? 'is-warn' : undefined}>
                <b>{totalWarnings}</b>
                <span>Warnings</span>
              </div>
            </div>
          )}
        </div>

        {tab === 'books' && (
          <>
            {!isOwner && assignedCount > 0 && (
              <p className="muted small">
                You're assigned to {assignedCount} book{assignedCount === 1 ? '' : 's'} — everything on this
                page (and in Book Analytics) is scoped to just those. Ask an owner if you need access to more.
              </p>
            )}

            {/* Every admin can see the catalogue; only an owner can change it.
                The server refuses these routes with 403 regardless — hiding
                the controls just stops offering an action that would fail. */}
            {isOwner && <BookForm onSubmit={handleRegister} submitting={submitting} error={submitError} />}

            <section className="card">
              <div className="section-head">
                <h2>Registered books</h2>
                {isOwner && books.length > 0 && <SyncAllButton onFinished={refresh} />}
                {totalWarnings > 0 && (
                  // Fetched with the bearer token rather than a plain href — the
                  // browser would follow that link unauthenticated and get a 401.
                  <button
                    className="button-link"
                    onClick={() => downloadCsv('/api/books/warnings.csv', 'prepfusion-warnings.csv')}
                  >
                    Download all warnings (CSV)
                  </button>
                )}
              </div>

              {books.length > 0 && (
                <div className="filter-bar">
                  <input
                    type="search"
                    placeholder="Search book, subject, domain or branch…"
                    value={bookSearch}
                    onChange={(e) => setBookSearch(e.target.value)}
                  />
                  <select value={bookSubject} onChange={(e) => setBookSubject(e.target.value)}>
                    <option value="">All subjects</option>
                    {bookSubjects.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  {hasBookFilters && (
                    <button
                      className="link"
                      onClick={() => {
                        setBookSearch('');
                        setBookSubject('');
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}

              {loading && <p className="muted">Loading…</p>}
              {loadError && <p className="error">{loadError}</p>}
              {!loading && !loadError && (
                <>
                  {hasBookFilters && (
                    <p className="muted small">
                      {filteredBooks.length} of {books.length} book{books.length === 1 ? '' : 's'} shown.
                    </p>
                  )}
                  <BookList
                    books={filteredBooks}
                    onChanged={refresh}
                    canWrite={isOwner}
                    assignedBooks={!isOwner ? user.assignedBooks || [] : null}
                    emptyMessage={hasBookFilters ? 'No books match this filter.' : undefined}
                  />
                </>
              )}
            </section>
          </>
        )}

        {tab === 'analytics' && <AnalyticsPanel />}
        {tab === 'contributions' && <ContributionsPanel />}
        {tab === 'user-analytics' && isOwner && <UserAnalyticsPanel />}
        {tab === 'inbox' && isOwner && <BroadcastPanel />}
        {tab === 'study-hub' && isOwner && <StudyHubPanel />}
        {tab === 'website-banner' && isOwner && <WebsiteBannerPanel />}
        {tab === 'bookstore' && isBookOwner && <BookstorePanel />}
        {tab === 'team-inbox' && <TeamInboxPanel isOwner={isOwner} />}
        {tab === 'resolved' && isOwner && <ResolutionsPanel />}
        {tab === 'admins' && isOwner && <AdminsPanel />}
        {tab === 'db-health' && isOwner && <DbHealthPanel />}
        {tab === 'guide' && <GuidePanel />}
        {tab === 'whats-new' && <WhatsNewPanel />}
      </div>
    </>
  );
}
