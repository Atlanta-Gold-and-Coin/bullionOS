'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { loginSchema } from '@agc/shared';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/lib/api-client';
import {
  BullionOSHeroMark,
  BullionOSWordmark,
} from '@/components/bullion-os-logo';
import { useAppSettings } from '@/lib/use-app-settings';

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const { data: appSettings } = useAppSettings();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid input');
      return;
    }
    setSubmitting(true);
    try {
      const me = await login(parsed.data);
      // Admins + staff land on the back-office; clients on the portal.
      // Operators previously had to take an extra click via the
      // "Admin →" link from /dashboard every time they signed in.
      const dest =
        me.role === 'admin' || me.role === 'staff'
          ? '/admin'
          : '/dashboard';
      router.replace(dest);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-bos-black px-4 py-12">
      {/* BullionOS hero mark + wordmark — the inline SVG identity for
          the meta-product. Per-tenant branding (the operator's company
          name, logo, etc.) still appears post-login on the admin shell
          and invoice PDFs. */}
      <div className="mb-8 flex flex-col items-center">
        <BullionOSHeroMark size={140} />
        <div className="mt-4">
          <BullionOSWordmark size="lg" withTagline />
        </div>
      </div>

      <div className="w-full max-w-sm rounded-2xl border border-bos-line bg-bos-night p-8 shadow-2xl shadow-black/40">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-white">Sign in</h1>
          <p className="mt-1 text-sm text-bos-mute">
            {appSettings?.branding.company_name ?? 'BullionOS'} · Operator portal
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-bos-text">Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block w-full rounded-md border border-bos-line bg-bos-black px-3 py-2 text-white outline-none ring-gold-400/40 placeholder:text-bos-mute focus:ring-2"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-bos-text">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full rounded-md border border-bos-line bg-bos-black px-3 py-2 text-white outline-none ring-gold-400/40 placeholder:text-bos-mute focus:ring-2"
            />
          </label>

          {error && (
            <div
              role="alert"
              className="rounded-md border border-red-700/40 bg-red-900/30 px-3 py-2 text-sm text-red-300"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-gold-400 px-4 py-2 text-sm font-semibold text-bos-black transition hover:bg-gold-300 disabled:opacity-60"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-bos-mute">
          New here?{' '}
          <Link
            href="/register"
            className="text-gold-400 underline-offset-2 hover:underline"
          >
            Create an account
          </Link>
        </p>
        <p className="mt-2 text-center text-sm text-bos-mute">
          Want to book an appointment?{' '}
          <Link
            href="/book"
            className="text-gold-400 underline-offset-2 hover:underline"
          >
            Schedule online
          </Link>
        </p>
      </div>

      <p className="mt-6 text-[10px] uppercase tracking-[0.18em] text-bos-mute">
        Powered by{' '}
        <span className="text-white">bullion</span>
        <span className="text-gold-400">OS</span>
      </p>
    </main>
  );
}
