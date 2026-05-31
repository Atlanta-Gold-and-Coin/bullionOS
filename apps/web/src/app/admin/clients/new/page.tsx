'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { ClientForm, fromClient, toDto } from '@/components/client-form';
import {
  CustomFieldsSection,
  useCustomFields,
  type CustomFieldValues,
} from '../_custom-fields';

export default function NewClientPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const customFields = useCustomFields('clients');
  const [customValues, setCustomValues] = useState<CustomFieldValues>({});

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">New client</h1>
      <p className="mt-1 text-sm text-ink-400">
        Create a retail client record. Portal access can be enabled later from the client's detail page.
      </p>

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
          initial={fromClient({})}
          submitLabel="Create client"
          onCancel={() => router.back()}
          onSubmit={async (v) => {
            const created = await apiFetch<{ id: string }>('/admin/clients', {
              method: 'POST',
              body: JSON.stringify({ ...toDto(v), custom_fields: customValues }),
            });
            await qc.invalidateQueries({ queryKey: ['admin', 'clients'] });
            router.push(`/admin/clients/${created.id}`);
          }}
        />
      </div>
    </div>
  );
}
