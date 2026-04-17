'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { NotificationsBell } from '@/components/notifications-bell';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center text-ink-400">
        Loading…
      </main>
    );
  }

  return (
    <div className="flex min-h-screen bg-ink-50 text-ink-900">
      <aside className="hidden w-60 flex-col border-r border-ink-200 bg-white px-4 py-6 md:flex">
        <div className="flex items-center gap-2 px-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/api/v1/public/branding/logo"
            alt="AGC"
            className="h-7 w-7 rounded-md object-contain"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
          <span className="font-semibold">AGC</span>
        </div>

        <nav className="mt-8 flex flex-col gap-1 text-sm">
          <NavLink href="/dashboard">Overview</NavLink>
          <NavLink href="/dashboard/transactions">Transactions</NavLink>
          <NavLink href="/dashboard/pricing">What We Pay</NavLink>
          <NavLink href="/dashboard/in-stock">In Stock</NavLink>
          <NavLink href="/dashboard/quotes">Quotes</NavLink>
          <NavLink href="/dashboard/requests">Requests</NavLink>
          <NavLink href="/dashboard/shipments">Shipments</NavLink>
          <NavLink href="/dashboard/security">Security</NavLink>
          {user.role === 'admin' || user.role === 'staff' ? (
            <NavLink href="/admin">Admin console</NavLink>
          ) : null}
        </nav>

        <div className="mt-auto space-y-2 text-sm">
          <div className="rounded-md bg-ink-50 p-3 text-xs text-ink-600">
            Signed in as <span className="font-medium text-ink-900">{user.email}</span>
            <div className="mt-0.5 text-ink-400">Role: {user.role}</div>
          </div>
          <button
            onClick={logout}
            className="w-full rounded-md border border-ink-200 px-3 py-1.5 text-left hover:bg-ink-50"
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-end gap-4 border-b border-ink-200 bg-white/90 px-6 py-3 backdrop-blur md:px-10">
          <NotificationsBell />
        </header>
        <main className="flex-1 px-6 py-6 md:px-10">{children}</main>
      </div>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-1.5 text-ink-600 transition hover:bg-ink-50 hover:text-ink-900"
    >
      {children}
    </Link>
  );
}
