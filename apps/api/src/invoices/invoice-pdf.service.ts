import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { Readable } from 'node:stream';
import QRCode from 'qrcode';
import type { InvoiceWithLines } from './invoices.service';
import { d, toDisplay } from '../common/money';
import { SettingsService, type BrandingSettings } from '../settings/settings.service';

/**
 * Minimal, financial-grade invoice PDF.
 * Design goals: zero dependencies besides pdfkit, deterministic layout,
 * currency-aligned columns, crisp mono for numbers.
 */
@Injectable()
export class InvoicePdfService {
  private readonly logger = new Logger(InvoicePdfService.name);

  constructor(private readonly settings: SettingsService) {}

  async render(invoice: InvoiceWithLines): Promise<Readable> {
    const branding = await this.settings.getBranding();
    // Pull the logo bytes straight from the DB. pdfkit can embed from a
    // Buffer, so no disk write + no /tmp dance.
    const logoAsset = await this.settings.getAsset('logo');
    // Editable invoice copy. Each field is `null` when the operator
    // hasn't customized it; the renderer falls through to the built-in
    // default per type below.
    const tpl = await this.settings.getInvoiceTemplate();

    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 54, left: 54, right: 54, bottom: 54 },
      info: {
        Title: `Invoice ${invoice.invoice_number}`,
        Author: branding.company_name,
        Subject: `Invoice ${invoice.invoice_number}`,
      },
    });

    // --- Top-of-page market disclaimer ---
    // Moved here from the footer so the customer sees it before they
    // scan line items / totals — "these prices are point-in-time" is
    // context that matters most while someone is reading the numbers,
    // not after they've closed the document.
    doc
      .font('Helvetica-Oblique')
      .fontSize(8)
      .fillColor('#6a6a72')
      .text(
        'Prices computed against live spot. This document is a record of a transaction at the time of creation.',
        54,
        30,
        { width: 504, align: 'center' },
      );

    // --- Header: logo (if set) OR wordmark ---
    let headerUsedLogo = false;
    if (logoAsset && logoAsset.mime !== 'image/svg+xml') {
      try {
        // pdfkit supports PNG + JPEG from a Buffer. SVG needs an extra dep,
        // so we fall back to the wordmark for SVG logos (still readable in UI).
        doc.image(logoAsset.bytes, 54, 48, { fit: [140, 40] });
        headerUsedLogo = true;
      } catch (err) {
        this.logger.warn(`Failed to embed logo: ${(err as Error).message}`);
        this.drawWordmark(doc, branding);
      }
    } else {
      this.drawWordmark(doc, branding);
    }

    // Company address block — sits below the logo/wordmark.
    //
    // PDF-001 layout: website/email on one line, phone on the line
    // directly below. Keeping phone on its own line makes it easier to
    // read at a glance on a printed invoice and mirrors the expected
    // customer-contact hierarchy (how you reach us > where we are).
    const addrY = 96;
    const addrLines: string[] = [];
    if (headerUsedLogo) addrLines.push(branding.company_name);
    if (branding.address_line1) addrLines.push(branding.address_line1);
    if (branding.address_line2) addrLines.push(branding.address_line2);
    if (branding.address_city_state_zip) addrLines.push(branding.address_city_state_zip);
    if (branding.website) addrLines.push(branding.website);
    if (branding.phone) addrLines.push(branding.phone);
    if (addrLines.length) {
      doc.font('Helvetica').fontSize(9).fillColor('#55555c');
      let y = addrY;
      for (const line of addrLines) {
        doc.text(line, 54, y, { width: 280 });
        y += 11;
      }
    }

    // Invoice block (right side)
    const rightX = 360;
    doc
      .font('Helvetica-Bold')
      .fontSize(16)
      .fillColor('#17171a')
      .text(invoice.type === 'sell' ? 'INVOICE' : 'BUY TICKET', rightX, 54, {
        align: 'right',
        width: 200,
      });

    // PDF-001: stack invoice number → date (MM-DD-YYYY) → time → status,
    // with date and time on separate lines so operators can scan them
    // independently. Previously date+time were combined on one line; the
    // new layout matches the request exactly.
    const { date: dateMDY, time: timeET } = formatDatePartsForPdf(invoice.created_at);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#55555c')
      .text(`#${invoice.invoice_number}`, rightX, 78, { align: 'right', width: 200 })
      .text(`Date: ${dateMDY}`, { align: 'right', width: 200 })
      .text(`Time: ${timeET}`, { align: 'right', width: 200 })
      .text(`Status: ${invoice.status.toUpperCase()}`, { align: 'right', width: 200 });

    // Created-by attribution. Renders right-aligned under the status
    // line so the audit trail ("which staff member rang this in?")
    // is visible on the printed copy without crowding the header.
    // Skipped for legacy / imported rows where created_by_user_id is
    // null.
    if (invoice.created_by_name) {
      doc.text(`Created by: ${invoice.created_by_name}`, {
        align: 'right',
        width: 200,
      });
    }

    // --- Client / Bill-to ---
    // Anchor below the address block rather than doc.y so the layout is
    // stable regardless of which header branch ran.
    const billToY = Math.max(addrY + addrLines.length * 11 + 16, 170);
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#8a8a92')
      .text(invoice.type === 'sell' ? 'BILL TO' : 'PAY TO', 54, billToY);
    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor('#17171a')
      .text(invoice.client_name, 54, billToY + 14);
    if (invoice.client_email) {
      doc.fontSize(9).fillColor('#55555c').text(invoice.client_email);
    }

    // --- Line items table ---
    const tableTop = billToY + 72;
    this.drawTableHeader(doc, tableTop);

    let cursorY = tableTop + 22;
    for (const line of invoice.line_items) {
      this.drawLine(doc, cursorY, line);
      cursorY += 22;
      if (cursorY > 680) {
        doc.addPage();
        this.drawTableHeader(doc, 54);
        cursorY = 54 + 22;
      }
    }

    // --- Totals ---
    cursorY += 10;
    doc
      .moveTo(54, cursorY)
      .lineTo(558, cursorY)
      .strokeColor('#d9d9de')
      .stroke();
    cursorY += 10;

    this.drawTotalRow(doc, cursorY, 'Subtotal', invoice.subtotal);
    cursorY += 16;
    if (d(invoice.tax).gt(0)) {
      this.drawTotalRow(doc, cursorY, 'Tax', invoice.tax);
      cursorY += 16;
    }
    if (d(invoice.shipping).gt(0)) {
      this.drawTotalRow(doc, cursorY, 'Shipping', invoice.shipping);
      cursorY += 16;
    }
    cursorY += 4;
    doc.font('Helvetica-Bold').fillColor('#17171a');
    this.drawTotalRow(doc, cursorY, 'Total', invoice.total, true);
    cursorY += 24;

    // --- Payment record (PDF-001) ---
    // Show each payment leg + amount. Source of truth is the JSONB
    // payment_methods array; fall back to the legacy single-method
    // column for pre-INV-010 rows. Hidden entirely for drafts with
    // no payment captured yet so we don't render an empty section.
    const paymentLegs = this.resolvePaymentLegs(invoice);
    if (paymentLegs.length > 0) {
      if (cursorY > 660) {
        doc.addPage();
        cursorY = 54;
      }
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#8a8a92')
        .text('PAYMENT', 54, cursorY);
      cursorY += 14;
      for (const leg of paymentLegs) {
        doc
          .font('Helvetica')
          .fontSize(10)
          .fillColor('#17171a')
          .text(capitalize(leg.method || '(unspecified)'), 54, cursorY, {
            width: 200,
          });
        if (leg.reference) {
          doc
            .font('Helvetica')
            .fontSize(9)
            .fillColor('#8a8a92')
            .text(leg.reference, 200, cursorY, { width: 200 });
        }
        doc
          .font('Courier')
          .fontSize(10)
          .fillColor('#17171a')
          .text(`$${toDisplay(leg.amount)}`, 400, cursorY, {
            width: 158,
            align: 'right',
          });
        cursorY += 14;
      }
      cursorY += 10;
    }

    // --- Notes (operator-entered) ---
    if (invoice.notes && invoice.notes.trim().length > 0) {
      if (cursorY > 640) {
        doc.addPage();
        cursorY = 54;
      }
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#8a8a92')
        .text('NOTES', 54, cursorY);
      cursorY += 14;
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#17171a')
        .text(invoice.notes, 54, cursorY, { width: 504 });
      cursorY = doc.y + 14;
    }

    // --- Operator footer comment (applies to every invoice) ---
    // Rendered BEFORE the legal disclosure so the disclosure still
    // reads as the final legal word on the document. Falls through
    // silently when the operator hasn't set a footer.
    if (tpl.footer_comment && tpl.footer_comment.trim().length > 0) {
      if (cursorY > 620) {
        doc.addPage();
        cursorY = 54;
      }
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#8a8a92')
        .text('ADDITIONAL INFORMATION', 54, cursorY);
      cursorY += 14;
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#17171a')
        .text(tpl.footer_comment, 54, cursorY, { width: 504 });
      cursorY = doc.y + 14;
    }

    // --- Per-side legal disclosure ---
    // Buy invoices: we are acquiring from the seller — include Seller Cert.
    // Sell invoices: we are transferring to the buyer — include market disclosure.
    // Both bodies fall through to the built-in defaults below when the
    // operator hasn't customized them on Settings → Invoice template.
    const disclosureTitle =
      invoice.type === 'buy' ? 'SELLER CERTIFICATION' : 'PRODUCT CONDITION & MARKET DISCLOSURE';
    const disclosureBody =
      invoice.type === 'buy'
        ? tpl.disclosure_buy ??
          `The seller certifies that all items presented are owned outright and are not stolen or subject to any legal claim. Seller agrees to indemnify and hold harmless ${branding.company_name} from any disputes arising from ownership claims.`
        : tpl.disclosure_sell ??
          `Precious metals products are subject to market volatility. All sales are final once payment is confirmed. ${branding.company_name} does not guarantee future market performance.`;

    if (cursorY > 640) {
      doc.addPage();
      cursorY = 54;
    }
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#8a8a92')
      .text(disclosureTitle, 54, cursorY);
    cursorY += 14;
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor('#17171a')
      .text(disclosureBody, 54, cursorY, { width: 504, align: 'justify' });

    // --- QR code + footer (PDF-001) ---
    // QR deep-links to the client-portal registration page. Clients can
    // snap it with their phone and land straight on signup without
    // typing a URL — drives retention on in-person walk-ins.
    //
    // WEB_ORIGIN is the canonical app URL (e.g. https://agcdesk.com).
    // Falls back to a literal /register path if the env is empty so a
    // mis-configured dev box still produces a parseable QR.
    const webOrigin = (process.env.WEB_ORIGIN ?? '').replace(/\/$/, '');
    const registerUrl = webOrigin ? `${webOrigin}/register` : '/register';
    // Use the current page's bottom as the anchor for the QR block so
    // multi-page invoices get the QR on the final page rather than
    // floating under the line-items table. Fixed Y placement is fine
    // because we've sized the block to sit comfortably above the 792pt
    // page edge with a 10pt bottom gutter.
    const qrTop = 690;
    try {
      const qrBuffer = await QRCode.toBuffer(registerUrl, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 180,
      });
      doc.image(qrBuffer, 54, qrTop, { width: 64, height: 64 });
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#17171a')
        .text('Create an account', 128, qrTop + 6, { width: 260 });
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#55555c')
        .text(
          'Scan to open your client portal — view invoices, submit buy/sell requests, book appointments.',
          128,
          qrTop + 20,
          { width: 360 },
        );
    } catch (err) {
      // QR rendering failures must not block the PDF. Log + continue.
      this.logger.warn(`QR generation failed: ${(err as Error).message}`);
    }

    // The "Prices computed against live spot" disclaimer used to sit
    // here in the footer. Moved to the top of page 1 (see the
    // Helvetica-Oblique block at the start of render()) so it reads
    // as context rather than a post-hoc footnote.

    doc.end();
    return doc as unknown as Readable;
  }

  /**
   * PDF-001: normalize payment_methods + legacy payment_method into a
   * single array the renderer can iterate. Drafts with no payment
   * captured yet return []. Legacy single-method rows synthesize one
   * leg covering the full total so the PDF still shows something
   * useful on invoices created before INV-010.
   */
  private resolvePaymentLegs(
    invoice: InvoiceWithLines,
  ): Array<{ method: string; reference: string | null; amount: string }> {
    const legs = (invoice.payment_methods as unknown as Array<{
      method: string;
      reference: string | null;
      amount: string;
    }> | null) ?? [];
    if (legs.length > 0) return legs;
    if (invoice.payment_method) {
      return [
        {
          method: String(invoice.payment_method),
          reference: null,
          amount: invoice.total,
        },
      ];
    }
    return [];
  }

  private drawWordmark(doc: PDFKit.PDFDocument, branding: BrandingSettings) {
    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor('#17171a')
      .text(branding.company_name, 54, 54, { continued: false });

    if (branding.company_tagline) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#55555c')
        .text(branding.company_tagline, 54, 78);
    }
  }

  private drawTableHeader(doc: PDFKit.PDFDocument, y: number) {
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#8a8a92');
    doc.text('ITEM', 54, y);
    doc.text('QTY', 340, y, { width: 40, align: 'right' });
    doc.text('UNIT PRICE', 400, y, { width: 80, align: 'right' });
    doc.text('TOTAL', 490, y, { width: 68, align: 'right' });
    doc
      .moveTo(54, y + 14)
      .lineTo(558, y + 14)
      .strokeColor('#d9d9de')
      .stroke();
  }

  private drawLine(
    doc: PDFKit.PDFDocument,
    y: number,
    line: InvoiceWithLines['line_items'][number],
  ) {
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#17171a')
      .text(line.product_name_snapshot, 54, y, { width: 280, ellipsis: true });

    doc.font('Courier').fontSize(10);
    doc.text(String(line.quantity), 340, y, { width: 40, align: 'right' });
    doc.text(`$${toDisplay(line.unit_price)}`, 400, y, { width: 80, align: 'right' });
    doc.text(`$${toDisplay(line.line_total)}`, 490, y, { width: 68, align: 'right' });
  }

  private drawTotalRow(
    doc: PDFKit.PDFDocument,
    y: number,
    label: string,
    value: string,
    bold = false,
  ) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).fillColor('#17171a');
    doc.text(label, 400, y, { width: 80, align: 'right' });
    doc.font(bold ? 'Courier-Bold' : 'Courier');
    doc.text(`$${toDisplay(value)}`, 490, y, { width: 68, align: 'right' });
  }
}

