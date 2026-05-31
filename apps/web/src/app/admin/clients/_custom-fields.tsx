'use client';

/**
 * Tenant custom-field rendering for client + product forms (tenant
 * customization feature). The schema is defined per-tenant in
 * Settings → Custom Fields and returned from GET /admin/settings as
 * `customFieldSchema`. Each entity (clients, products) carries a
 * `custom_fields` JSONB object keyed by FieldDef.key.
 *
 * Lives under admin/clients/ so both the client pages and the product
 * pages (which import it relatively) share one renderer without
 * duplicating the input logic. Default schema is empty → no extra
 * inputs render, so existing forms look byte-identical until a tenant
 * adds fields.
 */

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { APP_SETTINGS_QUERY_KEY } from '@/lib/use-app-settings';

export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'date' | 'boolean';
  options?: string[];
}

export interface CustomFieldSchema {
  clients: FieldDef[];
  products: FieldDef[];
}

/** A bag of custom-field values keyed by FieldDef.key. */
export type CustomFieldValues = Record<string, unknown>;

const EMPTY_SCHEMA: CustomFieldSchema = { clients: [], products: [] };

interface SettingsWithSchema {
  customFieldSchema?: CustomFieldSchema;
}

/**
 * Reads the per-entity custom-field definitions. Shares the
 * app-settings query key so it stays in sync with the rest of the FE
 * and is invalidated by the same mutations. Defaults to an empty list
 * so callers can render unconditionally.
 */
export function useCustomFields(entity: 'clients' | 'products'): FieldDef[] {
  const { data } = useQuery<SettingsWithSchema>({
    queryKey: APP_SETTINGS_QUERY_KEY,
    queryFn: () => apiFetch<SettingsWithSchema>('/admin/settings'),
    staleTime: 60_000,
  });
  return data?.customFieldSchema?.[entity] ?? EMPTY_SCHEMA[entity];
}

/**
 * Renders one input per custom-field definition. Reads/writes a flat
 * `custom_fields` object. When `fields` is empty (the default), this
 * renders nothing — keeping existing forms unchanged.
 */
export function CustomFieldsSection({
  fields,
  values,
  onChange,
  className,
}: {
  fields: FieldDef[];
  values: CustomFieldValues;
  onChange: (next: CustomFieldValues) => void;
  className?: string;
}) {
  if (fields.length === 0) return null;

  function set(key: string, value: unknown) {
    onChange({ ...values, [key]: value });
  }

  return (
    <div className={className ?? 'space-y-4'}>
      {fields.map((f) => (
        <label key={f.key} className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-ink-400">
            {f.label}
          </span>
          <div className="mt-1">
            <CustomFieldInput
              field={f}
              value={values[f.key]}
              onChange={(v) => set(f.key, v)}
            />
          </div>
        </label>
      ))}
    </div>
  );
}

function CustomFieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  switch (field.type) {
    case 'boolean':
      return (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5"
        />
      );
    case 'number':
      return (
        <input
          type="number"
          value={value == null ? '' : String(value)}
          onChange={(e) =>
            onChange(e.target.value === '' ? '' : Number(e.target.value))
          }
          className="input font-mono"
        />
      );
    case 'date':
      return (
        <input
          type="date"
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
          className="input"
        />
      );
    case 'select':
      return (
        <select
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
          className="input"
        >
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case 'text':
    default:
      return (
        <input
          type="text"
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
          className="input"
        />
      );
  }
}
