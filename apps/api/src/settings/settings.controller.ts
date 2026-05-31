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
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import { SettingsService } from './settings.service';
import {
  FLAG_REGISTRY,
  VALUE_REGISTRY,
  type FlagName,
  type ValueName,
  type ValueOf,
} from './settings-registry';

class UpdateBrandingDto {
  @IsOptional() @IsString() @MaxLength(100) company_name?: string;
  @IsOptional() @IsString() @MaxLength(200) company_tagline?: string;
  @IsOptional() @IsString() @MaxLength(120) address_line1?: string;
  @IsOptional() @IsString() @MaxLength(120) address_line2?: string;
  @IsOptional() @IsString() @MaxLength(120) address_city_state_zip?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) website?: string;
  // Theme overrides. Empty string = "use the built-in default" (the web
  // layer only injects a CSS var when the field is non-empty), so an
  // unset theme reproduces today's exact look.
  @IsOptional() @IsString() @MaxLength(40) accent_color?: string;
  @IsOptional() @IsString() @MaxLength(40) sidebar_bg?: string;
  @IsOptional() @IsString() @MaxLength(120) font_family?: string;
}

class CustomFieldDefDto {
  @IsString() @MaxLength(60) key!: string;
  @IsString() @MaxLength(120) label!: string;
  @IsIn(['text', 'number', 'select', 'date', 'boolean'])
  type!: 'text' | 'number' | 'select' | 'date' | 'boolean';
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  options?: string[];
}

class UpdateCustomFieldsDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomFieldDefDto)
  clients?: CustomFieldDefDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomFieldDefDto)
  products?: CustomFieldDefDto[];
}

class UpdateInvoiceTemplateDto {
  // All three fields are optional patches. null (or empty string) =
  // "revert to built-in default"; non-empty string = "override with
  // this text". Length caps keep the PDF layout from blowing past one
  // page of footer on a verbose operator.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  footer_comment?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  disclosure_buy?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  disclosure_sell?: string | null;
}

class UpdateEmailTemplateDto {
  // null on a field = reset to default. Both null = reset both.
  // Empty string is a different shape from null and is disallowed at
  // the UI layer — the admin page nudges operators to either fill
  // content or click Restore.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  body?: string | null;
}

/**
 * Registry of editable email templates. The admin UI iterates this
 * to render the form per template. Each entry carries its own
 * default text + the variable list that's available to the template
 * so the operator knows what `{{placeholders}}` they can use.
 */
