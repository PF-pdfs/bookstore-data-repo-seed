import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { listAdmins, grantAdmin, setAdminRole, removeAdmin, listBooks, setAdminBooks, setAdminBookOwner } from '../api.js';
import { formatDateIST as formatDate } from '../dateFormat.js';
import ConfirmDialog from './ConfirmDialog.jsx';

// Narrows which books an admin sees at all — Books tab, and every
// report/rating/warning tied to a book — so a large team doesn't have to
// wade through issues that aren't theirs. Empty selection = unrestricted,
// the default for every admin.
function BookAssignment({ admin, books, onSaved }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState(() => new Set(admin.assignedBooks || []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSelected(new Set(admin.assignedBooks || []));
    setExpanded(false);
  }, [admin.assignedBooks]);

  const toggle = (bookId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await setAdminBooks(admin.email, [...selected]);
      await onSaved();
      setOpen(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const assignedIds = admin.assignedBooks || [];
  const count = assignedIds.length;
  // Short labels: strip the redundant "PrepFusion" prefix most books share,
  // so two-line real estate isn't spent repeating it, and short en-dash
  // subject codes stay readable at a glance.
  const shortLabel = (label) => label.replace(/^PrepFusion\s+/, '');
  const assignedLabels = assignedIds.map((id) => {
    const book = books.find((b) => b.bookId === id);
    return book ? shortLabel(book.label) : id;
  });
  const SHOWN = 2;
  const collapsedSummary =
    count === 0
      ? 'All books'
      : assignedLabels.slice(0, SHOWN).join(', ') + (count > SHOWN ? ` +${count - SHOWN}` : '');
  const canExpand = count > SHOWN;

  return (
    <div className="book-assign">
      {expanded && count > 0 ? (
        <ul className="book-assign-full">
          {assignedLabels.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      ) : (
        <span className="book-assign-summary" title={count > 0 ? assignedLabels.join(', ') : undefined}>
          {collapsedSummary}
        </span>
      )}
      <div className="book-assign-row">
        {canExpand && (
          <button type="button" className="book-assign-toggle" onClick={() => setExpanded((e) => !e)}>
            {expanded ? '▲ show less' : '▼ show all'}
          </button>
        )}
        <button type="button" className="book-assign-edit" onClick={() => setOpen((o) => !o)}>
          Edit
        </button>
      </div>
      {open && (
        <div className="book-assign-picker">
          <p className="muted small">
            Leave everything unchecked to see all books (default). Check specific books to limit this admin
            to only those — they won't see any book, report, warning, or rating outside this list.
          </p>
          <div className="book-assign-list">
            {books.map((b) => (
              <label key={b.bookId} className="book-assign-item">
                <input type="checkbox" checked={selected.has(b.bookId)} onChange={() => toggle(b.bookId)} />
                {b.label}
              </label>
            ))}
          </div>
          {error && <p className="error">{error}</p>}
          <div className="book-assign-actions">
            <button type="button" className="ghost" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </button>
            <button type="button" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Owner-only. The server enforces every rule here independently — this UI just
// avoids offering actions that would be refused.
export default function AdminsPanel() {
  const { authFetch, user } = useAuth();
  const [data, setData] = useState(null);
  const [books, setBooks] = useState([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('admin');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Holds the pending action while its confirm dialog is open:
  // { kind: 'role', admin, nextRole } | { kind: 'remove', admin } | { kind: 'grant', email, role }.
  const [pending, setPending] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setData(await listAdmins());
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [authFetch]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    listBooks()
      .then((all) => setBooks([...all].sort((a, b) => a.label.localeCompare(b.label))))
      .catch(() => {});
  }, []);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const requestAdd = (event) => {
    event.preventDefault();
    if (!email.trim()) return;
    setPending({ kind: 'grant', email: email.trim(), role });
  };

  const admins = (data && data.admins) || [];
  const ownerCount = (data && data.ownerCount) || 0;
  const bookOwnerCount = (data && data.bookOwnerCount) || 0;

  // Bookstore access is a flag, not a role — toggled straight away rather
  // than through the confirm dialog the role change uses, since it never
  // ends anyone's session and is trivial to reverse. It's still gated
  // server-side against removing the last book owner.
  const toggleBookOwner = (admin) => run(() => setAdminBookOwner(admin.email, !admin.bookOwner));

  const confirmPending = async () => {
    if (!pending) return;
    if (pending.kind === 'role') {
      await run(() => setAdminRole(pending.admin.email, pending.nextRole));
    } else if (pending.kind === 'remove') {
      await run(() => removeAdmin(pending.admin.email));
    } else if (pending.kind === 'grant') {
      await run(async () => {
        await grantAdmin({ email: pending.email, role: pending.role });
        setEmail('');
        setRole('admin');
      });
    }
    setPending(null);
  };

  const dialogProps = (() => {
    if (!pending) return { open: false };
    if (pending.kind === 'role') {
      const becoming = pending.nextRole === 'owner' ? 'an Owner' : 'an Admin';
      return {
        open: true,
        title: pending.nextRole === 'owner' ? 'Promote to Owner?' : 'Change role to Admin?',
        message: `Make ${pending.admin.email} ${becoming}? ${
          pending.nextRole === 'owner'
            ? 'Owners can manage every other admin, including removing you.'
            : 'They will lose owner-level access, such as managing administrators.'
        }`,
        confirmLabel: pending.nextRole === 'owner' ? 'Make owner' : 'Make admin',
        danger: false
      };
    }
    if (pending.kind === 'grant') {
      const roleLabel = pending.role === 'owner' ? 'an Owner' : 'an Admin';
      return {
        open: true,
        title: 'Grant access?',
        message: `Add ${pending.email} as ${roleLabel}? They'll be able to sign in with Google and use this portal${
          pending.role === 'owner' ? ', including managing other admins.' : '.'
        }`,
        confirmLabel: 'Grant access',
        danger: false
      };
    }
    const isSelf = user && pending.admin.email === user.email;
    return {
      open: true,
      title: 'Remove access?',
      message: isSelf
        ? 'Remove your own access? You will be signed out immediately.'
        : `Remove ${pending.admin.email}? Their sessions end immediately.`,
      confirmLabel: 'Remove',
      danger: true
    };
  })();

  return (
    <section className="card">
      <div className="section-head">
        <h2>Administrators</h2>
        <span className="muted small">
          {admins.length} person{admins.length === 1 ? '' : 's'} · {ownerCount} owner
          {ownerCount === 1 ? '' : 's'} · {bookOwnerCount} book owner
          {bookOwnerCount === 1 ? '' : 's'}
        </span>
      </div>

      <p className="muted small">
        Anyone listed here can sign in with Google and use this portal. Owners can additionally manage
        this list. Access is by email address — you can add someone before they have ever signed in.
      </p>

      <p className="muted small">
        <b>Bookstore</b> is a separate permission from Owner/Admin — it controls who can edit the shop
        catalog, and an Owner does not get it automatically. Book owners can also grant it to each other
        from inside the Bookstore tab.
      </p>

      <form className="admin-add" onSubmit={requestAdd}>
        <input
          type="email"
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="admin">Admin</option>
          <option value="owner">Owner</option>
        </select>
        <button type="submit" disabled={busy || !email.trim()}>
          Grant access
        </button>
      </form>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}

      {data && admins.length === 0 && <p className="muted">No administrators yet.</p>}

      {data && admins.length > 0 && (
      <div className="table-scroll">
        {/* Its own class, not .book-table: that one carries a 1040px floor and
            per-column widths tuned for repo names, which do not exist here. */}
        <table className="admin-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Books</th>
              <th>Bookstore</th>
              <th>Added</th>
              <th>Added by</th>
              <th>Last signed in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {admins.map((a) => {
              // The last owner cannot be demoted or removed — the portal would
              // have nobody able to change its access list again.
              const isLastOwner = a.role === 'owner' && ownerCount <= 1;
              const isLastBookOwner = Boolean(a.bookOwner) && bookOwnerCount <= 1;
              const isSelf = user && a.email === user.email;
              return (
                <tr key={a.email}>
                  <td>
                    {a.name ? `${a.name} ` : ''}
                    <span className="muted small">{a.email}</span>
                    {isSelf && <span className="tag"> you</span>}
                  </td>
                  <td>
                    <span className={`status-badge status-${a.role === 'owner' ? 'reviewing' : 'open'}`}>
                      {a.role}
                    </span>
                  </td>
                  <td>
                    {a.role === 'owner' ? (
                      <span className="muted small">All (owner)</span>
                    ) : (
                      <BookAssignment admin={a} books={books} onSaved={refresh} />
                    )}
                  </td>
                  <td>
                    <button
                      className={a.bookOwner ? undefined : 'ghost'}
                      disabled={busy || isLastBookOwner}
                      title={isLastBookOwner ? 'Grant it to someone else first' : ''}
                      onClick={() => toggleBookOwner(a)}
                    >
                      {a.bookOwner ? 'Book owner' : 'Grant'}
                    </button>
                  </td>
                  <td className="small">{formatDate(a.addedAt)}</td>
                  <td className="small muted">{a.addedBy || '—'}</td>
                  <td className="small">{formatDate(a.lastLoginAt)}</td>
                  <td className="actions">
                    <button
                      className="ghost"
                      disabled={busy || isLastOwner}
                      title={isLastOwner ? 'Promote another owner first' : ''}
                      onClick={() =>
                        setPending({
                          kind: 'role',
                          admin: a,
                          nextRole: a.role === 'owner' ? 'admin' : 'owner'
                        })
                      }
                    >
                      {a.role === 'owner' ? 'Make admin' : 'Make owner'}
                    </button>
                    <button
                      className="danger"
                      disabled={busy || isLastOwner}
                      title={isLastOwner ? 'Promote another owner first' : ''}
                      onClick={() => setPending({ kind: 'remove', admin: a })}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      <ConfirmDialog
        {...dialogProps}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={confirmPending}
      />
    </section>
  );
}
