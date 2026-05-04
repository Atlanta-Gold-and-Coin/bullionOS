'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';

interface IntegrationStatus {
  provider:
    | 'ups'
    | 'fedex'
    | 'usps'
    | 'docusign'
    | 'metals'
    | 'google_calendar'
    | 'greminders'
    | 'gmail'
    | 'aurbitrage'
    | 'ifs';
  label: string;
  configured: boolean;
  enabled: boolean;
  display_hint: string | null;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  updated_at: string | null;
  redacted_credentials: Record<string, string> | null;
}

/**
 * Field metadata used to render per-provider forms.
 *
 * `secret: true` → render as a password input; don't prefill with the redacted
 * value (the API never returns the real one). `area: true` → render as a textarea
 * for multi-line values like a PEM private key.
 */
const FIELDS: Record<
  IntegrationStatus['provider'],
  Array<{ name: string; label: string; placeholder?: string; secret?: boolean; area?: boolean; select?: string[] }>
> = {
  ups: [
    { name: 'client_id', label: 'Client ID', placeholder: 'from developer.ups.com' },
    { name: 'client_secret', label: 'Client Secret', secret: true },
    { name: 'account_number', label: 'Account number (optional)' },
    { name: 'environment', label: 'Environment', select: ['cie', 'production'] },
  ],
  fedex: [
    { name: 'api_key', label: 'API Key' },
    { name: 'secret_key', label: 'Secret Key', secret: true },
    { name: 'account_number', label: 'Account number' },
    { name: 'environment', label: 'Environment', select: ['sandbox', 'production'] },
  ],
  usps: [
    { name: 'consumer_key', label: 'Consumer Key' },
    { name: 'consumer_secret', label: 'Consumer Secret', secret: true },
    { name: 'crid', label: 'CRID (optional)' },
    { name: 'mid', label: 'MID (optional)' },
    { name: 'environment', label: 'Environment', select: ['test', 'production'] },
  ],
  docusign: [
    { name: 'integration_key', label: 'Integration Key (Client ID)' },
    { name: 'account_id', label: 'Account ID (GUID)' },
    { name: 'user_id', label: 'Impersonated User ID (GUID)' },
    { name: 'base_path', label: 'Base Path', placeholder: 'https://demo.docusign.net/restapi' },
    { name: 'private_key_pem', label: 'Private Key (PEM)', secret: true, area: true },
    { name: 'webhook_secret', label: 'Webhook Secret (optional)', secret: true },
    { name: 'template_buy_contract', label: 'Template ID — Buy Contract (optional)' },
    { name: 'template_sell_contract', label: 'Template ID — Sell Contract (optional)' },
  ],
  metals: [
    { name: 'api_key', label: 'metals.dev API key', secret: true, placeholder: 'from https://metals.dev' },
    { name: 'url', label: 'API URL', placeholder: 'https://api.metals.dev/v1/latest' },
  ],
  google_calendar: [
    {
      name: 'client_id',
      label: 'OAuth Client ID',
      placeholder: '…apps.googleusercontent.com',
    },
    { name: 'client_secret', label: 'OAuth Client Secret', secret: true },
    {
      name: 'calendar_id',
      label: 'Calendar ID',
      placeholder: 'primary (or a specific calendar id)',
    },
    {
      name: 'timezone',
      label: 'Timezone (IANA)',
      placeholder: 'America/New_York',
    },
    {
      name: 'booking_window_days',
      label: 'Booking window (days ahead)',
      placeholder: '30',
    },
    {
      name: 'slot_minutes',
      label: 'Slot size (minutes)',
      placeholder: '30',
    },
    { name: 'hours_mon', label: 'Mon hours', placeholder: '10:00-17:00' },
    { name: 'hours_tue', label: 'Tue hours', placeholder: '10:00-17:00' },
    { name: 'hours_wed', label: 'Wed hours', placeholder: '10:00-17:00' },
    { name: 'hours_thu', label: 'Thu hours', placeholder: '10:00-17:00' },
    { name: 'hours_fri', label: 'Fri hours', placeholder: '10:00-17:00' },
    { name: 'hours_sat', label: 'Sat hours', placeholder: 'blank = closed' },
    { name: 'hours_sun', label: 'Sun hours', placeholder: 'blank = closed' },
    {
      name: 'services',
      label: 'Services (semicolon-separated)',
      placeholder: 'Buy consultation;Sell consultation;Appraisal',
    },
  ],
  greminders: [
    {
      name: 'api_key',
      label: 'API Key',
      secret: true,
      placeholder: 'from developer.greminders.com → API Keys',
    },
    {
      name: 'impersonation_id',
      label: 'Impersonation User ID (optional)',
      placeholder: 'GReminders user id whose bookings we watch',
    },
    {
      name: 'webhook_secret',
      label: 'Webhook signing secret',
      secret: true,
      placeholder: 'Set in GReminders → Webhooks → Edit → Secret',
    },
  ],
  gmail: [
    {
      name: 'client_id',
      label: 'OAuth Client ID',
      placeholder: '…apps.googleusercontent.com (reuse Calendar client if same project)',
    },
    { name: 'client_secret', label: 'OAuth Client Secret', secret: true },
    {
      name: 'mailbox_email',
      label: 'Mailbox',
      placeholder: 'sales@yourcompany.com',
    },
    {
      name: 'sender_filter',
      label: 'Sender filter (Gmail query)',
      placeholder: 'from:sales@rarcoa.com',
    },
    {
      name: 'subject_filter',
      label: 'Extra Gmail filter (free-form — body or subject)',
      placeholder: '"goldsheet"',
    },
    {
      name: 'processed_label',
      label: 'Processed label',
      placeholder: 'RARCOA/Processed',
    },
    // poll_interval_minutes isn't exposed here — the cron cadence is
    // fixed at 15 min in GmailService.scheduledPoll and changing this
    // field wouldn't shift it. Left in the schema for future use.
  ],
  aurbitrage: [
    {
      name: 'api_key',
      label: 'Aurbitrage API key',
      secret: true,
      placeholder: 'ak_live_… (from your Aurbitrage account)',
    },
    {
      name: 'url',
      label: 'API base URL',
      placeholder: 'https://www.aurbitrage.com/api/v1',
    },
  ],
  ifs: [
    {
      name: 'app_user_name',
      label: 'AppUserName',
      placeholder: 'IFS API user name',
    },
    {
      name: 'app_password',
      label: 'AppPassword',
      secret: true,
      placeholder: 'IFS API password',
    },
    {
      name: 'account_id',
      label: 'Account ID',
      placeholder: 'Your IFS account_id',
    },
    {
      name: 'url',
      label: 'API base URL',
      placeholder: 'https://www.ifsclients.com/client-app-api',
    },
  ],
};

