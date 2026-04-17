'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';

interface IntegrationStatus {
  provider: 'ups' | 'fedex' | 'usps' | 'docusign' | 'metals';
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
          {fields.map((f) => (
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
