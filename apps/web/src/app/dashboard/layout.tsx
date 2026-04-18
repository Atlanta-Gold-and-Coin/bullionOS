'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { NotificationsBell } from '@/components/notifications-bell';

/**
 * Client portal shell. Mirrors the admin layout's mobile drawer pattern:
 * desktop gets a persistent sidebar, mobile gets a hamburger-triggered
 * slide-in panel.
 */
const NAV_ITEMS: Array<{ href: string; label: string; adminOnly?: boolean }> = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/transactions', label: 'Transactions' },
  { href: '/dashboard/pricing', label: 'What We Pay' },
  { href: '/dashboard/in-stock', label: 'In Stock' },
  { href: '/dashboard/quotes', label: 'Quotes' },
  { href: '/dashboard/requests', label: 'Requests' },
  { href: '/dashboard/shipments', label: 'Shipments' },
  { href: '/dashboard/security', label: 'Security' },
  { href: '/admin', label: 'Admin console', adminOnly: true },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  if (loading || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center text-ink-400">
        Loading…
      </main>
    );
  }

  const isAdminish = user.role === 'admin' || user.role === 'staff';

  return (
    <div className="flex min-h-screen bg-ink-50 text-ink-900">
      <aside className="sticky top-0 hidden h-screen w-60 flex-col overflow-y-auto border-r border-ink-200 bg-white px-4 py-6 md:flex">
        <SidebarBody
          user={user}
          onLogout={logout}
          showAdmin={isAdminish}
        />
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-ink-900/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-ink-200 bg-white px-4 py-6 shadow-xl">
            <SidebarBody
              user={user}
              onLogout={logout}
              showAdmin={isAdminish}
            />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-ink-200 bg-white/90 px-4 py-3 backdrop-blur md:justify-end md:px-10">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="flex h-9 w-9 items-center justify-center rounded-md border border-ink-200 text-ink-700 hover:bg-ink-50 md:hidden"
          >
            <svg width="18" height="14" viewBox="0 0 18 14" fill="none" aria-hidden>
              <path
                d="M1 1h16M1 7h16M1 13h16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <NotificationsBell />
        </header>
        <main className="flex-1 px-4 py-6 md:px-10">{children}</main>
      </div>
    </div>
  );
}

function SidebarBody({
  user,
  onLogout,
  showAdmin,
}: {
  user: { email: string; role: string };
  onLogout: () => void;
  showAdmin: boolean;
}) {
  return (
    <>
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
        {NAV_ITEMS.filter((i) => !i.adminOnly || showAdmin).map((item) => (
          <NavLink key={item.href} href={item.href}>
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto space-y-2 text-sm">
        <div className="rounded-md bg-ink-50 p-3 text-xs text-ink-600">
          Signed in as <span className="font-medium text-ink-900">{user.email}</span>
          <div className="mt-0.5 text-ink-400">Role: {user.role}</div>
        </div>
        <button
          onClick={onLogout}
          className="w-full rounded-md border border-ink-200 px-3 py-1.5 text-left hover:bg-ink-50"
        >
          Sign out
        </button>
      </div>
    </>
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