export default function IntegrationsPage() {
  const { data } = useQuery({
    queryKey: ['admin', 'integrations'],
    queryFn: () => apiFetch<IntegrationStatus[]>('/admin/integrations'),
  });

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">Integrations</h1>
      <p className="mt-1 text-sm text-ink-400">
        API credentials for shipping carriers and DocuSign. Stored encrypted at rest
        (AES-256-GCM). Admin-only.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        {(data ?? []).map((s) => (
          <ProviderCard key={s.provider} status={s} />
        ))}
      </div>
    </div>
  );
}

function ProviderCard({ status }: { status: IntegrationStatus }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'toggle' | 'delete'>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const fields = FIELDS[status.provider];

  function set(name: string, v: string) {
    setValues((p) => ({ ...p, [name]: v }));
  }

  async function save() {
    setMsg(null);
    setBusy('save');
    try {
      // Only send non-empty fields. Empty secret fields mean "don't change"
      // on the server's view, but since the PUT is a full upsert, we need
      // to require every required field on first config. The API validates.
      const payload: Record<string, string> = {};
      for (const f of fields) {
        const v = values[f.name] ?? '';
        if (v.trim() !== '') payload[f.name] = v.trim();
        // For select fields with a default, still send if unchanged.
        if (f.select && !payload[f.name]) payload[f.name] = f.select[0];
      }
      await apiFetch(`/admin/integrations/${status.provider}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      setEditing(false);
      setValues({});
      await qc.invalidateQueries({ queryKey: ['admin', 'integrations'] });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof ApiError ? err.message : 'Save failed' });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setMsg(null);
    setBusy('test');
    try {
      const r = await apiFetch<{ ok: boolean; message: string }>(
        `/admin/integrations/${status.provider}/test`,
        { method: 'POST' },
      );
      setMsg({ kind: r.ok ? 'ok' : 'err', text: r.message });
      await qc.invalidateQueries({ queryKey: ['admin', 'integrations'] });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof ApiError ? err.message : 'Test failed' });
    } finally {
      setBusy(null);
    }
  }

  async function toggleEnabled() {
    setBusy('toggle');
    try {
      await apiFetch(`/admin/integrations/${status.provider}/enabled`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !status.enabled }),
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'integrations'] });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!confirm(`Remove ${status.label} credentials?`)) return;
    setBusy('delete');
    try {
      await apiFetch(`/admin/integrations/${status.provider}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['admin', 'integrations'] });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-ink-200 bg-white p-5">
      <header className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold">{status.label}</h3>
          {status.display_hint && (
            <p className="mt-0.5 font-mono text-xs text-ink-400">{status.display_hint}</p>
          )}
        </div>
        <StatusBadge status={status} />
      </header>

      {status.configured && !editing && (
        <div className="mt-3 space-y-2 text-xs">
          {status.redacted_credentials &&
            Object.entries(status.redacted_credentials).map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-ink-100 py-1">
                <span className="text-ink-400">{k}</span>
                <span className="font-mono text-ink-800">{String(v)}</span>
              </div>
            ))}
          {status.last_tested_at && (
            <p className="mt-2 text-[11px] text-ink-400">
              last test:{' '}
              <span className={status.last_test_ok ? 'text-green-700' : 'text-red-700'}>
                {status.last_test_ok ? 'ok' : 'failed'}
              </span>{' '}
              · {new Date(status.last_tested_at).toLocaleString()}
              {status.last_test_message && (
                <span className="block font-mono text-[10px]">
                  {status.last_test_message.slice(0, 120)}
                </span>
              )}
            </p>
          )}
        </div>
      )}

      {editing && (
        <div className="mt-3 space-y-3">
          {fields
            // refresh_token comes from the OAuth callback, not the form.
            .filter((f) => f.name !== 'refresh_token')
            .map((f) => (
            <label key={f.name} className="block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-ink-500">
                {f.label}
              </span>
              {f.select ? (
                <select
                  value={values[f.name] ?? f.select[0]}
                  onChange={(e) => set(f.name, e.target.value)}
                  className="input mt-1"
                >
                  {f.select.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : f.area ? (
                <textarea
                  value={values[f.name] ?? ''}
                  onChange={(e) => set(f.name, e.target.value)}
                  className="input mt-1 font-mono text-xs"
                  rows={6}
                  placeholder={f.placeholder ?? ''}
                  autoComplete="off"
                />
              ) : (
                <input
                  type={f.secret ? 'password' : 'text'}
                  value={values[f.name] ?? ''}
                  onChange={(e) => set(f.name, e.target.value)}
                  className="input mt-1 font-mono text-sm"
                  placeholder={f.placeholder ?? ''}
                  autoComplete="off"
                />
              )}
            </label>
          ))}
        </div>
      )}

      {msg && (
        <div
          role="alert"
          className={`mt-3 rounded-md px-3 py-2 text-xs ${
            msg.kind === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          }`}
        >
          {msg.text}
        </div>
      )}

      {status.provider === 'google_calendar' && status.configured && (
        <GoogleCalendarActions
          authorized={Boolean(
            status.redacted_credentials?.refresh_token &&
              status.redacted_credentials.refresh_token !== '—',
          )}
        />
      )}

      {status.provider === 'gmail' && status.configured && (
        <GmailActions
          authorized={Boolean(
            status.redacted_credentials?.refresh_token &&
              status.redacted_credentials.refresh_token !== '—',
          )}
        />
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {editing ? (
          <>
            <button
              onClick={() => {
                setEditing(false);
                setValues({});
                setMsg(null);
              }}
              className="rounded-md border border-ink-200 px-3 py-1.5 text-xs hover:bg-ink-50"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={busy !== null}
              className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-60"
            >
              {busy === 'save' ? 'Saving…' : status.configured ? 'Replace' : 'Save'}
            </button>
          </>
        ) : (
          <>
            {status.configured && (
              <>
                <button
                  onClick={test}
                  disabled={busy !== null}
                  className="rounded-md border border-ink-200 px-3 py-1.5 text-xs hover:bg-ink-50"
                >
                  {busy === 'test' ? 'Testing…' : 'Test connection'}
                </button>
                <button
                  onClick={toggleEnabled}
                  disabled={busy !== null}
                  className="rounded-md border border-ink-200 px-3 py-1.5 text-xs hover:bg-ink-50"
                >
                  {status.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  onClick={remove}
                  disabled={busy !== null}
                  className="rounded-md border border-ink-200 px-3 py-1.5 text-xs text-red-700 hover:bg-red-50"
                >
                  Remove
                </button>
              </>
            )}
            <button
              onClick={() => setEditing(true)}
              className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800"
            >
              {status.configured ? 'Edit' : 'Configure'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Google Calendar OAuth kickoff. The authorize endpoint returns the
 * consent URL and the registered redirect_uri — we show both so the
 * admin can copy the redirect into the Google Cloud Console.
 */
function GoogleCalendarActions({ authorized }: { authorized: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [redirect, setRedirect] = useState<string | null>(null);

  async function kickoff() {
    setErr(null);
    setBusy(true);
    try {
      // Return to the full web URL, not just a path — the callback runs on
      // the API origin (Railway) and a relative redirect would 404 the
      // admin back onto the API host instead of the Next.js app.
      const returnTo = `${window.location.origin}/admin/integrations`;
      const r = await apiFetch<{ url: string; redirect_uri: string }>(
        `/admin/integrations/google_calendar/authorize?return_to=${encodeURIComponent(
          returnTo,
        )}`,
      );
      setRedirect(r.redirect_uri);
      window.location.href = r.url;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Authorize failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-ink-100 bg-ink-50/40 p-3 text-xs">
      <p className="text-ink-600">
        {authorized
          ? 'Authorized. Re-run if you need to switch the Sales mailbox or re-grant scope.'
          : 'Save the client id + secret above, then click below to authorize as the Sales mailbox.'}
      </p>
      <p className="mt-1 text-[11px] text-ink-400">
        Google Cloud Console redirect URI must include this exact path:
        <code className="ml-1 block break-all bg-white px-2 py-1 font-mono text-[10px]">
          {redirect ?? `${window.location.origin}/api/v1/admin/integrations/google_calendar/callback`}
        </code>
      </p>
      <button
        onClick={kickoff}
        disabled={busy}
        className="mt-2 rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-60"
      >
        {busy ? 'Opening Google…' : authorized ? 'Re-authorize with Google' : 'Authorize with Google'}
      </button>
      {err && (
        <div role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-[11px] text-red-700">
          {err}
        </div>
      )}
    </div>
  );
}

/**
 * Gmail OAuth kickoff. Mirrors GoogleCalendarActions — separate because
 * the authorize endpoint path differs (`/admin/integrations/gmail/...`)
 * and the help copy is different (mailbox-polling context vs booking).
 */
function GmailActions({ authorized }: { authorized: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [redirect, setRedirect] = useState<string | null>(null);

  async function kickoff() {
    setErr(null);
    setBusy(true);
    try {
      const returnTo = `${window.location.origin}/admin/integrations`;
      const r = await apiFetch<{ url: string; redirect_uri: string }>(
        `/admin/integrations/gmail/authorize?return_to=${encodeURIComponent(returnTo)}`,
      );
      setRedirect(r.redirect_uri);
      window.location.href = r.url;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Authorize failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-ink-100 bg-ink-50/40 p-3 text-xs">
      <p className="text-ink-600">
        {authorized
          ? 'Authorized. Re-run if you switch the Sales mailbox or need to re-grant the Gmail scope.'
          : 'Save the client id + secret above, then click below to authorize as the Sales mailbox. The poller checks every 15 min for a new RARCOA goldsheet email.'}
      </p>
      <p className="mt-1 text-[11px] text-ink-400">
        Google Cloud Console redirect URI must include this exact path:
        <code className="ml-1 block break-all bg-white px-2 py-1 font-mono text-[10px]">
          {redirect ?? `${window.location.origin}/api/v1/admin/integrations/gmail/callback`}
        </code>
      </p>
      <p className="mt-1 text-[11px] text-ink-400">
        Required scope on the OAuth consent screen:
        <code className="ml-1 bg-white px-1.5 py-0.5 font-mono text-[10px]">
          gmail.modify
        </code>
      </p>
      <button
        onClick={kickoff}
        disabled={busy}
        className="mt-2 rounded-md bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-60"
      >
        {busy ? 'Opening Google…' : authorized ? 'Re-authorize Gmail' : 'Authorize Gmail'}
      </button>
      {err && (
        <div role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-[11px] text-red-700">
          {err}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: IntegrationStatus }) {
  if (!status.configured) {
    return (
      <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-500">
        not configured
      </span>
    );
  }
  if (!status.enabled) {
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
        disabled
      </span>
    );
  }
  if (status.last_test_ok === true) {
    return (
      <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700">
        active
      </span>
    );
  }
  if (status.last_test_ok === false) {
    return (
      <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">
        test failed
      </span>
    );
  }
  return (
    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
      untested
    </span>
  );
}
