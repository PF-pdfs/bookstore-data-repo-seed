import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { setAuthFetch } from './api.js';

// Session state for the admin portal.
//
// The access token lives in memory only — never localStorage, which any XSS on
// the page could read. The durable credential is the httpOnly pf_admin_refresh
// cookie the browser holds and JavaScript cannot touch, so "am I signed in?"
// is answered by asking the server to mint a fresh access token from it.

const AuthContext = createContext(null);
const REFRESH_MARGIN_SECONDS = 60;

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | signed-in | signed-out
  const [deniedEmail, setDeniedEmail] = useState(null);
  const accessTokenRef = useRef(null);
  const timerRef = useRef(null);

  // Google sends the browser back here with ?auth_error=not_authorised when
  // the account is real but not on the allowlist — worth saying plainly rather
  // than showing a bare sign-in screen again.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('auth_error') === 'not_authorised') {
      setDeniedEmail(params.get('email') || '');
    }
    if (params.has('auth_error') || params.has('signed_in')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const clearSession = useCallback(() => {
    accessTokenRef.current = null;
    setUser(null);
    setStatus('signed-out');
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/auth/refresh', { method: 'POST' });
    if (!res.ok) {
      clearSession();
      return null;
    }
    const data = await res.json();
    accessTokenRef.current = data.accessToken;
    setUser(data.user);
    setStatus('signed-in');
    setDeniedEmail(null);

    if (timerRef.current) clearTimeout(timerRef.current);
    const delay = Math.max(30, (data.expiresIn || 900) - REFRESH_MARGIN_SECONDS) * 1000;
    timerRef.current = setTimeout(() => {
      refresh().catch(() => clearSession());
    }, delay);

    return data.accessToken;
  }, [clearSession]);

  useEffect(() => {
    refresh().catch(() => clearSession());
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [refresh, clearSession]);

  const signIn = useCallback(() => {
    // A full navigation, not fetch: the provider needs to own the browser to
    // show its consent screen.
    window.location.href = '/api/auth/google/start';
  }, []);

  const signOut = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const authFetch = useCallback(
    async (path, options = {}) => {
      const send = (token) =>
        fetch(path, {
          ...options,
          headers: {
            ...(options.headers || {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          }
        });

      let res = await send(accessTokenRef.current);
      if (res.status === 401) {
        const body = await res.clone().json().catch(() => ({}));
        if (body.code === 'token_expired' || !accessTokenRef.current) {
          const token = await refresh();
          if (token) res = await send(token);
        }
      }
      // Access withdrawn while the tab was open: stop pretending we are in.
      if (res.status === 403) {
        const body = await res.clone().json().catch(() => ({}));
        if (body.code === 'not_admin') clearSession();
      }
      return res;
    },
    [refresh, clearSession]
  );

  // Registered once so every api.js call carries the bearer token without each
  // component having to pass it down.
  useEffect(() => {
    setAuthFetch(authFetch);
  }, [authFetch]);

  const value = useMemo(
    () => ({
      user,
      status,
      deniedEmail,
      isSignedIn: status === 'signed-in',
      isOwner: Boolean(user && user.isOwner),
      // Bookstore access — independent of isOwner. See server/auth/middleware.js.
      isBookOwner: Boolean(user && user.isBookOwner),
      signIn,
      signOut,
      authFetch,
      refresh
    }),
    [user, status, deniedEmail, signIn, signOut, authFetch, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