/**
 * PDF-001: split date/time so the header can stack them on separate
 * lines.
 *
 *   date → "04-17-2026"              (MM-DD-YYYY, dashes)
 *   time → "3:42 PM EDT"             (US/Eastern, shop tz)
 *
 * Always US/Eastern so two invoices logged minutes apart are
 * distinguishable on the printed ticket regardless of the operator's
 * laptop timezone.
 */
function formatDatePartsForPdf(iso: string | Date): { date: string; time: string } {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }).formatToParts(d);
  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    dateParts.find((p) => p.type === type)?.value ?? '';
  const date = `${lookup('month')}-${lookup('day')}-${lookup('year')}`;

  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);

  return { date, time };
}

/**
 * Title-case a payment method for PDF display.
 *
 * Default behavior: uppercase first letter. Short all-caps acronyms
 * (ACH, wire transfer reference terms) must stay fully uppercase —
 * "Ach" reads as a typo on a financial document. Maintain a small
 * allowlist here rather than trying to regex every two-or-three-letter
 * method so we don't accidentally shout "CASH" or "WIRE".
 */
function capitalize(s: string): string {
  if (s.length === 0) return s;
  const upper = s.toUpperCase();
  const allCapsAcronyms = new Set(['ACH']);
  if (allCapsAcronyms.has(upper)) return upper;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
