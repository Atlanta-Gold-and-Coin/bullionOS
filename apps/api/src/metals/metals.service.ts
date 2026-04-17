import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';
import type { Metal } from '../db/types';
import { IntegrationsService } from '../integrations/integrations.service';

export interface SpotPrices {
  gold: string;
  silver: string;
  platinum: string;
  palladium: string;
  /** ISO timestamp of when metals.dev last updated the prices. */
  asOf: string;
  /** Epoch ms we cached this response. */
  cachedAt: number;
}

const CACHE_KEY = 'metals:spot:v1';

/**
 * Resolved metals credential. Comes from one of three places, in priority order:
 *   1. `/admin/integrations → metals`  (AES-256-GCM encrypted; preferred)
 *   2. `METALS_API_KEY` env var        (bootstrap / dev fallback)
 *   3. neither → fetch throws with a useful error
 *
 * Admins rotate by pasting a new key in the admin UI. No redeploy needed.
 */
interface MetalsCreds {
  api_key: string;
  url: string;
}

@Injectable()
export class MetalsService {
  private readonly logger = new Logger(MetalsService.name);
  private readonly ttlSec: number;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly integrations: IntegrationsService,
  ) {
    this.ttlSec = this.config.get<number>('METALS_CACHE_TTL_SEC', 30);
  }

  /**
   * Returns current spot prices per troy oz in USD.
   * Served from Redis cache when fresh; otherwise fetched from metals.dev.
   *
   * Cache strategy: SET with PX TTL. We also return from cache on upstream failure
   * as a best-effort fallback, so a metals.dev outage doesn't take down pricing.
   */
  async getSpot(): Promise<SpotPrices> {
    const cached = await this.redis.get(CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached) as SpotPrices;
      } catch {
        // fall through to refetch
      }
    }
    return this.refresh();
  }

  /** Force a refresh from metals.dev. */
  async refresh(): Promise<SpotPrices> {
    const creds = await this.resolveCreds();
    if (!creds) {
      return this.onUpstreamFailure(
        new Error('No metals.dev credentials configured (check /admin/integrations or METALS_API_KEY env)'),
      );
    }

    const url = new URL(creds.url);
    url.searchParams.set('api_key', creds.api_key);
    url.searchParams.set('currency', 'USD');
    url.searchParams.set('unit', 'toz');

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      return this.onUpstreamFailure(err);
    }

    if (!res.ok) {
      return this.onUpstreamFailure(new Error(`metals.dev responded ${res.status}`));
    }

    const body = (await res.json()) as {
      status?: string;
      metals?: Partial<Record<Metal, number>>;
      timestamps?: { metal?: string };
    };

    if (body.status && body.status !== 'success') {
      return this.onUpstreamFailure(new Error(`metals.dev status: ${body.status}`));
    }

    const metals = body.metals ?? {};
    if (!metals.gold || !metals.silver || !metals.platinum || !metals.palladium) {
      return this.onUpstreamFailure(new Error('metals.dev returned incomplete metals map'));
    }

    const prices: SpotPrices = {
      gold: String(metals.gold),
      silver: String(metals.silver),
      platinum: String(metals.platinum),
      palladium: String(metals.palladium),
      asOf: body.timestamps?.metal ?? new Date().toISOString(),
      cachedAt: Date.now(),
    };

    await this.redis.set(CACHE_KEY, JSON.stringify(prices), 'EX', this.ttlSec);
    return prices;
  }

  /**
   * Resolve credentials from integrations (preferred) or env (fallback).
   * Returns null if neither is configured.
   */
  private async resolveCreds(): Promise<MetalsCreds | null> {
    const fromDb = await this.integrations.getCredentials('metals');
    if (fromDb?.api_key) {
      return { api_key: fromDb.api_key, url: fromDb.url };
    }
    // Env fallback — keeps dev setups and first-boot deployments working.
    const api_key = this.config.get<string>('METALS_API_KEY', '');
    const url = this.config.get<string>('METALS_API_URL', 'https://api.metals.dev/v1/latest');
    if (api_key) return { api_key, url };
    return null;
  }

  /** If upstream fails but we have a stale cache entry, serve it. Otherwise throw. */
  private async onUpstreamFailure(err: unknown): Promise<SpotPrices> {
    this.logger.warn(`metals.dev fetch failed: ${(err as Error).message}`);
    const stale = await this.redis.get(CACHE_KEY);
    if (stale) {
      try {
        return JSON.parse(stale) as SpotPrices;
      } catch {
        /* fallthrough */
      }
    }
    throw new Error(`Metal prices unavailable: ${(err as Error).message}`);
  }

  /** Convenience: return the spot price for a single metal as a string. */
  async getSpotFor(metal: Metal): Promise<string> {
    const all = await this.getSpot();
    return all[metal];
  }

  /**
   * Exercise the metals.dev endpoint with whatever credentials currently
   * resolve (admin integration wins; env is fallback). Called by the
   * /admin/integrations "Test connection" button.
   */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const creds = await this.resolveCreds();
    if (!creds) return { ok: false, message: 'Not configured (no admin integration and no env fallback)' };
    try {
      const url = new URL(creds.url);
      url.searchParams.set('api_key', creds.api_key);
      url.searchParams.set('currency', 'USD');
      url.searchParams.set('unit', 'toz');
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return { ok: false, message: `metals.dev responded ${res.status}` };
      const body = (await res.json()) as { status?: string; metals?: Record<string, unknown> };
      if (body.status && body.status !== 'success') {
        return { ok: false, message: `status=${body.status}` };
      }
      const count = body.metals ? Object.keys(body.metals).length : 0;
      // Wipe the cached spot so the next /public/spot read exercises the
      // new credential end-to-end instead of returning the old payload.
      try {
        await this.redis.del(CACHE_KEY);
      } catch { /* non-fatal */ }
      return { ok: true, message: `metals.dev ok (${count} metals returned)` };
    } catch (err) {
      return { ok: false, message: (err as Error).message.slice(0, 500) };
    }
  }
}
