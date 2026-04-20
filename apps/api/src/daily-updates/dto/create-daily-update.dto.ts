import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateDailyUpdateDto {
  /**
   * Markdown body. 10k chars is plenty for a feed-style post; anything
   * longer should probably be a full document on a separate page.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  body!: string;
}

export class UpdateDailyUpdateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  body!: string;
}
