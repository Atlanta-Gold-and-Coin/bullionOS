'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getAccessToken } from '@/lib/api-client';

/**
 * Admin → Imports
 *
 * CSV bulk import for the entities operators typically onboard from
 * a prior system: products, inventory counts, clients, historical
 * invoices. Two-step flow per importer:
 *
 *   1. Pick a CSV → POST with ?dry_run=true → preview pane shows
 *      the parsed totals + per-row errors.
 *   2. Confirm → POST with ?dry_run=false → results pane shows
 *      what was committed.
 *
 * Operators can re-pick a different file at any point; the preview
 * resets. Errors don't block the commit — bad rows are skipped, good
 * rows insert. The whole import runs in one DB transaction so a
 * runtime failure mid-batch rolls back.
 */

type ImportKind = 'products' | 'inventory' | 'clients' | 'historical-invoices';

interface ImportResult {
  total: number;
  ok: number;
  skipped: number;
  errors: Array<{ row: number; error: string; raw: Record<string, string> }>;
  preview: Record<string, unknown>[];
  dryRun: boolean;
}

const KIND_META: Record<
  ImportKind,
  { label: string; columns: string; example: string }
> = {
  products: {
    label: 'Products',
    columns:
      'sku, name, metal, category, weight_troy_oz, purity, description, is_active, show_on_website',
    example:
      'sku,name,metal,category,weight_troy_oz,purity\nAU-EAGLE-1,1 oz American Gold Eagle,gold,coin,1,0.9167\nAG-MAPLE-1,1 oz Silver Maple Leaf,silver,coin,1,0.9999',
  },
  inventory: {
    label: 'Inventory',
    columns:
      'sku, quantity_on_hand, location, weighted_avg_cost, last_purchase_price, notes',
    example:
      'sku,quantity_on_hand,location,weighted_avg_cost,last_purchase_price,notes\nAU-EAGLE-1,5,Main Safe,2350.00,2400.00,opening count\nAG-MAPLE-1,40,Showcase,31.25,32.00,cycle count',
  },
  clients: {
    label: 'Clients',
    columns:
      'first_name, last_name, company, email, phone, address_line1, address_line2, city, region, postal_code, country, notes, heard_from, client_type',
    example:
      'first_name,last_name,company,email,phone,client_type\nAlice,Smith,,alice@example.com,555-1234,retail\n,,Acme Coin,buyer@acme.com,555-9876,wholesaler',
  },
  'historical-invoices': {
    label: 'Historical Invoices',
    columns:
      'date (YYYY-MM-DD), type (buy|sell), amount, client_email (optional), client_name, is_wholesale, reference, notes',
    example:
      'date,type,amount,client_email,client_name,is_wholesale\n2024-03-15,sell,1850.00,alice@example.com,,false\n2024-03-22,buy,12500.00,,Walk-in customer,false',
  },
};

export default function ImportsPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-semibold">Imports</h1>
      <p className="mt-1 text-sm text-ink-400">
        Bulk-load data from CSV. Each section runs a dry-run preview
        first; once you&rsquo;ve reviewed it, click Commit to write.
        Bad rows are reported but never block — good rows always
        commit cleanly.
      </p>

      <ImporterCard kind="products" />
      <ImporterCard kind="inventory" />
      <ImporterCard kind="clients" />
      <ImporterCard kind="historical-invoices" />
    </div>
  );
}

function ImporterCard({ kind }: { kind: ImportKind }) {
  const qc = useQueryClient();
  const meta = KIND_META[kind];
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [committed, setCommitted] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setPreview(null);
    setCommitted(null);
    setError(null);
  }

  async function upload(dryRun: boolean) {
    if (!file) {
      setError('Pick a CSV file first.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const token = getAccessToken();
      const res = await fetch(
        `/api/v1/admin/imports/${kind}?dry_run=${dryRun}`,
        {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: fd,
        },
      );
      const json = (await res.json()) as ImportResult & { message?: string };
      if (!res.ok) {
        setError(json.message ?? `HTTP ${res.status}`);
        return;
      }
      if (dryRun) {
        setPreview(json);
        setCommitted(null);
      } else {
        setCommitted(json);
        setPreview(null);
        setFile(null);
        // Invalidate any list views that might surface the freshly
        // imported rows.
        qc.invalidateQueries({ queryKey: ['admin', 'products'] });
        qc.invalidateQueries({ queryKey: ['admin', 'inventory'] });
        qc.invalidateQueries({ queryKey: ['admin', 'products', 'sheet'] });
        qc.invalidateQueries({ queryKey: ['admin', 'clients'] });
        qc.invalidateQueries({ queryKey: ['admin', 'historical-invoices'] });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
      <header className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">{meta.label}</h2>
        <span className="text-[11px] text-ink-400">
          POST /admin/imports/{kind}
        </span>
      </header>
      <p className="mt-2 text-xs text-ink-500">
        <strong>Columns:</strong> {meta.columns}
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-ink-500 hover:text-ink-700">
          Example
        </summary>
        <pre className="mt-2 overflow-x-auto rounded bg-ink-50 p-2 text-[11px]">
          {meta.example}
        </pre>
      </details>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            reset();
          }}
          className="text-sm"
        />
        <button
          type="button"
          disabled={!file || busy}
          onClick={() => upload(true)}
          className="rounded border border-ink-300 bg-white px-3 py-1.5 text-sm hover:bg-ink-50 disabled:opacity-50"
        >
          Preview (dry-run)
        </button>
        {preview && preview.ok > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => upload(false)}
            className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Commit {preview.ok} rows
          </button>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {preview && <ResultPane result={preview} kind="preview" />}
      {committed && <ResultPane result={committed} kind="committed" />}
    </section>
  );
}

function ResultPane({
  result,
  kind,
}: {
  result: ImportResult;
  kind: 'preview' | 'committed';
}) {
  const verb = kind === 'preview' ? 'would import' : 'imported';
  return (
    <div className="mt-4 rounded border border-ink-200 bg-ink-50 p-3">
      <p className="text-sm">
        <strong>
          {result.total} rows parsed · {verb} {result.ok} ·{' '}
          {result.skipped} skipped (errors)
        </strong>
      </p>
      {result.errors.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-red-700 hover:text-red-900">
            {result.errors.length} error{result.errors.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-red-700">
            {result.errors.slice(0, 50).map((e, i) => (
              <li key={i}>
                <span className="font-mono">row {e.row}:</span> {e.error}
              </li>
            ))}
            {result.errors.length > 50 && (
              <li className="text-ink-400">
                … and {result.errors.length - 50} more
              </li>
            )}
          </ul>
        </details>
      )}
      {result.preview.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-ink-600 hover:text-ink-900">
            Preview ({result.preview.length} of {result.ok} rows)
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-white p-2 text-[11px]">
            {JSON.stringify(result.preview, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
