import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateDailyUpdateCommentDto {
  /**
   * Plain text comment body. 4k is generous for a feed-style thread —
   * if a teammate needs to write more, it's probably a doc.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}

export class UpdateDailyUpdateCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}
