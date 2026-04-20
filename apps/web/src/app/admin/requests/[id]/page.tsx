'use client';

/**
 * Deep-link target for deal-request notifications.
 *
 * Notifications are fan-out: every admin + staff gets their own row
 * pointing at `/admin/requests/{id}`. When a teammate accepts or rejects
 * the request first, the DB row still exists (status changes, not
 * deleted) — so a naive page would 404 only when the underlying record
 * was purged for some other reason. The real failure mode this page
 * handles is:
 *
 *   (a) there was no route at /admin/requests/[id] until now, so
 *       clicking *any* notification 404'd with Next's default error
 *       page — regardless of whether anyone else had clicked it;
 *   (b) if the request really is gone (hard-delete via client
 *       self-service or admin cleanup), we want a friendly explainer
 *       instead of the generic 404.
 *
 * Behavior:
 *   - Fetches GET /admin/deal-requests/:id.
 *   - On success, redirects to /admin/requests?status=<status>#req-<id>
 *     so the item is surfaced in the right tab with the rest of the
 *     list. The list view is the source of truth for accept/reject
 *     actions; we don't duplicate that UI here.
 *   - On 404/403, renders a friendly "Already handled" card with a
 *     link back to the list instead of a hard error.
 */

import { use, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';

interface AdminDealRequest {
  id: string;
  status: 'pending' | 'accepted' | 'rejected';
  client_name: string;
  product_name: string | null;
  created_at: string;
}

export default function RequestDeepLinkPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { data, error, isLoading } = useQuery({
    queryKey: ['admin', 'deal-request', id],
    queryFn: () => apiFetch<AdminDealRequest>(`/admin/deal-requests/${id}`),
    // Notifications can be old; don't thrash the API if nav bounces.
    retry: false,
  });

  useEffect(() => {
    if (!data) return;
    // Bounce to the list tab that matches the request's current state
    // so the operator lands on the card they were trying to reach.
    router.replace(`/admin/requests?status=${data.status}#req-${data.id}`);
  }, [data, router]);

  if (isLoading) {
    return <div className="text-sm text-ink-400">Loading request…</div>;
  }

  const status = error instanceof ApiError ? error.status : null;
  if (status === 404 || status === 403) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-ink-200 bg-white p-6 text-sm">
        <h1 className="text-base font-semibold">Request no longer available</h1>
        <p className="mt-2 text-ink-600">
          This deal request may have been removed, or you don&apos;t have access
          to it. If a teammate already accepted or rejected it, it will still
          appear on the main list under the matching tab.
        </p>
        <div className="mt-4">
          <Link
            href="/admin/requests"
            className="inline-block rounded-md bg-ink-900 px-3 py-1.5 text-white hover:bg-ink-800"
          >
            Back to all requests
          </Link>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
        Failed to load request: {(error as Error).message}
      </div>
    );
  }

  // data loaded; useEffect above is redirecting — render a brief placeholder
  return <div className="text-sm text-ink-400">Opening request…</div>;
}
