'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { SpotTicker } from '@/components/spot-ticker';
import { NotificationsBell } from '@/components/notifications-bell';

/**
 * Admin shell.
 *
 * Desktop (md+): persistent left sidebar + main content column.
 * Mobile (<md):  slide-in drawer triggered by a hamburger in the sticky
 *                header. Closes on route change, Escape, or backdrop click.
 *                Body scroll is locked while the drawer is open so the
 *                page doesn't jiggle behind it.
 *
 * The same NavLinks array powers both layouts — one source of truth for
 * what lives in the admin console.
 */

const NAV_ITEMS: Array<{ href: string; label: string }> = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/kpi', label: 'KPI' },
  { href: '/admin/calendar', label: 'Calendar' },
  { href: '/admin/invoices', label: 'Invoices' },
  { href: '/admin/invoices/new', label: 'New invoice' },
  { href: '/admin/clients', label: 'Clients' },
  { href: '/admin/requests', label: 'Requests' },
  { href: '/admin/shipments', label: 'Shipments' },
  { href: '/admin/quotes', label: 'Quotes' },
  { href: '/admin/inventory', label: 'Products' },
  { href: '/admin/in-stock-sheet', label: 'In stock sheet' },
  { href: '/admin/buy-sheet', label: 'What we pay' },
  { href: '/admin/products', label: 'Catalog' },
  { href: '/admin/integrations', label: 'Integrations' },
  { href: '/admin/backups', label: 'Backups' },
  { href: '/admin/settings', label: 'Settings' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace('/login');
    else if (user.role !== 'admin' && user.role !== 'staff') router.replace('/dashboard');
  }, [loading, user, router]);

  // Close the drawer on route change so the mobile flow is: tap link →
  // page changes → drawer dismisses → content visible.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Esc to close + lock body scroll while the drawer is up.
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

  if (loading || !user || (user.role !== 'admin' && user.role !== 'staff')) {
    return (
      <main className="flex min-h-screen items-center justify-center text-ink-400">
        Loading…
      </main>
    );
  }

  return (
    <div className="flex min-h-screen bg-ink-50 text-ink-900">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 flex-col overflow-y-auto border-r border-ink-200 bg-white px-4 py-6 md:flex">
        <SidebarBody user={user} onLogout={logout} />
      </aside>

      {/* Mobile drawer — backdrop + sliding panel. */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-ink-900/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-ink-200 bg-white px-4 py-6 shadow-xl">
            <SidebarBody user={user} onLogout={logout} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-ink-200 bg-white/90 px-4 py-3 backdrop-blur md:gap-4 md:px-10">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="flex h-9 w-9 items-center justify-center rounded-md border border-ink-200 text-ink-700 hover:bg-ink-50 md:hidden"
          >
            {/* Hamburger — hand-rolled SVG, no icon lib. */}
            <svg width="18" height="14" viewBox="0 0 18 14" fill="none" aria-hidden>
              <path
                d="M1 1h16M1 7h16M1 13h16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <div className="flex-1 min-w-0 overflow-x-auto">
            <SpotTicker />
          </div>
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
}: {
  user: { email: string; role: string };
  onLogout: () => void;
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
        <div>
          <div className="font-semibold leading-none">AGC</div>
          <div className="text-[10px] uppercase tracking-wide text-ink-400">Admin</div>
        </div>
      </div>

      <nav className="mt-8 flex flex-col gap-1 text-sm">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.href} href={item.href}>
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto space-y-2 text-sm">
        <div className="rounded-md bg-ink-50 p-3 text-xs text-ink-600">
          <div className="truncate font-medium text-ink-900">{user.email}</div>
          <div className="mt-0.5 text-ink-400">Role: {user.role}</div>
        </div>
        <a
          href="/dashboard"
          className="block w-full rounded-md border border-ink-200 px-3 py-1.5 text-center text-ink-700 hover:bg-ink-50"
        >
          Client portal view →
        </a>
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
