'use client';

import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { ClientForm, fromClient, toDto } from '@/components/client-form';

export default function NewClientPage() {
  const router = useRouter();
  const qc = useQueryClient();

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">New client</h1>
      <p className="mt-1 text-sm text-ink-400">
        Create a retail client record. Portal access can be enabled later from the client's detail page.
      </p>

      <div className="mt-6">
        <ClientForm
          initial={fromClient({})}
          submitLabel="Create client"
          onCancel={() => router.back()}
          onSubmit={async (v) => {
            const created = await apiFetch<{ id: string }>('/admin/clients', {
              method: 'POST',
              body: JSON.stringify(toDto(v)),
            });
            await qc.invalidateQueries({ queryKey: ['admin', 'clients'] });
            router.push(`/admin/clients/${created.id}`);
          }}
        />
      </div>
    </div>
  );
}
