import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB, PremiumType } from '../db/types';
import { Roles } from '../common/decorators/roles.decorator';
import { PricingService } from '../pricing/pricing.service';
import { PricingRulesService } from '../pricing/pricing-rules.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';
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
    @Inject(KYSELY) private readonly db: Kysely<DB>,
  ) {}

  @Get()
  list() {
    return this.products.list();
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
    return this.pricingRules.upsert({
      scope: 'product',
      product_id: product.id,
      buy_premium_type: dto.buy_premium_type,
      buy_premium_value: dto.buy_premium_value,
      sell_premium_type: dto.sell_premium_type,
      sell_premium_value: dto.sell_premium_value,
    });
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
  }

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.products.delete(id);
  }
}
