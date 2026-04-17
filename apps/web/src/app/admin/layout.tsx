'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { SpotTicker } from '@/components/spot-ticker';
import { NotificationsBell } from '@/components/notifications-bell';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace('/login');
    else if (user.role !== 'admin' && user.role !== 'staff') router.replace('/dashboard');
  }, [loading, user, router]);

  if (loading || !user || (user.role !== 'admin' && user.role !== 'staff')) {
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
          <div>
            <div className="font-semibold leading-none">AGC</div>
            <div className="text-[10px] uppercase tracking-wide text-ink-400">Admin</div>
          </div>
        </div>

        <nav className="mt-8 flex flex-col gap-1 text-sm">
          <NavLink href="/admin">Dashboard</NavLink>
          <NavLink href="/admin/invoices">Invoices</NavLink>
          <NavLink href="/admin/invoices/new">New invoice</NavLink>
          <NavLink href="/admin/clients">Clients</NavLink>
          <NavLink href="/admin/requests">Requests</NavLink>
          <NavLink href="/admin/shipments">Shipments</NavLink>
          <NavLink href="/admin/quotes">Quotes</NavLink>
          <NavLink href="/admin/inventory">Inventory</NavLink>
          <NavLink href="/admin/products">Products</NavLink>
          <NavLink href="/admin/pricing">Pricing rules</NavLink>
          <NavLink href="/admin/integrations">Integrations</NavLink>
          <NavLink href="/admin/settings">Settings</NavLink>
        </nav>

        <div className="mt-auto space-y-2 text-sm">
          <div className="rounded-md bg-ink-50 p-3 text-xs text-ink-600">
            <div className="truncate font-medium text-ink-900">{user.email}</div>
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
        <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-ink-200 bg-white/90 px-6 py-3 backdrop-blur md:px-10">
          <div className="flex-1 min-w-0">
            <SpotTicker />
          </div>
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
