'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import { useAppSettings } from '@/lib/use-app-settings';

interface PublicConfig {
  configured: boolean;
  /** Raw service labels persisted in integrations (e.g. "Buy Appointment"). */
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
 * UI tiers:
 *
 *   Top-level type (3 buttons)
 *     ─ Buy Appointment
 *     ─ Sell Appointment
 *     ─ Appraisal  ───▶ Required sub-choice:
 *                          ─ Appraisal Only
 *                          ─ Appraisal with Intent to Sell
 *
 * Server-side the admin configures ALL of these as literal service names
 * (see integrations_registry "services" default). The selected sub-choice
 * is what's submitted; the top-level "Appraisal" button is only a grouping
 * in the form.
 *
 * Appraisal bookings are auto-upgraded to a 60-minute block server-side
 * (calendar.controller.ts → `isAppraisal` branch).
 */
type TopService = 'buy' | 'sell' | 'appraisal';
type AppraisalKind = 'only' | 'with_intent';

const APPRAISAL_ONLY = 'Appraisal Only';
const APPRAISAL_WITH_INTENT = 'Appraisal with Intent to Sell';
const APPRAISAL_DISCLAIMER =
  'Please note, Appraisals that do not result in the sale of at least 50% of the collection\u2019s value (no obligation) are billed at $350/hr with a minimum of 1 hour.';

export default function BookPage() {
  const { data: appSettings } = useAppSettings();
  const branding = appSettings?.branding;
  const { data: config, isLoading, isError } = useQuery({
    queryKey: ['public', 'calendar', 'config'],
    queryFn: () => apiFetch<PublicConfig>('/public/calendar/config'),
  });

  const [topService, setTopService] = useState<TopService | null>(null);
  const [appraisalKind, setAppraisalKind] = useState<AppraisalKind | null>(null);
  const [dateIso, setDateIso] = useState<string>(todayIso());
  const [chosenStart, setChosenStart] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ start: string } | null>(null);

  // Resolve the final server-side service label from the two-level picker.
  const selectedService = useMemo(() => {
    if (topService === 'buy') return resolveServiceLabel(config?.services, 'buy', 'Buy Appointment');
    if (topService === 'sell') return resolveServiceLabel(config?.services, 'sell', 'Sell Appointment');
    if (topService === 'appraisal') {
      if (appraisalKind === 'only') return APPRAISAL_ONLY;
      if (appraisalKind === 'with_intent') return APPRAISAL_WITH_INTENT;
    }
    return null;
  }, [topService, appraisalKind, config?.services]);

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

  // Appraisals lock out 60-min slots. The server re-validates (grabs any
  // adjacent slot too) but hiding non-aligned slots up front avoids
  // wasted round-trips. 30-min granularity is still fine since the
  // server just extends the end time.
  //
  // Keep all slots visible for buy/sell.
  const slotsToShow = slotsData?.slots ?? [];

