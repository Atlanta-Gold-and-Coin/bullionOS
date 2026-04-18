import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { Readable } from 'node:stream';
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

    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 54, left: 54, right: 54, bottom: 54 },
      info: {
        Title: `Invoice ${invoice.invoice_number}`,
        Author: branding.company_name,
        Subject: `Invoice ${invoice.invoice_number}`,
      },
    });

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

    // Company address block — sits below the logo/wordmark. Five lines max
    // (name is included when logo crowds out the wordmark so it's still legible).
    const addrY = 96;
    const addrLines: string[] = [];
    if (headerUsedLogo) addrLines.push(branding.company_name);
    if (branding.address_line1) addrLines.push(branding.address_line1);
    if (branding.address_line2) addrLines.push(branding.address_line2);
    if (branding.address_city_state_zip) addrLines.push(branding.address_city_state_zip);
    const contactBits = [branding.website, branding.phone].filter(Boolean);
    if (contactBits.length) addrLines.push(contactBits.join('  ·  '));
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

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#55555c')
      .text(`#${invoice.invoice_number}`, rightX, 78, { align: 'right', width: 200 })
      .text(`Date: ${formatDateTimeForPdf(invoice.created_at)}`, {
        align: 'right',
        width: 200,
      })
      .text(`Status: ${invoice.status.toUpperCase()}`, { align: 'right', width: 200 });

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

    // --- Per-side legal disclosure ---
    // Buy invoices: we are acquiring from the seller — include Seller Cert.
    // Sell invoices: we are transferring to the buyer — include market disclosure.
    const disclosureTitle =
      invoice.type === 'buy' ? 'SELLER CERTIFICATION' : 'PRODUCT CONDITION & MARKET DISCLOSURE';
    const disclosureBody =
      invoice.type === 'buy'
        ? 'The seller certifies that all items presented are owned outright and are not stolen or subject to any legal claim. Seller agrees to indemnify and hold harmless Atlanta Gold and Coin from any disputes arising from ownership claims.'
        : 'Precious metals products are subject to market volatility. All sales are final once payment is confirmed. Atlanta Gold and Coin does not guarantee future market performance.';

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

    // --- Footer ---
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#8a8a92')
      .text(
        'Prices computed against live spot. This document is a record of a transaction at the time of creation.',
        54,
        760,
        { width: 504, align: 'center' },
      );

    doc.end();
    return doc as unknown as Readable;
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
 * Render the invoice date + time in US/Eastern (shop's home timezone) so
 * two invoices logged five minutes apart are distinguishable on printed
 * PDFs. Format: "Apr 17, 2026 · 3:42 PM EDT" — short enough to fit the
 * 200-pt header column.
 */
function formatDateTimeForPdf(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  // Intl bakes in DST handling via timeZone; safer than manual offsets.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const parts = fmt.formatToParts(d);
  // The default format is "Apr 17, 2026, 3:42 PM EDT" — swap the middle
  // comma for a middle dot so it reads as a single line without inviting
  // a Date/Time column split when scanned.
  const joined = parts.map((p) => p.value).join('');
  return joined.replace(/,\s*(?=\d)/, ' · ');
}
