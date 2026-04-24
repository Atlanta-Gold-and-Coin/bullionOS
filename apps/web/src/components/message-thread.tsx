'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';

interface Message {
  id: string;
  deal_request_id: string;
  author_user_id: string;
  author_role: 'admin' | 'staff' | 'client';
  author_name: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

/**
 * Deal-request message thread. Same component for both sides — the server
 * enforces access and marks the opposite side's posts as read on GET.
 */
export function MessageThread({
  requestId,
  viewerRole,
}: {
  requestId: string;
  viewerRole: 'admin' | 'staff' | 'client';
}) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ref for the scroll container so we can pin to the newest message
  // on open + when a new message arrives.
  const scrollRef = useRef<HTMLDivElement>(null);
  // Tracked across renders: has the very first scroll-to-bottom happened
  // yet (false until messages first arrive), and was the user sitting
  // near the bottom at the time of the last scroll event. We only
  // auto-scroll on new messages if they're near the bottom already —
  // otherwise we'd yank them out of reading older history mid-scroll.
  const didInitialScrollRef = useRef(false);
  const isNearBottomRef = useRef(true);

  const { data } = useQuery({
    queryKey: ['messages', requestId],
    queryFn: () => apiFetch<Message[]>(`/deal-requests/${requestId}/messages`),
    refetchInterval: 15_000,
  });

  async function send() {
    const text = body.trim();
    if (!text) return;
    setError(null);
    setBusy(true);
    try {
      await apiFetch(`/deal-requests/${requestId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: text }),
      });
      setBody('');
      // Always scroll after the user sends — the message they just
      // typed should appear in view regardless of where they were.
      isNearBottomRef.current = true;
      await qc.invalidateQueries({ queryKey: ['messages', requestId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Send failed');
    } finally {
      setBusy(false);
    }
  }

  const messages = data ?? [];

  // Auto-scroll to bottom:
  //   - On first load, as soon as messages arrive (the "default" UX)
  //   - On every new message, only if the user was already near the
  //     bottom (within ~50px). React Query's poll refetch triggers this
  //     too, so incoming admin replies land in view for a user who just
  //     had the thread open.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (messages.length === 0) return;
    if (!didInitialScrollRef.current || isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      didInitialScrollRef.current = true;
    }
  }, [messages.length]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    // 50px leeway — small overshoot (just scrolled past the last msg
    // and rubber-banded) still counts as "near bottom".
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }

  return (
    <div className="mt-3 rounded-md border border-ink-200 bg-ink-50/40 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
        Thread
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1"
      >
        {messages.length === 0 && (
          <p className="text-xs text-ink-400">No messages yet.</p>
        )}
        {messages.map((m) => {
          const mine = viewerRole === m.author_role ||
            (viewerRole !== 'client' && m.author_role !== 'client');
          return (
            <div
              key={m.id}
              className={`flex ${mine ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                  mine
                    ? 'bg-ink-900 text-white'
                    : 'bg-white text-ink-900 ring-1 ring-ink-200'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wide opacity-70">
                    {m.author_role === 'client' ? m.author_name : 'AGC'}
                  </span>
                  <span className="text-[10px] opacity-50">
                    {new Date(m.created_at).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex gap-2">
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Type a message…"
          className="input flex-1 text-sm"
          maxLength={4000}
        />
        <button
          onClick={send}
          disabled={busy || !body.trim()}
          className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {busy ? '…' : 'Send'}
        </button>
      </div>
      {error && (
        <div className="mt-2 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
