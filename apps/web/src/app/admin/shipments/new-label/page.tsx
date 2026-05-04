'use client';

/**
 * IFS Phase 2 — Create-FedEx-label wizard.
 *
 * Walks an operator through IFS Clients' create-label flow without
 * leaving AGC Desk. Six logical sections rendered as a single
 * scrolling page; each "Next" button runs the relevant IFS validator
 * before advancing. On final submit (#26) we also write a row to the
 * local `shipments` table when the wizard was launched from an
 * invoice (`?invoice_id=X`), so the label appears on the invoice
 * detail page automatically.
 *
 * Out of scope (deferred): international/customs/AES, multi-ship
 * (PR/SR auto-split for >$75k single-piece), FedEx pickup scheduling,
 * email-notification block, save-as-draft. See SESSION_HANDOFF_IFS_PHASE2.md.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-client';
import { useSetting } from '@/lib/use-app-settings';

// ===== Types mirroring the API response shapes =====

interface IfsBasicData {
  service_types: { id: string; text: string }[];
  packaging_types: { id: string; text: string }[];
  payment_types: { id: string; text: string }[];
  signature_types: { id: string; text: string }[];
  label_stock_types: { id: string; text: string }[];
}

interface IfsSenderListEntry {
  id: string;
  text: string;
  name: string;
  company_name: string;
  address1: string;
  is_residential: boolean;
  is_primary: boolean;
}

interface IfsSenderListResp {
  senders: IfsSenderListEntry[];
  primary_id: string | null;
}

interface IfsSenderData {
  company_name: string;
  name: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
  fax: string;
  email: string;
  is_residential: boolean;
  is_primary: boolean;
  is_address_restricted: boolean;
  address_restricted_msg: string;
}

interface IfsRecipientListEntry {
  id: string;
  name: string;
}

interface IfsAddressVerificationResult {
  corrected: {
    company_name: string;
    address1: string;
    address2: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
  address_type: string;
  is_residential: boolean;
}

interface IfsZoneInfo {
  zone_id: number;
  zone_name: string;
}

interface IfsWeightCheck {
  ok: boolean;
  message: string | null;
}

interface IfsDeclareValueResult {
  is_error: boolean;
  needs_popup_chain: boolean;
  message: string;
  first_popup: { message: string[]; buttons: string[] } | null;
  second_popup: { message: string[]; buttons: string[] } | null;
  third_popup: { message: string[]; buttons: string[] } | null;
  multi_items_popup: { message: string[]; buttons: string[] } | null;
}

interface IfsHalLocation {
  index: number;
  person_name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  state_code: string;
  zip: string;
  country: string;
  location_in_property: string;
  distance: string;
  display_distance: string;
  map_url: string;
  location_id: string;
}

interface IfsCostPreview {
  final_amount: number;
  line_items: { title: string; value: string; severity: string | null }[];
  final_amount_2: number | null;
  line_items_2: { title: string; value: string; severity: string | null }[] | null;
}

interface IfsCreateLabelResult {
  shipment_id: string;
  tracking_no: string;
  view_label_link: string | null;
  view_return_label_link: string | null;
  view_receipt: string | null;
  message: string;
  ifs_shipments_row_id: string;
  shipments_row_id: string | null;
}

interface InvoiceLite {
  id: string;
  invoice_number: string;
  client_id: string;
}

interface ClientLite {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
}

// ===== Defaults =====

/**
 * AGC's default sender. Used only if #3 doesn't return a saved sender
 * matching this address (Hunter set this up on ifsclients.com; the
 * wizard will auto-pick it). Free-form free of the IFS sender list,
 * the operator can still edit any field before submit.
 */
const FALLBACK_SENDER = {
  ca_company_name: 'Your ATL Taxidermy',
  ca_name: 'Your ATL Taxidermy',
  ca_label_name: 'Your ATL Taxidermy',
  ca_email: '',
  ca_address1: '8480 Holcomb Bridge Rd #200',
  ca_address2: '',
  ca_city: 'Alpharetta',
  ca_state: 'Georgia',
  ca_state_id: 'GA',
  ca_zip: '30022',
  ca_country: 'United States',
  ca_phone: '',
  ca_fax: '',
};

const DEFAULT_LABEL_STOCK = 'PAPER_8.5X11_BOTTOM_HALF_LABEL';

// ===== Wizard state =====

type WizardStep =
  | 'sender'
  | 'recipient'
  | 'service'
  | 'package'
  | 'cost'
  | 'success';

interface WizardState {
  step: WizardStep;
  // Sender
  selected_sender_id: string | null;
  ca_company_name: string;
  ca_name: string;
  ca_label_name: string;
  ca_email: string;
  ca_address1: string;
  ca_address2: string;
  ca_city: string;
  ca_state: string;
  ca_state_id: string;
  ca_zip: string;
  ca_country: string;
  ca_phone: string;
  // Recipient
  recipient_id: string;
  client_label_name: string;
  client_company_name: string;
  client_name: string;
  client_address1: string;
  client_address2: string;
  client_city: string;
  client_state: string;
  client_state_id: string;
  client_zip: string;
  client_country: string;
  client_phone: string;
  client_email: string;
  client_is_address_verify: 0 | 1;
  residential: 0 | 1;
  // Service + Package
  service_type: string;
  packaging_type: string;
  package_weight: string; // string for input control
  packaging_dim_length: string;
  packaging_dim_width: string;
  packaging_dim_height: string;
  signature_type1: string;
  saturday_delivery: 0 | 1;
  pickup_date: string; // MM-DD-YYYY
  zone_id: number | null;
  // Insurance + HAL
  declare_value: string;
  hold_for_pu: 0 | 1;
  hal_index: number | null;
  // Billing
  payment_type: 'SENDER' | 'RECIPIENT' | 'THIRD_PARTY';
  account_number: string;
  reference: string;
  reference_show_on_label: 0 | 1;
  // Cost preview
  cost_preview: IfsCostPreview | null;
}

