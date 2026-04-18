/**
 * One-shot: wipe every product + related pricing rule / inventory / quote,
 * then import a fresh catalog from the "Updated AGC product rates" CSV
 * and create a per-product BUY pricing rule with the operator-chosen %.
 *
 * What this DOES remove:
 *   - products (hard delete)
 *   - pricing_rules WHERE scope='product' (cascaded on FK)
 *   - inventory rows (cascaded)
 *   - price_quotes (cascaded)
 *
 * What it does NOT remove:
 *   - invoices + invoice_line_items — product_id is nullable with ON DELETE
 *     SET NULL (migration 010). Historical invoices stay intact; their
 *     line items keep their snapshot rows (name, weight, premium, unit price
 *     at time of invoice) but lose the FK link to the now-deleted product.
 *   - Metal-scoped pricing_rules (scope='metal'). These survive in case
 *     a product is later imported without its own override.
 *
 * The new pricing semantic is "X% of spot × metal_content". CSV 'Percent' is
 * stored on the rule as buy_premium_value and read verbatim. The sell
 * default is 105 (typical 5% retail markup); operators can edit per-product
 * on /admin/products/:id.
 *
 * Usage:
 *   DATABASE_URL=... pnpm exec tsx src/db/reset-and-import-products.ts <csv>
 */

import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { DB, Metal, ProductCategory } from './types';

// Default sell-side markup applied to every freshly-imported product. The
// CSV only carries buy percentages — operators edit sell per-product via
// the in-stock / buy sheet inline editor.
const DEFAULT_SELL_PERCENT = '105';

