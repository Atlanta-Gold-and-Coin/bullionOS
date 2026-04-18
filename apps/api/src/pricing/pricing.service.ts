import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB, Metal, PremiumType, Product } from '../db/types';
import { MetalsService } from '../metals/metals.service';
import { d, toDbString, Decimal } from '../common/money';

export interface ResolvedRule {
  buy_premium_type: PremiumType;
  buy_premium_value: string;
  sell_premium_type: PremiumType;
  sell_premium_value: string;
  /** 'metal' (default) or 'product' (override). Useful for explainability. */
  source: 'metal' | 'product' | 'none';
  rule_id: string | null;
}

export interface PriceQuote {
  product_id: string;
  product_name: string;
  metal: Metal;
  quantity: number;

  // ----- Snapshotted product physical attributes -----
  // `product_weight_troy_oz` is the GROSS weight of one unit as listed in the
  // catalog (1.0909 oz for a Gold Eagle, 1.0 for a Silver Eagle, etc.).
  // `product_purity` is the fineness fraction (0.9167, 0.999, ...).
  // `metal_content_per_unit` = product_weight_troy_oz * product_purity.
  // We keep all three distinct: invoice snapshots must capture the raw product
  // shape, not just the derived content.
  product_weight_troy_oz: string;
  product_purity: string;
  metal_content_per_unit: string;

  spot_per_oz: string;
  melt_value_per_unit: string;

  buy_unit_price: string;
  buy_line_total: string;
  buy_premium_type: PremiumType;
  buy_premium_value: string;

  sell_unit_price: string;
  sell_line_total: string;
  sell_premium_type: PremiumType;
  sell_premium_value: string;

  computed_at: string;
  source: 'metal' | 'product' | 'none';
  rule_id: string | null;
}

interface ProductRow {
  id: string;
  name: string;
  metal: Metal;
  weight_troy_oz: string;
  purity: string;
  metal_content_troy_oz: string;
}

/**
 * Pricing engine.
 *
 * Resolution order per product:
 *  1. Active product override  (pricing_rules.scope='product', product_id=X, is_active=true)
 *  2. Active metal default      (pricing_rules.scope='metal',   metal=P.metal, is_active=true)
 *  3. Hard fallback: 0% premium (returns melt value; flagged source='none')
 *
 * Math:
 *   melt           = spot_per_oz * metal_content_per_unit
 *   buy_per_unit   = premium_type='percent' ? melt * (pct/100) : (spot + flat_per_oz) * metal_content
 *   sell_per_unit  = same formula with sell_premium
 *
 * Percent semantics are "fraction of spot × weight" — value=96 means we pay
 * 96% of melt (typical bullion dealer buy side). Value=105 means we sell
 * at 105% of melt (typical retail markup). This is a break from the older
 * "+X% above melt" semantics; all pricing_rules must be re-keyed to the
 * new meaning.
 *
 * NOTE: 'flat' premium is dollars-per-troy-oz-of-metal-content, so a flat
 * premium on a 1oz Gold Eagle and a 10oz gold bar scales correctly with
 * metal content. This is how precious-metals dealers typically quote
 * flat-over-spot premiums.
 */
