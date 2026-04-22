import { Controller, Get, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ProductsService } from '../products/products.service';
import { PricingService } from '../pricing/pricing.service';
import { MetalsService } from '../metals/metals.service';
import { InvoicesService } from '../invoices/invoices.service';
import { InvoicePdfService } from '../invoices/invoice-pdf.service';
import { toDisplay } from '../common/money';

/**
 * Client-portal-scoped endpoints. Only role='client' reaches these.
 * Differs from /public in that clients will eventually see their own
 * pricing tiers; for Phase 1 it's the same buy-price feed.
 */
@Controller('client')
@Roles('client')
export class ClientPortalController {
  constructor(
    private readonly products: ProductsService,
    private readonly pricing: PricingService,
    private readonly metals: MetalsService,
    private readonly invoices: InvoicesService,
    private readonly pdf: InvoicePdfService,
  ) {}

  /**
   * Read-only catalog feeds are widened to admin/staff so operators can
   * preview the customer portal without needing a separate client
   * account. The invoice endpoints below stay client-only because they
   * resolve the caller's linked `clients.user_id` — admin users don't
   * have a clients row, so those endpoints genuinely don't have data
   * to return for them.
   *
   * Switched from Promise.all(products.map(...quote())) to quoteMany()
   * so we do 1 DB sweep instead of 213 concurrent quote calls — the
   * portal page load was spinning for several seconds before.
   */
  @Get('prices')
  @Roles('client', 'admin', 'staff')
  async prices() {
    const products = await this.products.list({ onlyActive: true, onlyWebsite: true });
    const spot = await this.metals.getSpot();

    const quotes = await this.pricing.quoteMany(
      products.map((p) => ({ product_id: p.id, quantity: 1 })),
    );
    const quoteByProduct = new Map(quotes.map((q) => [q.product_id, q]));

    const items = products
      .map((p) => {
        const q = quoteByProduct.get(p.id);
        if (!q) return null;
        return {
          product_id: p.id,
          sku: p.sku,
          name: p.name,
          metal: p.metal,
          buy_price: toDisplay(q.buy_unit_price, 2),
        };
      })
      .filter(<T>(v: T | null): v is T => v !== null);

    return { items, as_of: spot.asOf };
  }

  @Get('spot')
  @Roles('client', 'admin', 'staff')
  async spot() {
    const s = await this.metals.getSpot();
    return {
      gold: toDisplay(s.gold, 2),
      silver: toDisplay(s.silver, 2),
      platinum: toDisplay(s.platinum, 2),
      palladium: toDisplay(s.palladium, 2),
      change: s.change ?? null,
      as_of: s.asOf,
    };
  }

  @Get('invoices')
  listInvoices(@CurrentUser() user: RequestUser) {
    return this.invoices.listForClientUser(user.id);
  }

  @Get('invoices/:id')
  getInvoice(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.invoices.getByIdForClientUser(user.id, id);
  }

  @Get('invoices/:id/pdf')
  async invoicePdf(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ) {
    const invoice = await this.invoices.getByIdForClientUser(user.id, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="invoice-${invoice.invoice_number}.pdf"`,
    );
    const stream = await this.pdf.render(invoice);
    stream.pipe(res);
  }
}