interface Row {
  csvCategory: string;
  name: string;
  oz: string; // AGW in troy oz
  percent: string; // e.g. "96" for 96%
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: tsx reset-and-import-products.ts <csv path>');
    process.exit(2);
  }
  const connectionString =
    process.env.DATABASE_URL ?? process.env.DATABASE_PUBLIC_URL;
  if (!connectionString) {
    console.error('Set DATABASE_URL.');
    process.exit(2);
  }

  const raw = await fs.readFile(path, 'utf8');
  const rows = parseCsv(raw);
  if (rows.length === 0) {
    console.error('No rows parsed.');
    process.exit(1);
  }

  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        ssl: isLocal ? false : { rejectUnauthorized: false },
      }),
    }),
  });

  // Guard: require explicit confirmation before wiping production.
  // Set WIPE_CONFIRMED=yes in the environment to proceed.
  if ((process.env.WIPE_CONFIRMED ?? '').toLowerCase() !== 'yes') {
    console.error(
      'Refusing to wipe products without explicit confirmation.\n' +
        'Re-run with WIPE_CONFIRMED=yes to proceed.',
    );
    await db.destroy();
    process.exit(2);
  }

  const existing = await db
    .selectFrom('products')
    .select(db.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  console.log(`Current product count: ${existing.n}`);
  console.log(`Planning to import: ${rows.length} rows`);

  // Counters by metal/category for SKU assignment + console summary.
  const skuCounter = new Map<string, number>();
  const counts = { inserted: 0, rules: 0 };

  try {
    await db.transaction().execute(async (trx) => {
      // Wipe in FK-friendly order. price_quotes + inventory both cascade
      // from products; explicit deletes make the log line-by-line clearer.
      await sql`DELETE FROM price_quotes`.execute(trx);
      await sql`DELETE FROM inventory`.execute(trx);
      await sql`DELETE FROM pricing_rules WHERE scope = 'product'`.execute(trx);

      // deal_requests has a CHECK constraint requiring product_id OR
      // product_description to be non-null (migration 004). When we SET
      // NULL on product_id during delete cascade, any row whose
      // product_description was empty would trip the check. Backfill
      // product_description from the product name first so the row still
      // satisfies the constraint after the cascade.
      await sql`
        UPDATE deal_requests
           SET product_description = p.name
          FROM products p
         WHERE deal_requests.product_id = p.id
           AND (deal_requests.product_description IS NULL
                OR deal_requests.product_description = '')
      `.execute(trx);

      // invoice_line_items.product_id is SET NULL on delete (migration 010).
      // deal_requests.product_id is SET NULL (migration 012).
      // Nothing else to hand-cascade.
      await sql`DELETE FROM products`.execute(trx);
      console.log('  ✓ Cleared existing products and dependent rows');

      let position = 0;
      for (const r of rows) {
        position += 1;

        const metal = inferMetal(r.csvCategory, r.name);
        const dbCategory = mapCategory(r.csvCategory, r.name);
        const agw = r.oz;
        const sku = nextSku(skuCounter, metal, dbCategory);
        const sortOrder = position * 10;

        const insertedProduct = await trx
          .insertInto('products')
          .values({
            sku,
            name: r.name,
            metal,
            category: dbCategory,
            // metal_content_troy_oz is the only weight field used by the
            // pricing engine; gross + purity are stored for display only.
            // CSV 'Oz' is AGW — set all three to the same value so the
            // math round-trips correctly regardless of which column a
            // caller reads. Operators can refine purity per product later.
            weight_troy_oz: agw,
            purity: '1',
            metal_content_troy_oz: agw,
            is_active: true,
            show_on_website: true,
            sort_order: sortOrder,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await trx
          .insertInto('pricing_rules')
          .values({
            scope: 'product',
            product_id: insertedProduct.id,
            metal: null,
            buy_premium_type: 'percent',
            buy_premium_value: r.percent,
            sell_premium_type: 'percent',
            sell_premium_value: DEFAULT_SELL_PERCENT,
            is_active: true,
          })
          .execute();

        counts.inserted += 1;
        counts.rules += 1;
      }
    });
  } finally {
    // Vacuum the changes are flushed before the connection closes so the
    // calling process sees a steady-state count on immediate re-read.
  }

  const afterCount = await db
    .selectFrom('products')
    .select(db.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  await db.destroy();

  console.log('');
  console.log(`✓ Import complete`);
  console.log(`  Products inserted:       ${counts.inserted}`);
  console.log(`  Product pricing rules:   ${counts.rules}`);
  console.log(`  Product count now:       ${afterCount.n}`);
}

/**
 * Infer the primary metal from the CSV category or row name. CSV category
 * is the authoritative signal on this file; we fall back to name patterns
 * on the few rows where the category is vague (e.g. "Proof Sets" that are
 * silver).
 */
function inferMetal(category: string, name: string): Metal {
  const c = category.toLowerCase();
  const n = name.toLowerCase();
  if (c.includes('gold')) return 'gold';
  if (c.includes('platinum')) return 'platinum';
  if (c.includes('palladium')) return 'palladium';
  if (c.includes('silver')) return 'silver';
  if (/\bproof set|uncirculated|premier|prestige\b/.test(c)) return 'silver';
  if (/gold/.test(n)) return 'gold';
  if (/platinum/.test(n)) return 'platinum';
  if (/palladium/.test(n)) return 'palladium';
  return 'silver';
}

/**
 * Map the free-form CSV category (plus hints from the name) to the
 * schema's canonical ProductCategory (coin|bar|round|numismatic|jewelry|
 * other). The frontend's deriveDisplayCategory re-partitions further into
 * 12 operator-facing buckets (silver_junk, pre_1933_gold, etc.).
 */
function mapCategory(csvCategory: string, name: string): ProductCategory {
  const c = csvCategory.toLowerCase();
  const n = name.toLowerCase();
  if (c.includes('bar')) return 'bar';
  if (c.includes('pre-1933')) return 'numismatic';
  if (c.includes('proof set') || c.includes('uncirculated') || c.includes('premier') || c.includes('prestige')) {
    return 'numismatic';
  }
  if (/\bround\b/.test(c) || /\bround\b/.test(n)) return 'round';
  if (c.includes('coin')) return 'coin';
  if (/\bbar\b/.test(n)) return 'bar';
  return 'coin';
}

/**
 * Generate deterministic SKUs so operators can recognize them at a glance.
 * Format: METAL-CAT-### — e.g. AU-C-001 for the first gold coin, AU-N-001
 * for the first pre-1933 numismatic gold, AG-B-001 for the first silver
 * bar/round. Reset within each metal+category combo so the sequence doesn't
 * get overwhelmingly large.
 */
function nextSku(
  counter: Map<string, number>,
  metal: Metal,
  category: ProductCategory,
): string {
  const metalPrefix = { gold: 'AU', silver: 'AG', platinum: 'PT', palladium: 'PD' }[metal];
  const catLetter =
    category === 'coin'
      ? 'C'
      : category === 'bar'
        ? 'B'
        : category === 'round'
          ? 'R'
          : category === 'numismatic'
            ? 'N'
            : category === 'jewelry'
              ? 'J'
              : 'X';
  const key = `${metalPrefix}-${catLetter}`;
  const next = (counter.get(key) ?? 0) + 1;
  counter.set(key, next);
  return `${key}-${String(next).padStart(3, '0')}`;
}

/**
 * Parse the Aureus-style CSV: header row "Category,Product,Oz,Percent,FixedPrice".
 * Skips:
 *   - empty rows
 *   - rows whose Product field is blank (the file has "Category Xyz,,,,"
 *     comment markers used as visual separators)
 *   - rows that contain neither a percent nor a fixed price
 */
function parseCsv(text: string): Row[] {
  const stripped = text.replace(/^\uFEFF/, '');
  const lines = stripped.split(/\r?\n/);
  const out: Row[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    // Header
    if (/^category,product/i.test(raw)) continue;
    // Simple CSV split — no quoted fields in this file.
    const cols = raw.split(',').map((s) => s.trim());
    if (cols.length < 4) continue;
    const [category, product, oz, percent] = cols;
    // Skip separator rows ("Category XYZ,,,,") — they have no product.
    if (!product) continue;
    // Need at least a percent or we can't price the row.
    if (!percent) continue;
    // Clean up non-ASCII whitespace Aureus sometimes wedges into names.
    const cleanName = product.replace(/\s{2,}/g, ' ').replace(/\s+/g, ' ').trim();
    out.push({
      csvCategory: category,
      name: cleanName,
      oz: oz || '0',
      percent,
    });
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
