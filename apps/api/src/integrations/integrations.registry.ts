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

/**
 * Google Calendar OAuth2 credentials for the public booking flow.
 *
 * Setup (one-time, by an admin):
 *   1. In Google Cloud Console, create an OAuth 2.0 Web Application client.
 *   2. Add the redirect URI shown in the admin UI.
 *   3. Paste client_id + client_secret here.
 *   4. Click "Authorize with Google" — the flow signs in as the Sales
 *      mailbox and returns a refresh_token we persist to this row.
 *   5. Set calendar_id to the target calendar (usually 'primary' for the
 *      Sales mailbox).
 *
 * The refresh_token is the one credential we *can't* let the admin paste
 * in raw — it has to come from Google's OAuth server. The admin UI will
 * call the PUT endpoint with the full object after the OAuth exchange
 * completes.
 */
const googleCalendarCreds = z.object({
  client_id: z.string().min(20).max(400),
  client_secret: z.string().min(20).max(400),
  // Sales@... primary calendar by default.
  calendar_id: z.string().min(1).max(400).default('primary'),
  // Populated by the OAuth callback after the one-time user consent.
  // Empty string until the admin clicks "Authorize with Google" — that's
  // the expected first-save state, so no length minimum here.
  refresh_token: z.string().max(1000).default(''),
  // IANA tz — matters because Google expects RFC3339 w/ tz and the shop
  // operates in America/New_York.
  timezone: z.string().min(3).max(64).default('America/New_York'),
  // Booking window in days from today. 30 is a sensible default for a
  // walk-in business; weddings and appraisals can be longer.
  booking_window_days: z.coerce.number().int().min(1).max(180).default(30),
  // Appointment slot length in minutes.
  slot_minutes: z.coerce.number().int().min(10).max(240).default(30),
  // Business hours, 24h clock. One range per weekday, Monday = 1.
  // Value '' means closed that day.
  hours_mon: z.string().max(32).default('10:00-17:00'),
  hours_tue: z.string().max(32).default('10:00-17:00'),
  hours_wed: z.string().max(32).default('10:00-17:00'),
  hours_thu: z.string().max(32).default('10:00-17:00'),
  hours_fri: z.string().max(32).default('10:00-17:00'),
  hours_sat: z.string().max(32).default(''),
  hours_sun: z.string().max(32).default(''),
  // Semicolon-separated human-readable service names the public form
  // offers. E.g. "Buy consultation;Sell consultation;Appraisal".
  services: z
    .string()
    .max(500)
    .default('Buy consultation;Sell consultation;Appraisal'),
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
  google_calendar: {
    label: 'Google Calendar (Booking)',
    schema: googleCalendarCreds,
    secretFields: ['client_secret', 'refresh_token'] as const,
    hint: (c: z.infer<typeof googleCalendarCreds>) =>
      `${c.calendar_id} · ${c.refresh_token ? 'authorized' : 'not authorized'}`,
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