  useEffect(() => {
    // Reset sub-choice when top-level service changes.
    if (topService !== 'appraisal') setAppraisalKind(null);
  }, [topService]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!selectedService) {
      setError('Pick the type of appointment first.');
      return;
    }
    if (!chosenStart) {
      setError('Pick a time slot.');
      return;
    }
    if (!name.trim() || !email.trim()) {
      setError('Name and email are required.');
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch('/public/calendar/book', {
        method: 'POST',
        body: JSON.stringify({
          service: selectedService,
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
    const phone = branding?.phone;
    const website = branding?.website;
    return (
      <Shell>
        <p className="text-sm text-ink-600">
          Online booking is being set up. Please contact us
          {phone ? <> at {phone}</> : null}
          {website ? <> or visit {website}</> : null}
          {' '}and we&rsquo;ll schedule you directly.
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

  const isAppraisal = topService === 'appraisal';

  return (
    <Shell>
      <form onSubmit={submit} className="space-y-6">
        <section className="rounded-xl border border-ink-200 bg-white p-5">
          <label className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Type of appointment
          </label>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <TopServiceButton
              active={topService === 'buy'}
              onClick={() => setTopService('buy')}
              label="Buy Appointment"
              sub="Purchase from our inventory"
            />
            <TopServiceButton
              active={topService === 'sell'}
              onClick={() => setTopService('sell')}
              label="Sell Appointment"
              sub="Bring items for us to buy"
            />
            <TopServiceButton
              active={topService === 'appraisal'}
              onClick={() => setTopService('appraisal')}
              label="Appraisal"
              sub="Professional valuation"
            />
          </div>

          {isAppraisal && (
            <div className="mt-4 rounded-md border border-ink-200 bg-ink-50/60 p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-600">
                Appraisal type <span className="text-red-600">*</span>
              </div>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <SubChoiceButton
                  active={appraisalKind === 'only'}
                  onClick={() => setAppraisalKind('only')}
                  label={APPRAISAL_ONLY}
                />
                <SubChoiceButton
                  active={appraisalKind === 'with_intent'}
                  onClick={() => setAppraisalKind('with_intent')}
                  label={APPRAISAL_WITH_INTENT}
                />
              </div>
              <p className="mt-3 text-xs font-medium text-red-600">
                {APPRAISAL_DISCLAIMER}
              </p>
              <p className="mt-2 text-xs text-ink-500">
                Appraisal appointments are scheduled for a full hour.
              </p>
            </div>
          )}
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
          ) : slotsToShow.length === 0 ? (
            <p className="mt-2 text-sm text-ink-400">
              No open slots on this day. Try a different date.
            </p>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {slotsToShow.map((s) => (
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
            <div>
              <label className="text-xs text-ink-500">
                Full name <span className="text-red-600">*</span>
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="input mt-1"
                maxLength={200}
              />
            </div>
            <div>
              <label className="text-xs text-ink-500">
                Email <span className="text-red-600">*</span>
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="input mt-1"
                maxLength={254}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="text-xs text-ink-500">Phone (optional)</label>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="input mt-1"
                maxLength={40}
              />
            </div>
          </div>
          <label className="mt-3 block text-xs text-ink-500">
            Anything we should know? (what you&rsquo;re looking to buy or sell, rough quantity, etc.)
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="input mt-1"
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
          disabled={submitting || !chosenStart || !selectedService}
          className="w-full rounded-md bg-ink-900 px-4 py-3 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {submitting
            ? 'Booking…'
            : chosenStart && selectedService
              ? `Confirm ${selectedService} — ${new Date(chosenStart).toLocaleString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}`
              : topService === 'appraisal' && !appraisalKind
                ? 'Select an appraisal type above'
                : !topService
                  ? 'Pick an appointment type above'
                  : 'Pick a time slot above'}
        </button>
      </form>
    </Shell>
  );
}

function TopServiceButton({
  active,
  onClick,
  label,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-start gap-1 rounded-md border p-4 text-left transition ${
        active
          ? 'border-ink-900 bg-ink-900 text-white'
          : 'border-ink-200 text-ink-700 hover:bg-ink-50'
      }`}
    >
      <span className="text-sm font-semibold">{label}</span>
      <span className={`text-xs ${active ? 'text-ink-200' : 'text-ink-500'}`}>
        {sub}
      </span>
    </button>
  );
}

function SubChoiceButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-3 py-2 text-sm transition ${
        active
          ? 'border-ink-900 bg-ink-900 text-white'
          : 'border-ink-200 text-ink-700 hover:bg-ink-50'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Map a top-level service choice to whichever label the admin actually
 * configured in /admin/integrations. Defaults to the expected label if
 * no match is found — keeps booking working even when the admin renames
 * a service, as long as the intent is obvious from the first word.
 */
function resolveServiceLabel(
  services: string[] | undefined,
  kind: 'buy' | 'sell',
  fallback: string,
): string {
  if (!services) return fallback;
  const keyword = kind === 'buy' ? 'buy' : 'sell';
  const match = services.find((s) => s.toLowerCase().startsWith(keyword));
  return match ?? fallback;
}

function Shell({ children }: { children: React.ReactNode }) {
  // Shell is rendered both on the loading path AND the error path,
  // so it pulls branding itself rather than relying on the parent
  // BookPage having reached its body. useAppSettings is cached.
  const { data: appSettings } = useAppSettings();
  const branding = appSettings?.branding;
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Book an appointment</h1>
        <p className="mt-1 text-sm text-ink-400">
          {[
            branding?.company_name,
            branding?.address_line1,
            branding?.address_city_state_zip,
            branding?.phone,
          ]
            .filter(Boolean)
            .join(' · ')}
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
