'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import { APP_SETTINGS_QUERY_KEY } from '@/lib/use-app-settings';

/**
 * Settings → Custom Fields
 *
 * Lets an operator define extra per-entity fields for clients and
 * products. The schema is stored under the app_settings key
 * 'custom_fields_schema' and returned from GET /admin/settings as
 * `customFieldSchema`; this page saves it via
 * PATCH /admin/settings/custom-fields.
 *
 * The field defs drive the inputs rendered on the client/product
 * create + edit forms (web-forms slice), which read/write the values
 * on each entity's `custom_fields` JSON column. Defining a field here
 * is purely additive — existing records simply have no value for it.
 *
 * Default schema is { clients: [], products: [] } => no custom fields,
 * which reproduces today's behavior exactly.
 *
 * Admin-only — this page lives under /admin/settings/.
 */

type FieldType = 'text' | 'number' | 'select' | 'date' | 'boolean';

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Select (dropdown)' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Yes / No' },
];

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
}

interface CustomFieldSchema {
  clients: FieldDef[];
  products: FieldDef[];
}

const EMPTY_SCHEMA: CustomFieldSchema = { clients: [], products: [] };

// Slugify a label into a stable storage key (snake_case, alnum only).
function toKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export default function CustomFieldsSettingsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: APP_SETTINGS_QUERY_KEY,
    queryFn: () => apiFetch<{ customFieldSchema?: CustomFieldSchema }>('/admin/settings'),
  });

  const [schema, setSchema] = useState<CustomFieldSchema>(EMPTY_SCHEMA);
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okAt, setOkAt] = useState<number | null>(null);

  // Seed once from the server payload; guard against refetch clobbering
  // in-flight edits (same pattern as the other settings editors).
  useEffect(() => {
    if (!data || seeded) return;
    const incoming = data.customFieldSchema;
    setSchema({
      clients: incoming?.clients ?? [],
      products: incoming?.products ?? [],
    });
    setSeeded(true);
  }, [data, seeded]);

  function updateEntity(
    entity: keyof CustomFieldSchema,
    next: FieldDef[],
  ) {
    setSchema((s) => ({ ...s, [entity]: next }));
    setOkAt(null);
  }

  // Block save when any field is missing a label/key or has duplicate
  // keys within the same entity — those would collide in custom_fields.
  function validate(): string | null {
    for (const entity of ['clients', 'products'] as const) {
      const seen = new Set<string>();
      for (const f of schema[entity]) {
        if (!f.label.trim()) return `Every ${entity} field needs a label.`;
        if (!f.key) return `Every ${entity} field needs a key.`;
        if (seen.has(f.key))
          return `Duplicate field key "${f.key}" in ${entity}.`;
        seen.add(f.key);
        if (f.type === 'select' && (!f.options || f.options.length === 0))
          return `Select field "${f.label}" (${entity}) needs at least one option.`;
      }
    }
    return null;
  }

  async function save() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await apiFetch('/admin/settings/custom-fields', {
        method: 'PATCH',
        body: JSON.stringify(schema),
      });
      await qc.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
      setOkAt(Date.now());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center gap-3 text-sm text-ink-500">
        <Link href="/admin/settings" className="hover:underline">
          Settings
        </Link>
        <span>›</span>
        <span className="text-ink-900">Custom fields</span>
      </div>
      <h1 className="mt-2 text-2xl font-semibold">Custom fields</h1>
      <p className="mt-1 text-sm text-ink-400">
        Define extra fields to capture on clients and products. They appear on
        the create and edit forms; existing records keep working and simply
        have no value until you fill them in.
      </p>

      <EntityEditor
        title="Client fields"
        description="Shown on the client create / edit forms."
        fields={schema.clients}
        onChange={(next) => updateEntity('clients', next)}
      />

      <EntityEditor
        title="Product fields"
        description="Shown on the product create / edit forms."
        fields={schema.products}
        onChange={(next) => updateEntity('products', next)}
      />

      {error && (
        <div role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}
      {okAt && !error && (
        <div className="mt-4 rounded-md bg-green-50 px-3 py-2 text-xs text-green-700">
          Saved. The new fields appear on client and product forms.
        </div>
      )}

      <div className="mt-6 flex justify-end">
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

function EntityEditor({
  title,
  description,
  fields,
  onChange,
}: {
  title: string;
  description: string;
  fields: FieldDef[];
  onChange: (next: FieldDef[]) => void;
}) {
  function addField() {
    onChange([...fields, { key: '', label: '', type: 'text' }]);
  }

  function updateField(index: number, patch: Partial<FieldDef>) {
    onChange(
      fields.map((f, i) => {
        if (i !== index) return f;
        const merged = { ...f, ...patch };
        // Keep `key` derived from `label` so it stays stable + collision
        // free without the operator having to think about it.
        if (patch.label !== undefined) merged.key = toKey(patch.label);
        // Drop `options` for non-select types so the payload stays clean.
        if (merged.type !== 'select') delete merged.options;
        return merged;
      }),
    );
  }

  function removeField(index: number) {
    onChange(fields.filter((_, i) => i !== index));
  }

  return (
    <section className="mt-6 rounded-xl border border-ink-200 bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            {title}
          </h2>
          <p className="mt-1 text-xs text-ink-400">{description}</p>
        </div>
        <button
          type="button"
          onClick={addField}
          className="shrink-0 rounded-md border border-ink-200 px-3 py-1 text-sm text-ink-700 hover:bg-ink-50"
        >
          + Add field
        </button>
      </div>

      {fields.length === 0 ? (
        <p className="mt-4 text-sm text-ink-400">No custom fields yet.</p>
      ) : (
        <ul className="mt-4 space-y-4">
          {fields.map((f, i) => (
            <li key={i} className="rounded-lg border border-ink-200 bg-ink-50 p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_auto]">
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                    Label
                  </span>
                  <input
                    value={f.label}
                    onChange={(e) => updateField(i, { label: e.target.value })}
                    maxLength={80}
                    placeholder="e.g. Loyalty tier"
                    className="input mt-1 text-sm"
                  />
                  {f.key && (
                    <span className="mt-1 block font-mono text-[11px] text-ink-400">
                      key: {f.key}
                    </span>
                  )}
                </label>

                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                    Type
                  </span>
                  <select
                    value={f.type}
                    onChange={(e) =>
                      updateField(i, { type: e.target.value as FieldType })
                    }
                    className="input mt-1 text-sm"
                  >
                    {FIELD_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => removeField(i)}
                    className="rounded-md border border-ink-200 px-3 py-1.5 text-sm text-ink-700 hover:bg-red-50 hover:text-red-700"
                  >
                    Remove
                  </button>
                </div>
              </div>

              {f.type === 'select' && (
                <label className="mt-3 block">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                    Options (one per line)
                  </span>
                  <textarea
                    value={(f.options ?? []).join('\n')}
                    onChange={(e) =>
                      updateField(i, {
                        options: e.target.value
                          .split('\n')
                          .map((o) => o.trim())
                          .filter((o) => o !== ''),
                      })
                    }
                    rows={3}
                    placeholder={'Gold\nSilver\nPlatinum'}
                    className="input mt-1 font-mono text-xs"
                  />
                </label>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
