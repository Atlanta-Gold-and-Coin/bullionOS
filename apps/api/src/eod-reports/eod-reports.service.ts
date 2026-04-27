import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Kysely, sql } from 'kysely';
import Decimal from 'decimal.js';
import { KYSELY } from '../db/database.module';
import type { DB } from '../db/types';
import { EmailService } from '../email/email.service';

/**
 * End-of-day business report. Emails a per-metal sales / purchase
 * breakdown (today / week-to-date / month-to-date) to all active
 * @atlantagoldandcoin.com and @atlantagoldandcoinbuyers.com users
 * who haven't opted out of email notifications.
 *
 * Cron fires Mon–Fri at 18:00 ET (6pm = end of storefront hours).
 * Skips weekends — the storefront is closed and there's no
 * meaningful daily activity to report. Operators can hit the
 * `/admin/eod-reports/send-now` endpoint anytime to force a fresh
 * send (useful for testing, or for ad-hoc Saturday reviews).
 */

const METALS = ['gold', 'silver', 'platinum', 'palladium'] as const;
type Metal = (typeof METALS)[number];

interface MetalBreakdown {
  gold: number;
  silver: number;
  platinum: number;
  palladium: number;
  other: number; // ad-hoc / no-product lines
  total: number;
}

interface PeriodTotals {
  sells: MetalBreakdown;
  buys: MetalBreakdown;
  invoice_count: number;
}

export interface EodReportData {
  /** Local-date label, e.g. "Apr 27, 2026". */
  label_today: string;
  /** ISO YYYY-MM-DD. */
  iso_today: string;
  today: PeriodTotals;
  week_to_date: PeriodTotals;
  month_to_date: PeriodTotals;
  /** True when there were no qualifying invoices in the day. */
  empty_today: boolean;
}

interface SendResult {
  ok: boolean;
  recipients: string[];
  empty_day: boolean;
  message: string;
}

@Injectable()
export class EodReportsService {
  private readonly logger = new Logger(EodReportsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<DB>,
    private readonly email: EmailService,
  ) {}

