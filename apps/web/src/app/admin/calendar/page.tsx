'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';

interface CalendarEvent {
  id: string;
  summary: string;
  location: string | null;
  htmlLink: string | null;
  start: string;
  end: string;
  status: string;
  attendees: Array<{
    email: string;
    name: string | null;
    responseStatus: string | null;
  }>;
}

type Range = 'today' | '7d' | '30d' | '90d';

const RANGES: Array<{ id: Range; label: string; days: number }> = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
];

/**
 * Admin calendar view. Reads events from the Sales Google Calendar via
 * /admin/calendar/events and exposes a "New event" form that creates
 * unrestricted events (any duration, any attendees, any service label).
 *
 * The public /book page and this page share the exact same calendar, so
 * slot availability stays consistent — if an admin blocks off 2 pm here
 * the booking page won't offer it.
 */
export default function AdminCalendarPage() {
  const qc = useQueryClient();
  const [range, setRange] = useState<Range>('7d');
  const [showForm, setShowForm] = useState(false);

  const { from, to } = useMemo(() => {
    const now = new Date();
    // Start of today, local time.
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = RANGES.find((r) => r.id === range)!.days;
    const end = new Date(start.getTime() + days * 24 * 3600 * 1000);
    return { from: start.toISOString(), to: end.toISOString() };
  }, [range]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'calendar', 'events', range],
    queryFn: () =>
      apiFetch<{ events: CalendarEvent[] }>(
        `/admin/calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ),
    refetchInterval: 60_000,
  });

  const grouped = useMemo(
    () => groupByDay(data?.events ?? []),
    [data],
  );

  async function cancel(id: string) {
    if (!confirm('Cancel this event? Attendees will get a notification email.')) return;
    try {
      await apiFetch(`/admin/calendar/events/${id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['admin', 'calendar', 'events'] });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Cancel failed');
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Calendar</h1>
          <p className="mt-1 text-sm text-ink-400">
            Events on the Sales Google Calendar. Creating one here lands it
            directly on <span className="font-mono">sales@atlantagoldandcoinbuyers.com</span>{' '}
            and sends invites to any attendees.
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800"
        >
          {showForm ? 'Close' : 'New event'}
        </button>
      </div>

      {showForm && (
        <NewEventForm
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ['admin', 'calendar', 'events'] });
            setShowForm(false);
          }}
        />
      )}

      <nav className="mt-6 inline-flex rounded-md border border-ink-200 bg-white p-1 text-sm">
        {RANGES.map((r) => (
          <button
            key={r.id}
            onClick={() => setRange(r.id)}
            className={`rounded px-3 py-1.5 transition ${
              range === r.id
                ? 'bg-ink-900 text-white'
                : 'text-ink-600 hover:text-ink-900'
            }`}
          >
            {r.label}
          </button>
        ))}
      </nav>

      {error && (
        <div role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {(error as ApiError).message ?? 'Failed to load events'}
        </div>
      )}

      {isLoading ? (
        <div className="mt-6 rounded-xl border border-ink-200 bg-white p-8 text-center text-sm text-ink-400">
          Loading…
        </div>
      ) : grouped.length === 0 ? (
        <div className="mt-6 rounded-xl border border-ink-200 bg-white p-8 text-center text-sm text-ink-400">
          No events in this range.
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {grouped.map((g) => (
            <section key={g.dayIso}>
              <h2 className="mb-2 text-sm font-semibold text-ink-700">
                {new Date(g.dayIso).toLocaleDateString(undefined, {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                })}
              </h2>
              <div className="overflow-hidden rounded-xl border border-ink-200 bg-white">
                {g.events.map((ev) => (
                  <EventRow key={ev.id} event={ev} onCancel={() => cancel(ev.id)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({
  event,
  onCancel,
}: {
  event: CalendarEvent;
  onCancel: () => void;
}) {
  const start = new Date(event.start);
  const end = new Date(event.end);
  return (
    <div className="grid grid-cols-12 items-start gap-4 border-b border-ink-100 px-4 py-3 last:border-b-0 hover:bg-ink-50/50">
      <div className="col-span-3 font-mono text-xs text-ink-600">
        {fmtTime(start)} – {fmtTime(end)}
      </div>
      <div className="col-span-7">
        <div className="font-medium">{event.summary}</div>
        {event.location && (
          <div className="text-xs text-ink-400">📍 {event.location}</div>
        )}
        {event.attendees.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
            {event.attendees.slice(0, 6).map((a) => (
              <span
                key={a.email}
                className={`rounded-full px-2 py-0.5 ${
                  a.responseStatus === 'accepted'
                    ? 'bg-green-100 text-green-700'
                    : a.responseStatus === 'declined'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-ink-100 text-ink-600'
                }`}
              >
                {a.name ?? a.email}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="col-span-2 text-right text-xs">
        {event.htmlLink && (
          <a
            href={event.htmlLink}
            target="_blank"
            rel="noopener noreferrer"
            className="mr-2 text-ink-600 hover:text-ink-900"
          >
            Open ↗
          </a>
        )}
        <button
          onClick={onCancel}
          className="text-red-600 hover:text-red-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function NewEventForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(todayIso());
  const [startTime, setStartTime] = useState(nextHourLabel());
  const [durationMin, setDurationMin] = useState(30);
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [attendeesRaw, setAttendeesRaw] = useState(''); // comma-separated emails
  const [notify, setNotify] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    // Build ISO timestamps from the local <input type="date"> + <input type="time">
    // by treating the values as local wall-clock and letting the browser JS
    // Date constructor apply the viewer's timezone. If you need ET precisely,
    // set your machine/browser to that tz, or extend to accept tz explicitly.
    const startLocal = new Date(`${date}T${startTime}:00`);
    const endLocal = new Date(startLocal.getTime() + durationMin * 60 * 1000);
    if (Number.isNaN(startLocal.getTime())) {
      setError('Invalid date/time');
      return;
    }
    const attendees = attendeesRaw
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter((s) => s.includes('@'))
      .map((email) => ({ email }));
    setSubmitting(true);
    try {
      await apiFetch('/admin/calendar/events', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          start: startLocal.toISOString(),
          end: endLocal.toISOString(),
          location: location.trim() || undefined,
          description: description.trim() || undefined,
          attendees: attendees.length ? attendees : undefined,
          sendUpdates: notify ? 'all' : 'none',
        }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mt-4 space-y-4 rounded-xl border border-ink-200 bg-white p-5"
    >
      <div>
        <label className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Title
        </label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Coin show · OoO · Appointment with Hunter"
          className="input mt-1"
          maxLength={300}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <label className="block text-xs font-semibold uppercase tracking-wide text-ink-400 sm:col-span-2">
          Date
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="input mt-1 font-mono"
          />
        </label>
        <label className="block text-xs font-semibold uppercase tracking-wide text-ink-400">
          Start
          <input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="input mt-1 font-mono"
          />
        </label>
        <label className="block text-xs font-semibold uppercase tracking-wide text-ink-400">
          Duration
          <select
            value={durationMin}
            onChange={(e) => setDurationMin(Number(e.target.value))}
            className="input mt-1"
          >
            {[15, 30, 45, 60, 90, 120, 180, 240, 480].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} min` : `${m / 60} h`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div>
        <label className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Location (optional)
        </label>
        <input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Store, Zoom link, address…"
          className="input mt-1"
          maxLength={400}
        />
      </div>
      <div>
        <label className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Attendees (optional · comma-separated emails)
        </label>
        <input
          value={attendeesRaw}
          onChange={(e) => setAttendeesRaw(e.target.value)}
          placeholder="client@example.com, broker@example.com"
          className="input mt-1"
        />
      </div>
      <div>
        <label className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Notes (optional)
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="input mt-1"
          maxLength={5000}
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-700">
        <input
          type="checkbox"
          checked={notify}
          onChange={(e) => setNotify(e.target.checked)}
        />
        Email invitations to attendees
      </label>
      {error && (
        <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {submitting ? 'Creating…' : 'Create event'}
        </button>
      </div>
    </form>
  );
}

function groupByDay(
  events: CalendarEvent[],
): Array<{ dayIso: string; events: CalendarEvent[] }> {
  const map = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const d = new Date(ev.start);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(ev);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dayIso, events]) => ({ dayIso, events }));
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Next hour on the clock, e.g. "14:00". */
function nextHourLabel(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return `${String(d.getHours()).padStart(2, '0')}:00`;
}
