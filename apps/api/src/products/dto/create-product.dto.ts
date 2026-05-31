import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[A-Z0-9._-]+$/, {
    message: 'sku must be uppercase alphanumeric with . - or _',
  })
  sku!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsIn(['gold', 'silver', 'platinum', 'palladium'])
  metal!: 'gold' | 'silver' | 'platinum' | 'palladium';

  @IsIn(['coin', 'bar', 'round', 'numismatic', 'jewelry', 'other'])
  category!: 'coin' | 'bar' | 'round' | 'numismatic' | 'jewelry' | 'other';

  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0.00000001)
  @Max(100000)
  weight_troy_oz!: number;

  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0.0001)
  @Max(1)
  purity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  image_url?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsBoolean()
  show_on_website?: boolean;

  /**
   * Optional slug that pins this product into a specific display
   * category on the counter-facing views (builtins or admin-added).
   * Empty string / null = use the heuristic from product-category.ts.
   * Stored as-is; unknown slugs gracefully fall back to 'other'.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$|^$/, {
    message: 'display_category_override must be lowercase snake_case or empty',
  })
  @MaxLength(40)
  display_category_override?: string | null;

  /**
   * Migration 039: per-tenant custom field values, keyed by the field
   * defs in app_settings `custom_fields_schema`. Stored as-is
   * (passthrough — no server-side validation against the schema).
   */
  @IsOptional()
  @IsObject()
  custom_fields?: Record<string, unknown>;
}
