import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB, Product } from '../db/types';
import { d, toDbString } from '../common/money';
import { PublicCacheService } from '../public/public-cache.service';
import type { CreateProductDto } from './dto/create-product.dto';
import type { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductsService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly cache: PublicCacheService,
  ) {}

  async list(opts: { onlyActive?: boolean; onlyWebsite?: boolean } = {}): Promise<Product[]> {
    // sort_order is the hand-curated order from the catalog drag-and-drop.
    // Ties break on name. Migration 018 seeds unique ranks so the first
    // render looks identical to the pre-drag version.
    let q = this.db
      .selectFrom('products')
      .selectAll()
      .orderBy('sort_order')
      .orderBy('name');
    if (opts.onlyActive) q = q.where('is_active', '=', true);
    if (opts.onlyWebsite) q = q.where('show_on_website', '=', true);
    return q.execute();
  }

  /**
   * Apply a new ordering. The client sends the full ordered list of ids
   * for whatever view it's rendering (typically the full active catalog).
   * We assign ranks in multiples of 10 so future single-row slots can
   * stay O(1) without renumbering. If the client sends a partial list,
   * any omitted rows keep their existing rank.
   */
  async reorder(orderedIds: string[]): Promise<void> {
    if (orderedIds.length === 0) return;
    await this.db.transaction().execute(async (trx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await trx
          .updateTable('products')
          .set({ sort_order: (i + 1) * 10 })
          .where('id', '=', orderedIds[i])
          .execute();
      }
    });
    // Without this, /public/what-we-pay and /public/in-stock keep the
    // pre-drag order in Redis for up to 30s, which means the WordPress
    // plugin and any other anonymous consumer briefly shows a different
    // sequence than Catalog / Buy Sheet / In-Stock Sheet. Invalidate so
    // the next public fetch recomputes against the new sort_order.
    await this.cache.invalidatePricingDependent();
  }

  async getById(id: string): Promise<Product> {
    const row = await this.db
      .selectFrom('products')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Product not found');
    return row;
  }

  async create(dto: CreateProductDto): Promise<Product> {
    const content = d(dto.weight_troy_oz).times(d(dto.purity));
    let created: Product;
    try {
      created = await this.db
        .insertInto('products')
        .values({
          sku: dto.sku,
          name: dto.name,
          metal: dto.metal,
          category: dto.category,
          weight_troy_oz: toDbString(dto.weight_troy_oz),
          purity: toDbString(dto.purity),
          metal_content_troy_oz: toDbString(content),
          description: dto.description ?? null,
          image_url: dto.image_url ?? null,
          is_active: dto.is_active ?? true,
          show_on_website: dto.show_on_website ?? false,
          // Migration 039: per-tenant custom field values. Passthrough,
          // defaults to {} when the form sends nothing. JSONB needs an
          // explicit ::jsonb cast so pg doesn't drop the object to text.
          ...(dto.custom_fields !== undefined && {
            custom_fields: sql`${JSON.stringify(dto.custom_fields)}::jsonb`,
          }),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new BadRequestException('SKU already exists');
      }
      throw err;
    }
    await this.cache.invalidatePricingDependent();
    return created;
  }

  async update(id: string, dto: UpdateProductDto): Promise<Product> {
    const existing = await this.getById(id);

    // Content-driven edit: if metal_content_troy_oz was patched without
    // an explicit purity/weight, hold gross weight constant and
    // back-solve purity so the new content value sticks. This is the
    // path the In-Stock Sheet's inline AGW/ASW editor uses.
    let weight = dto.weight_troy_oz ?? Number(existing.weight_troy_oz);
    let purity = dto.purity ?? Number(existing.purity);
    let contentOverride: number | undefined;
    if (
      dto.metal_content_troy_oz !== undefined &&
      dto.weight_troy_oz === undefined &&
      dto.purity === undefined
    ) {
      contentOverride = dto.metal_content_troy_oz;
      if (weight <= 0) {
        throw new BadRequestException(
          'Cannot edit metal content on a product with zero gross weight',
        );
      }
      purity = contentOverride / weight;
      if (!(purity > 0) || purity > 1) {
        throw new BadRequestException(
          `Derived purity (${purity.toFixed(6)}) is outside 0–1. ` +
            `Either adjust gross weight first, or edit weight + purity directly.`,
        );
      }
    }
    const content = contentOverride !== undefined
      ? d(contentOverride)
      : d(weight).times(d(purity));

    let row: Product | undefined;
    try {
      row = await this.db
        .updateTable('products')
        .set({
          ...(dto.sku !== undefined && { sku: dto.sku }),
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.metal !== undefined && { metal: dto.metal }),
          ...(dto.category !== undefined && { category: dto.category }),
          ...(dto.weight_troy_oz !== undefined && { weight_troy_oz: toDbString(dto.weight_troy_oz) }),
          ...(dto.purity !== undefined && { purity: toDbString(dto.purity) }),
          // When the operator edits metal_content directly, write the
          // back-solved purity (derived above) so weight × purity still
          // equals the typed-in content.
          ...(contentOverride !== undefined && { purity: toDbString(purity) }),
          ...((dto.weight_troy_oz !== undefined ||
            dto.purity !== undefined ||
            contentOverride !== undefined) && {
            metal_content_troy_oz: toDbString(content),
          }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.image_url !== undefined && { image_url: dto.image_url }),
          ...(dto.is_active !== undefined && { is_active: dto.is_active }),
          ...(dto.show_on_website !== undefined && { show_on_website: dto.show_on_website }),
          // Empty string coming from the form means "clear the override";
          // persist as NULL so the heuristic takes over again.
          ...(dto.display_category_override !== undefined && {
            display_category_override:
              dto.display_category_override === '' ? null : dto.display_category_override,
          }),
          // Migration 039: per-tenant custom field values. Passthrough
          // (replace semantics) — JSONB needs the explicit ::jsonb cast.
          ...(dto.custom_fields !== undefined && {
            custom_fields: sql`${JSON.stringify(dto.custom_fields)}::jsonb`,
          }),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
    } catch (err) {
      // SKU has a UNIQUE index; surface a friendly 400 instead of a 500
      // when an inline edit collides with another product. Mirrors the
      // create() handler so the UI gets a consistent shape.
      if ((err as { code?: string }).code === '23505') {
        throw new BadRequestException('SKU already exists');
      }
      throw err;
    }

    if (!row) throw new NotFoundException('Product not found');
    await this.cache.invalidatePricingDependent();
    return row;
  }

  async delete(id: string): Promise<void> {
    // Soft-delete by default (flip is_active). Hard-delete is allowed at the
    // DB level now (migrations 010 + 012: invoice line items snapshot every
    // value, inventory cascades, inventory_movements sets product_id NULL)
    // but we keep soft-delete in the default path so accidental catalog
    // removals are trivially reversible.
    const r = await this.db
      .updateTable('products')
      .set({ is_active: false })
      .where('id', '=', id)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) throw new NotFoundException('Product not found');
    await this.cache.invalidatePricingDependent();
  }

  /**
   * Permanent row deletion — callable only behind the PIN gate in
   * AdminProductsController. FKs are all set to CASCADE / SET NULL (see
   * migrations 010 + 012) so the row can disappear without orphaning
   * invoice lines or movement history. Use this when a product was
   * created in error and shouldn't even exist in the "inactive" bucket.
   *
   * deal_requests has a check constraint requiring either product_id
   * or product_description to be non-null; when the FK sets product_id
   * NULL, a request with no description would otherwise fail the check
   * and abort the whole delete. Backfill product_description first so
   * the request row keeps its semantic content after the product row
   * is gone.
   */
  async deleteHard(id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const prod = await trx
        .selectFrom('products')
        .select(['sku', 'name'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!prod) throw new NotFoundException('Product not found');

      await trx
        .updateTable('deal_requests')
        .set({ product_description: `${prod.sku} — ${prod.name}` })
        .where('product_id', '=', id)
        .where('product_description', 'is', null)
        .execute();

      const r = await trx
        .deleteFrom('products')
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(r.numDeletedRows) === 0) throw new NotFoundException('Product not found');
    });
    await this.cache.invalidatePricingDependent();
  }
}
