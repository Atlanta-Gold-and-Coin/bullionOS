import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Matches RegisterDto's password rules: length > composition.
 * 12+ chars, at least one letter + one digit. The current_password field
 * is just the old password for re-authentication — no complexity check on
 * it since we only use it to verify identity.
 */
export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  current_password!: string;

  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters' })
  @MaxLength(200)
  @Matches(/[A-Za-z]/, { message: 'Password must contain a letter' })
  @Matches(/[0-9]/, { message: 'Password must contain a number' })
  new_password!: string;
}
