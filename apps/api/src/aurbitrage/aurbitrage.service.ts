import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Kysely } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB } from '../db/types';
import { IntegrationsService } from '../integrations/integrations.service';
import type { CredentialsFor } from '../integrations/integrations.registry';
import { toDbString } from '../common/money';

/**
 * Aurbitrage (aurbitrage.com) integration.
 *
 * Aurbitrage aggregates buy/sell prices from multiple wholesalers
 * (MTB Metals, Dillon Gage, APMEX, Pinehurst, Sunshine Mint, etc.)
 * and exposes a unified `/api/v1/pricing/favorites` endpoint. Their
 * response is a nested category → header → product → side (bid/ask)
 * → dealer-array shape; this service flattens that into one row per
 * (sku, side, dealer) tuple in `aurbitrage_quotes`.
 *
 * Sync strategy: full reload. The favorites endpoint returns the
 * complete current snapshot on every call, so the cleanest model is
 * to wipe + reinsert inside a transaction. No upsert keys, no
 * compound uniqueness — each sync is authoritative.
 *
 * Cadence: 15 min via @Cron, mirroring the GmailService pattern.
 * Operators can also force a refresh via the "Refresh now" button on
 * /admin/aurbitrage which calls runSync() directly.
 */

interface AurbitrageQuoteRow {
  dealer: string;
  dealerId: number | null;
  notes: string | null;
  equivalentOz: number | null;
  dataSource: string | null;
  date: string | null;
  metal: string | null;
  aurbitrageSkuId: number;
  section?: string | null;
  price: number;
  shippingNote?: string | null;
  priceSign?: string | null;
  format?: string | null;
  priceFormat?: string | null;
  displayPriceAs?: string | null;
}
interface AurbitrageProductRow {
  name: string;
  subCategory: string | null;
  type: string | null;
  equivalentOz: number | null;
  aurbitrageSkuId: number;
  isFavorite?: boolean;
  isShortlisted?: boolean;
  metal: string | null;
  ask: AurbitrageQuoteRow[];
  bid: AurbitrageQuoteRow[];
}
interface AurbitrageGroupRow {
  category: string | null;
  header: string | null;
  data: AurbitrageProductRow[];
}
interface AurbitrageFavoritesResponse {
  success: boolean;
  data?: {
    pricingData: AurbitrageGroupRow[];
  };
  message?: string;
}

export interface SyncResult {
  ok: boolean;
  message: string;
  quote_count: number;
  synced_at: string;
}

export interface QuoteRow {
  id: string;
  aurbitrage_sku_id: number;
  product_name: string;
  category: string | null;
  sub_category: string | null;
  product_type: string | null;
  metal: string | null;
  equivalent_oz: number | null;
  side: 'bid' | 'ask';
  dealer: string;
  dealer_id: number | null;
  price: number;
  price_format: string | null;
  format: string | null;
  data_source: string | null;
  notes: string | null;
  shipping_note: string | null;
  quote_date: string | null;
}

@Injectable()
export class AurbitrageService {
  private readonly logger = new Logger(AurbitrageService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly integrations: IntegrationsService,
  ) {}

  /** Configured + enabled? Used to short-circuit sync on cold installs. */
  async isAvailable(): Promise<boolean> {
    const creds = await this.integrations.getCredentials('aurbitrage');
    return Boolean(creds?.api_key);
  }

