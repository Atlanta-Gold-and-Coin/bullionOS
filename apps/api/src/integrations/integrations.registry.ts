import { z } from 'zod';

/**
 * Registry of known integration providers. Each provider declares:
 *   - a Zod schema for its credentials
 *   - which fields are "secret" (masked in responses)
 *   - how to derive the non-secret display_hint
 *
 * To add a new provider, append here and add its name to ProviderName.
 * Everything else (storage, encryption, admin UI) is provider-agnostic.
 */

const upsCreds = z.object({
  client_id: z.string().min(20).max(200),
  client_secret: z.string().min(20).max(500),
  account_number: z.string().max(20).optional().default(''),
  environment: z.enum(['cie', 'production']).default('cie'),
});

const fedexCreds = z.object({
  api_key: z.string().min(20).max(200),
  secret_key: z.string().min(20).max(500),
  account_number: z.string().min(5).max(20),
  environment: z.enum(['sandbox', 'production']).default('sandbox'),
});

const uspsCreds = z.object({
  consumer_key: z.string().min(10).max(200),
  consumer_secret: z.string().min(10).max(500),
  crid: z.string().min(3).max(20).optional().default(''),
  mid: z.string().min(3).max(20).optional().default(''),
  environment: z.enum(['test', 'production']).default('test'),
});

const metalsCreds = z.object({
  api_key: z.string().min(8).max(500),
  // URL override in case metals.dev moves or you mirror the API.
  url: z.string().url().default('https://api.metals.dev/v1/latest'),
});

const docusignCreds = z.object({
  integration_key: z.string().min(20).max(100),
  account_id: z.string().min(20).max(100),
  user_id: z.string().min(20).max(100),
  base_path: z
    .string()
    .url()
    .default('https://demo.docusign.net/restapi'),
  // RSA private key (PEM). Required for JWT Grant.
  private_key_pem: z.string().min(100),
  webhook_secret: z.string().min(8).max(200).optional().default(''),
  // Per-template GUIDs.
  template_buy_contract: z.string().optional().default(''),
  template_sell_contract: z.string().optional().default(''),
});

export const PROVIDERS = {
  ups: {
    label: 'UPS',
    schema: upsCreds,
    secretFields: ['client_secret'] as const,
    hint: (c: z.infer<typeof upsCreds>) => `${c.environment} · id ${maskId(c.client_id)}`,
  },
  fedex: {
    label: 'FedEx',
    schema: fedexCreds,
    secretFields: ['secret_key'] as const,
    hint: (c: z.infer<typeof fedexCreds>) => `${c.environment} · acct ${mask(c.account_number)}`,
  },
  usps: {
    label: 'USPS',
    schema: uspsCreds,
    secretFields: ['consumer_secret'] as const,
    hint: (c: z.infer<typeof uspsCreds>) => `${c.environment} · key ${maskId(c.consumer_key)}`,
  },
  docusign: {
    label: 'DocuSign',
    schema: docusignCreds,
    secretFields: ['private_key_pem', 'webhook_secret'] as const,
    hint: (c: z.infer<typeof docusignCreds>) =>
      `acct ${mask(c.account_id)} · ${c.base_path.includes('demo') ? 'demo' : 'prod'}`,
  },
  metals: {
    label: 'metals.dev',
    schema: metalsCreds,
    secretFields: ['api_key'] as const,
    hint: (c: z.infer<typeof metalsCreds>) =>
      `key ${maskId(c.api_key)} · ${new URL(c.url).host}`,
  },
} as const;

export type ProviderName = keyof typeof PROVIDERS;

export type CredentialsFor<P extends ProviderName> = z.infer<(typeof PROVIDERS)[P]['schema']>;

export function isProvider(name: string): name is ProviderName {
  return name in PROVIDERS;
}

function mask(s: string, keep = 4): string {
  if (!s) return '';
  if (s.length <= keep) return '*'.repeat(s.length);
  return `${'*'.repeat(Math.max(4, s.length - keep))}${s.slice(-keep)}`;
}

function maskId(s: string): string {
  if (!s) return '';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** Strip secret fields from a credentials object for public display. */
export function redact<P extends ProviderName>(
  provider: P,
  creds: CredentialsFor<P>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...creds };
  for (const f of PROVIDERS[provider].secretFields) {
    if (f in out) out[f as string] = mask(String(out[f as string]));
  }
  return out;
}
