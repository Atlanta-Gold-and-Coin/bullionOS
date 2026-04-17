'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { loginSchema } from '@agc/shared';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/lib/api-client';

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
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
      await login(parsed.data);
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink-50 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm ring-1 ring-ink-200">
        <div className="mb-6">
          {/* Served from /api/v1/public/branding/logo — admins upload at /admin/settings */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/api/v1/public/branding/logo"
            alt="AGC"
            className="h-12 w-12 rounded-md object-contain"
            onError={(e) => {
              // Fallback to a neutral block if the logo isn't configured yet.
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
          <h1 className="mt-4 text-xl font-semibold text-ink-900">Sign in</h1>
          <p className="mt-1 text-sm text-ink-400">AGC client portal</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-ink-800">Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-ink-900 outline-none ring-gold-500/30 focus:ring-2"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-ink-800">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full rounded-md border border-ink-200 bg-white px-3 py-2 text-ink-900 outline-none ring-gold-500/30 focus:ring-2"
            />
          </label>

          {error && (
            <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-ink-800 disabled:opacity-60"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-ink-400">
          New here?{' '}
          <Link href="/register" className="text-ink-900 underline-offset-2 hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </main>
  );
}
