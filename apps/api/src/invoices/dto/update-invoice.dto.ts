import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentEntryDto } from './create-invoice.dto';

const ALL_PAYMENT_METHODS = [
  'wire',
  'check',
  'ach',
  'cash',
  'crypto',
  'card',
  'zelle',
  'venmo',
] as const;

/**
 * Header-level edit on an existing invoice. Line items are NOT editable
 * here — changing a quantity or price on a paid ticket requires
 * unwinding inventory movements and restating totals, which belongs in
 * its own flow (void + recreate, or a dedicated line-edit service).
 *
 * Fields below are all metadata that don't affect inventory or totals
 * calculation directly; the service recomputes total = subtotal + tax +
 * shipping when tax or shipping changes.
 *
 * Usable on any invoice regardless of status — closed (paid/shipped)
 * included — so operators can correct clerical errors on yesterday's
 * walk-in without voiding and re-writing the ticket.
 */
export class UpdateInvoiceDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  tax?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  shipping?: number;

  @IsOptional()
  @IsIn(ALL_PAYMENT_METHODS)
  payment_method?: (typeof ALL_PAYMENT_METHODS)[number];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => PaymentEntryDto)
  payment_methods?: PaymentEntryDto[];

  /** Retroactively restamp the invoice's transaction time. */
  @IsOptional()
  @IsISO8601()
  transacted_at?: string;
}
