import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateShipmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  tracking_number?: string;

  /**
   * Carrier-specific service level. Validated against the current
   * shipment's carrier in the service (we don't accept a carrier change
   * here — that would require regenerating the tracking URL + re-pricing).
   */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  delivery_speed?: string;

  @IsOptional()
  @IsIn([
    'label_created',
    'in_transit',
    'out_for_delivery',
    'delivered',
    'exception',
    'returned',
  ])
  status?:
    | 'label_created'
    | 'in_transit'
    | 'out_for_delivery'
    | 'delivered'
    | 'exception'
    | 'returned';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
