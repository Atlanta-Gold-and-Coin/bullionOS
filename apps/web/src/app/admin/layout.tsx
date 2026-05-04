'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { SpotTicker } from '@/components/spot-ticker';
import { NotificationsBell } from '@/components/notifications-bell';
import { useAppSettings, type FlagName } from '@/lib/use-app-settings';
import {
  BullionOSLogo,
  BullionOSWordmark,
} from '@/components/bullion-os-logo';

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
  /**
   * If set, the entry only appears when the named feature flag is
   * enabled. Flag absent or true → visible. Flag false → hidden.
   * Flags are sourced from useAppSettings + useFlag.
   */
  flag?: FlagName;
}
interface NavGroup {
  href: string;
  label: string;
  flag?: FlagName;
  children: NavChild[];
}
type NavEntry = NavChild | NavGroup;

function isGroup(e: NavEntry): e is NavGroup {
  return 'children' in e;
}

/**
 * Filter a nav tree by enabled feature flags. A group whose own flag
 * is disabled is dropped entirely; otherwise its children are filtered
 * individually. Groups with no surviving children also drop.
 */
function applyFlags(
  items: NavEntry[],
  flags: Record<FlagName, boolean>,
): NavEntry[] {
  const out: NavEntry[] = [];
  for (const item of items) {
    if (item.flag && !flags[item.flag]) continue;
    if (isGroup(item)) {
      const kids = item.children.filter(
        (c) => !c.flag || flags[c.flag],
      );
      if (kids.length === 0) continue;
      out.push({ ...item, children: kids });
    } else {
      out.push(item);
    }
  }
  return out;
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
      {
        href: '/admin/clients/tracking',
        label: 'Client tracking',
        flag: 'client_tracking_enabled',
      },
      { href: '/admin/requests', label: 'Deal requests' },
      { href: '/admin/quotes', label: 'Quotes' },
    ],
  },
  { href: '/admin/shipments', label: 'Shipments', flag: 'ifs_enabled' },
  // Price Sheet is a top-level tab — it's the single most-frequented
  // counter page, so burying it under Catalog costs an extra click
  // every quote. Catalog keeps the two less-used sheet siblings.
  { href: '/admin/pricesheet', label: 'Price Sheet' },
  {
    href: '/admin/products',
    label: 'Catalog',
    children: [
      { href: '/admin/in-stock-sheet', label: 'In Stock Sheet' },
      { href: '/admin/buy-sheet', label: 'What We Pay' },
      // RARCOA supplier pricing — daily goldsheet ingest + AGC
      // markdown-applied prices. Admin-only upload; staff can view.
      { href: '/admin/rarcoa', label: 'RARCOA' },
      // Aurbitrage — multi-wholesaler price aggregator. Compare bids/
      // asks across MTB, Dillon Gage, APMEX, Pinehurst, etc., on the
      // same product without leaving AGC Desk.
      { href: '/admin/aurbitrage', label: 'Aurbitrage' },
    ],
  },
  // Scrap workflows live under their own parent so the calculator
  // and the buy/sell scrap-invoice flow are visible without burying
  // them inside Invoices. Lines created here are ad-hoc only — no
  // catalog products, so scrap never appears on /admin/pricesheet
  // or the buy/sell sheets. KPI rolls scrap under "other" until
  // operators ask for per-metal categorization.
  {
    href: '/admin/scrap/calculator',
    label: 'Scrap',
    flag: 'scrap_enabled',
    children: [
      { href: '/admin/scrap/calculator', label: 'Scrap Calculator' },
      { href: '/admin/scrap/invoice', label: 'Scrap Invoice' },
    ],
  },
  {
    href: '/admin/settings',
    label: 'Settings',
    children: [
      { href: '/admin/settings/features', label: 'Features' },
      { href: '/admin/categories', label: 'Categories' },
      { href: '/admin/integrations', label: 'Integrations' },
      { href: '/admin/imports', label: 'Imports (CSV)' },
      { href: '/admin/backups', label: 'Backups' },
      // Historical KPI totals from before AGC Desk went live; drives
      // the dashboard 12-month chart and KPI timeline for
      // month/quarter/year views.
      { href: '/admin/settings/kpi-manual', label: 'KPI history' },
      // Day-granular reconciliation of past-system invoices. Feeds
      // the same KPI rollup as KPI history but per-invoice rather
      // than per-month — used when the accountant wants to book
      // prior-month invoices one at a time from QuickBooks / old POS.
      { href: '/admin/historical-invoices', label: 'Historical invoices' },
      // Editable copy for every system-sent email (invoice emails,
      // etc.). Text-only, with {{variable}} substitution.
      { href: '/admin/settings/email-templates', label: 'Email templates' },
    ],
  },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const { data: appSettings } = useAppSettings();
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
    <div className="bos-theme flex min-h-screen bg-bos-black text-ink-900">
      {/* `.bos-theme` scopes the dark-mode CSS overrides in globals.css
          to the admin shell only — login / public booking / register
          pages outside this tree keep their original light surfaces. */}
      {/* Desktop sidebar — BullionOS night surface with subtle gold
          edge. Sidebar background is pure-dark; content rendering is
          unchanged inside (NavLink / NavGroupLinks restyle inline). */}
      <aside className="sticky top-0 hidden h-screen w-60 flex-col overflow-y-auto border-r border-bos-line bg-bos-night px-4 py-6 md:flex">
        <SidebarBody user={user} onLogout={logout} pathname={pathname} />
      </aside>

      {/* Mobile drawer — same BullionOS night look on the sliding panel. */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-bos-line bg-bos-night px-4 py-6 shadow-xl">
            <SidebarBody user={user} onLogout={logout} pathname={pathname} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-bos-line bg-bos-night/95 px-4 py-3 text-bos-text backdrop-blur md:gap-4 md:px-10">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="flex h-9 w-9 items-center justify-center rounded-md border border-bos-line text-bos-text hover:bg-white/5 md:hidden"
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
        <main className="flex-1 bg-bos-black px-4 py-6 md:px-10">
          {/* Per-page content. Card surfaces inside `children` are
              re-styled to the dark theme via the .bos-theme CSS
              overrides in globals.css — no per-page edits required.
              The overrides target the heaviest-used utility classes
              (bg-white, bg-ink-50/100/200, border-ink-100/200, and
              the text-ink-* scale) so existing markup flips dark in
              place. */}
          {children}
        </main>
        <AdminFooter />
      </div>
    </div>
  );
}

