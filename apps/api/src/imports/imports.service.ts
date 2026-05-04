import { Inject, Injectable, Logger } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { KYSELY } from '../db/database.module';
import type { DB, Metal, ProductCategory } from '../db/types';
import { parseCsv } from './csv-parser';

/**
 * CSV import service.
 *
 * One operator-facing entry point per supported entity (products,
 * clients, historical invoices). Each method:
 *   1. Parses the CSV into header-keyed records.
 *   2. Validates each row against a per-entity schema (returning
 *      structured per-row errors rather than aborting the whole batch).
 *   3. In dry-run mode, reports what would happen without writing.
 *   4. In commit mode, inserts row-by-row inside a transaction;
 *      bad rows are skipped (their errors still reported), good
 *      rows are persisted.
 *
 * Importers are intentionally simple — they handle the 80% case
 * (clean export from spreadsheet / prior CRM). Operators with
 * bespoke shapes can prep their CSV externally before upload.
 */

export interface ImportResult<T = unknown> {
  total: number;
  ok: number;
  skipped: number;
  errors: Array<{ row: number; error: string; raw: Record<string, string> }>;
  /** Sample of rows that would be / were inserted. Capped at 25. */
  preview: T[];
  dryRun: boolean;
}

const VALID_METALS: Metal[] = ['gold', 'silver', 'platinum', 'palladium'];
const VALID_CATEGORIES: ProductCategory[] = [
  'coin',
  'bar',
  'round',
  'numismatic',
  'jewelry',
  'other',
];