  /** Admin "Test connection" — pings favorites with a tiny request. */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const creds = (await this.integrations.getCredentials(
      'aurbitrage',
    )) as CredentialsFor<'aurbitrage'> | null;
    if (!creds) return { ok: false, message: 'Not configured' };
    try {
      const data = await this.fetchFavorites(creds);
      const productCount = (data.data?.pricingData ?? []).reduce(
        (n, g) => n + (g.data?.length ?? 0),
        0,
      );
      return {
        ok: true,
        message: `OK · ${productCount} favorited product${productCount === 1 ? '' : 's'} returned`,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message.slice(0, 500) };
    }
  }

  /**
   * Cron entry. Aurbitrage refreshes their backend every few minutes;
   * a 15-min poll is plenty fresh for operator price-compare and
   * keeps API call volume well under any reasonable rate limit.
   */
  @Cron('0 */15 * * * *', { name: 'aurbitrage-sync' })
  async scheduledSync(): Promise<void> {
    if (!(await this.isAvailable())) return;
    try {
      const r = await this.runSync();
      this.logger.log(
        `Aurbitrage sync: ${r.ok ? 'ok' : 'error'} · ${r.quote_count} quotes`,
      );
    } catch (err) {
      this.logger.error(
        `Aurbitrage sync failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /**
   * Fetch favorites + replace the local quote set in one transaction.
   * Records the outcome on the singleton sync-state row so the UI can
   * surface freshness/error state.
   */
  async runSync(): Promise<SyncResult> {
    const creds = (await this.integrations.getCredentials(
      'aurbitrage',
    )) as CredentialsFor<'aurbitrage'> | null;
    if (!creds) {
      throw new BadRequestException('Aurbitrage not configured');
    }

    let payload: AurbitrageFavoritesResponse;
    try {
      payload = await this.fetchFavorites(creds);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      await this.recordSyncState({ ok: false, message: msg, count: 0 });
      throw new BadRequestException(`Aurbitrage fetch failed: ${msg}`);
    }
    if (!payload.success || !payload.data?.pricingData) {
      const msg = payload.message ?? 'Unexpected response shape';
      await this.recordSyncState({ ok: false, message: msg, count: 0 });
      throw new BadRequestException(`Aurbitrage returned error: ${msg}`);
    }

    // Flatten the nested response into one row per (sku, side, dealer).
    const inserts: Array<Record<string, unknown>> = [];
    for (const group of payload.data.pricingData) {
      for (const product of group.data ?? []) {
        for (const ask of product.ask ?? []) {
          inserts.push(this.toQuoteRow(group, product, ask, 'ask'));
        }
        for (const bid of product.bid ?? []) {
          inserts.push(this.toQuoteRow(group, product, bid, 'bid'));
        }
      }
    }

    await this.db.transaction().execute(async (trx) => {
      // Truncate + bulk insert. Faster than per-row upsert and
      // respects the API's "full set every call" contract.
      await trx.deleteFrom('aurbitrage_quotes').execute();
      if (inserts.length > 0) {
        // Postgres has a parameter limit (~65k); chunk to be safe on
        // very large favorites lists. With ~14 cols/row, 1000 rows is
        // 14k params — well under.
        for (let i = 0; i < inserts.length; i += 1000) {
          await trx
            .insertInto('aurbitrage_quotes')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .values(inserts.slice(i, i + 1000) as any)
            .execute();
        }
      }
    });

    const result: SyncResult = {
      ok: true,
      message: `Synced ${inserts.length} quotes`,
      quote_count: inserts.length,
      synced_at: new Date().toISOString(),
    };
    await this.recordSyncState({
      ok: true,
      message: result.message,
      count: inserts.length,
    });
    return result;
  }

  /**
   * List all quotes flattened. Used by the admin browse page; UI
   * groups + ranks dealers per product on the client.
   */
  async listQuotes(): Promise<QuoteRow[]> {
    const rows = await this.db
      .selectFrom('aurbitrage_quotes')
      .selectAll()
      .orderBy('product_name', 'asc')
      .orderBy('side', 'asc')
      .orderBy('price', 'asc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      aurbitrage_sku_id: r.aurbitrage_sku_id,
      product_name: r.product_name,
      category: r.category,
      sub_category: r.sub_category,
      product_type: r.product_type,
      metal: r.metal,
      equivalent_oz: r.equivalent_oz !== null ? Number(r.equivalent_oz) : null,
      side: r.side,
      dealer: r.dealer,
      dealer_id: r.dealer_id,
      price: Number(r.price),
      price_format: r.price_format,
      format: r.format,
      data_source: r.data_source,
      notes: r.notes,
      shipping_note: r.shipping_note,
      quote_date: r.quote_date ? r.quote_date.toString() : null,
    }));
  }

  async getSyncState(): Promise<{
    last_synced_at: string | null;
    last_sync_status: string | null;
    last_sync_message: string | null;
    last_sync_quote_count: number | null;
    configured: boolean;
  }> {
    const row = await this.db
      .selectFrom('aurbitrage_sync_state')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirst();
    return {
      last_synced_at: row?.last_synced_at ? row.last_synced_at.toString() : null,
      last_sync_status: row?.last_sync_status ?? null,
      last_sync_message: row?.last_sync_message ?? null,
      last_sync_quote_count: row?.last_sync_quote_count ?? null,
      configured: await this.isAvailable(),
    };
  }

  // --- internals ---

  private async fetchFavorites(
    creds: CredentialsFor<'aurbitrage'>,
  ): Promise<AurbitrageFavoritesResponse> {
    // Ask for DollarPerOz — operators compare wholesalers in $/oz
    // because that's the standard unit metal trades in (regardless of
    // coin denomination or fractional weight). Aurbitrage normalizes
    // every dealer's quote to per-troy-oz on the server side. Some
    // dealers' premiums-only listings may still come back in
    // Percentage format when there's no $ basis to convert from; we
    // surface those with `format='%'` and the UI handles them.
    const url = `${creds.url.replace(/\/$/, '')}/pricing/favorites?convertFormat=DollarPerOz`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'x-api-key': creds.api_key,
          accept: 'application/json',
          'user-agent': 'AGC-Desk/1.0 (+https://agcdesk.com)',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        // Surface the response body when present — Aurbitrage
        // sometimes returns a JSON error envelope on 4xx.
        const text = (await res.text()).slice(0, 300);
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
      }
      return (await res.json()) as AurbitrageFavoritesResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  private toQuoteRow(
    group: AurbitrageGroupRow,
    product: AurbitrageProductRow,
    quote: AurbitrageQuoteRow,
    side: 'bid' | 'ask',
  ): Record<string, unknown> {
    return {
      aurbitrage_sku_id: product.aurbitrageSkuId,
      product_name: product.name,
      category: group.category ?? null,
      sub_category: product.subCategory ?? null,
      product_type: product.type ?? null,
      metal: product.metal ?? null,
      equivalent_oz:
        product.equivalentOz !== null && product.equivalentOz !== undefined
          ? toDbString(product.equivalentOz)
          : null,
      side,
      dealer: quote.dealer,
      dealer_id: quote.dealerId ?? null,
      price: toDbString(quote.price ?? 0),
      price_format: quote.priceFormat ?? quote.displayPriceAs ?? null,
      format: quote.format ?? null,
      price_sign: quote.priceSign ?? null,
      data_source: quote.dataSource ?? null,
      notes: quote.notes ?? null,
      shipping_note: quote.shippingNote ?? null,
      quote_date: quote.date ? new Date(quote.date) : null,
    };
  }

  private async recordSyncState(args: {
    ok: boolean;
    message: string;
    count: number;
  }): Promise<void> {
    await this.db
      .insertInto('aurbitrage_sync_state')
      .values({
        id: 1,
        last_synced_at: new Date(),
        last_sync_status: args.ok ? 'ok' : 'error',
        last_sync_message: args.message.slice(0, 500),
        last_sync_quote_count: args.count,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          last_synced_at: new Date(),
          last_sync_status: args.ok ? 'ok' : 'error',
          last_sync_message: args.message.slice(0, 500),
          last_sync_quote_count: args.count,
        }),
      )
      .execute();
  }
}
