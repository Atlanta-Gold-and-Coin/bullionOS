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
}
