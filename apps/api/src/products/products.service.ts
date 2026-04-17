import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
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

    const weight = dto.weight_troy_oz ?? Number(existing.weight_troy_oz);
    const purity = dto.purity ?? Number(existing.purity);
    const content = d(weight).times(d(purity));

    const row = await this.db
      .updateTable('products')
      .set({
        ...(dto.sku !== undefined && { sku: dto.sku }),
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.metal !== undefined && { metal: dto.metal }),
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.weight_troy_oz !== undefined && { weight_troy_oz: toDbString(dto.weight_troy_oz) }),
        ...(dto.purity !== undefined && { purity: toDbString(dto.purity) }),
        ...((dto.weight_troy_oz !== undefined || dto.purity !== undefined) && {
          metal_content_troy_oz: toDbString(content),
        }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.image_url !== undefined && { image_url: dto.image_url }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }),
        ...(dto.show_on_website !== undefined && { show_on_website: dto.show_on_website }),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

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
}
