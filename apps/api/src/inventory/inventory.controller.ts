import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AdjustInventoryDto } from './dto/adjust-inventory.dto';
import { SetInventoryLocationDto } from './dto/set-location.dto';
import { InventoryService } from './inventory.service';

@Controller()
export class InventoryController {
  constructor(private readonly service: InventoryService) {}

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
  @Get('client/in-stock')
  @Roles('client')
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
  publicInStock() {
    return this.service.inStock({ onlyWebsite: true });
  }
}
