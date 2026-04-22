import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { IsEmail, IsUUID } from 'class-validator';
import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { KYSELY } from '../db/database.module';
import type { DB } from '../db/types';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AdjustInventoryDto } from './dto/adjust-inventory.dto';
import { SetInventoryLocationDto } from './dto/set-location.dto';
import { InventoryService } from './inventory.service';
import { resolveDisplayCategory, SECTIONS } from '../common/display-category';

class RestockSubscribeDto {
  @IsUUID() product_id!: string;
  @IsEmail() email!: string;
}

@Controller()
export class InventoryController {
  constructor(
    private readonly service: InventoryService,
    @Inject(KYSELY) private readonly db: Kysely<DB>,
  ) {}

  @Get('admin/inventory')
  @Roles('admin', 'staff')
  list() {
    return this.service.list();
  }

  @Patch('admin/inventory/:productId')
  @Roles('admin', 'staff')
  adjust(
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body() dto: AdjustInventoryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.adjust(productId, dto.delta, user.id, dto.notes);
  }

  /**
   * PROD-002 — edit the storage-location label for a product. Separate
   * endpoint from the quantity-delta adjust so the two concerns stay
   * cleanly auditable (one movement row per request, no combined
   * "moved + relocated" ambiguity).
   */
  @Patch('admin/inventory/:productId/location')
  @Roles('admin', 'staff')
  setLocation(
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body() dto: SetInventoryLocationDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.setLocation(productId, dto.location, user.id);
  }

  /**
   * Client-portal view (requires auth, role=client).
   *
   * Shows every in-stock item regardless of the `show_on_website`
   * toggle — that toggle is for the anonymous WP plugin audience.
   * Logged-in clients are entitled to see the full in-stock inventory.
   */
  // Widened to admin/staff so operators can preview the client portal
  // without logging in as a customer. The data is the same full in-stock
  // list regardless of caller — there's no per-client personalization
  // on this endpoint — so exposing it to admins is strictly additive.
  @Get('client/in-stock')
  @Roles('client', 'admin', 'staff')
  clientInStock() {
    return this.service.inStock({ onlyWebsite: false });
  }

  /**
   * Public shop feed — no auth. Consumed by the WordPress plugin at
   * atlantagoldandcoin.com.
   *
   * Explicit no-store header so neither Railway's Fastly edge nor any
   * reverse proxy layers a cache on top of our intended WP transient.
   * When an admin toggles show_on_website, this response must reflect
   * the flip on the very next fetch; if Fastly held a 30s cached copy,
   * the WP transient would read stale data, re-cache it, and the toggle
   * wouldn't visibly take effect until both layers expired.
   */
  @Public()
  @Get('public/in-stock')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  @Header('Pragma', 'no-cache')
  async publicInStock() {
    const rows = await this.service.inStock({ onlyWebsite: true });
    // Tag every row with its display_category slug + label so the WP
    // plugin can render sections matching the CRM Catalog taxonomy
    // (e.g. 'Morgan and Peace Silver Dollars', 'US Mint Proof Gold
    // Coins'). Tagging happens here rather than in the service because
    // the resolver pulls from a frontend-shared lib that we keep pure.
    const labelBySlug = new Map<string, string>(SECTIONS.map((s) => [s.id as string, s.label]));
    return rows.map((r) => {
      const slug = resolveDisplayCategory(r);
      return {
        ...r,
        display_category: slug,
        display_category_label: labelBySlug.get(slug) ?? 'Other',
      };
    });
  }

  /**
   * Out-of-stock SKUs on the public shop feed — powers the "Notify me
   * when back in stock" section at the bottom of the Live Inventory
   * widget. Same no-auth + no-store conventions as the in-stock sibling.
   */
  @Public()
  @Get('public/out-of-stock')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  @Header('Pragma', 'no-cache')
  async publicOutOfStock() {
    const rows = await this.service.outOfStock();
    const labelBySlug = new Map<string, string>(
      SECTIONS.map((s) => [s.id as string, s.label]),
    );
    return rows.map((r) => {
      const slug = resolveDisplayCategory(r);
      return {
        ...r,
        display_category: slug,
        display_category_label: labelBySlug.get(slug) ?? 'Other',
      };
    });
  }

  /**
   * Anonymous signup for a restock notification. No double-opt-in yet
   * (the email is trusted on first submit); duplicate signups UPSERT
   * against the (product_id, email) unique index and are a no-op.
   *
   * The actual email-on-restock trigger is a separate worker that
   * watches inventory.applyMovement — this endpoint only captures
   * the intent. See docs/restock-notify.md for the wiring plan.
   */
  @Public()
  @Post('public/restock-notify')
  @HttpCode(200)
  async subscribeRestockNotification(
    @Body() dto: RestockSubscribeDto,
    @Ip() ip: string,
  ) {
    const email = dto.email.trim().toLowerCase();
    if (!email || email.length > 254) {
      throw new BadRequestException('Invalid email');
    }
    // Confirm the product exists + is publicly visible so we don't
    // collect signups for SKUs that will never surface to the widget.
    const product = await this.db
      .selectFrom('products')
      .select(['id', 'name', 'show_on_website'])
      .where('id', '=', dto.product_id)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (!product) throw new NotFoundException('Product not found');
    if (!product.show_on_website) {
      throw new BadRequestException('Product is not listed publicly');
    }
    const token = randomUUID().replace(/-/g, '');
    await this.db
      .insertInto('restock_subscriptions')
      .values({
        product_id: dto.product_id,
        email,
        token,
        ip: (ip || '').slice(0, 64) || null,
      })
      .onConflict((oc) =>
        // Re-signing up for the same product is a no-op; keep the
        // original token + created_at so a later unsubscribe URL still
        // works.
        oc.columns(['product_id', 'email']).doNothing(),
      )
      .execute();
    return {
      ok: true,
      message: `We'll email ${email} when ${product.name} is back in stock.`,
    };
  }
}