/**
 * Branded footer that appears at the bottom of every admin page.
 * Subtle "Powered by BullionOS" lockup over the dark night surface.
 */
function AdminFooter() {
  return (
    <footer className="border-t border-bos-line bg-bos-night px-4 py-4 text-center md:px-10">
      <div className="flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.18em] text-bos-mute">
        <span>Powered by</span>
        <BullionOSWordmark size="sm" />
      </div>
    </footer>
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
  // useAppSettings is cached by react-query — calling it here re-uses
  // the same fetch the parent layout kicked off.
  const { data: appSettings } = useAppSettings();
  // While settings load, render the full nav (every flag treated as
  // enabled). When settings arrive, items with disabled flags drop.
  // This avoids the sidebar flickering missing items during nav.
  const visibleNav = appSettings
    ? applyFlags(NAV_ITEMS, appSettings.flags)
    : NAV_ITEMS;
  return (
    <>
      <div className="flex items-center gap-2 px-2">
        <BullionOSLogo size={28} />
        <div>
          <div className="font-semibold leading-none text-white">
            <span>bullion</span>
            <span className="text-gold-400">OS</span>
          </div>
          <div className="text-[10px] uppercase tracking-wide text-bos-mute">
            {appSettings?.branding.company_name ?? 'BullionOS Desk'} · Admin
          </div>
        </div>
      </div>

      <nav className="mt-8 flex flex-col gap-1 text-sm">
        {visibleNav.map((item) =>
          isGroup(item) ? (
            <NavGroupLinks key={item.href} group={item} pathname={pathname} />
          ) : (
            <NavLink key={item.href} href={item.href} pathname={pathname}>
              {item.label}
            </NavLink>
          ),
        )}
      </nav>

      <div className="mt-auto space-y-2 text-sm">
        <div className="rounded-md bg-white/5 p-3 text-xs text-bos-text">
          <div className="truncate font-medium text-white">{user.email}</div>
          <div className="mt-0.5 text-bos-mute">Role: {user.role}</div>
        </div>
        <a
          href="/dashboard"
          className="block w-full rounded-md border border-bos-line px-3 py-1.5 text-center text-bos-text hover:bg-white/5 hover:text-white"
        >
          Client portal view →
        </a>
        <button
          onClick={onLogout}
          className="w-full rounded-md border border-bos-line px-3 py-1.5 text-center text-bos-text hover:bg-white/5 hover:text-white"
        >
          Sign out
        </button>
      </div>
    </>
  );
}

function NavLink({
  href,
  children,
  pathname,
}: {
  href: string;
  children: React.ReactNode;
  pathname?: string;
}) {
  const active = pathname === href || (pathname?.startsWith(href + '/') ?? false);
  return (
    <Link
      href={href}
      className={
        'rounded-md px-3 py-1.5 transition ' +
        (active
          ? 'bg-gold-400/10 text-gold-400'
          : 'text-bos-text hover:bg-white/5 hover:text-white')
      }
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
          className={
            'flex-1 rounded-md px-3 py-1.5 transition ' +
            (active
              ? 'bg-gold-400/10 text-gold-400'
              : 'text-bos-text hover:bg-white/5 hover:text-white')
          }
        >
          {group.label}
        </Link>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? `Collapse ${group.label}` : `Expand ${group.label}`}
          aria-expanded={open}
          className="rounded-md p-1 text-bos-mute transition hover:bg-white/5 hover:text-white"
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
        <div className="ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-bos-line pl-2">
          {group.children.map((c) => {
            const childActive =
              pathname === c.href || pathname.startsWith(c.href + '/');
            return (
              <Link
                key={c.href}
                href={c.href}
                className={
                  'rounded-md px-3 py-1 text-xs transition ' +
                  (childActive
                    ? 'bg-gold-400/10 text-gold-400'
                    : 'text-bos-text hover:bg-white/5 hover:text-white')
                }
              >
                {c.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
