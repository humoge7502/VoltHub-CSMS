'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getToken, logout } from '../lib/ui';

// Session-aware topbar/drawer links. SSR renders the logged-out variant (the
// common case for first paint); after hydration the token decides. The storage
// listener keeps multi-tab sessions honest: logging out in one tab updates the
// rest without a reload.
export function SessionLinks({ className }) {
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    setAuthed(!!getToken());
    const onStorage = (e) => {
      if (e.key === 'vh_token') setAuthed(!!e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  if (!authed) {
    return (
      <span className={className}>
        <Link href="/login">Log in</Link>
        <Link href="/signup">Sign up</Link>
      </span>
    );
  }
  return (
    <span className={className}>
      <Link href="/profile">Profile</Link>
      <button
        type="button"
        className="linklike"
        onClick={async () => {
          await logout();
          window.location = '/';
        }}
      >
        Sign out
      </button>
    </span>
  );
}