@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(@Inject(KYSELY) private readonly db: Kysely<DB>) {}

  /**
   * Products import.
   *
   * Required columns: sku, name, metal
   * Optional columns: category (default "other"), weight_troy_oz
   *   (default 0), purity (default 1), description, is_active
   *   (default true), show_on_website (default false)
   *
   * Upserts on `sku` — existing rows have their non-key fields updated.
   * Use this to bulk-load a fresh catalog OR refresh weights/names
   * after a supplier change.
   */
  async importProducts(
    csv: string,
    opts: { dryRun: boolean; actorUserId: string | null },
  ): Promise<ImportResult> {
    const records = parseCsv(csv);
    const result: ImportResult = {
      total: records.length,
      ok: 0,
      skipped: 0,
      errors: [],
      preview: [],
      dryRun: opts.dryRun,
    };

    const valid: Array<{
      sku: string;
      name: string;
      metal: Metal;
      category: ProductCategory;
      weight_troy_oz: string;
      purity: string;
      description: string | null;
      is_active: boolean;
      show_on_website: boolean;
    }> = [];

    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const sku = r.sku?.trim();
      const name = r.name?.trim();
      const metalRaw = r.metal?.trim().toLowerCase();
      if (!sku) {
        result.errors.push({ row: i + 2, error: 'missing sku', raw: r });
        continue;
      }
      if (!name) {
        result.errors.push({ row: i + 2, error: 'missing name', raw: r });
        continue;
      }
      if (!VALID_METALS.includes(metalRaw as Metal)) {
        result.errors.push({
          row: i + 2,
          error: `invalid metal "${metalRaw}" (must be one of ${VALID_METALS.join(', ')})`,
          raw: r,
        });
        continue;
      }
      const categoryRaw = (r.category?.trim().toLowerCase() ||
        'other') as ProductCategory;
      if (!VALID_CATEGORIES.includes(categoryRaw)) {
        result.errors.push({
          row: i + 2,
          error: `invalid category "${categoryRaw}"`,
          raw: r,
        });
        continue;
      }
      const weight = (r.weight_troy_oz?.trim() || '0').replace(/[^0-9.]/g, '');
      const purity = (r.purity?.trim() || '1').replace(/[^0-9.]/g, '');
      valid.push({
        sku,
        name,
        metal: metalRaw as Metal,
        category: categoryRaw,
        weight_troy_oz: weight,
        purity,
        description: r.description?.trim() || null,
        is_active: parseBool(r.is_active, true),
        show_on_website: parseBool(r.show_on_website, false),
      });
    }

    result.preview = valid.slice(0, 25);

    if (!opts.dryRun && valid.length > 0) {
      await this.db.transaction().execute(async (trx) => {
        for (const v of valid) {
          await trx
            .insertInto('products')
            .values({
              sku: v.sku,
              name: v.name,
              metal: v.metal,
              category: v.category,
              weight_troy_oz: v.weight_troy_oz,
              purity: v.purity,
              metal_content_troy_oz: sql`(${v.weight_troy_oz}::numeric * ${v.purity}::numeric)`,
              description: v.description,
              is_active: v.is_active,
              show_on_website: v.show_on_website,
            })
            .onConflict((oc) =>
              oc.column('sku').doUpdateSet({
                name: v.name,
                metal: v.metal,
                category: v.category,
                weight_troy_oz: v.weight_troy_oz,
                purity: v.purity,
                metal_content_troy_oz: sql`(${v.weight_troy_oz}::numeric * ${v.purity}::numeric)`,
                description: v.description,
                is_active: v.is_active,
                show_on_website: v.show_on_website,
                updated_at: new Date(),
              }),
            )
            .execute();
        }
      });
      this.logger.log(
        `Products import: ${valid.length}/${records.length} rows committed (actor=${opts.actorUserId ?? 'unknown'})`,
      );
    }

    result.ok = valid.length;
    result.skipped = result.errors.length;
    return result;
  }

  /**
   * Clients import.
   *
   * Required columns: at least ONE of first_name / last_name / company
   * Optional columns: email, phone, address_line1, address_line2,
   *   city, region, postal_code, country, notes, client_type
   *   (retail/wholesaler), heard_from
   *
   * Existing client (matched by lowercased email) is left untouched —
   * no overwrite. Clients with empty email never match and are
   * always created (potentially duplicating; operator's responsibility
   * to dedupe pre-import).
   */
  async importClients(
    csv: string,
    opts: { dryRun: boolean; actorUserId: string | null },
  ): Promise<ImportResult> {
    const records = parseCsv(csv);
    const result: ImportResult = {
      total: records.length,
      ok: 0,
      skipped: 0,
      errors: [],
      preview: [],
      dryRun: opts.dryRun,
    };

    type ValidClient = {
      first_name: string | null;
      last_name: string | null;
      company: string | null;
      email: string | null;
      phone: string | null;
      address_line1: string | null;
      address_line2: string | null;
      city: string | null;
      region: string | null;
      postal_code: string | null;
      country: string | null;
      notes: string | null;
      heard_from: string | null;
      client_type: 'retail' | 'wholesaler';
    };
    const valid: ValidClient[] = [];

    // Pre-fetch existing emails so duplicate detection is one query
    // rather than N queries.
    const emailSet = new Set<string>();
    for (let i = 0; i < records.length; i++) {
      const e = records[i].email?.trim().toLowerCase();
      if (e) emailSet.add(e);
    }
    const existingEmails =
      emailSet.size > 0
        ? await this.db
            .selectFrom('clients')
            .select('email')
            .where(
              'email',
              'in',
              Array.from(emailSet) as [string, ...string[]],
            )
            .execute()
        : [];
    const dupSet = new Set(
      existingEmails
        .map((r) => r.email?.toLowerCase())
        .filter((e): e is string => !!e),
    );

    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const first = r.first_name?.trim() || null;
      const last = r.last_name?.trim() || null;
      const company = r.company?.trim() || null;
      if (!first && !last && !company) {
        result.errors.push({
          row: i + 2,
          error:
            'must have at least one of first_name, last_name, or company',
          raw: r,
        });
        continue;
      }
      const email = r.email?.trim().toLowerCase() || null;
      if (email && dupSet.has(email)) {
        result.errors.push({
          row: i + 2,
          error: `email already exists in DB (${email})`,
          raw: r,
        });
        continue;
      }
      const clientType =
        r.client_type?.trim().toLowerCase() === 'wholesaler'
          ? 'wholesaler'
          : 'retail';
      valid.push({
        first_name: first,
        last_name: last,
        company,
        email,
        phone: r.phone?.trim() || null,
        address_line1: r.address_line1?.trim() || null,
        address_line2: r.address_line2?.trim() || null,
        city: r.city?.trim() || null,
        region: r.region?.trim() || null,
        postal_code: r.postal_code?.trim() || null,
        country: r.country?.trim() || null,
        notes: r.notes?.trim() || null,
        heard_from: r.heard_from?.trim() || null,
        client_type: clientType,
      });
    }

    result.preview = valid.slice(0, 25);

    if (!opts.dryRun && valid.length > 0) {
      await this.db.transaction().execute(async (trx) => {
        for (const v of valid) {
          await trx
            .insertInto('clients')
            .values({
              first_name: v.first_name,
              last_name: v.last_name,
              company: v.company,
              email: v.email,
              phone: v.phone,
              address_line1: v.address_line1,
              address_line2: v.address_line2,
              city: v.city,
              region: v.region,
              postal_code: v.postal_code,
              country: v.country,
              notes: v.notes,
              heard_from: v.heard_from,
              client_type: v.client_type,
              is_portal_enabled: false,
            })
            .execute();
        }
      });
      this.logger.log(
        `Clients import: ${valid.length}/${records.length} rows committed (actor=${opts.actorUserId ?? 'unknown'})`,
      );
    }

    result.ok = valid.length;
    result.skipped = result.errors.length;
    return result;
  }

  /**
   * Historical invoices import — pre-system invoices (from a prior
   * CRM, QuickBooks export, paper records, etc.).
   *
   * Required columns: date (YYYY-MM-DD), type (buy|sell), amount
   * Optional columns: client_email (lookup to existing client),
   *   client_name (free-form name when no client match),
   *   is_wholesale (true/false), reference, notes
   *
   * Rows with a matching client_email link to that client_id;
   * unmatched emails fall back to client_name. Both client_id and
   * client_name can coexist for cases where the operator wants to
   * preserve the original spelling.
   */
  async importHistoricalInvoices(
    csv: string,
    opts: { dryRun: boolean; actorUserId: string | null },
  ): Promise<ImportResult> {
    const records = parseCsv(csv);
    const result: ImportResult = {
      total: records.length,
      ok: 0,
      skipped: 0,
      errors: [],
      preview: [],
      dryRun: opts.dryRun,
    };

    type ValidHistorical = {
      date: string;
      type: 'buy' | 'sell';
      amount: string;
      is_wholesale: boolean;
      client_id: string | null;
      client_name: string | null;
      reference: string | null;
      notes: string | null;
    };
    const valid: ValidHistorical[] = [];

    // Pre-fetch client_id by lowercased email for the email join.
    const emailSet = new Set<string>();
    for (const r of records) {
      const e = r.client_email?.trim().toLowerCase();
      if (e) emailSet.add(e);
    }
    const emailRows =
      emailSet.size > 0
        ? await this.db
            .selectFrom('clients')
            .select(['id', 'email'])
            .where(
              'email',
              'in',
              Array.from(emailSet) as [string, ...string[]],
            )
            .execute()
        : [];
    const emailToId = new Map<string, string>();
    for (const r of emailRows) {
      if (r.email) emailToId.set(r.email.toLowerCase(), r.id);
    }

    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const date = r.date?.trim();
      const typeRaw = r.type?.trim().toLowerCase();
      const amountRaw = r.amount?.trim();
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        result.errors.push({
          row: i + 2,
          error: 'date must be YYYY-MM-DD',
          raw: r,
        });
        continue;
      }
      if (typeRaw !== 'buy' && typeRaw !== 'sell') {
        result.errors.push({
          row: i + 2,
          error: `type must be "buy" or "sell" (got "${typeRaw}")`,
          raw: r,
        });
        continue;
      }
      const amount = (amountRaw ?? '').replace(/[^0-9.\-]/g, '');
      if (!amount || !Number.isFinite(Number(amount))) {
        result.errors.push({
          row: i + 2,
          error: `amount must be numeric (got "${amountRaw}")`,
          raw: r,
        });
        continue;
      }
      const email = r.client_email?.trim().toLowerCase();
      const clientId = email ? emailToId.get(email) ?? null : null;
      valid.push({
        date,
        type: typeRaw,
        amount,
        is_wholesale: parseBool(r.is_wholesale, false),
        client_id: clientId,
        client_name: r.client_name?.trim() || null,
        reference: r.reference?.trim() || null,
        notes: r.notes?.trim() || null,
      });
    }

    result.preview = valid.slice(0, 25);

    if (!opts.dryRun && valid.length > 0) {
      await this.db.transaction().execute(async (trx) => {
        for (const v of valid) {
          await trx
            .insertInto('historical_invoices')
            .values({
              date: v.date,
              type: v.type,
              amount: v.amount,
              is_wholesale: v.is_wholesale,
              client_id: v.client_id,
              client_name: v.client_name,
              reference: v.reference,
              notes: v.notes,
              created_by_user_id: opts.actorUserId,
            })
            .execute();
        }
      });
      this.logger.log(
        `Historical invoices import: ${valid.length}/${records.length} rows committed (actor=${opts.actorUserId ?? 'unknown'})`,
      );
    }

    result.ok = valid.length;
    result.skipped = result.errors.length;
    return result;
  }
}

function parseBool(input: string | undefined, fallback: boolean): boolean {
  if (input === undefined) return fallback;
  const s = input.trim().toLowerCase();
  if (['1', 'true', 't', 'yes', 'y'].includes(s)) return true;
  if (['0', 'false', 'f', 'no', 'n', ''].includes(s)) return false;
  return fallback;
}
