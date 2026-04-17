'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';

interface PublicConfig {
  configured: boolean;
  services: string[];
  timezone: string;
  bookingWindowDays: number;
  slotMinutes: number;
}

interface Slot {
  start: string;
  end: string;
}

/**
 * Public appointment booking at /book.
 *
 * Flow:
 *   1. Load /public/calendar/config to learn services + window + slot size.
 *   2. Pick a service + a date from the next N days.
 *   3. Fetch /public/calendar/slots?date=YYYY-MM-DD. Slot grid renders
 *      what's free after subtracting Google FreeBusy.
 *   4. Fill in name + email + phone + notes. POST /public/calendar/book.
 *   5. On success show a confirmation — Google sends its own email
 *      invitation to the booker automatically.
 *
 * Everything happens on the Sales mailbox's primary calendar (or whichever
 * calendar the admin configured in /admin/integrations).
 */
export default function BookPage() {
  const { data: config, isLoading, isError } = useQuery({
    queryKey: ['public', 'calendar', 'config'],
    queryFn: () => apiFetch<PublicConfig>('/public/calendar/config'),
  });

  const [service, setService] = useState<string>('');
  const [dateIso, setDateIso] = useState<string>(todayIso());
  const [chosenStart, setChosenStart] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ start: string } | null>(null);

  // Pick the first service as the default once config lands.
  useMemo(() => {
    if (config?.services.length && !service) setService(config.services[0]);
  }, [config, service]);

  const { data: slotsData, isFetching: slotsLoading } = useQuery({
    queryKey: ['public', 'calendar', 'slots', dateIso],
    queryFn: () =>
      apiFetch<{ slots: Slot[]; timezone: string }>(
        `/public/calendar/slots?date=${dateIso}`,
      ),
    enabled: Boolean(config?.configured) && !confirmed,
  });

  const dateOptions = useMemo(() => {
    if (!config?.bookingWindowDays) return [];
    return buildDateOptions(config.bookingWindowDays);
  }, [config]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!chosenStart || !service || !name || !email) {
      setError('Fill in every field and pick a time slot.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch('/public/calendar/book', {
        method: 'POST',
        body: JSON.stringify({
          service,
          start: chosenStart,
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          notes: notes.trim() || undefined,
        }),
      });
      setConfirmed({ start: chosenStart });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Booking failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (isLoading) {
    return <Shell><p className="text-sm text-ink-400">Loading…</p></Shell>;
  }
  if (isError || !config || !config.configured) {
    return (
      <Shell>
        <p className="text-sm text-ink-600">
          Online booking is being set up. Please call us at 404-236-9744 or
          email sales@atlantagoldandcoinbuyers.com and we&rsquo;ll schedule you
          directly.
        </p>
      </Shell>
    );
  }

  if (confirmed) {
    return (
      <Shell>
        <div className="rounded-xl border border-sell-200 bg-sell-50 p-6">
          <h2 className="text-lg font-semibold text-sell-700">You&rsquo;re booked.</h2>
          <p className="mt-2 text-sm text-ink-700">
            We&rsquo;ve added{' '}
            <span className="font-medium">
              {new Date(confirmed.start).toLocaleString(undefined, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                timeZoneName: 'short',
              })}
            </span>{' '}
            to our calendar. A confirmation is on its way to {email}. If you
            need to reschedule, just reply to that email or call us.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <form onSubmit={submit} className="space-y-6">
        <section className="rounded-xl border border-ink-200 bg-white p-5">
          <label className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Service
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            {config.services.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setService(s)}
                className={`rounded-md border px-3 py-1.5 text-sm transition ${
                  service === s
                    ? 'border-ink-900 bg-ink-900 text-white'
                    : 'border-ink-200 text-ink-700 hover:bg-ink-50'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-ink-200 bg-white p-5">
          <label className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Date
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            {dateOptions.map((d) => (
              <button
                key={d.iso}
                type="button"
                onClick={() => {
                  setDateIso(d.iso);
                  setChosenStart(null);
                }}
                className={`rounded-md border px-3 py-1.5 text-xs transition ${
                  dateIso === d.iso
                    ? 'border-ink-900 bg-ink-900 text-white'
                    : 'border-ink-200 text-ink-700 hover:bg-ink-50'
                }`}
              >
                <div className="font-medium">{d.label}</div>
                <div className="text-[10px] opacity-80">{d.sub}</div>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-ink-200 bg-white p-5">
          <label className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Time ({slotsData?.timezone ?? config.timezone})
          </label>
          {slotsLoading ? (
            <p className="mt-2 text-sm text-ink-400">Loading times…</p>
          ) : slotsData?.slots.length === 0 ? (
            <p className="mt-2 text-sm text-ink-400">
              No open slots on this day. Try a different date.
            </p>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(slotsData?.slots ?? []).map((s) => (
                <button
                  key={s.start}
                  type="button"
                  onClick={() => setChosenStart(s.start)}
                  className={`rounded-md border px-3 py-2 text-sm transition ${
                    chosenStart === s.start
                      ? 'border-ink-900 bg-ink-900 text-white'
                      : 'border-ink-200 hover:bg-ink-50'
                  }`}
                >
                  {new Date(s.start).toLocaleTimeString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-ink-200 bg-white p-5">
          <label className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Your details
          </label>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              required
              className="input"
              maxLength={200}
            />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              required
              className="input"
              maxLength={254}
            />
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Phone (optional)"
              className="input"
              maxLength={40}
            />
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything we should know? (what you're looking to buy or sell, rough quantity, etc.)"
            rows={3}
            className="input mt-3"
            maxLength={2000}
          />
        </section>

        {error && (
          <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !chosenStart}
          className="w-full rounded-md bg-ink-900 px-4 py-3 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {submitting
            ? 'Booking…'
            : chosenStart
              ? `Confirm ${new Date(chosenStart).toLocaleString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}`
              : 'Pick a time slot above'}
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Book an appointment</h1>
        <p className="mt-1 text-sm text-ink-400">
          Atlanta Gold and Coin · 8480 Holcomb Bridge Rd #200 · Alpharetta, GA ·
          404-236-9744
        </p>
      </header>
      {children}
    </main>
  );
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildDateOptions(windowDays: number) {
  const out: Array<{ iso: string; label: string; sub: string }> = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({
      iso,
      label: d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }),
      sub: d.toLocaleDateString(undefined, { month: 'short' }),
    });
  }
  return out;
}
