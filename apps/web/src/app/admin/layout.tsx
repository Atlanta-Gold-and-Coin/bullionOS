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

/**
 * Nav structure.
 *
 * Top-level items are either a flat link OR a group with a header link
 * plus nested children. Groups expand when the active route matches the
 * group root or any of its children, so operators always see where they
 * are within a section.
 *
 * Consolidations (Apr 2026):
 *   - Removed the old "Products" (/admin/inventory) top-level link.
 *     That surface was a subset of Catalog with three extras
 *     (reservation badges, sell price column, adjustment notes) —
 *     all three are now folded into Catalog. The route itself still
 *     resolves for any lingering bookmarks.
 *   - Clients group: "Clients" list + nested "Requests" and "Quotes"
 *     (previously their own top-level entries). Both are client-scoped
 *     anyway; surfacing them as siblings of the client list reduces
 *     top-level clutter.
 *   - Settings group: "Settings" + nested "Categories", "Integrations",
 *     "Backups" — operator-facing site config moves under one header.
 */
interface NavChild {
  href: string;
  label: string;
}
interface NavGroup {
  href: string;
  label: string;
  children: NavChild[];
}
type NavEntry = NavChild | NavGroup;

function isGroup(e: NavEntry): e is NavGroup {
  return 'children' in e;
}

const NAV_ITEMS: NavEntry[] = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/kpi', label: 'KPI' },
  { href: '/admin/calendar', label: 'Calendar' },
  // Invoices parent carries two sub-entries so the ways to act on
  // invoices (create, collect) sit under one heading. The parent link
  // still navigates to the invoice list; children handle create + AR.
  {
    href: '/admin/invoices',
    label: 'Invoices',
    children: [
      { href: '/admin/invoices/new', label: 'New invoice' },
      { href: '/admin/wholesale/reconciliation', label: 'Wholesale AR' },
    ],
  },
  {
    href: '/admin/clients',
    label: 'Clients',
    children: [
      { href: '/admin/requests', label: 'Deal requests' },
      { href: '/admin/quotes', label: 'Quotes' },
    ],
  },
  { href: '/admin/shipments', label: 'Shipments' },
  // Catalog parent groups the three pricing / stock views that all
  // read the same sheet payload. Parent route is still the Catalog
  // (drag-reorder surface); children are the printable sheets.
  {
    href: '/admin/products',
    label: 'Catalog',
    children: [
      { href: '/admin/pricesheet', label: 'Price Sheet' },
      { href: '/admin/in-stock-sheet', label: 'In Stock Sheet' },
      { href: '/admin/buy-sheet', label: 'What We Pay' },
    ],
  },
  {
    href: '/admin/settings',
    label: 'Settings',
    children: [
      { href: '/admin/categories', label: 'Categories' },
      { href: '/admin/integrations', label: 'Integrations' },
      { href: '/admin/backups', label: 'Backups' },
      // Historical KPI totals from before AGC Desk went live; drives
      // the dashboard 12-month chart and KPI timeline for
      // month/quarter/year views.
      { href: '/admin/settings/kpi-manual', label: 'KPI history' },
      // Editable copy for every system-sent email (invoice emails,
      // etc.). Text-only, with {{variable}} substitution.
      { href: '/admin/settings/email-templates', label: 'Email templates' },
    ],
  },
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
        <SidebarBody user={user} onLogout={logout} pathname={pathname} />
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
            <SidebarBody user={user} onLogout={logout} pathname={pathname} />
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
  pathname,
}: {
  user: { email: string; role: string };
  onLogout: () => void;
  /** Active route — used to auto-expand the matching nav group. */
  pathname: string;
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
        {NAV_ITEMS.map((item) =>
          isGroup(item) ? (
            <NavGroupLinks key={item.href} group={item} pathname={pathname} />
          ) : (
            <NavLink key={item.href} href={item.href}>
              {item.label}
            </NavLink>
          ),
        )}
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

/**
 * Collapsible nav group — header link + chevron that reveals children.
 *
 * Auto-expands whenever the active route matches the group root or any
 * of its children, so operators who deep-link into (e.g.)
 * /admin/categories land with the Settings group already open and
 * highlighting "Categories". Clicking the chevron toggles the manual
 * override for the current session; navigating back resets to the
 * auto-expand rule.
 */
function NavGroupLinks({
  group,
  pathname,
}: {
  group: { href: string; label: string; children: Array<{ href: string; label: string }> };
  pathname: string;
}) {
  const active =
    pathname === group.href ||
    pathname.startsWith(group.href + '/') ||
    group.children.some(
      (c) => pathname === c.href || pathname.startsWith(c.href + '/'),
    );
  const [open, setOpen] = useState(active);

  // Re-sync on path change — when an operator navigates into a child
  // via a deep-link elsewhere, we want the group to open automatically.
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-0.5">
        <Link
          href={group.href}
          className="flex-1 rounded-md px-3 py-1.5 text-ink-600 transition hover:bg-ink-50 hover:text-ink-900"
        >
          {group.label}
        </Link>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? `Collapse ${group.label}` : `Expand ${group.label}`}
          aria-expanded={open}
          className="rounded-md p-1 text-ink-400 transition hover:bg-ink-50 hover:text-ink-900"
        >
          <span
            className={`inline-block transition-transform ${
              open ? 'rotate-90' : ''
            }`}
          >
            ›
          </span>
        </button>
      </div>
      {open && (
        <div className="ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-ink-100 pl-2">
          {group.children.map((c) => (
            <Link
              key={c.href}
              href={c.href}
              className="rounded-md px-3 py-1 text-xs text-ink-600 transition hover:bg-ink-50 hover:text-ink-900"
            >
              {c.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
