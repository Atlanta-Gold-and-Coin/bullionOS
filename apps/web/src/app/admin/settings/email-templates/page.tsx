'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';

/**
 * Email template editor.
 *
 * Operator-editable copy for every system-generated email AGC Desk
 * sends. Each entry in the backend's EMAIL_TEMPLATE_REGISTRY lists:
 *   - default subject + body
 *   - the stored override (if any)
 *   - the variables available to the template
 *
 * UX rules:
 *   - When no override is set, the inputs are pre-filled with the
 *     defaults so operators can iterate from there.
 *   - "Restore default" clears the override (server deletes the
 *     app_settings rows); the preview falls back to the default.
 *   - A live preview panel renders the template with sample values
 *     so operators can see formatting before saving.
 *   - Admin-only — this page is under /admin/settings/.
 */

interface TemplateVariable {
  key: string;
  description: string;
}

interface EmailTemplate {
  slug: string;
  label: string;
  description: string;
  default_subject: string;
  default_body: string;
  variables: TemplateVariable[];
  current_subject: string | null;
  current_body: string | null;
}

const SAMPLE_VARS: Record<string, string> = {
  client_name: 'David Williams',
  invoice_number: '2026-000123',
  doc_label: 'invoice',
  type: 'sell',
  total: '4,821.50',
  status: 'paid',
  company_name: 'Your Company',
};

export default function EmailTemplatesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'email-templates'],
    queryFn: () =>
      apiFetch<EmailTemplate[]>('/admin/settings/email-templates'),
  });

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">Email templates</h1>
      <p className="mt-1 text-sm text-ink-400">
        Copy for every system-sent email. Variables in{' '}
        <code className="rounded bg-ink-100 px-1 font-mono">{'{{double_braces}}'}</code>{' '}
        are substituted at send time. Unrecognized placeholders stay
        visible as-is so typos are obvious in the preview.
      </p>

      {isLoading ? (
        <p className="mt-8 text-sm text-ink-400">Loading…</p>
      ) : (
        <div className="mt-8 space-y-10">
          {(data ?? []).map((t) => (
            <TemplateEditor key={t.slug} template={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateEditor({ template }: { template: EmailTemplate }) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState(
    template.current_subject ?? template.default_subject,
  );
  const [body, setBody] = useState(
    template.current_body ?? template.default_body,
  );
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(
    null,
  );

  const dirty =
    subject !== (template.current_subject ?? template.default_subject) ||
    body !== (template.current_body ?? template.default_body);
  const overriden =
    template.current_subject !== null || template.current_body !== null;

  async function save() {
    setBusy('save');
    setFlash(null);
    try {
      await apiFetch(`/admin/settings/email-templates/${template.slug}`, {
        method: 'PATCH',
        body: JSON.stringify({ subject, body }),
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'email-templates'] });
      setFlash({ kind: 'ok', msg: 'Saved.' });
    } catch (e) {
      setFlash({
        kind: 'err',
        msg: e instanceof ApiError ? e.message : 'Save failed',
      });
    } finally {
      setBusy(null);
    }
  }

  async function restore() {
    if (
      !confirm(
        'Restore the default subject and body for this template? Your current overrides will be deleted.',
      )
    )
      return;
    setBusy('reset');
    setFlash(null);
    try {
      await apiFetch(`/admin/settings/email-templates/${template.slug}`, {
        method: 'PATCH',
        body: JSON.stringify({ subject: null, body: null }),
      });
      setSubject(template.default_subject);
      setBody(template.default_body);
      await qc.invalidateQueries({ queryKey: ['admin', 'email-templates'] });
      setFlash({ kind: 'ok', msg: 'Restored to defaults.' });
    } catch (e) {
      setFlash({
        kind: 'err',
        msg: e instanceof ApiError ? e.message : 'Restore failed',
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-xl border border-ink-200 bg-white p-5">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{template.label}</h2>
          <p className="mt-1 text-sm text-ink-500">{template.description}</p>
        </div>
        {overriden && (
          <span className="rounded-full bg-gold-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gold-600">
            Customized
          </span>
        )}
      </header>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-[2fr_1fr]">
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Subject
            </span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
              className="input mt-1 font-mono text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Body (plain text)
            </span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              maxLength={10_000}
              className="input mt-1 font-mono text-sm"
            />
          </label>

          {flash && (
            <p
              role={flash.kind === 'err' ? 'alert' : undefined}
              className={`rounded-md px-3 py-1.5 text-xs ${
                flash.kind === 'ok'
                  ? 'bg-green-50 text-green-700'
                  : 'bg-red-50 text-red-700'
              }`}
            >
              {flash.msg}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={save}
              disabled={!dirty || busy !== null}
              className="rounded-md bg-ink-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
            >
              {busy === 'save' ? 'Saving…' : dirty ? 'Save' : 'No changes'}
            </button>
            {overriden && (
              <button
                onClick={restore}
                disabled={busy !== null}
                className="rounded-md border border-ink-200 px-4 py-1.5 text-sm hover:bg-ink-50 disabled:opacity-60"
              >
                {busy === 'reset' ? 'Restoring…' : 'Restore default'}
              </button>
            )}
          </div>
        </div>

        <aside className="space-y-4 text-sm">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Available variables
            </h3>
            <ul className="mt-1 space-y-1 text-xs">
              {template.variables.map((v) => (
                <li key={v.key}>
                  <code className="rounded bg-ink-100 px-1 font-mono">
                    {`{{${v.key}}}`}
                  </code>
                  <span className="ml-2 text-ink-500">{v.description}</span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Preview
            </h3>
            <div className="mt-1 rounded-md border border-ink-200 bg-ink-50 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                Subject
              </div>
              <div className="text-xs font-medium text-ink-900">
                {renderTemplate(subject, SAMPLE_VARS)}
              </div>
              <div className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                Body
              </div>
              <pre className="whitespace-pre-wrap break-words font-sans text-xs text-ink-800">
                {renderTemplate(body, SAMPLE_VARS)}
              </pre>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

/**
 * Same placeholder substitution as the server — kept in sync so the
 * preview matches what recipients actually see.
 */
function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, key) => {
    const v = vars[key];
    if (v === undefined) return match;
    return v;
  });
}
