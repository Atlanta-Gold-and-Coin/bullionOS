import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { UpdateShipmentDto } from './dto/update-shipment.dto';
import { ShipmentsService, trackingUrlFor } from './shipments.service';
import { DELIVERY_SPEEDS } from './delivery-speeds';

@Controller('admin/shipments')
@Roles('admin', 'staff')
export class AdminShipmentsController {
  constructor(private readonly service: ShipmentsService) {}

  /**
   * Expose the carrier→delivery-speed whitelist so the web UI can build
   * the dropdown without hardcoding it. Returned as the flat object —
   * keys are carriers ('ups' | 'fedex' | 'usps' | 'other'), values are
   * ordered arrays of human-readable service names. (SHIP-001)
   *
   * Declared BEFORE the `:id` route so Nest's matcher picks this up
   * instead of trying to parse "delivery-speeds" as a UUID.
   */
  @Get('delivery-speeds')
  getDeliverySpeeds() {
    return DELIVERY_SPEEDS;
  }

  @Get()
  async list() {
    const rows = await this.service.listAll();
    return rows.map((r) => ({
      ...r,
      tracking_url: trackingUrlFor(r.carrier, r.tracking_number),
    }));
  }

  @Get(':id')
  async getById(@Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.service.getById(id);
    return { ...r, tracking_url: trackingUrlFor(r.carrier, r.tracking_number) };
  }

  @Post()
  create(@Body() dto: CreateShipmentDto, @CurrentUser() user: RequestUser) {
    return this.service.create(dto, user.id);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateShipmentDto,
  ) {
    return this.service.update(id, dto);
  }
}

@Controller('client/shipments')
@Roles('client')
export class ClientShipmentsController {
  constructor(private readonly service: ShipmentsService) {}

  @Get()
  async list(@CurrentUser() user: RequestUser) {
    const rows = await this.service.listForClientUser(user.id);
    return rows.map((r) => ({
      ...r,
      tracking_url: trackingUrlFor(r.carrier, r.tracking_number),
    }));
  }
}
