'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserRole } from '@agc/shared';
import { apiFetch, ApiError } from '@/lib/api-client';

/**
 * Admin → Users (team management).
 *
 * Lists staff/admin accounts and exposes the per-user
 * `can_view_owner_private` allowlist flag as a checkbox. Replaces the
 * old hardcoded email allowlist (migration 038's bootstrap UPDATE,
 * removed by the api-data slice) — admins are now granted access here.
 *
 * Reads GET /admin/users and persists via PATCH /admin/users/:id
 * (both owned by the api settings/data slices per the integration
 * contract). The checkbox sends only `can_view_owner_private` so it
 * never touches unrelated fields.
 */

interface AdminUserRow {
  id: string;
  email: string;
  role: UserRole;
  status: 'active' | 'restricted' | 'disabled';
  first_name: string | null;
  last_name: string | null;
  can_view_owner_private: boolean;
}

export default function AdminUsersPage() {
  const qc = useQueryClient();
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<AdminUserRow[]>({
    queryKey: ['admin', 'users'],
    queryFn: () => apiFetch<AdminUserRow[]>('/admin/users'),
  });

  async function setOwnerPrivate(id: string, value: boolean) {
    setError(null);
    setSavingId(id);
    try {
      await apiFetch(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ can_view_owner_private: value }),
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">Users</h1>
      <p className="mt-1 text-sm text-ink-400">
        Manage team members and their access. The owner-private
        permission lets a user see clients and invoices flagged as
        owner-private.
      </p>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      {isLoading && (
        <div className="mt-6 text-sm text-ink-400">Loading…</div>
      )}

      {data && (
        <div className="mt-6 overflow-hidden rounded-xl border border-ink-200 bg-white">
          <ul className="divide-y divide-ink-100">
            {data.map((u) => {
              const name = [u.first_name, u.last_name]
                .filter(Boolean)
                .join(' ');
              const saving = savingId === u.id;
              return (
                <li key={u.id} className="flex items-start gap-4 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink-900">
                      {name || u.email}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-500">
                      {u.email}
                      <span className="mx-1.5">·</span>
                      <span className="capitalize">{u.role}</span>
                      {u.status !== 'active' && (
                        <>
                          <span className="mx-1.5">·</span>
                          <span className="capitalize text-amber-600">
                            {u.status}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-ink-700">
                    <input
                      type="checkbox"
                      checked={u.can_view_owner_private}
                      disabled={saving}
                      onChange={(e) =>
                        setOwnerPrivate(u.id, e.target.checked)
                      }
                    />
                    <span className="whitespace-nowrap">
                      Can view owner-private clients
                    </span>
                    {saving && (
                      <span className="text-[11px] text-ink-400">Saving…</span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
