/**
 * Carrier-specific delivery speed whitelist (ticket SHIP-001).
 *
 * The list mirrors the options available in each carrier's retail shipping
 * UI as of 2026-04. Values are persisted as TEXT in `shipments.delivery_speed`
 * (migration 021) and validated against this table at write time — we do NOT
 * store them as an enum in Postgres because carriers add/rename services
 * often and a CHECK constraint would force a migration on each change.
 *
 * Labels are what the UI renders; they double as the stored value so
 * historical rows are human-readable without a lookup table.
 *
 * When a carrier is not in this table (e.g. 'other'), delivery_speed must
 * be NULL — we don't accept arbitrary free-form strings since they'd break
 * the dropdown UX in a way the operator couldn't see until later.
 */
export const DELIVERY_SPEEDS = {
  usps: ['Flat Rate', 'Ground Advantage', 'Priority', 'Priority Express'],
  ups: [
    'Ground',
    '2nd Day Air',
    '2nd Day Air - Saturday Delivery',
    'Overnight',
    'Overnight - Saturday Delivery',
    'Overnight - Early Delivery',
  ],
  fedex: [
    'Ground',
    '2nd Day Air',
    'Overnight - Standard',
    'Overnight - Priority',
  ],
  other: [] as string[],
} as const;

export type ShipmentCarrier = keyof typeof DELIVERY_SPEEDS;

/**
 * Validate a (carrier, speed) pair.
 *
 *   - carrier not in whitelist → throws
 *   - speed undefined/null     → ok (speed is optional)
 *   - carrier='other' + speed  → throws (no whitelist for 'other')
 *   - speed present but not in carrier's list → throws
 *
 * Returns the normalized speed (trimmed) or null.
 */
export function validateDeliverySpeed(
  carrier: string,
  speed: string | null | undefined,
): string | null {
  if (speed === undefined || speed === null || speed === '') return null;
  if (!(carrier in DELIVERY_SPEEDS)) {
    throw new Error(`Unknown carrier: ${carrier}`);
  }
  const trimmed = speed.trim();
  const allowed = DELIVERY_SPEEDS[carrier as ShipmentCarrier];
  if (!allowed.includes(trimmed as never)) {
    throw new Error(
      `Invalid delivery speed "${trimmed}" for carrier ${carrier}. ` +
        `Allowed: ${allowed.length ? allowed.join(', ') : '(none — carrier does not support service levels)'}`,
    );
  }
  return trimmed;
}
