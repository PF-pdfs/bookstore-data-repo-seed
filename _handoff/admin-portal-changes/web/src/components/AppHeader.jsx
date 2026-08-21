import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useTheme } from '../theme.js';
import Brand from './Brand.jsx';
import { getMyInbox } from '../api.js';

// One bar for everything: where you are, where else you can go, and who you
// are. The tabs used to sit in a strip of their own below a separate account
// row, which gave the page two competing headers above every screen.

function Icon({ path, size = 15 }) {
  return (
    <svg
      className="nav-ic"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

const BOOK_ICON = (
  <>
    <path d="M12 21V7" />
    <path d="M3 5a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3H4a1 1 0 0 1-1-1Z" />
  </>
);

const CHART_ICON = (
  <>
    <path d="M3 3v16a2 2 0 0 0 2 2h16" />
    <path d="M7 15l4-5 4 3 5-7" />
  </>
);

/* A flag, matching the one kb-website's footer now uses for the link that
   files these — the same gesture on both sides of the queue. */
const FLAG_ICON = (
  <>
    <path d="M4 21V4a6 6 0 0 1 8 0 6 6 0 0 0 8 0v9a6 6 0 0 1-8 0 6 6 0 0 0-8 0Z" />
  </>
);

const PEOPLE_ICON = (
  <>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.9" />
    <path d="M16 3.1a4 4 0 0 1 0 7.8" />
  </>
);

const USER_ANALYTICS_ICON = (
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
    <path d="M7 14l2 2 4-4" />
  </>
);

const INBOX_ICON = (
  <>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </>
);

const GUIDE_ICON = (
  <>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
  </>
);

const RESOLVED_ICON = (
  <>
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <path d="m9 11 3 3L22 4" />
  </>
);

const STUDY_HUB_ICON = (
  <>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="M10 9l5 3-5 3Z" />
  </>
);

/* A shopping bag — the shop tab, drawn in the same single-weight outline
   style as every other icon here rather than pulled from an icon library. */
const BOOKSTORE_ICON = (
  <>
    <path d="M4 8h16l-1.2 12.1a1 1 0 0 1-1 .9H6.2a1 1 0 0 1-1-.9Z" />
    <path d="M8.5 11V6.5a3.5 3.5 0 0 1 7 0V11" />
  </>
);

const BANNER_ICON = (
  <>
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <circle cx="8.5" cy="10.5" r="1.5" />
    <path d="m3 16 5-4 4 3 3-2 5 4" />
  </>
);

const DB_HEALTH_ICON = (
  <>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5v14a9 3 0 0 0 18 0V5" />
    <path d="M3 12a9 3 0 0 0 18 0" />
  </>
);

// The account menu is anchored by its right edge, not its left: it sits at the
// end of the bar, so a panel measured from the left would hang off the
// viewport on a narrow window.
function AccountMenu({ user, isOwner, signOut }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) });
    }
    setOpen((prev) => !prev);
  };

  return (
    <div className="acct" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="avatar-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        aria-label="Your account"
        title={user.email}
      >
        {/* Google does not always return a picture, and the avatar is the only
            way to reach Sign out — so it must always render something. */}
        {user.avatarUrl ? (
          <img className="avatar" src={user.avatarUrl} alt="" />
        ) : (
          <span className="avatar avatar-fallback" aria-hidden="true">
            {(user.name || user.email || '?').trim()[0].toUpperCase()}
          </span>
        )}
      </button>

      {open && (
        <div className="acct-panel" role="menu" style={pos ? { top: pos.top, right: pos.right } : undefined}>
          <div className="acct-who">
            <strong>
              {user.name || user.email}{' '}
              <span className={`status-badge status-${isOwner ? 'reviewing' : 'open'}`}>{user.role}</span>
            </strong>
            <span>{user.email}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            className="acct-item"
            onClick={() => {
              setOpen(false);
              signOut();
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="m16 17 5-5-5-5" />
              <path d="M21 12H9" />
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default function AppHeader({ tab, onTab }) {
  const { user, isOwner, isBookOwner, signOut } = useAuth();
  const { toggle } = useTheme();

  // Polled rather than pushed — this is an internal admin tool with a
  // handful of users, so a 60s interval (matches kb-website's own
  // NotificationBell) is plenty responsive without needing websockets.
  const [teamInboxUnread, setTeamInboxUnread] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      getMyInbox()
        .then((r) => {
          if (!cancelled) setTeamInboxUnread(r.unreadCount);
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Owner-only tabs are hidden here for convenience — the server refuses the
  // underlying routes regardless. Team Inbox is the one exception: every
  // admin can read it, only the owner can compose in it (gated inside the
  // panel itself, same split as the server routes).
  const tabs = [
    { key: 'books', label: 'Books', icon: BOOK_ICON },
    { key: 'analytics', label: 'Book Analytics', icon: CHART_ICON },
    { key: 'contributions', label: 'Reported errors', icon: FLAG_ICON },
    ...(isOwner ? [{ key: 'user-analytics', label: 'User Analytics', icon: USER_ANALYTICS_ICON }] : []),
    ...(isOwner ? [{ key: 'inbox', label: 'Inbox', icon: INBOX_ICON }] : []),
    ...(isOwner ? [{ key: 'study-hub', label: 'Study Hub', icon: STUDY_HUB_ICON }] : []),
    ...(isOwner ? [{ key: 'website-banner', label: 'Website Banner', icon: BANNER_ICON }] : []),
    // Bookstore access is its own permission, not implied by isOwner.
    ...(isBookOwner ? [{ key: 'bookstore', label: 'Bookstore', icon: BOOKSTORE_ICON }] : []),
    { key: 'team-inbox', label: 'Team Inbox', icon: INBOX_ICON, badge: teamInboxUnread },
    ...(isOwner ? [{ key: 'resolved', label: 'Resolved', icon: RESOLVED_ICON }] : []),
    ...(isOwner ? [{ key: 'admins', label: 'Administrators', icon: PEOPLE_ICON }] : []),
    ...(isOwner ? [{ key: 'db-health', label: 'DB health', icon: DB_HEALTH_ICON }] : []),
    { key: 'guide', label: 'Guide', icon: GUIDE_ICON }
  ];

  return (
    <header className="bar">
      <div className="bar-in">
        <Brand large />

        <nav className="nav" aria-label="Sections">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              className={tab === t.key ? 'nav-current' : undefined}
              aria-current={tab === t.key ? 'page' : undefined}
              onClick={() => onTab(t.key)}
            >
              <Icon path={t.icon} />
              {t.label}
              {t.badge > 0 && <span className="subtab-count">{t.badge}</span>}
            </button>
          ))}
        </nav>

        <div className="bar-actions">
          <button className="tt" type="button" onClick={toggle} aria-label="Toggle dark mode" title="Toggle dark mode">
            <svg
              className="i-moon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
            </svg>
            <svg
              className="i-sun"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          </button>
          {user && <AccountMenu user={user} isOwner={isOwner} signOut={signOut} />}
        </div>
      </div>
    </header>
  );
}
