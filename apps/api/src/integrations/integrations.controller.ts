import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { ShipmentCarrier } from '../db/types';
import { CarrierService } from './carrier.service';
import { DocuSignService } from './docusign.service';
import { IntegrationsService } from './integrations.service';
import { MetalsService } from '../metals/metals.service';
import { isProvider, type ProviderName } from './integrations.registry';

function parseProvider(raw: string): ProviderName {
  if (!isProvider(raw)) throw new BadRequestException('Unknown provider');
  return raw;
}

@Controller('admin/integrations')
@Roles('admin') // admin only — creds grant spend
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly carrier: CarrierService,
    private readonly docusign: DocuSignService,
    private readonly metals: MetalsService,
  ) {}

  @Get()
  list() {
    return this.integrations.listStatus();
  }

  @Put(':provider')
  async set(
    @Param('provider') raw: string,
    @Body() body: unknown,
    @CurrentUser() user: RequestUser,
  ) {
    const provider = parseProvider(raw);
    return this.integrations.set(provider, body, user.id);
  }

  @Patch(':provider/enabled')
  @HttpCode(204)
  async toggle(
    @Param('provider') raw: string,
    @Body() body: { enabled: boolean },
    @CurrentUser() user: RequestUser,
  ) {
    const provider = parseProvider(raw);
    await this.integrations.setEnabled(provider, Boolean(body.enabled), user.id);
  }

  @Delete(':provider')
  @HttpCode(204)
  async remove(@Param('provider') raw: string, @CurrentUser() user: RequestUser) {
    const provider = parseProvider(raw);
    await this.integrations.remove(provider, user.id);
  }

  /** Exercise the real OAuth token endpoint and record the result. */
  @Post(':provider/test')
  async test(@Param('provider') raw: string) {
    const provider = parseProvider(raw);
    let result: { ok: boolean; message: string };
    if (provider === 'docusign') {
      result = await this.docusign.testConnection();
    } else if (provider === 'metals') {
      result = await this.metals.testConnection();
    } else {
      result = await this.carrier.testConnection(provider as ShipmentCarrier);
    }
    await this.integrations.recordTestResult(provider, result.ok, result.message);
    return result;
  }
}
