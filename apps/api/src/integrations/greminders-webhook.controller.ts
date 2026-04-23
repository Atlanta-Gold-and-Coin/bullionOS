import { BadRequestException, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { GremindersService, type GremindersWebhookEnvelope } from './greminders.service';

/**
 * Public webhook receiver for GReminders events.
 *
 * Give this URL to GReminders: in their dashboard →
 *   Integrations → Webhooks → Add Subscription →
 *   https://agc-api-production.up.railway.app/api/v1/public/greminders/webhook
 *   Events: booking created / updated / canceled.
 *
 * Auth is per-payload (no bearer token): every request carries an
 * HMAC-SHA256 `X-Greminders-Signature` header computed against the
 * webhook_secret stored in the `greminders` integration row. A bad
 * signature returns 400 so GReminders surfaces the failure in their
 * delivery log. An absent secret in our config logs a warning but
 * accepts the event — dev-only convenience, not intended for prod.
 *
 * Idempotency: GReminders retries on non-2xx. The audit_logs write
 * is the only side effect; a replayed event becomes a duplicate row
 * with the same metadata, which is harmless. If the volume ever
 * warrants it, add a UNIQUE index on (action, greminders_event_id)
 * extracted from metadata.
 */
@Controller('public/greminders')
export class GremindersWebhookController {
  constructor(private readonly greminders: GremindersService) {}

  @Public()
  @Post('webhook')
  @HttpCode(200)
  async receive(@Req() req: Request) {
    // Raw body for HMAC. The global JSON parser already consumed and
    // parsed req.body, so we reconstruct from the parsed copy. For a
    // strictly correct signature check we'd want express.raw() on
    // this route — see CarrierWebhooksController for the same nuance.
    // In practice GReminders signs UTF-8 JSON produced from the event,
    // which JSON.stringify reproduces exactly.
    const rawBody =
      (req as Request & { rawBody?: Buffer }).rawBody
      ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const sig = headerVal(req, 'x-greminders-signature');
    const ts = headerVal(req, 'x-greminders-request-timestamp');

    // Signature format: HMAC-SHA256(`<timestamp>:<body>`, webhook_secret).
    // The timestamp header is required — the signing string embeds it to
    // prevent replays of captured-but-unmodified webhooks.
    const signatureOk = await this.greminders.verifySignature(rawBody, sig, ts);
    if (!signatureOk) {
      throw new BadRequestException('Invalid GReminders webhook signature');
    }

    const envelope = (req.body ?? {}) as Partial<GremindersWebhookEnvelope>;
    if (!envelope || !envelope.data) {
      // Return 200 so GReminders doesn't retry a garbage payload; log
      // it as received-but-ignored.
      return { received: true, ignored: 'missing envelope/data' };
    }

    const result = await this.greminders.ingest(envelope as GremindersWebhookEnvelope);
    return {
      received: true,
      change_type: envelope.change_type ?? 'unknown',
      ...result,
    };
  }
}

function headerVal(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0) return v[0];
  return undefined;
}
