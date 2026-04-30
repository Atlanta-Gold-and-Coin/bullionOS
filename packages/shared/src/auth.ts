import { z } from 'zod';
import { USER_ROLES } from './roles';

export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
  totp: z.string().min(6).max(8).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .max(200)
    .regex(/[A-Za-z]/, 'Password must contain a letter')
    .regex(/[0-9]/, 'Password must contain a number'),
  first_name: z.string().min(1).max(80),
  last_name: z.string().min(1).max(80),
  phone: z.string().max(40).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const tokenResponseSchema = z.object({
  access_token: z.string(),
  access_expires_in: z.number().int().positive(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export const meResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(USER_ROLES),
  status: z.enum(['active', 'restricted', 'disabled']),
  is_2fa_enabled: z.boolean(),
  last_login_at: z.string().datetime().nullable(),
  // Owner-private allowlist flag (migration 038). Surfaced so the
  // web UI can conditionally render privacy controls.
  can_view_owner_private: z.boolean().optional(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  phone: z.string().nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
