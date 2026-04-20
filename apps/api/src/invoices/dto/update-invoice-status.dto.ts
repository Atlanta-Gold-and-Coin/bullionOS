import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateInvoiceStatusDto {
  @IsIn(['draft', 'finalized', 'paid', 'shipped', 'canceled'])
  status!: 'draft' | 'finalized' | 'paid' | 'shipped' | 'canceled';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /**
   * Admin-only oversell override. When true on a transition that reserves
   * or consumes inventory (draft→finalized, finalized→paid/shipped), the
   * on-hand guard is bypassed so the movement commits even if it takes
   * inventory negative. Ignored for non-admin actors.
   */
  @IsOptional()
  @IsBoolean()
  force_oversell?: boolean;
}