@Injectable()
export class PricingService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly metals: MetalsService,
  ) {}

  async resolveRule(product: Pick<Product, 'id' | 'metal'>): Promise<ResolvedRule> {
    // Product override first.
    const override = await this.db
      .selectFrom('pricing_rules')
      .selectAll()
      .where('scope', '=', 'product')
      .where('product_id', '=', product.id)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (override) {
      return {
        buy_premium_type: override.buy_premium_type,
        buy_premium_value: override.buy_premium_value,
        sell_premium_type: override.sell_premium_type,
        sell_premium_value: override.sell_premium_value,
        source: 'product',
        rule_id: override.id,
      };
    }

    const metalDefault = await this.db
      .selectFrom('pricing_rules')
      .selectAll()
      .where('scope', '=', 'metal')
      .where('metal', '=', product.metal)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (metalDefault) {
      return {
        buy_premium_type: metalDefault.buy_premium_type,
        buy_premium_value: metalDefault.buy_premium_value,
        sell_premium_type: metalDefault.sell_premium_type,
        sell_premium_value: metalDefault.sell_premium_value,
        source: 'metal',
        rule_id: metalDefault.id,
      };
    }

    return {
      buy_premium_type: 'percent',
      buy_premium_value: '0',
      sell_premium_type: 'percent',
      sell_premium_value: '0',
      source: 'none',
      rule_id: null,
    };
  }

  /** Compute buy + sell price for a given product/quantity using current spot. */
  async quote(productId: string, quantity = 1): Promise<PriceQuote> {
    if (quantity <= 0) throw new Error('quantity must be positive');
    const [result] = await this.quoteMany([{ product_id: productId, quantity }]);
    if (!result) throw new NotFoundException('Product not found or inactive');
    return result;
  }

  /**
   * Batch variant: takes N product/quantity pairs and returns N quotes with:
   *   - 1 SELECT over products        (IN-list)
   *   - 1 SELECT over product overrides (IN-list)
   *   - 1 SELECT over metal defaults    (IN-list of distinct metals)
   *   - 1 spot-price read per distinct metal (Redis-cached)
   *
   * Input order is preserved in the output. Products that don't exist or are
   * inactive are simply omitted from the result; callers that need strict
   * parity should compare lengths or check by product_id.
   */
  async quoteMany(
    items: Array<{ product_id: string; quantity: number }>,
  ): Promise<PriceQuote[]> {
    if (items.length === 0) return [];
    for (const it of items) {
      if (it.quantity <= 0) throw new Error('quantity must be positive');
    }

    // Deduplicate the product ids we need to look up.
    const productIds = Array.from(new Set(items.map((i) => i.product_id)));

    // Single product query.
    const products = await this.db
      .selectFrom('products')
      .select([
        'id',
        'name',
        'metal',
        'weight_troy_oz',
        'purity',
        'metal_content_troy_oz',
      ])
      .where('id', 'in', productIds)
      .where('is_active', '=', true)
      .execute();
    const productById = new Map<string, ProductRow>(
      products.map((p) => [p.id, p as ProductRow]),
    );

    if (productById.size === 0) return [];

    // Resolve rules in two IN-list queries (product overrides + metal defaults).
    const [overrides, metalDefaults] = await Promise.all([
      this.db
        .selectFrom('pricing_rules')
        .selectAll()
        .where('scope', '=', 'product')
        .where('is_active', '=', true)
        .where('product_id', 'in', productIds)
        .execute(),
      this.db
        .selectFrom('pricing_rules')
        .selectAll()
        .where('scope', '=', 'metal')
        .where('is_active', '=', true)
        .where(
          'metal',
          'in',
          Array.from(new Set(products.map((p) => p.metal))),
        )
        .execute(),
    ]);

    const overrideByProduct = new Map(
      overrides.filter((r) => r.product_id).map((r) => [r.product_id as string, r]),
    );
    const defaultByMetal = new Map(
      metalDefaults.filter((r) => r.metal).map((r) => [r.metal as Metal, r]),
    );

    // Fetch each needed spot once (MetalsService caches in Redis anyway).
    const metalsNeeded = Array.from(new Set(products.map((p) => p.metal)));
    const spotByMetal = new Map<Metal, string>();
    await Promise.all(
      metalsNeeded.map(async (m) => {
        spotByMetal.set(m, await this.metals.getSpotFor(m));
      }),
    );

    const now = new Date().toISOString();

    // Compose results in the caller's input order.
    const out: PriceQuote[] = [];
    for (const item of items) {
      const product = productById.get(item.product_id);
      if (!product) continue;

      const rule = this.resolveRuleFrom(
        product.id,
        product.metal,
        overrideByProduct.get(product.id),
        defaultByMetal.get(product.metal),
      );

      const spot = spotByMetal.get(product.metal)!;
      const grossWeight = d(product.weight_troy_oz);
      const purity = d(product.purity);
      const content = d(product.metal_content_troy_oz);
      const melt = d(spot).times(content);

      const buyUnit = this.applyPremium(melt, content, rule.buy_premium_type, rule.buy_premium_value);
      const sellUnit = this.applyPremium(melt, content, rule.sell_premium_type, rule.sell_premium_value);

      const qty = d(item.quantity);

      out.push({
        product_id: product.id,
        product_name: product.name,
        metal: product.metal,
        quantity: item.quantity,

        product_weight_troy_oz: toDbString(grossWeight),
        product_purity: toDbString(purity),
        metal_content_per_unit: toDbString(content),

        spot_per_oz: toDbString(spot),
        melt_value_per_unit: toDbString(melt),

        buy_unit_price: toDbString(buyUnit),
        buy_line_total: toDbString(buyUnit.times(qty)),
        buy_premium_type: rule.buy_premium_type,
        buy_premium_value: rule.buy_premium_value,

        sell_unit_price: toDbString(sellUnit),
        sell_line_total: toDbString(sellUnit.times(qty)),
        sell_premium_type: rule.sell_premium_type,
        sell_premium_value: rule.sell_premium_value,

        computed_at: now,
        source: rule.source,
        rule_id: rule.rule_id,
      });
    }
    return out;
  }

  /** In-memory equivalent of resolveRule(), fed pre-fetched rows. */
  private resolveRuleFrom(
    productId: string,
    metal: Metal,
    override: { id: string; buy_premium_type: PremiumType; buy_premium_value: string; sell_premium_type: PremiumType; sell_premium_value: string } | undefined,
    metalDefault: { id: string; buy_premium_type: PremiumType; buy_premium_value: string; sell_premium_type: PremiumType; sell_premium_value: string } | undefined,
  ): ResolvedRule {
    if (override) {
      return {
        buy_premium_type: override.buy_premium_type,
        buy_premium_value: override.buy_premium_value,
        sell_premium_type: override.sell_premium_type,
        sell_premium_value: override.sell_premium_value,
        source: 'product',
        rule_id: override.id,
      };
    }
    if (metalDefault) {
      return {
        buy_premium_type: metalDefault.buy_premium_type,
        buy_premium_value: metalDefault.buy_premium_value,
        sell_premium_type: metalDefault.sell_premium_type,
        sell_premium_value: metalDefault.sell_premium_value,
        source: 'metal',
        rule_id: metalDefault.id,
      };
    }
    void productId;
    void metal;
    return {
      buy_premium_type: 'percent',
      buy_premium_value: '0',
      sell_premium_type: 'percent',
      sell_premium_value: '0',
      source: 'none',
      rule_id: null,
    };
  }

  /**
   * Apply a premium to melt value.
   *
   *  percent → melt * (1 + pct/100)
   *  flat    → melt + (flat_per_oz * metal_content)
   */
  private applyPremium(
    melt: Decimal,
    metalContent: Decimal,
    type: PremiumType,
    value: string,
  ): Decimal {
    const v = d(value);
    if (type === 'percent') {
      // X% of melt. Dealer sets 96 to buy at 96% of spot-content, or 105
      // to sell at 105% of spot-content. Explicit fraction-of semantics
      // (not "markup above") — see class-level doc for the rationale.
      return melt.times(v.div(100));
    }
    // (spot + flat) × content  — flat adds a $/oz-of-metal premium on top
    // of pure melt. Works for both directions (positive for sell above
    // spot, negative for buy below spot).
    return melt.plus(v.times(metalContent));
  }
}
