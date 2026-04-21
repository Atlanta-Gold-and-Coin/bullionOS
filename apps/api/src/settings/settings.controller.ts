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
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, type RequestUser } from '../common/decorators/current-user.decorator';
import { SettingsService } from './settings.service';

class UpdateBrandingDto {
  @IsOptional() @IsString() @MaxLength(100) company_name?: string;
  @IsOptional() @IsString() @MaxLength(200) company_tagline?: string;
  @IsOptional() @IsString() @MaxLength(120) address_line1?: string;
  @IsOptional() @IsString() @MaxLength(120) address_line2?: string;
  @IsOptional() @IsString() @MaxLength(120) address_city_state_zip?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) website?: string;
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
      'Hi {{client_name}},\n\n' +
      'Your {{doc_label}} {{invoice_number}} is attached as a PDF.\n' +
      'Total: ${{total}}\n' +
      'Status: {{status}}\n\n' +
      'If you have questions, just reply to this email.\n\n' +
      '— {{company_name}}',
    variables: [
      { key: 'client_name', description: 'Client’s full name (or company for wholesalers)' },
      { key: 'invoice_number', description: 'Formatted invoice number, e.g. 2026-000123' },
      { key: 'doc_label', description: '"invoice" or "buy ticket" depending on invoice type' },
      { key: 'type', description: '"sell" or "buy" raw' },
      { key: 'total', description: 'Dollar total, two decimals, no $' },
      { key: 'status', description: 'draft / finalized / paid / shipped / canceled' },
      { key: 'company_name', description: 'Your branded company name' },
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
    return { branding: await this.settings.getBranding() };
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
    ];
    for (const [dtoField, key] of fields) {
      const value = dto[dtoField];
      if (value !== undefined) await this.settings.setString(key, value, user.id);
    }
    return this.settings.getBranding();
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
