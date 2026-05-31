'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { ClientForm, fromClient, toDto } from '@/components/client-form';
import {
  CustomFieldsSection,
  useCustomFields,
  type CustomFieldValues,
} from '../../_custom-fields';

export default function EditClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const customFields = useCustomFields('clients');
  const [customValues, setCustomValues] = useState<CustomFieldValues>({});

  const { data } = useQuery({
    queryKey: ['admin', 'client', id],
    queryFn: () =>
      apiFetch<Record<string, unknown>>(`/admin/clients/${id}`),
  });

  // Seed the custom-field editor from the loaded record once it arrives.
  useEffect(() => {
    if (data) {
      const cf = data.custom_fields;
      setCustomValues(
        cf && typeof cf === 'object' ? (cf as CustomFieldValues) : {},
      );
    }
  }, [data]);

  if (!data) return <div className="text-sm text-ink-400">Loading…</div>;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">Edit client</h1>

      {customFields.length > 0 && (
        <div className="mt-6 rounded-xl border border-ink-200 bg-white p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-ink-500">
            Custom fields
          </h2>
          <CustomFieldsSection
            fields={customFields}
            values={customValues}
            onChange={setCustomValues}
          />
        </div>
      )}

      <div className="mt-6">
        <ClientForm
          initial={fromClient(data as never)}
          submitLabel="Save"
          onCancel={() => router.push(`/admin/clients/${id}`)}
          onSubmit={async (v) => {
            await apiFetch(`/admin/clients/${id}`, {
              method: 'PATCH',
              body: JSON.stringify({ ...toDto(v), custom_fields: customValues }),
            });
            await qc.invalidateQueries({ queryKey: ['admin', 'client', id] });
            await qc.invalidateQueries({ queryKey: ['admin', 'clients'] });
            router.push(`/admin/clients/${id}`);
          }}
        />
      </div>
    </div>
  );
}
