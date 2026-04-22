import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Kysely } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB, PremiumType } from '../db/types';
import { Roles } from '../common/decorators/roles.decorator';
import { PricingService } from '../pricing/pricing.service';
import { PricingRulesService } from '../pricing/pricing-rules.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';
import { ProductsImportService } from './products-import.service';
import {
  IsNumber,
  IsIn,
  Max,
  Min,
} from 'class-validator';

class UpsertProductPricingDto {
  @IsIn(['percent', 'flat'])
  buy_premium_type!: PremiumType;

  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-100)
  @Max(100000)
  buy_premium_value!: number;

  @IsIn(['percent', 'flat'])
  sell_premium_type!: PremiumType;

  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(-100)
  @Max(100000)
  sell_premium_value!: number;
}

@Controller('admin/products')
@Roles('admin', 'staff')
export class AdminProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly pricing: PricingService,
    private readonly pricingRules: PricingRulesService,
    private readonly importer: ProductsImportService,
    @Inject(KYSELY) private readonly db: Kysely<DB>,
  ) {}

  /**
   * Short-lived in-memory cache for the /sheet endpoint. Price Sheet,
   * In-Stock Sheet, and Buy Sheet all hit the same payload on page
   * load + 60s poll. Without this, three admins open on three pages =
   * three full catalog × pricing recomputes every minute; with it,
   * burst requests inside the TTL window return from a Map lookup.
   *
   * TTL is intentionally short (5s) — admin mutations call
   * invalidateSheetCache() to clear it immediately, so the cache
   * doesn't mask fresh edits.
   */
  private static sheetCache: { at: number; data: unknown } | null = null;
  private static readonly SHEET_CACHE_TTL_MS = 5_000;

  static invalidateSheetCache() {
    AdminProductsController.sheetCache = null;
  }

  /**
   * CSV import — two-phase: preview first (shows create/update/error per row),
   * then commit if the operator approves. Admin only, file capped at 2 MB.
   */
  @Post('import/preview')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 2_000_000, files: 1 },
    }),
  )
  async previewImport(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('file is required (multipart/form-data)');
    const text = file.buffer.toString('utf8');
    return this.importer.preview(text);
  }

  @Post('import/commit')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 2_000_000, files: 1 },
    }),
  )
  async commitImport(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('file is required (multipart/form-data)');
    const text = file.buffer.toString('utf8');
    return this.importer.commit(text);
  }

  @Get()
  list() {
    return this.products.list();
  }

  /**
   * Persist a new catalog order from the drag-and-drop UI. Body is the
   * full ordered list of product ids. Takes ~one UPDATE per row; for our
   * scale (low thousands at most) that's fine.
   */
  @Post('reorder')
  @HttpCode(204)
  async reorder(@Body() body: { order: string[] }) {
    if (!Array.isArray(body.order)) {
      throw new BadRequestException('order must be an array of product ids');
    }
    // Loose validation — bad ids just become no-ops, the service still
    // returns 204. The UI always sends valid uuids.
    await this.products.reorder(body.order);
    AdminProductsController.invalidateSheetCache();
  }

  /**
   * One-shot payload for the printable sheets (/admin/in-stock-sheet and
   * /admin/buy-sheet). Joins products + current buy/sell quotes + inventory
   * so the front-end needs exactly one fetch per page load.
   *
   * All pricing uses `quoteMany` (bounded-N DB reads) and the cached spot,
   * so this is cheap enough to call every 60s without rate-limit concerns.
   */
  @Get('sheet')
  async sheet() {
    const now = Date.now();
    if (
      AdminProductsController.sheetCache &&
      now - AdminProductsController.sheetCache.at <
        AdminProductsController.SHEET_CACHE_TTL_MS
    ) {
      return AdminProductsController.sheetCache.data;
    }

    const products = await this.products.list({ onlyActive: true });
    if (products.length === 0) {
      AdminProductsController.sheetCache = { at: now, data: [] };
      return [];
    }

    const quotes = await this.pricing.quoteMany(
      products.map((p) => ({ product_id: p.id, quantity: 1 })),
    );
    const quoteById = new Map(quotes.map((q) => [q.product_id, q]));

    // Pull all inventory in one query, then index by product_id.
    const invRows = await this.db
      .selectFrom('inventory')
      .select([
        'product_id',
        'quantity_on_hand',
        'quantity_reserved',
        'location',
        'weighted_avg_cost',
      ])
      .where(
        'product_id',
        'in',
        products.map((p) => p.id),
      )
      .execute();
    const invByProduct = new Map(invRows.map((r) => [r.product_id, r]));

    const result = products.map((p) => {
      const q = quoteById.get(p.id);
      const inv = invByProduct.get(p.id);
      const on_hand = Number(inv?.quantity_on_hand ?? 0);
      const reserved = Number(inv?.quantity_reserved ?? 0);
      return {
        product_id: p.id,
        sku: p.sku,
        name: p.name,
        metal: p.metal,
        category: p.category,
        show_on_website: p.show_on_website,
        weight_troy_oz: p.weight_troy_oz,
        // Purity + sort_order exposed so the 3 sheet-consuming pages
        // can render inline purity editors and honor the operator's
        // manual drag order without a second roundtrip.
        purity: p.purity,
        sort_order: p.sort_order,
        display_category_override: p.display_category_override,
        buy_price: q ? q.buy_unit_price : null,
        sell_price: q ? q.sell_unit_price : null,
        quantity_on_hand: on_hand,
        quantity_reserved: reserved,
        available: on_hand - reserved,
        // Storage label — 'main' by default, editable on Catalog.
        // COALESCE at the service level also handles products with no
        // inventory row yet, but belt-and-suspenders here too.
        location: inv?.location ?? 'main',
      };
    });
    AdminProductsController.sheetCache = { at: now, data: result };
    return result;
  }

  @Get(':id')
  getById(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.products.getById(id);
  }

  /** Live price preview for a single product (uses current spot). */
  @Get(':id/quote')
  quote(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('quantity') quantity?: string,
  ) {
    const q = quantity ? Math.max(1, Math.floor(Number(quantity))) : 1;
    return this.pricing.quote(id, q);
  }

  /**
   * Resolve the pricing rule for this product:
   *   source='product' → a product-specific override is active
   *   source='metal'   → no override, inheriting the metal default
   *   source='none'    → no rule at all (0% fallback)
   *
   * Returns the premium fields directly so the admin UI can show+edit them
   * without chasing a separate pricing-rules endpoint.
   */
  @Get(':id/pricing-rule')
  async getPricingRule(@Param('id', new ParseUUIDPipe()) id: string) {
    const product = await this.products.getById(id);
    const rule = await this.pricing.resolveRule({ id: product.id, metal: product.metal });
    return {
      product_id: product.id,
      product_metal: product.metal,
      source: rule.source,
      rule_id: rule.rule_id,
      buy_premium_type: rule.buy_premium_type,
      buy_premium_value: rule.buy_premium_value,
      sell_premium_type: rule.sell_premium_type,
      sell_premium_value: rule.sell_premium_value,
    };
  }

  /** Create or replace this product's override rule. */
  @Put(':id/pricing-override')
  async setPricingOverride(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpsertProductPricingDto,
  ) {
    const product = await this.products.getById(id);
    const result = await this.pricingRules.upsert({
      scope: 'product',
      product_id: product.id,
      buy_premium_type: dto.buy_premium_type,
      buy_premium_value: dto.buy_premium_value,
      sell_premium_type: dto.sell_premium_type,
      sell_premium_value: dto.sell_premium_value,
    });
    AdminProductsController.invalidateSheetCache();
    return result;
  }

  /** Drop any product-specific override, falling back to the metal default. */
  @Delete(':id/pricing-override')
  @HttpCode(204)
  async clearPricingOverride(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.products.getById(id); // 404 if missing
    const active = await this.db
      .selectFrom('pricing_rules')
      .select('id')
      .where('scope', '=', 'product')
      .where('product_id', '=', id)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (!active) throw new BadRequestException('No override to clear');
    await this.pricingRules.deactivate(active.id);
    AdminProductsController.invalidateSheetCache();
  }

  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateProductDto) {
    const result = await this.products.create(dto);
    AdminProductsController.invalidateSheetCache();
    return result;
  }

  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    const result = await this.products.update(id, dto);
    AdminProductsController.invalidateSheetCache();
    return result;
  }

  /**
   * Soft-delete a product. PIN-gated (0424) to prevent accidental
   * drag-and-click deletions during rapid catalog edits. The PIN is
   * short and intentionally memorable — not a cryptographic control,
   * just a "are you sure?" wall that's stronger than a confirm()
   * dialog. The check mirrors what the UI already enforces; we
   * validate here too so a direct API call can't bypass.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('pin') pin?: string,
    @Query('hard') hard?: string,
  ) {
    const expected = process.env.PRODUCT_DELETE_PIN || '0424';
    if (!pin || pin.trim() !== expected) {
      throw new ForbiddenException(
        'Delete PIN required. Ask an admin if you don’t have it.',
      );
    }
    // Same PIN gates both soft- and hard-delete. `?hard=1` asks for the
    // row to actually disappear (used when a product was created in
    // error and the inactive bucket shouldn't keep it around). Default
    // stays soft-delete so a stray click is still trivially reversible.
    if (hard === '1' || hard === 'true') {
      await this.products.deleteHard(id);
    } else {
      await this.products.delete(id);
    }
    AdminProductsController.invalidateSheetCache();
  }
}
