'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

interface EnrollResponse {
  otpauth_url: string;
  qr_data_url: string;
  recovery_codes: string[];
}

export default function SecurityPage() {
  const { user, refreshMe } = useAuth();
  const qc = useQueryClient();
  const enabled = Boolean(user?.is_2fa_enabled);

  const [enroll, setEnroll] = useState<EnrollResponse | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  async function startEnroll() {
    setError(null);
    setBusy(true);
    try {
      const r = await apiFetch<EnrollResponse>('/auth/2fa/enroll', { method: 'POST' });
      setEnroll(r);
      setConfirmed(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Enroll failed');
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    setError(null);
    setBusy(true);
    try {
      await apiFetch('/auth/2fa/activate', {
        method: 'POST',
        body: JSON.stringify({ code: code.replace(/\s+/g, '') }),
      });
      setConfirmed(true);
      await refreshMe();
      qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Activation failed');
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!confirm('Disable two-factor authentication?')) return;
    setError(null);
    setBusy(true);
    try {
      await apiFetch('/auth/2fa', { method: 'DELETE' });
      setEnroll(null);
      setCode('');
      setConfirmed(false);
      await refreshMe();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Disable failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">Security</h1>
      <p className="mt-1 text-sm text-ink-400">
        Protect your account with two-factor authentication.
      </p>

      <section className="mt-6 rounded-xl border border-ink-200 bg-white p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Two-factor authentication</h2>
            <p className="mt-1 text-sm text-ink-400">
              Authenticator app (Google Authenticator, 1Password, Authy).
            </p>
          </div>
          {enabled ? (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
              ON
            </span>
          ) : (
            <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600">
              OFF
            </span>
          )}
        </div>

        {enabled ? (
          <div className="mt-4">
            <button
              onClick={disable}
              disabled={busy}
              className="rounded-md border border-ink-200 px-4 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60"
            >
              Disable 2FA
            </button>
          </div>
        ) : !enroll ? (
          <div className="mt-4">
            <button
              onClick={startEnroll}
              disabled={busy}
              className="rounded-md bg-ink-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
            >
              {busy ? 'Starting…' : 'Enable 2FA'}
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div>
              <h3 className="text-sm font-semibold">1. Scan this QR code</h3>
              <p className="mt-1 text-xs text-ink-400">
                In your authenticator app, add a new account and scan this code.
              </p>
              <div className="mt-3 inline-block rounded-md border border-ink-200 bg-white p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={enroll.qr_data_url} alt="2FA QR code" width={180} height={180} />
              </div>
              <p className="mt-2 break-all font-mono text-[11px] text-ink-400">
                Or enter manually: {enroll.otpauth_url}
              </p>
            </div>

            <div>
              <h3 className="text-sm font-semibold">2. Save recovery codes</h3>
              <p className="mt-1 text-xs text-ink-400">
                Store these somewhere safe — they're the only way in if you lose your
                device. Each one works exactly once.
              </p>
              <div className="mt-2 rounded-md border border-ink-200 bg-ink-50 p-3 font-mono text-sm">
                {enroll.recovery_codes.map((c) => (
                  <div key={c} className="py-0.5">
                    {c}
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold">3. Verify the setup</h3>
              <p className="mt-1 text-xs text-ink-400">
                Enter the current 6-digit code from your authenticator.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  inputMode="numeric"
                  maxLength={8}
                  className="input w-32 text-center font-mono tracking-widest"
                />
                <button
                  onClick={activate}
                  disabled={busy || code.length < 6}
                  className="rounded-md bg-ink-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
                >
                  {busy ? 'Verifying…' : 'Activate'}
                </button>
              </div>
            </div>
          </div>
        )}

        {confirmed && (
          <div className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
            2FA is now active. You'll be asked for a code on every sign-in.
          </div>
        )}
        {error && (
          <div role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
      </section>

      <PasswordChangeSection />
    </div>
  );
}

function PasswordChangeSection() {
  const { logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    if (next !== confirm) {
      setStatus({ kind: 'err', msg: 'New passwords do not match' });
      return;
    }
    if (next.length < 12) {
      setStatus({ kind: 'err', msg: 'New password must be at least 12 characters' });
      return;
    }
    if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) {
      setStatus({ kind: 'err', msg: 'New password needs a letter and a number' });
      return;
    }
    setBusy(true);
    try {
      await apiFetch('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      setStatus({
        kind: 'ok',
        msg: 'Password updated. Other sessions have been signed out. Signing you out on this device in 3 seconds…',
      });
      setCurrent('');
      setNext('');
      setConfirm('');
      setTimeout(() => {
        logout();
      }, 3000);
    } catch (err) {
      setStatus({
        kind: 'err',
        msg: err instanceof ApiError ? err.message : 'Password change failed',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-ink-200 bg-white p-6">
      <h2 className="text-base font-semibold">Change password</h2>
      <p className="mt-1 text-sm text-ink-400">
        12+ characters with at least one letter and one number. Changing your
        password will sign you out of every other session.
      </p>

      <form onSubmit={submit} className="mt-4 space-y-3 max-w-sm">
        <label className="block">
          <span className="text-sm font-medium text-ink-800">Current password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="input mt-1"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-800">New password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="input mt-1"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink-800">Confirm new password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="input mt-1"
          />
        </label>

        {status && (
          <div
            role={status.kind === 'err' ? 'alert' : undefined}
            className={`rounded-md px-3 py-2 text-sm ${
              status.kind === 'ok'
                ? 'bg-green-50 text-green-700'
                : 'bg-red-50 text-red-700'
            }`}
          >
            {status.msg}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {busy ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </section>
  );
}
