'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';

/**
 * Invoice-template editor.
 *
 * Three text fields layered on top of the hardcoded PDF renderer:
 *
 *   - footer_comment      — free-form block on every invoice (any type)
 *   - disclosure_buy      — overrides SELLER CERTIFICATION body
 *   - disclosure_sell     — overrides PRODUCT CONDITION & MARKET body
 *
 * Leaving a field blank reverts that field to the built-in default. The
 * defaults come back in the same GET so the operator can copy, tweak,
 * or reset with a single click.
 */

interface InvoiceTemplateResponse {
  current: {
    footer_comment: string | null;
    disclosure_buy: string | null;
    disclosure_sell: string | null;
  };
  defaults: {
    footer_comment: string;
    disclosure_buy: string;
    disclosure_sell: string;
  };
}

export default function InvoiceTemplatePage() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['admin', 'settings', 'invoice-template'],
    queryFn: () => apiFetch<InvoiceTemplateResponse>('/admin/settings/invoice-template'),
  });

  const [footer, setFooter] = useState('');
  const [buy, setBuy] = useState('');
  const [sell, setSell] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okAt, setOkAt] = useState<number | null>(null);

  // Seed the textareas once when the server payload arrives. Without
  // the `seeded` guard, refetches after save would wipe in-flight edits.
  useEffect(() => {
    if (!data || seeded) return;
    setFooter(data.current.footer_comment ?? '');
    setBuy(data.current.disclosure_buy ?? '');
    setSell(data.current.disclosure_sell ?? '');
    setSeeded(true);
  }, [data, seeded]);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      // Empty string → null on the server (= revert to built-in default).
      await apiFetch('/admin/settings/invoice-template', {
        method: 'PATCH',
        body: JSON.stringify({
          footer_comment: footer.trim() === '' ? null : footer,
          disclosure_buy: buy.trim() === '' ? null : buy,
          disclosure_sell: sell.trim() === '' ? null : sell,
        }),
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'settings', 'invoice-template'] });
      setOkAt(Date.now());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function restoreBuy() {
    if (!data) return;
    setBuy(data.defaults.disclosure_buy);
  }
  function restoreSell() {
    if (!data) return;
    setSell(data.defaults.disclosure_sell);
  }
  function clearBuy() {
    setBuy('');
  }
  function clearSell() {
    setSell('');
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center gap-3 text-sm text-ink-500">
        <Link href="/admin/settings" className="hover:underline">
          Settings
        </Link>
        <span>›</span>
        <span className="text-ink-900">Invoice template</span>
      </div>
      <h1 className="mt-2 text-2xl font-semibold">Invoice template</h1>
      <p className="mt-1 text-sm text-ink-400">
        Text shown on every invoice PDF. Leaving a field blank falls back to
        the built-in default for that block — the disclosures already ship
        with legally-reviewed text, so only override if you have a reason.
      </p>

      <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
          Additional information (all invoices)
        </h2>
        <p className="mt-1 text-xs text-ink-400">
          Free-form block. Renders under <em>Notes</em> and above the legal
          disclosure on every buy and sell invoice. Hidden automatically
          when empty, so customers on older invoices don&rsquo;t see a stray
          header.
        </p>
        <textarea
          value={footer}
          onChange={(e) => setFooter(e.target.value)}
          maxLength={2000}
          placeholder="e.g. Store hours: Mon–Fri 10a–6p. Walk-ins welcome. Appointments recommended for buys over $10,000."
          className="input mt-3 h-28 w-full font-mono text-xs"
        />
        <div className="mt-1 text-right text-[11px] text-ink-400">
          {footer.length} / 2000
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Buy invoice disclosure
            </h2>
            <p className="mt-1 text-xs text-ink-400">
              Replaces the <strong>SELLER CERTIFICATION</strong> block on buy
              tickets. Blank reverts to the default.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={restoreBuy}
              className="rounded-md border border-ink-200 px-2 py-0.5 text-xs text-ink-700 hover:bg-ink-50"
              title="Copy the built-in default into the editor"
            >
              Load default
            </button>
            <button
              onClick={clearBuy}
              className="rounded-md border border-ink-200 px-2 py-0.5 text-xs text-ink-700 hover:bg-ink-50"
              title="Clear the field — PDF will use the built-in default"
            >
              Clear
            </button>
          </div>
        </div>
        <textarea
          value={buy}
          onChange={(e) => setBuy(e.target.value)}
          maxLength={2000}
          className="input mt-3 h-28 w-full font-mono text-xs"
        />
        <details className="mt-2 text-xs text-ink-500">
          <summary className="cursor-pointer">Current default</summary>
          <p className="mt-2 rounded-md bg-ink-50 p-3 text-ink-700">
            {data?.defaults.disclosure_buy ?? '…'}
          </p>
        </details>
      </section>

      <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
              Sell invoice disclosure
            </h2>
            <p className="mt-1 text-xs text-ink-400">
              Replaces the <strong>PRODUCT CONDITION &amp; MARKET DISCLOSURE</strong>{' '}
              block on sell invoices. Blank reverts to the default.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={restoreSell}
              className="rounded-md border border-ink-200 px-2 py-0.5 text-xs text-ink-700 hover:bg-ink-50"
              title="Copy the built-in default into the editor"
            >
              Load default
            </button>
            <button
              onClick={clearSell}
              className="rounded-md border border-ink-200 px-2 py-0.5 text-xs text-ink-700 hover:bg-ink-50"
              title="Clear the field — PDF will use the built-in default"
            >
              Clear
            </button>
          </div>
        </div>
        <textarea
          value={sell}
          onChange={(e) => setSell(e.target.value)}
          maxLength={2000}
          className="input mt-3 h-28 w-full font-mono text-xs"
        />
        <details className="mt-2 text-xs text-ink-500">
          <summary className="cursor-pointer">Current default</summary>
          <p className="mt-2 rounded-md bg-ink-50 p-3 text-ink-700">
            {data?.defaults.disclosure_sell ?? '…'}
          </p>
        </details>
      </section>

      {error && (
        <div role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}
      {okAt && !error && (
        <div className="mt-4 rounded-md bg-green-50 px-3 py-2 text-xs text-green-700">
          Saved. New PDFs pick up the change immediately.
        </div>
      )}

      <div className="mt-6 flex justify-end gap-2">
        <button
          onClick={save}
          disabled={saving || !seeded}
          className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