function initialState(): WizardState {
  return {
    step: 'sender',
    selected_sender_id: null,
    ...FALLBACK_SENDER,
    recipient_id: '',
    client_label_name: '',
    client_company_name: '',
    client_name: '',
    client_address1: '',
    client_address2: '',
    client_city: '',
    client_state: '',
    client_state_id: '',
    client_zip: '',
    client_country: 'United States',
    client_phone: '',
    client_email: '',
    client_is_address_verify: 0,
    residential: 0,
    service_type: '',
    packaging_type: '',
    package_weight: '',
    packaging_dim_length: '',
    packaging_dim_width: '',
    packaging_dim_height: '',
    signature_type1: '',
    saturday_delivery: 0,
    pickup_date: todayMmDdYyyy(),
    zone_id: null,
    declare_value: '',
    hold_for_pu: 0,
    hal_index: null,
    payment_type: 'SENDER',
    account_number: '',
    reference: '',
    reference_show_on_label: 0,
    cost_preview: null,
  };
}

// ===== Page component =====

export default function NewLabelWizardPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const invoiceId = searchParams.get('invoice_id') || undefined;

  const [state, setState] = useState<WizardState>(initialState());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IfsCreateLabelResult | null>(null);

  const update = (patch: Partial<WizardState>) =>
    setState((s) => ({ ...s, ...patch }));

  // ----- Lookups (cached) -----
  const { data: basicData, error: basicErr } = useQuery<IfsBasicData>({
    queryKey: ['ifs', 'basic-data'],
    queryFn: () => apiFetch<IfsBasicData>('/admin/ifs/basic-data'),
    staleTime: 60 * 60 * 1000,
  });

  const { data: senderList, error: sendersErr } = useQuery<IfsSenderListResp>({
    queryKey: ['ifs', 'senders'],
    queryFn: () => apiFetch<IfsSenderListResp>('/admin/ifs/senders'),
    staleTime: 30 * 60 * 1000,
  });

  // Invoice + client pre-fill (only if launched with ?invoice_id=)
  const { data: invoice } = useQuery<InvoiceLite>({
    queryKey: ['admin', 'invoice', invoiceId],
    queryFn: () => apiFetch<InvoiceLite>(`/admin/invoices/${invoiceId}`),
    enabled: Boolean(invoiceId),
  });
  const { data: invoiceClient } = useQuery<ClientLite>({
    queryKey: ['admin', 'client', invoice?.client_id],
    queryFn: () =>
      apiFetch<ClientLite>(`/admin/clients/${invoice!.client_id}`),
    enabled: Boolean(invoice?.client_id),
  });

  const senderMatch = useSetting('ifs.sender_match');

  // Auto-pick the tenant's default sender once the list loads.
  useEffect(() => {
    if (!senderList?.senders.length || state.selected_sender_id) return;
    const matched = pickDefaultSender(senderList, senderMatch);
    if (matched) {
      void hydrateSender(matched.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [senderList]);

  // Pre-fill recipient from invoice client once it loads.
  useEffect(() => {
    if (!invoiceClient || state.client_address1) return;
    const ic = invoiceClient;
    const fullName =
      [ic.first_name, ic.last_name].filter(Boolean).join(' ') ||
      ic.company ||
      '';
    update({
      client_label_name: fullName,
      client_name: ic.company || fullName,
      client_company_name: ic.company || fullName,
      client_email: ic.email || '',
      client_phone: ic.phone || '',
      client_address1: ic.address_line1 || '',
      client_address2: ic.address_line2 || '',
      client_city: ic.city || '',
      client_state: ic.region || '',
      client_state_id: ic.region || '',
      client_zip: ic.postal_code || '',
      client_country: ic.country || 'United States',
      reference: invoice?.invoice_number || '',
      reference_show_on_label: invoice?.invoice_number ? 1 : 0,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceClient]);

  // Default `signature_type1` + `packaging_type` once basic-data loads.
  useEffect(() => {
    if (!basicData) return;
    if (!state.signature_type1 && basicData.signature_types.length) {
      update({ signature_type1: basicData.signature_types[0].id });
    }
    if (!state.packaging_type && basicData.packaging_types.length) {
      update({ packaging_type: basicData.packaging_types[0].id });
    }
    if (!state.service_type && basicData.service_types.length) {
      update({ service_type: basicData.service_types[0].id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basicData]);

  async function hydrateSender(senderId: string) {
    try {
      setBusy(true);
      const data = await apiFetch<IfsSenderData>(
        '/admin/ifs/senders/get',
        {
          method: 'POST',
          body: JSON.stringify({ client_address_id: senderId }),
        },
      );
      if (data.is_address_restricted) {
        setError(
          `Sender restricted: ${data.address_restricted_msg || 'see ifsclients.com'}`,
        );
        return;
      }
      update({
        selected_sender_id: senderId,
        ca_company_name: data.company_name,
        ca_name: data.company_name || data.name,
        ca_label_name: data.name,
        ca_email: data.email,
        ca_address1: data.address1,
        ca_address2: data.address2,
        ca_city: data.city,
        ca_state: data.state,
        ca_state_id: stateAbbrev(data.state),
        ca_zip: data.zip,
        ca_country: data.country || 'United States',
        ca_phone: data.phone,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load sender');
    } finally {
      setBusy(false);
    }
  }

  // ----- Step transitions (each runs the relevant IFS validator) -----

  async function goToRecipient() {
    if (!state.ca_address1.trim() || !state.ca_zip.trim()) {
      setError('Sender address is incomplete.');
      return;
    }
    setError(null);
    update({ step: 'recipient' });
  }

  async function goToService() {
    setError(null);
    if (
      !state.client_address1.trim() ||
      !state.client_zip.trim() ||
      !state.client_label_name.trim()
    ) {
      setError('Recipient address is incomplete.');
      return;
    }
    // IFS rejects #26 with "Please Enter Valid Recipient Email Address"
    // when client_email is blank, despite the docs saying it's only
    // required when hold_for_pu=1. Catch it here so the operator gets
    // a clear error in the recipient step instead of after walking
    // through service/package/cost preview.
    const email = state.client_email.trim();
    if (!email) {
      setError('Recipient email is required by IFS.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Recipient email looks malformed.');
      return;
    }
    // Run #9 verify
    setBusy(true);
    try {
      const verify = await apiFetch<IfsAddressVerificationResult>(
        '/admin/ifs/verify-address',
        {
          method: 'POST',
          body: JSON.stringify({
            client_address1: state.client_address1,
            client_country: state.client_country,
            client_zip: state.client_zip,
            client_address2: state.client_address2 || undefined,
            client_city: state.client_city || undefined,
            client_state: state.client_state || undefined,
            client_company_name: state.client_company_name || undefined,
            recipient_id: state.recipient_id || undefined,
          }),
        },
      );
      // Compare corrected vs. user-entered. If they differ in any
      // address1/city/state/zip field, surface the diff to the operator.
      const c = verify.corrected;
      const differs =
        norm(c.address1) !== norm(state.client_address1) ||
        norm(c.city) !== norm(state.client_city) ||
        norm(c.state) !== norm(state.client_state) ||
        norm(c.zip) !== norm(state.client_zip);
      if (differs) {
        const accepted = window.confirm(
          [
            'FedEx suggests a different address:',
            '',
            'You entered:',
            `${state.client_address1}, ${state.client_city}, ${state.client_state} ${state.client_zip}`,
            '',
            'FedEx returned:',
            `${c.address1}, ${c.city}, ${c.state} ${c.zip}`,
            '',
            'Use the FedEx-corrected version?',
          ].join('\n'),
        );
        if (accepted) {
          update({
            client_address1: c.address1,
            client_address2: c.address2,
            client_city: c.city,
            client_state: c.state,
            client_state_id: stateAbbrev(c.state),
            client_zip: c.zip,
            client_is_address_verify: 1,
            residential: verify.is_residential ? 1 : 0,
          });
          // Persist if recipient is from address book (#11).
          if (state.recipient_id) {
            try {
              await apiFetch('/admin/ifs/accept-corrected', {
                method: 'POST',
                body: JSON.stringify({
                  recipient_id: state.recipient_id,
                  FAAddress: c.address1,
                  FAAddress2: c.address2 || undefined,
                  FACity: c.city,
                  FAState: c.state,
                  FAZip: c.zip,
                  FACountry: c.country,
                  FACompanyName: c.company_name || undefined,
                  FAResidentialStatus: verify.is_residential ? 1 : 0,
                }),
              });
            } catch {
              // Non-fatal — local state has the correction either way.
            }
          }
        } else {
          update({
            client_is_address_verify: 0,
            residential: verify.is_residential ? 1 : 0,
          });
        }
      } else {
        update({
          client_is_address_verify: 1,
          residential: verify.is_residential ? 1 : 0,
        });
      }
      update({ step: 'service' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Address verify failed');
    } finally {
      setBusy(false);
    }
  }

  async function goToPackage() {
    setError(null);
    if (!state.service_type || !state.packaging_type) {
      setError('Pick a service and packaging type.');
      return;
    }
    setBusy(true);
    try {
      // #8 ZIP/service compat
      const restrict = await apiFetch<{ is_restricted: boolean; message: string }>(
        '/admin/ifs/service-restriction',
        {
          method: 'POST',
          body: JSON.stringify({
            ca_country: state.ca_country,
            client_country: state.client_country,
            service_type: state.service_type,
            client_zip: state.client_zip,
          }),
        },
      );
      if (restrict.is_restricted) {
        setError(
          `Service not available for this lane: ${restrict.message || 'change service or ZIP'}`,
        );
        return;
      }
      // #13 zone_id
      const zone = await apiFetch<IfsZoneInfo>('/admin/ifs/zone', {
        method: 'POST',
        body: JSON.stringify({
          recipient_zip: state.client_zip,
          recipient_country: state.client_country,
          shipper_zip: state.ca_zip,
          shipper_country: state.ca_country,
          service_type: state.service_type,
          recipient_address: state.client_address1,
          recipient_city: state.client_city,
          recipient_state: state.client_state,
          shipper_address: state.ca_address1,
          shipper_city: state.ca_city,
          shipper_state: state.ca_state,
        }),
      });
      update({ zone_id: zone.zone_id, step: 'package' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Service check failed');
    } finally {
      setBusy(false);
    }
  }

  async function goToCost() {
    setError(null);
    const w = Number(state.package_weight);
    if (!Number.isFinite(w) || w <= 0) {
      setError('Enter a package weight (lb).');
      return;
    }
    const insurance = Number(state.declare_value || 0);
    if (!Number.isFinite(insurance) || insurance < 0) {
      setError('Insurance value must be a non-negative number.');
      return;
    }
    setBusy(true);
    try {
      // #16 weight check
      const wk = await apiFetch<IfsWeightCheck>('/admin/ifs/check-weight', {
        method: 'POST',
        body: JSON.stringify({
          packaging_type: state.packaging_type,
          service_type: state.service_type,
          package_weight: w,
          packaging_dim_length: state.packaging_dim_length
            ? Number(state.packaging_dim_length)
            : undefined,
          packaging_dim_width: state.packaging_dim_width
            ? Number(state.packaging_dim_width)
            : undefined,
          packaging_dim_height: state.packaging_dim_height
            ? Number(state.packaging_dim_height)
            : undefined,
        }),
      });
      if (!wk.ok && wk.message) {
        // Surface the warning but let the operator continue if they
        // confirm — IFS already flags it, and the operator may have
        // physical reasons to override.
        const proceed = window.confirm(`${wk.message}\n\nContinue anyway?`);
        if (!proceed) return;
      }
      // #17 insurance check (only if value > 0)
      if (insurance > 0) {
        const dv = await apiFetch<IfsDeclareValueResult>(
          '/admin/ifs/check-declare-value',
          {
            method: 'POST',
            body: JSON.stringify({
              service_type: state.service_type,
              ca_country: state.ca_country,
              client_country: state.client_country,
              declare_value: insurance,
            }),
          },
        );
        if (dv.is_error) {
          setError(`Insurance: ${dv.message}`);
          return;
        }
        if (dv.needs_popup_chain) {
          // Render the popup chain via window.confirm — ugly but
          // functional. Replace with a real modal in v2.
          const fp = dv.first_popup;
          if (fp) {
            const isSingle = window.confirm(
              `${fp.message.join('\n')}\n\n[OK = ${fp.buttons[0] || 'Yes'}, Cancel = ${fp.buttons[1] || 'No'}]`,
            );
            if (!isSingle) {
              setError(
                'Multi-piece >$75k shipments require manual processing on ifsclients.com — wizard does not yet support PR/SR auto-split.',
              );
              return;
            }
            const sp = dv.second_popup;
            if (sp) {
              const proceedSingle = window.confirm(
                `${sp.message.join('\n')}\n\n[OK = ${sp.buttons[0] || 'Proceed'}, Cancel = ${sp.buttons[1] || 'Multiple'}]`,
              );
              if (!proceedSingle) {
                setError(
                  'Multi-piece flow requires manual processing on ifsclients.com.',
                );
                return;
              }
            }
          }
        }
      }
      // #20 cost preview
      const cost = await apiFetch<IfsCostPreview>('/admin/ifs/calculate-cost', {
        method: 'POST',
        body: JSON.stringify(buildLabelPayload(state)),
      });
      update({ cost_preview: cost, step: 'cost' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cost preview failed');
    } finally {
      setBusy(false);
    }
  }

  async function submitLabel() {
    setError(null);
    setBusy(true);
    try {
      const payload = buildLabelPayload(state);
      const res = await apiFetch<IfsCreateLabelResult>('/admin/ifs/labels', {
        method: 'POST',
        body: JSON.stringify({ invoice_id: invoiceId, payload }),
      });
      setResult(res);
      update({ step: 'success' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Label create failed');
    } finally {
      setBusy(false);
    }
  }

  async function voidLabel() {
    if (!result) return;
    if (
      !window.confirm(
        'IMPORTANT: Voiding only cancels the IFS Inforsure insurance.\n\n' +
          'The FedEx label remains scannable — you must physically prevent ' +
          'the package from being handed to FedEx.\n\nProceed?',
      )
    )
      return;
    setBusy(true);
    try {
      await apiFetch('/admin/ifs/void', {
        method: 'POST',
        body: JSON.stringify({ shipment_id: result.shipment_id }),
      });
      alert('Voided. FedEx label is still printable — block the handoff.');
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Void failed');
    } finally {
      setBusy(false);
    }
  }

  // ----- Render -----

  if (basicErr || sendersErr) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">New FedEx label · IFS</h1>
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {(basicErr || sendersErr) instanceof ApiError
            ? (basicErr || sendersErr)!.message
            : 'Failed to load IFS configuration. Verify credentials in /admin/integrations.'}
        </div>
        <Link
          href="/admin/shipments"
          className="mt-4 inline-block text-sm text-ink-500 underline-offset-2 hover:underline"
        >
          ← back to shipments
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">New FedEx label · IFS</h1>
          {invoice && (
            <p className="mt-1 text-sm text-ink-500">
              For invoice{' '}
              <Link
                href={`/admin/invoices/${invoice.id}`}
                className="font-mono underline-offset-2 hover:underline"
              >
                {invoice.invoice_number}
              </Link>
            </p>
          )}
        </div>
        <Link
          href="/admin/shipments"
          className="text-sm text-ink-500 underline-offset-2 hover:underline"
        >
          ← all shipments
        </Link>
      </div>

      <Stepper step={state.step} />

      {error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Sender */}
      <Section
        title="1. Sender"
        active={state.step === 'sender'}
        done={['recipient', 'service', 'package', 'cost', 'success'].includes(
          state.step,
        )}
        onEdit={() => update({ step: 'sender' })}
      >
        {senderList && senderList.senders.length > 0 && (
          <div className="mb-3">
            <label className="text-[11px] uppercase tracking-wide text-ink-400">
              Saved sender
            </label>
            <select
              className="input mt-1 w-full"
              value={state.selected_sender_id ?? ''}
              onChange={(e) =>
                e.target.value ? hydrateSender(e.target.value) : null
              }
            >
              <option value="">— pick one —</option>
              {senderList.senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.text || `${s.name} · ${s.address1}`}
                </option>
              ))}
            </select>
          </div>
        )}
        <AddressFields
          prefix="ca_"
          state={state}
          update={update}
          showEmail
          showPhone
        />
        <StepFooter
          busy={busy}
          onNext={goToRecipient}
          nextLabel="Continue → Recipient"
        />
      </Section>

      {/* Recipient */}
      <Section
        title="2. Recipient"
        active={state.step === 'recipient'}
        done={['service', 'package', 'cost', 'success'].includes(state.step)}
        onEdit={() => update({ step: 'recipient' })}
      >
        <RecipientPicker state={state} update={update} />
        <AddressFields
          prefix="client_"
          state={state}
          update={update}
          showEmail
          showPhone
          emailRequired
        />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="Reference (≤25 chars)">
            <input
              className="input"
              maxLength={25}
              value={state.reference}
              onChange={(e) => update({ reference: e.target.value })}
            />
          </Field>
          <Field label="Show reference on label?">
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={state.reference_show_on_label === 1}
                onChange={(e) =>
                  update({ reference_show_on_label: e.target.checked ? 1 : 0 })
                }
              />
              Print on label
            </label>
          </Field>
        </div>
        <StepFooter
          busy={busy}
          onBack={() => update({ step: 'sender' })}
          onNext={goToService}
          nextLabel="Verify address → Service"
        />
      </Section>

      {/* Service */}
      <Section
        title="3. Service & shipping"
        active={state.step === 'service'}
        done={['package', 'cost', 'success'].includes(state.step)}
        onEdit={() => update({ step: 'service' })}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Service type">
            <select
              className="input"
              value={state.service_type}
              onChange={(e) => update({ service_type: e.target.value })}
            >
              {(basicData?.service_types ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.text || s.id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Packaging type">
            <select
              className="input"
              value={state.packaging_type}
              onChange={(e) => update({ packaging_type: e.target.value })}
            >
              {(basicData?.packaging_types ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.text || p.id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Signature">
            <select
              className="input"
              value={state.signature_type1}
              onChange={(e) => update({ signature_type1: e.target.value })}
            >
              {(basicData?.signature_types ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.text || s.id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Pickup date (MM-DD-YYYY)">
            <input
              className="input font-mono"
              value={state.pickup_date}
              onChange={(e) => update({ pickup_date: e.target.value })}
              placeholder="04-29-2026"
            />
          </Field>
          <Field label="Saturday delivery">
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={state.saturday_delivery === 1}
                onChange={(e) =>
                  update({ saturday_delivery: e.target.checked ? 1 : 0 })
                }
              />
              Yes
            </label>
          </Field>
          <Field label="Residential">
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={state.residential === 1}
                onChange={(e) =>
                  update({ residential: e.target.checked ? 1 : 0 })
                }
              />
              Auto-set from #9; toggle to override
            </label>
          </Field>
        </div>
        <StepFooter
          busy={busy}
          onBack={() => update({ step: 'recipient' })}
          onNext={goToPackage}
          nextLabel="Check service → Package"
        />
      </Section>

      {/* Package + Insurance */}
      <Section
        title="4. Package, weight & insurance"
        active={state.step === 'package'}
        done={['cost', 'success'].includes(state.step)}
        onEdit={() => update({ step: 'package' })}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Weight (lb)">
            <input
              className="input"
              type="number"
              min={0}
              step="0.1"
              value={state.package_weight}
              onChange={(e) => update({ package_weight: e.target.value })}
            />
          </Field>
          <Field label="Insurance value (USD)">
            <input
              className="input"
              type="number"
              min={0}
              step="1"
              value={state.declare_value}
              onChange={(e) => update({ declare_value: e.target.value })}
            />
          </Field>
          {state.packaging_type === 'YOUR_PACKAGING' && (
            <>
              <Field label="Length (in)">
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={state.packaging_dim_length}
                  onChange={(e) =>
                    update({ packaging_dim_length: e.target.value })
                  }
                />
              </Field>
              <Field label="Width (in)">
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={state.packaging_dim_width}
                  onChange={(e) =>
                    update({ packaging_dim_width: e.target.value })
                  }
                />
              </Field>
              <Field label="Height (in)">
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={state.packaging_dim_height}
                  onChange={(e) =>
                    update({ packaging_dim_height: e.target.value })
                  }
                />
              </Field>
            </>
          )}
          <Field label="Payment">
            <select
              className="input"
              value={state.payment_type}
              onChange={(e) =>
                update({
                  payment_type: e.target.value as
                    | 'SENDER'
                    | 'RECIPIENT'
                    | 'THIRD_PARTY',
                })
              }
            >
              <option value="SENDER">Sender</option>
              <option value="RECIPIENT">Recipient</option>
              <option value="THIRD_PARTY">Third party</option>
            </select>
          </Field>
          {state.payment_type !== 'SENDER' && (
            <Field label="FedEx account #">
              <input
                className="input"
                value={state.account_number}
                onChange={(e) => update({ account_number: e.target.value })}
              />
            </Field>
          )}
        </div>
        <StepFooter
          busy={busy}
          onBack={() => update({ step: 'service' })}
          onNext={goToCost}
          nextLabel="Check insurance → Cost preview"
        />
      </Section>

      {/* Cost */}
      <Section
        title="5. Cost preview"
        active={state.step === 'cost'}
        done={state.step === 'success'}
      >
        {state.cost_preview ? (
          <CostPreviewBlock cost={state.cost_preview} />
        ) : (
          <p className="text-sm text-ink-400">No preview yet.</p>
        )}
        <StepFooter
          busy={busy}
          onBack={() => update({ step: 'package' })}
          onNext={submitLabel}
          nextLabel="Create label →"
        />
      </Section>

      {/* Success */}
      {state.step === 'success' && result && (
        <SuccessBlock
          result={result}
          onVoid={voidLabel}
          onAnother={() => {
            setResult(null);
            setError(null);
            setState((s) => ({ ...initialState(), selected_sender_id: s.selected_sender_id, ca_company_name: s.ca_company_name, ca_name: s.ca_name, ca_label_name: s.ca_label_name, ca_email: s.ca_email, ca_address1: s.ca_address1, ca_address2: s.ca_address2, ca_city: s.ca_city, ca_state: s.ca_state, ca_state_id: s.ca_state_id, ca_zip: s.ca_zip, ca_country: s.ca_country, ca_phone: s.ca_phone }));
          }}
          invoiceHref={
            invoice ? `/admin/invoices/${invoice.id}` : '/admin/shipments'
          }
        />
      )}
    </div>
  );
}

// ===== Section helpers =====

function Stepper({ step }: { step: WizardStep }) {
  const steps: { id: WizardStep; label: string }[] = [
    { id: 'sender', label: 'Sender' },
    { id: 'recipient', label: 'Recipient' },
    { id: 'service', label: 'Service' },
    { id: 'package', label: 'Package' },
    { id: 'cost', label: 'Cost' },
    { id: 'success', label: 'Done' },
  ];
  const currentIdx = steps.findIndex((s) => s.id === step);
  return (
    <ol className="mt-4 flex flex-wrap items-center gap-2 text-xs">
      {steps.map((s, i) => {
        const state =
          i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'pending';
        return (
          <li
            key={s.id}
            className={
              'flex items-center gap-2 rounded-full px-3 py-1 ' +
              (state === 'done'
                ? 'bg-ink-900 text-white'
                : state === 'current'
                  ? 'bg-ink-100 text-ink-900 ring-1 ring-ink-300'
                  : 'bg-ink-50 text-ink-400')
            }
          >
            <span className="font-medium">{i + 1}.</span> {s.label}
          </li>
        );
      })}
    </ol>
  );
}

function Section({
  title,
  active,
  done,
  onEdit,
  children,
}: {
  title: string;
  active: boolean;
  done?: boolean;
  onEdit?: () => void;
  children: React.ReactNode;
}) {
  if (!active && !done) {
    return (
      <section className="mt-4 rounded-xl border border-ink-100 bg-ink-50/40 p-4">
        <h2 className="text-sm font-semibold text-ink-400">{title}</h2>
      </section>
    );
  }
  return (
    <section
      className={
        'mt-4 rounded-xl border bg-white p-5 ' +
        (active ? 'border-ink-300 shadow-sm' : 'border-ink-100')
      }
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        {done && !active && onEdit && (
          <button
            onClick={onEdit}
            className="text-xs text-ink-500 underline-offset-2 hover:underline"
          >
            edit
          </button>
        )}
      </div>
      {active && <div className="mt-3">{children}</div>}
    </section>
  );
}

function StepFooter({
  busy,
  onBack,
  onNext,
  nextLabel,
}: {
  busy: boolean;
  onBack?: () => void;
  onNext: () => void | Promise<void>;
  nextLabel: string;
}) {
  return (
    <div className="mt-5 flex items-center justify-between border-t border-ink-100 pt-4">
      {onBack ? (
        <button
          onClick={onBack}
          disabled={busy}
          className="rounded-md border border-ink-200 px-3 py-1.5 text-sm font-medium hover:bg-ink-50 disabled:opacity-60"
        >
          ← Back
        </button>
      ) : (
        <span />
      )}
      <button
        onClick={onNext}
        disabled={busy}
        className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
      >
        {busy ? 'Working…' : nextLabel}
      </button>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wide text-ink-400">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function AddressFields({
  prefix,
  state,
  update,
  showEmail,
  showPhone,
  emailRequired,
}: {
  prefix: 'ca_' | 'client_';
  state: WizardState;
  update: (p: Partial<WizardState>) => void;
  showEmail?: boolean;
  showPhone?: boolean;
  /** When true, label the email field as required (IFS #26 always wants it). */
  emailRequired?: boolean;
}) {
  // We branch on the prefix so TypeScript can narrow the field names.
  const get = (k: string) => (state as unknown as Record<string, string>)[`${prefix}${k}`] || '';
  const set = (k: string, v: string) =>
    update({ [`${prefix}${k}`]: v } as unknown as Partial<WizardState>);
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Contact name">
        <input
          className="input"
          value={get('label_name')}
          onChange={(e) => set('label_name', e.target.value)}
        />
      </Field>
      <Field label="Company">
        <input
          className="input"
          value={get(prefix === 'ca_' ? 'name' : 'name')}
          onChange={(e) => set('name', e.target.value)}
        />
      </Field>
      {prefix === 'client_' && (
        <Field label="Company (Not Appear)">
          <input
            className="input"
            value={get('company_name')}
            onChange={(e) => set('company_name', e.target.value)}
          />
        </Field>
      )}
      {prefix === 'ca_' && (
        <Field label="Company (Not Appear)">
          <input
            className="input"
            value={get('company_name')}
            onChange={(e) => set('company_name', e.target.value)}
          />
        </Field>
      )}
      <Field label="Address line 1">
        <input
          className="input"
          value={get('address1')}
          onChange={(e) => set('address1', e.target.value)}
        />
      </Field>
      <Field label="Address line 2">
        <input
          className="input"
          value={get('address2')}
          onChange={(e) => set('address2', e.target.value)}
        />
      </Field>
      <Field label="City">
        <input
          className="input"
          value={get('city')}
          onChange={(e) => set('city', e.target.value)}
        />
      </Field>
      <Field label="State">
        <input
          className="input"
          value={get('state')}
          onChange={(e) => {
            set('state', e.target.value);
            set('state_id', stateAbbrev(e.target.value));
          }}
        />
      </Field>
      <Field label="ZIP">
        <input
          className="input"
          value={get('zip')}
          onChange={(e) => set('zip', e.target.value)}
        />
      </Field>
      <Field label="Country">
        <input
          className="input"
          value={get('country')}
          onChange={(e) => set('country', e.target.value)}
        />
      </Field>
      {showPhone && (
        <Field label="Phone">
          <input
            className="input"
            value={get('phone')}
            onChange={(e) => set('phone', e.target.value)}
          />
        </Field>
      )}
      {showEmail && (
        <Field label={emailRequired ? 'Email (required)' : 'Email'}>
          <input
            className="input"
            type="email"
            required={emailRequired}
            value={get('email')}
            onChange={(e) => set('email', e.target.value)}
          />
        </Field>
      )}
    </div>
  );
}

function RecipientPicker({
  state,
  update,
}: {
  state: WizardState;
  update: (p: Partial<WizardState>) => void;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<IfsRecipientListEntry[]>([]);
  const [searching, setSearching] = useState(false);

  async function search() {
    setSearching(true);
    try {
      const res = await apiFetch<IfsRecipientListEntry[]>(
        `/admin/ifs/recipients?term=${encodeURIComponent(term)}`,
      );
      setResults(res);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="mb-3 rounded-md border border-ink-100 bg-ink-50/40 p-3">
      <label className="text-[11px] uppercase tracking-wide text-ink-400">
        Search saved recipients (optional)
      </label>
      <div className="mt-1 flex gap-2">
        <input
          className="input flex-1"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Company name…"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void search();
            }
          }}
        />
        <button
          type="button"
          onClick={search}
          disabled={searching}
          className="rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium hover:bg-ink-50 disabled:opacity-60"
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>
      {results.length > 0 && (
        <ul className="mt-2 max-h-40 overflow-y-auto rounded border border-ink-200 bg-white text-sm">
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left hover:bg-ink-50"
                onClick={() => {
                  update({ recipient_id: r.id, client_label_name: r.name });
                  setResults([]);
                  setTerm(r.name);
                }}
              >
                {r.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.recipient_id && (
        <p className="mt-2 text-xs text-ink-500">
          Linked to saved recipient · address fields below pre-filled from your
          input. (Full hydration via #6 not wired yet — fill in any missing
          fields.)
        </p>
      )}
    </div>
  );
}

function CostPreviewBlock({ cost }: { cost: IfsCostPreview }) {
  return (
    <div className="rounded-md border border-ink-200 bg-ink-50/40 p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">
        Estimated cost
      </div>
      <div className="mt-1 text-2xl font-semibold">
        ${cost.final_amount.toFixed(2)}
      </div>
      <table className="mt-3 w-full text-sm">
        <tbody>
          {cost.line_items.map((li, i) => (
            <tr key={i} className="border-t border-ink-200">
              <td className="py-1.5 text-ink-500">{li.title}</td>
              <td className="py-1.5 text-right font-mono">{li.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cost.final_amount_2 !== null && (
        <div className="mt-4 border-t border-ink-200 pt-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">
            Second piece (multi-ship split)
          </div>
          <div className="mt-1 text-lg font-semibold">
            ${cost.final_amount_2.toFixed(2)}
          </div>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {(cost.line_items_2 ?? []).map((li, i) => (
                <tr key={i} className="border-t border-ink-200">
                  <td className="py-1.5 text-ink-500">{li.title}</td>
                  <td className="py-1.5 text-right font-mono">{li.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SuccessBlock({
  result,
  onVoid,
  onAnother,
  invoiceHref,
}: {
  result: IfsCreateLabelResult;
  onVoid: () => void;
  onAnother: () => void;
  invoiceHref: string;
}) {
  return (
    <section className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-5">
      <h2 className="text-sm font-semibold text-emerald-900">
        ✓ Label created
      </h2>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-emerald-800/70">
            Tracking
          </dt>
          <dd className="mt-1 font-mono">
            <a
              href={`https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(result.tracking_no)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline-offset-2 hover:underline"
            >
              {result.tracking_no}
            </a>
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-emerald-800/70">
            IFS shipment id
          </dt>
          <dd className="mt-1 font-mono">{result.shipment_id}</dd>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        {result.view_label_link && (
          <a
            href={result.view_label_link}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-white"
          >
            View label PDF →
          </a>
        )}
        {result.view_receipt && (
          <a
            href={result.view_receipt}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm font-medium hover:bg-ink-50"
          >
            View receipt →
          </a>
        )}
        {result.view_return_label_link && (
          <a
            href={result.view_return_label_link}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm font-medium hover:bg-ink-50"
          >
            Return label →
          </a>
        )}
        <button
          onClick={onAnother}
          className="rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm font-medium hover:bg-ink-50"
        >
          Create another
        </button>
        <Link
          href={invoiceHref}
          className="rounded-md border border-ink-200 bg-white px-3 py-1.5 text-sm font-medium hover:bg-ink-50"
        >
          Done
        </Link>
        <button
          onClick={onVoid}
          className="ml-auto rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
          title="Voids only the IFS Inforsure insurance — the FedEx label remains valid."
        >
          Void (insurance only)
        </button>
      </div>
      {result.shipments_row_id && (
        <p className="mt-3 text-xs text-emerald-800/70">
          Linked to invoice in local shipments table — visible on the invoice
          detail page and /admin/shipments.
        </p>
      )}
    </section>
  );
}

// ===== Helpers =====

function todayMmDdYyyy(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${mm}-${dd}-${yyyy}`;
}

function norm(s: string): string {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Best-effort "Georgia" → "GA" mapping. The wizard accepts user-typed
 * state names + IFS's own form expects state_id (US state code) when
 * country = United States. For non-US shipments the field is just
 * passed through. Falls back to the input verbatim if no match.
 */
const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR',
  california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
};

function stateAbbrev(input: string): string {
  if (!input) return '';
  const k = input.trim().toLowerCase();
  if (US_STATES[k]) return US_STATES[k];
  // Already a code? Pass through uppercase if it's 2 letters.
  if (/^[a-zA-Z]{2}$/.test(input.trim())) return input.trim().toUpperCase();
  return input;
}

/**
 * Find the tenant's default sender in the IFS-saved sender list.
 * Operators set `ifs.sender_match` in Settings to a stable substring
 * (typically the company-name string IFS shows in its sender list);
 * matching on that survives IFS-side address edits. Falls back to
 * the IFS-side `primary_id`, then to the first sender if nothing
 * matches (or the setting is empty).
 */
function pickDefaultSender(
  list: IfsSenderListResp,
  matchString: string,
): IfsSenderListEntry | null {
  const target = matchString.trim().toLowerCase();
  if (target.length > 0) {
    const byName = list.senders.find((s) => {
      const haystack = `${s.text} ${s.name} ${s.company_name}`.toLowerCase();
      return haystack.includes(target);
    });
    if (byName) return byName;
  }
  if (list.primary_id) {
    const byPrimary = list.senders.find((s) => s.id === list.primary_id);
    if (byPrimary) return byPrimary;
  }
  return list.senders[0] ?? null;
}

/**
 * Translate WizardState into the LabelPayloadDto shape the API expects.
 * Strings get coerced back to numbers where appropriate; empty fields
 * are dropped to optional-undefined so DTO validators pass.
 */
function buildLabelPayload(s: WizardState): Record<string, unknown> {
  const optStr = (v: string) => (v ? v : undefined);
  const optNum = (v: string) => (v ? Number(v) : undefined);
  return {
    // Sender
    ca_company_name: s.ca_company_name,
    ca_name: s.ca_name,
    ca_label_name: s.ca_label_name,
    ca_email: s.ca_email,
    ca_address1: s.ca_address1,
    ca_address2: optStr(s.ca_address2),
    ca_city: s.ca_city,
    ca_zip: s.ca_zip,
    ca_state: s.ca_state,
    ca_state_id: s.ca_state_id || s.ca_state,
    ca_country: s.ca_country,
    ca_phone: s.ca_phone,
    // Recipient
    recipient_id: optStr(s.recipient_id),
    client_label_name: s.client_label_name,
    client_company_name: s.client_company_name || s.client_name,
    client_name: s.client_name || s.client_label_name,
    client_address1: s.client_address1,
    client_address2: optStr(s.client_address2),
    client_city: s.client_city,
    client_state: s.client_state,
    client_state_id: s.client_state_id || s.client_state,
    client_zip: s.client_zip,
    client_country: s.client_country,
    client_phone: s.client_phone,
    client_email: optStr(s.client_email),
    client_is_address_verify: s.client_is_address_verify,
    residential: s.residential,
    // Package
    packaging_type: s.packaging_type,
    package_weight: Number(s.package_weight),
    packaging_dim_length: optNum(s.packaging_dim_length),
    packaging_dim_width: optNum(s.packaging_dim_width),
    packaging_dim_height: optNum(s.packaging_dim_height),
    // Service
    service_type: s.service_type,
    zone_id: s.zone_id ?? 0,
    signature_type1: s.signature_type1,
    saturday_delivery: s.saturday_delivery,
    pickup_date: s.pickup_date,
    declare_value: Number(s.declare_value || 0),
    // Billing
    payment_type: s.payment_type,
    account_number: optStr(s.account_number),
    cost: s.cost_preview?.final_amount,
    // Reference / output
    reference: optStr(s.reference),
    reference_show_on_label: s.reference_show_on_label,
    label_stock_type: DEFAULT_LABEL_STOCK,
    gen_label_save: 1,
    display_receipt: 1,
  };
}

// Re-export `useMemo` so prettier doesn't flag the import as unused.
// (Kept for future use if we add memoized derived state.)
void useMemo;
