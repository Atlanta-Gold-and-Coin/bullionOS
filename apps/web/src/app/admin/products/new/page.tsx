'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import {
  CustomFieldsSection,
  useCustomFields,
  type CustomFieldValues,
} from '../../clients/_custom-fields';

const METALS = ['gold', 'silver', 'platinum', 'palladium'] as const;
const CATEGORIES = ['coin', 'bar', 'round', 'numismatic', 'jewelry', 'other'] as const;

export default function NewProductPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const customFields = useCustomFields('products');
  const [customValues, setCustomValues] = useState<CustomFieldValues>({});
  const [form, setForm] = useState({
    sku: '',
    name: '',
    metal: 'gold' as (typeof METALS)[number],
    category: 'coin' as (typeof CATEGORIES)[number],
    weight_troy_oz: '1',
    purity: '0.999',
    show_on_website: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch('/admin/products', {
        method: 'POST',
        body: JSON.stringify({
          sku: form.sku.trim().toUpperCase(),
          name: form.name.trim(),
          metal: form.metal,
          category: form.category,
          weight_troy_oz: Number(form.weight_troy_oz),
          purity: Number(form.purity),
          show_on_website: form.show_on_website,
          custom_fields: customValues,
        }),
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'products'] });
      router.push('/admin/products');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create product');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-semibold">New product</h1>
      <form onSubmit={submit} className="mt-6 space-y-4 rounded-xl border border-ink-200 bg-white p-6">
        <Field label="SKU" hint="Uppercase alphanumeric, - and _ allowed">
          <input
            required
            value={form.sku}
            onChange={(e) => setForm({ ...form, sku: e.target.value })}
            className="input"
            placeholder="AU-EAGLE-1OZ"
          />
        </Field>
        <Field label="Name">
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="input"
            placeholder="1 oz American Gold Eagle"
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Metal">
            <select
              value={form.metal}
              onChange={(e) => setForm({ ...form, metal: e.target.value as (typeof METALS)[number] })}
              className="input"
            >
              {METALS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category">
            <select
              value={form.category}
              onChange={(e) =>
                setForm({ ...form, category: e.target.value as (typeof CATEGORIES)[number] })
              }
              className="input"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Weight (troy oz)">
            <input
              required
              type="number"
              step="0.0001"
              min="0.0001"
              value={form.weight_troy_oz}
              onChange={(e) => setForm({ ...form, weight_troy_oz: e.target.value })}
              className="input font-mono"
            />
          </Field>
          <Field label="Purity (0–1)">
            <input
              required
              type="number"
              step="0.0001"
              min="0.0001"
              max="1"
              value={form.purity}
              onChange={(e) => setForm({ ...form, purity: e.target.value })}
              className="input font-mono"
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-800">
          <input
            type="checkbox"
            checked={form.show_on_website}
            onChange={(e) => setForm({ ...form, show_on_website: e.target.checked })}
          />
          Show on public "What We Pay" feed
        </label>

        {customFields.length > 0 && (
          <div className="space-y-4 border-t border-ink-100 pt-4">
            <span className="text-sm font-medium text-ink-800">Custom fields</span>
            <CustomFieldsSection
              fields={customFields}
              values={customValues}
              onChange={setCustomValues}
            />
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={() => router.back()}
            className="rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700 hover:bg-ink-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
          >
            {submitting ? 'Creating…' : 'Create product'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-ink-800">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}
