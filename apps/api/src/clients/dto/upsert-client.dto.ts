import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { ClientType } from '../../db/types';

export class CreateClientDto {
  // first_name + last_name are optional (migration 020). Either a personal
  // name OR a company must be present — enforced by the `clients_has_identity`
  // CHECK constraint on the DB side and mirrored in the service.
  @IsOptional()
  @IsString()
  @MaxLength(80)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  last_name?: string;

  /** Company/organization name. Primary identity for wholesale records. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  company?: string;

  /**
   * Extra email addresses on file (e.g. accountant, partner). Stored as a
   * JSONB array; the primary is still `email`.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsEmail({}, { each: true })
  secondary_emails?: string[];

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address_line1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address_line2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postal_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  heard_from?: string;

  @IsOptional()
  @IsIn(['retail', 'wholesaler'])
  client_type?: ClientType;

  @IsOptional()
  @IsBoolean()
  is_portal_enabled?: boolean;

  /**
   * Migration 038: when true, this client and their invoices are
   * fully invisible to admin/staff users without
   * `users.can_view_owner_private`. Used for owner / accounting
   * personal accounts. KPI/EOD totals still include the dollars —
   * privacy is detail-level only.
   */
  @IsOptional()
  @IsBoolean()
  is_owner_private?: boolean;
}

export class UpdateClientDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  last_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  company?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsEmail({}, { each: true })
  secondary_emails?: string[];

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address_line1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address_line2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postal_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  heard_from?: string;

  @IsOptional()
  @IsIn(['retail', 'wholesaler'])
  client_type?: ClientType;

  @IsOptional()
  @IsBoolean()
  is_portal_enabled?: boolean;

  /**
   * Migration 038: privacy fence — see CreateClientDto for semantics.
   * Only effective when the requesting user has
   * `can_view_owner_private = true`; the service rejects the field
   * silently for non-allowlisted callers (no IDOR — they can't see
   * the client to begin with).
   */
  @IsOptional()
  @IsBoolean()
  is_owner_private?: boolean;
}