const EMAIL_TEMPLATE_REGISTRY: Array<{
  slug: string;
  label: string;
  description: string;
  default_subject: string;
  default_body: string;
  variables: Array<{ key: string; description: string }>;
}> = [
  {
    slug: 'invoice',
    label: 'Invoice email',
    description:
      'Sent when an operator clicks "Email" on an invoice. The invoice PDF is attached automatically — no need to reference it in the body.',
    default_subject:
      'Your {{doc_label}} from {{company_name}} — {{invoice_number}}',
    default_body:
      'Hi {{client_first_name}},\n\n' +
      'Your {{doc_label}} {{invoice_number}} is attached as a PDF.\n' +
      'Total: ${{total}}\n' +
      'Status: {{status}}\n\n' +
      'If you have questions, just reply to this email.\n\n' +
      '— {{company_name}}',
    variables: [
      { key: 'client_name', description: 'Client’s full name (or company for wholesalers)' },
      {
        key: 'client_first_name',
        description:
          'Client’s first name only — preferred for greetings. Falls back to full name if first_name is blank (company-only wholesalers).',
      },
      {
        key: 'client_last_name',
        description: 'Client’s last name only. Empty string if not set.',
      },
      { key: 'invoice_number', description: 'Formatted invoice number, e.g. 2026-000123' },
      { key: 'doc_label', description: '"invoice" or "buy ticket" depending on invoice type' },
      { key: 'type', description: '"sell" or "buy" raw' },
      { key: 'total', description: 'Dollar total, two decimals, no $' },
      { key: 'status', description: 'draft / finalized / paid / shipped / canceled' },
      { key: 'company_name', description: 'Your branded company name' },
    ],
  },
  {
    slug: 'restock_back_in_stock',
    label: 'Back-in-stock notification',
    description:
      'Sent to anonymous subscribers who clicked "Notify me when back in stock" on the public shop widget. One email per (product, email) pair — the first fire stamps notified_at so the same person never gets double-emailed for the same product. Include {{unsubscribe_url}} somewhere visible; CAN-SPAM + common decency.',
    default_subject: '{{product_name}} is back in stock at {{company_name}}',
    default_body:
      'Hi,\n\n' +
      "{{product_name}} is back in stock at {{company_name}}. You signed up to be notified when it returned.\n\n" +
      'Shop now: {{shop_url}}\n\n' +
      'Quantities can move fast — first-come, first-served.\n\n' +
      '— {{company_name}}\n' +
      '{{company_phone}}\n\n' +
      'No longer interested? Unsubscribe: {{unsubscribe_url}}',
    variables: [
      { key: 'product_name', description: 'The product that just came back in stock' },
      { key: 'product_sku', description: 'Operator-facing SKU, e.g. "AU-EAGLE-1OZ"' },
      { key: 'shop_url', description: 'Homepage of the public shop (branding.website)' },
      { key: 'unsubscribe_url', description: 'One-click unsubscribe link keyed to this subscriber' },
      { key: 'company_name', description: 'Your branded company name' },
      { key: 'company_phone', description: 'Your branded phone number' },
    ],
  },
];

// Same mime + magic-byte validation for both logo and favicon. 1 MB max —
// brand assets over that are rarely intentional, and this keeps DB bytea
// storage bounded.
const ALLOWED_MIME = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/svg+xml', '.svg'],
  ['image/x-icon', '.ico'],
  ['image/vnd.microsoft.icon', '.ico'],
]);
const MAX_ASSET_BYTES = 1_000_000;

