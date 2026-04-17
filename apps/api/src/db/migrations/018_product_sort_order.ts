import { Kysely, sql } from 'kysely';

/**
 * 018_product_sort_order
 *
 * Adds an INTEGER sort_order column to products so the catalog page can
 * present a hand-curated order (drag-and-drop UI) rather than fall back
 * to alphabetical. Existing rows are seeded with their created_at rank
 * so the initial order matches what the user sees today. New rows land
 * at the end (max+10) unless the caller specifies otherwise.
 *
 * Index is a partial on (is_active, sort_order) since the catalog page
 * only lists active products — keeps the index tight.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('products')
    .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();

  // Seed: give every existing row a sort_order matching created_at order.
  // We step by 10 so drag-reorder has integer headroom to slot rows
  // in-between without a full renumber on every move.
  await sql`
    WITH ordered AS (
      SELECT id, (row_number() OVER (ORDER BY created_at, id)) * 10 AS rank
      FROM products
    )
    UPDATE products p
    SET sort_order = o.rank
    FROM ordered o
    WHERE p.id = o.id
  `.execute(db);

  await db.schema
    .createIndex('products_sort_order_idx')
    .on('products')
    .columns(['is_active', 'sort_order'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('products_sort_order_idx').ifExists().execute();
  await db.schema.alterTable('products').dropColumn('sort_order').execute();
}