  /**
   * Mon–Fri at 18:00 America/New_York. Storefront closes at 5pm,
   * leaving an hour buffer for any final tickets to be marked paid
   * before the report goes out. Skips weekends; admin can manually
   * trigger via the controller if a Sat/Sun report is wanted.
   */
  @Cron('0 0 18 * * 1-5', {
    name: 'eod-report',
    timeZone: 'America/New_York',
  })
  async scheduledSend(): Promise<void> {
    try {
      const r = await this.send();
      this.logger.log(
        `EOD report: ${r.ok ? 'sent' : 'skipped'} → ${r.recipients.length} recipients (${r.message})`,
      );
    } catch (err) {
      this.logger.error(
        `EOD report failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /** Generate + send the report. Returns recipients + status. */
  async send(forDateIso?: string): Promise<SendResult> {
    const data = await this.buildReport(forDateIso);
    const recipients = await this.resolveRecipients();

    if (recipients.length === 0) {
      return {
        ok: false,
        recipients: [],
        empty_day: data.empty_today,
        message: 'No eligible recipients (need @atlantagoldandcoin[buyers].com user with email_notifications=true).',
      };
    }

    const html = this.renderHtml(data);
    const subject = `AGC End-of-Day · ${data.label_today} · ${data.empty_today ? 'no activity' : '$' + data.today.sells.total.toFixed(0) + ' sells / $' + data.today.buys.total.toFixed(0) + ' buys'}`;

    // Send one BCC blast — keeps recipient list private and avoids
    // looking like a reply-all chain. EmailService swallows per-send
    // failures so a single bad address can't break the whole batch,
    // but we still capture the count for the result.
    for (const to of recipients) {
      await this.email.send({
        to,
        subject,
        html,
        text: this.renderPlaintext(data),
      });
    }
    return {
      ok: true,
      recipients,
      empty_day: data.empty_today,
      message: `Report sent to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}.`,
    };
  }

  /** Same data the cron uses — exposed for the admin preview button. */
  async buildReport(forDateIso?: string): Promise<EodReportData> {
    const target = forDateIso ?? this.todayInEt();
    const today = await this.totalsFor(target, target);

    // Week-to-date: Sunday → today, inclusive. Sunday is the
    // operator's calendar-week boundary (Mon would also work; pick
    // one and stick with it for trend continuity).
    const weekStart = this.startOfWeek(target);
    const wtd = await this.totalsFor(weekStart, target);

    // Month-to-date: 1st of the month → today.
    const monthStart = target.slice(0, 7) + '-01';
    const mtd = await this.totalsFor(monthStart, target);

    const empty = today.invoice_count === 0;
    return {
      label_today: this.labelDate(target),
      iso_today: target,
      today,
      week_to_date: wtd,
      month_to_date: mtd,
      empty_today: empty,
    };
  }

  // ── Data layer ────────────────────────────────────────────────

  /**
   * Aggregates committed invoice activity in [from, to] inclusive.
   * "Committed" means status in (finalized, paid, shipped) — i.e.,
   * the invoice has been recognized as real (not draft, not
   * canceled). Sums line_item.line_total per metal, split by
   * invoice.type (sell vs buy). Excludes clients flagged
   * exclude_from_reports.
   */
  private async totalsFor(fromIso: string, toIso: string): Promise<PeriodTotals> {
    // Recognition timestamp: prefer finalized_at (the earliest
    // commit point), falling back to created_at for older rows that
    // pre-date the finalized_at column. Mirrors the same logic the
    // KPI rollup uses elsewhere.
    const rows = await this.db
      .selectFrom('invoice_line_items as li')
      .innerJoin('invoices as i', 'i.id', 'li.invoice_id')
      .innerJoin('clients as c', 'c.id', 'i.client_id')
      .leftJoin('products as p', 'p.id', 'li.product_id')
      .select([
        'i.type as inv_type',
        sql<string | null>`p.metal`.as('metal'),
        sql<string>`coalesce(li.line_total, 0)`.as('line_total'),
      ])
      .where('i.status', 'in', ['finalized', 'paid', 'shipped'])
      .where('c.exclude_from_reports', '=', false)
      .where(
        sql<boolean>`coalesce(i.finalized_at, i.created_at) >= ${fromIso}::date`,
      )
      .where(
        sql<boolean>`coalesce(i.finalized_at, i.created_at) < (${toIso}::date + interval '1 day')`,
      )
      .execute();

    const sells = this.zero();
    const buys = this.zero();
    const seenInvoiceIds = new Set<string>();
    // Distinct invoice count: get from a separate query for accuracy
    // since the line-item join multiplies the row count.
    const invoiceIds = await this.db
      .selectFrom('invoices as i')
      .innerJoin('clients as c', 'c.id', 'i.client_id')
      .select('i.id')
      .where('i.status', 'in', ['finalized', 'paid', 'shipped'])
      .where('c.exclude_from_reports', '=', false)
      .where(
        sql<boolean>`coalesce(i.finalized_at, i.created_at) >= ${fromIso}::date`,
      )
      .where(
        sql<boolean>`coalesce(i.finalized_at, i.created_at) < (${toIso}::date + interval '1 day')`,
      )
      .execute();
    for (const r of invoiceIds) seenInvoiceIds.add(r.id);

    for (const r of rows) {
      const bucket = r.inv_type === 'sell' ? sells : buys;
      const amt = Number(r.line_total ?? 0);
      const m = (r.metal ?? '') as Metal;
      if ((METALS as readonly string[]).includes(m)) {
        bucket[m] = new Decimal(bucket[m]).plus(amt).toNumber();
      } else {
        bucket.other = new Decimal(bucket.other).plus(amt).toNumber();
      }
      bucket.total = new Decimal(bucket.total).plus(amt).toNumber();
    }
    return { sells, buys, invoice_count: seenInvoiceIds.size };
  }

  private zero(): MetalBreakdown {
    return { gold: 0, silver: 0, platinum: 0, palladium: 0, other: 0, total: 0 };
  }

  // ── Recipients ────────────────────────────────────────────────

  private async resolveRecipients(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('users')
      .select('email')
      .where('status', '=', 'active')
      .where('email_notifications', '=', true)
      .where((eb) =>
        eb.or([
          eb('email', 'like', '%@atlantagoldandcoin.com'),
          eb('email', 'like', '%@atlantagoldandcoinbuyers.com'),
        ]),
      )
      .execute();
    return rows.map((r) => r.email).sort();
  }

  // ── Date helpers ──────────────────────────────────────────────

  /**
   * Today's date in America/New_York, formatted YYYY-MM-DD. The
   * cron and any operator-triggered send should both anchor to the
   * shop's local calendar — UTC midnight rollover would cut off
   * 7-11pm ET activity into the wrong day.
   */
  private todayInEt(): string {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(new Date());
  }

  /** Sunday of the week containing iso (YYYY-MM-DD), local cal. */
  private startOfWeek(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dow = dt.getUTCDay(); // 0=Sun..6=Sat
    dt.setUTCDate(dt.getUTCDate() - dow);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }

  private labelDate(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }

  // ── HTML rendering ────────────────────────────────────────────

  /**
   * Self-contained HTML email. Inline-styled because most email
   * clients strip <style> tags. Bars are CSS-width divs (not SVG)
   * so they render in Outlook desktop, which strips <svg>.
   */
  renderHtml(d: EodReportData): string {
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const dollars = (n: number) =>
      `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

    // Compute the maximum total across all 3 periods for shared bar
    // scaling. Without this each bar would scale to its own period
    // and "today $5k" would visually equal "month $500k" — false
    // signal to the eye.
    const maxTotal = Math.max(
      1,
      d.today.sells.total + d.today.buys.total,
      d.week_to_date.sells.total + d.week_to_date.buys.total,
      d.month_to_date.sells.total + d.month_to_date.buys.total,
    );

    const periods: Array<{ label: string; key: 'today' | 'week_to_date' | 'month_to_date' }> = [
      { label: 'Today', key: 'today' },
      { label: 'Week-to-date', key: 'week_to_date' },
      { label: 'Month-to-date', key: 'month_to_date' },
    ];

    // ── Top: 3 KPI cards
    const kpiCards = periods
      .map((p) => {
        const period = d[p.key];
        const net = period.sells.total - period.buys.total;
        return `
          <td valign="top" style="width:33.33%;padding:0 6px;">
            <div style="border:1px solid #e5e5ea;border-radius:8px;padding:14px;background:#fafafb;">
              <div style="font-size:10px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#888;margin-bottom:6px;">${esc(p.label)}</div>
              <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:18px;font-weight:700;color:#17171a;line-height:1.2;">${dollars(period.sells.total)}</div>
              <div style="font-size:11px;color:#888;margin-top:2px;">sells · ${period.invoice_count} invoice${period.invoice_count === 1 ? '' : 's'}</div>
              <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#a14848;margin-top:8px;">${dollars(period.buys.total)} <span style="color:#aaa;font-weight:400;font-size:10px;">buys</span></div>
              <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:${net >= 0 ? '#0a7a3a' : '#a14848'};margin-top:2px;font-weight:600;">${net >= 0 ? '+' : ''}${dollars(net)} <span style="color:#aaa;font-weight:400;font-size:10px;">net</span></div>
            </div>
          </td>`;
      })
      .join('');

    // ── Bar chart — stacked metal bars, one row per period ──
    const metalColors: Record<Metal, string> = {
      gold: '#d4a017',
      silver: '#9aa3ad',
      platinum: '#7e8aa1',
      palladium: '#5a8170',
    };
    const buildStackedBar = (mb: MetalBreakdown, period_total_for_scale: number) => {
      const overall = period_total_for_scale > 0 ? (mb.total / maxTotal) * 100 : 0;
      const segments = METALS.map((m) => {
        if (mb[m] <= 0) return '';
        const pctOfPeriod = mb.total > 0 ? (mb[m] / mb.total) * 100 : 0;
        return `<span style="display:inline-block;height:18px;width:${pctOfPeriod}%;background:${metalColors[m]};vertical-align:top;"></span>`;
      }).join('');
      return `
        <div style="background:#f0f0f3;border-radius:4px;width:${overall}%;min-width:1px;overflow:hidden;">
          ${segments}
        </div>`;
    };

    const barRows = periods
      .map((p) => {
        const period = d[p.key];
        const sellsBar = buildStackedBar(period.sells, period.sells.total);
        const buysBar = buildStackedBar(period.buys, period.buys.total);
        return `
          <tr>
            <td style="padding:8px 12px 0 0;font-size:11px;color:#888;width:120px;vertical-align:top;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;">${esc(p.label)}</td>
            <td style="padding:6px 0;">
              <div style="font-size:10px;color:#0a7a3a;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:2px;">Sells ${dollars(period.sells.total)}</div>
              ${sellsBar}
              <div style="font-size:10px;color:#a14848;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;margin:8px 0 2px;">Buys ${dollars(period.buys.total)}</div>
              ${buysBar}
            </td>
          </tr>`;
      })
      .join('');

    const legend = METALS.map(
      (m) =>
        `<span style="display:inline-block;margin-right:14px;font-size:11px;color:#666;">
          <span style="display:inline-block;width:10px;height:10px;background:${metalColors[m]};border-radius:2px;vertical-align:middle;margin-right:4px;"></span>
          ${esc(m.charAt(0).toUpperCase() + m.slice(1))}
        </span>`,
    ).join('');

    // ── Per-metal table ──
    const metalRow = (metal: Metal | 'other') => {
      const sells = [d.today.sells, d.week_to_date.sells, d.month_to_date.sells];
      const buys = [d.today.buys, d.week_to_date.buys, d.month_to_date.buys];
      const metalLabel = metal === 'other' ? 'Other / scrap' : metal.charAt(0).toUpperCase() + metal.slice(1);
      const swatch =
        metal === 'other'
          ? '#cccccc'
          : metalColors[metal];
      return `
        <tr>
          <td style="padding:8px 10px;border-top:1px solid #e5e5ea;font-size:13px;color:#222;">
            <span style="display:inline-block;width:8px;height:8px;background:${swatch};border-radius:2px;vertical-align:middle;margin-right:6px;"></span>
            ${esc(metalLabel)}
          </td>
          <td style="padding:8px 10px;border-top:1px solid #e5e5ea;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace;text-align:right;color:#0a7a3a;">${dollars(sells[0][metal])}</td>
          <td style="padding:8px 10px;border-top:1px solid #e5e5ea;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace;text-align:right;color:#a14848;">${dollars(buys[0][metal])}</td>
          <td style="padding:8px 10px;border-top:1px solid #e5e5ea;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace;text-align:right;color:#0a7a3a;">${dollars(sells[1][metal])}</td>
          <td style="padding:8px 10px;border-top:1px solid #e5e5ea;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace;text-align:right;color:#a14848;">${dollars(buys[1][metal])}</td>
          <td style="padding:8px 10px;border-top:1px solid #e5e5ea;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace;text-align:right;color:#0a7a3a;">${dollars(sells[2][metal])}</td>
          <td style="padding:8px 10px;border-top:1px solid #e5e5ea;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace;text-align:right;color:#a14848;">${dollars(buys[2][metal])}</td>
        </tr>`;
    };

    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>End of Day · ${esc(d.label_today)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#17171a;">
  <table cellpadding="0" cellspacing="0" border="0" style="max-width:680px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e5ea;overflow:hidden;">
    <tr>
      <td style="padding:24px 24px 12px;border-bottom:1px solid #f0f0f3;">
        <div style="font-size:10px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:#888;">End of Day</div>
        <h1 style="margin:4px 0 0;font-size:22px;font-weight:600;color:#17171a;">${esc(d.label_today)}</h1>
        ${d.empty_today ? '<p style="margin:6px 0 0;font-size:13px;color:#888;">No qualifying invoices today.</p>' : ''}
      </td>
    </tr>
    <tr><td style="padding:18px 18px 0;"><table cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr>${kpiCards}</tr></table></td></tr>
    <tr>
      <td style="padding:24px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#888;margin-bottom:6px;">Volume comparison</div>
        <div style="margin-bottom:12px;">${legend}</div>
        <table cellpadding="0" cellspacing="0" border="0" style="width:100%;">${barRows}</table>
      </td>
    </tr>
    <tr>
      <td style="padding:0 24px 24px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#888;margin-bottom:8px;">By metal</div>
        <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border:1px solid #e5e5ea;border-radius:6px;border-collapse:separate;border-spacing:0;">
          <thead>
            <tr style="background:#fafafb;">
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;color:#888;">Metal</th>
              <th colspan="2" style="padding:8px 10px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;color:#888;border-left:1px solid #e5e5ea;">Today</th>
              <th colspan="2" style="padding:8px 10px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;color:#888;border-left:1px solid #e5e5ea;">Week</th>
              <th colspan="2" style="padding:8px 10px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;color:#888;border-left:1px solid #e5e5ea;">Month</th>
            </tr>
            <tr style="background:#fafafb;">
              <th></th>
              <th style="padding:4px 10px 8px;text-align:right;font-size:9px;font-weight:600;color:#0a7a3a;">Sell</th>
              <th style="padding:4px 10px 8px;text-align:right;font-size:9px;font-weight:600;color:#a14848;">Buy</th>
              <th style="padding:4px 10px 8px;text-align:right;font-size:9px;font-weight:600;color:#0a7a3a;border-left:1px solid #e5e5ea;">Sell</th>
              <th style="padding:4px 10px 8px;text-align:right;font-size:9px;font-weight:600;color:#a14848;">Buy</th>
              <th style="padding:4px 10px 8px;text-align:right;font-size:9px;font-weight:600;color:#0a7a3a;border-left:1px solid #e5e5ea;">Sell</th>
              <th style="padding:4px 10px 8px;text-align:right;font-size:9px;font-weight:600;color:#a14848;">Buy</th>
            </tr>
          </thead>
          <tbody>
            ${METALS.map(metalRow).join('')}
            ${(d.today.sells.other > 0 || d.today.buys.other > 0 || d.week_to_date.sells.other > 0 || d.week_to_date.buys.other > 0 || d.month_to_date.sells.other > 0 || d.month_to_date.buys.other > 0) ? metalRow('other') : ''}
          </tbody>
        </table>
        <p style="margin:14px 0 0;font-size:11px;color:#888;line-height:1.45;">
          Activity from invoices in <strong>finalized</strong>, <strong>paid</strong>, or <strong>shipped</strong> status. Drafts and canceled invoices are excluded. Clients flagged exclude-from-reports are also excluded.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:14px 24px;background:#fafafb;border-top:1px solid #f0f0f3;font-size:11px;color:#888;">
        Sent automatically by AGC Desk · <a href="https://agcdesk.com/admin/kpi" style="color:#888;text-decoration:underline;">Open KPI dashboard →</a>
      </td>
    </tr>
  </table>
</body></html>`;
  }

  /** Plaintext fallback for clients that strip HTML. */
  renderPlaintext(d: EodReportData): string {
    const $ = (n: number) =>
      `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    const lines: string[] = [];
    lines.push(`AGC End of Day — ${d.label_today}`);
    lines.push('='.repeat(40));
    if (d.empty_today) lines.push('No qualifying invoices today.');
    lines.push('');
    for (const [label, period] of [
      ['Today', d.today],
      ['Week-to-date', d.week_to_date],
      ['Month-to-date', d.month_to_date],
    ] as const) {
      lines.push(`${label}:`);
      lines.push(`  Sells: ${$(period.sells.total)} (${period.invoice_count} invoices)`);
      lines.push(`  Buys:  ${$(period.buys.total)}`);
      lines.push(`  Net:   ${$(period.sells.total - period.buys.total)}`);
      for (const m of METALS) {
        if (period.sells[m] === 0 && period.buys[m] === 0) continue;
        lines.push(`    ${m.padEnd(10)} sell ${$(period.sells[m]).padStart(8)}   buy ${$(period.buys[m]).padStart(8)}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }
}