@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('admin/settings')
  @Roles('admin', 'staff')
  async get() {
    // Returns { branding, flags, values } — single fetch that powers
    // the FE useAppSettings hook and any settings-derived UI.
    // Backward-compatible with consumers that only read `branding`.
    return this.settings.getAppSettings();
  }

  /**
   * Registry metadata (descriptions, defaults, types) so the admin
   * Settings → Features page can render a generic toggle UI without
   * knowing about each flag/value individually.
   */
  @Get('admin/settings/registry')
  @Roles('admin')
  getRegistry() {
    return {
      flags: Object.entries(FLAG_REGISTRY).map(([name, def]) => ({
        name,
        default: def.default,
        description: def.description,
      })),
      values: Object.entries(VALUE_REGISTRY).map(([name, def]) => ({
        name,
        type: def.type,
        default: def.default,
        description: def.description,
      })),
    };
  }

  @Patch('admin/settings/flags/:name')
  @Roles('admin')
  async setFlag(
    @Param('name') name: string,
    @Body() dto: { value: boolean },
    @CurrentUser() user: RequestUser,
  ) {
    if (!(name in FLAG_REGISTRY)) {
      throw new BadRequestException(`Unknown flag: ${name}`);
    }
    if (typeof dto?.value !== 'boolean') {
      throw new BadRequestException('value must be a boolean');
    }
    await this.settings.setFlag(name as FlagName, dto.value, user.id);
    return { ok: true, name, value: dto.value };
  }

  @Patch('admin/settings/values/:name')
  @Roles('admin')
  async setValue(
    @Param('name') name: string,
    @Body() dto: { value: string | number },
    @CurrentUser() user: RequestUser,
  ) {
    if (!(name in VALUE_REGISTRY)) {
      throw new BadRequestException(`Unknown setting: ${name}`);
    }
    const def = VALUE_REGISTRY[name as ValueName];
    if (def.type === 'number' && typeof dto?.value !== 'number') {
      throw new BadRequestException(`${name} requires a number`);
    }
    if (def.type === 'string' && typeof dto?.value !== 'string') {
      throw new BadRequestException(`${name} requires a string`);
    }
    await this.settings.setValue(
      name as ValueName,
      dto.value as ValueOf<ValueName>,
      user.id,
    );
    return { ok: true, name, value: dto.value };
  }

  @Patch('admin/settings/branding')
  @Roles('admin')
  async updateBranding(@Body() dto: UpdateBrandingDto, @CurrentUser() user: RequestUser) {
    const fields: Array<[keyof UpdateBrandingDto, string]> = [
      ['company_name', 'branding.company_name'],
      ['company_tagline', 'branding.company_tagline'],
      ['address_line1', 'branding.address_line1'],
      ['address_line2', 'branding.address_line2'],
      ['address_city_state_zip', 'branding.address_city_state_zip'],
      ['phone', 'branding.phone'],
      ['website', 'branding.website'],
      ['accent_color', 'branding.accent_color'],
      ['sidebar_bg', 'branding.sidebar_bg'],
      ['font_family', 'branding.font_family'],
    ];
    for (const [dtoField, key] of fields) {
      const value = dto[dtoField];
      if (value !== undefined) await this.settings.setString(key, value, user.id);
    }
    return this.settings.getBranding();
  }

  /**
   * Replace the tenant custom-field schema for clients + products. Each
   * array is optional; an omitted array preserves the stored side, so a
   * caller can patch just clients or just products. Returns the full
   * normalized schema. customFieldSchema is also surfaced read-side via
   * GET /admin/settings.
   */
  @Patch('admin/settings/custom-fields')
  @Roles('admin')
  async updateCustomFields(
    @Body() dto: UpdateCustomFieldsDto,
    @CurrentUser() user: RequestUser,
  ) {
    const current = await this.settings.getCustomFieldSchema();
    return this.settings.setCustomFieldSchema(
      {
        clients: dto.clients ?? current.clients,
        products: dto.products ?? current.products,
      },
      user.id,
    );
  }

  @Post('admin/settings/logo')
  @Roles('admin')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_ASSET_BYTES, files: 1 },
    }),
  )
  async uploadLogo(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    this.validateImage(file);
    await this.settings.setAsset('logo', file!.mimetype, file!.buffer, user.id);
    return this.settings.getBranding();
  }

  @Delete('admin/settings/logo')
  @Roles('admin')
  @HttpCode(204)
  async removeLogo() {
    await this.settings.deleteAsset('logo');
  }

  @Post('admin/settings/favicon')
  @Roles('admin')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_ASSET_BYTES, files: 1 },
    }),
  )
  async uploadFavicon(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    this.validateImage(file);
    await this.settings.setAsset('favicon', file!.mimetype, file!.buffer, user.id);
    return this.settings.getBranding();
  }

  @Delete('admin/settings/favicon')
  @Roles('admin')
  @HttpCode(204)
  async removeFavicon() {
    await this.settings.deleteAsset('favicon');
  }

  /**
   * List every editable email template with its registry metadata
   * (label, description, default text, variable catalog) AND the
   * currently-stored override (if any). One fetch drives the whole
   * admin UI.
   */
  @Get('admin/settings/email-templates')
  @Roles('admin')
  async listEmailTemplates() {
    const out: Array<{
      slug: string;
      label: string;
      description: string;
      default_subject: string;
      default_body: string;
      variables: Array<{ key: string; description: string }>;
      current_subject: string | null;
      current_body: string | null;
    }> = [];
    for (const entry of EMAIL_TEMPLATE_REGISTRY) {
      const stored = await this.settings.getEmailTemplate(entry.slug);
      out.push({
        ...entry,
        current_subject: stored.subject,
        current_body: stored.body,
      });
    }
    return out;
  }

  @Patch('admin/settings/email-templates/:slug')
  @Roles('admin')
  async updateEmailTemplate(
    @Param('slug') slug: string,
    @Body() dto: UpdateEmailTemplateDto,
    @CurrentUser() user: RequestUser,
  ) {
    if (!EMAIL_TEMPLATE_REGISTRY.find((t) => t.slug === slug)) {
      throw new BadRequestException(`Unknown email template: ${slug}`);
    }
    await this.settings.setEmailTemplate(slug, dto, user.id);
    return this.settings.getEmailTemplate(slug);
  }

  /**
   * Current invoice-template overrides + the built-in defaults so the
   * admin UI can show a Restore-to-default affordance per field without
   * a second roundtrip.
   */
  @Get('admin/settings/invoice-template')
  @Roles('admin', 'staff')
  async getInvoiceTemplate() {
    const [current, branding] = await Promise.all([
      this.settings.getInvoiceTemplate(),
      this.settings.getBranding(),
    ]);
    const co = branding.company_name;
    return {
      current,
      defaults: {
        footer_comment: '',
        disclosure_buy:
          `The seller certifies that all items presented are owned outright and are not stolen or subject to any legal claim. Seller agrees to indemnify and hold harmless ${co} from any disputes arising from ownership claims.`,
        disclosure_sell:
          `Precious metals products are subject to market volatility. All sales are final once payment is confirmed. ${co} does not guarantee future market performance.`,
      },
    };
  }

  @Patch('admin/settings/invoice-template')
  @Roles('admin')
  async updateInvoiceTemplate(
    @Body() dto: UpdateInvoiceTemplateDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.settings.setInvoiceTemplate(dto, user.id);
    return this.settings.getInvoiceTemplate();
  }

  /** Public: serves the logo for PDFs, email, and the web header. */
  @Public()
  @Get('public/branding/logo')
  getLogo(@Res() res: Response) {
    return this.serveAsset('logo', res);
  }

  /** Public: serves the browser favicon. */
  @Public()
  @Get('public/branding/favicon')
  getFavicon(@Res() res: Response) {
    return this.serveAsset('favicon', res);
  }

  private async serveAsset(slug: 'logo' | 'favicon', res: Response) {
    const asset = await this.settings.getAsset(slug);
    if (!asset) {
      res.status(404).end();
      return;
    }
    // Revalidation-based caching instead of a hard TTL. An ETag derived
    // from the upload timestamp lets the browser/CDN keep the bytes in
    // its cache AND still pick up a fresh upload on the very next
    // request without a hard refresh. max-age=0 + must-revalidate forces
    // a conditional GET every time; 304s are cheap (no body).
    const etag = `W/"${slug}-${asset.updatedAt.getTime()}"`;
    if (res.req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', asset.mime);
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', asset.updatedAt.toUTCString());
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('Content-Length', asset.bytes.length);
    res.end(asset.bytes);
  }

  private validateImage(file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('file is required (multipart/form-data)');
    const ext = ALLOWED_MIME.get(file.mimetype);
    if (!ext) {
      throw new BadRequestException(
        `Unsupported image type. Allowed: ${[...ALLOWED_MIME.keys()].join(', ')}`,
      );
    }
    if (file.mimetype === 'image/png' && !this.startsWith(file.buffer, [0x89, 0x50, 0x4e, 0x47])) {
      throw new BadRequestException('File content does not match PNG');
    }
    if (file.mimetype === 'image/jpeg' && !this.startsWith(file.buffer, [0xff, 0xd8, 0xff])) {
      throw new BadRequestException('File content does not match JPEG');
    }
  }

  private startsWith(buf: Buffer, bytes: number[]): boolean {
    if (buf.length < bytes.length) return false;
    for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
    return true;
  }
}
