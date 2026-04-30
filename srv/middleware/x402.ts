/**
 * Express middleware factory for x402 payment gating.
 *
 * Mount on a CAP service path to gate every request beneath it. The
 * `skipPaths` regex carves out things buyers MUST be able to fetch
 * without paying — `$metadata`, `$batch` previews, etc.
 *
 * Two pricing modes:
 *   1. `priceUnits`   — single price for everything under this mount
 *   2. `routePricing` — { 'EntityOrActionName': 'priceUnitsString' }, matched
 *                       by the last path segment (stripped of OData args).
 *
 * The 402 body is the canonical Masumi-spec shape. We append a parenthetical
 * machine-readable error code to the `error` string when the rejection is
 * NOT just "missing header" — wire-compat preserved (the field stays a
 * single string), buyer can grep for the code.
 */

import cds from '@sap/cds';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { buildPaymentRequirements } from '../x402/requirements';
import { process as processX402 } from '../x402/process';
import { Codes } from '../x402/errors';
import type { PaymentClaim } from '../x402/validate';

// Augment Express's Request so handlers downstream can read `req.payment`
// after the middleware accepts a payment.
declare module 'express-serve-static-core' {
  interface Request {
    payment?: PaymentClaim;
  }
}

const log = cds.log('x402');

export interface X402MiddlewareOptions {
  /** raw asset units, single price mode */
  priceUnits?: string | number;
  /** per-route prices */
  routePricing?: Record<string, string | number>;
  /** paths to exempt (default: /$metadata, /$batch, /, root) */
  skipPaths?: RegExp;
  /** shown in the 402 body */
  description?: string;
  /** audit tag for FeedReads */
  feedKind?: string;
}

function pickPriceUnits(req: Request, opts: X402MiddlewareOptions): string | null {
  if (opts.routePricing) {
    // Last URL segment, with OData function-args stripped:
    //   /odata/v4/price/getBestPrice(pair='ADA-USD') -> getBestPrice
    const segment = (req.path.split('/').pop() ?? '').split('(')[0]!;
    const price = opts.routePricing[segment];
    if (price != null) return String(price);
    if (opts.priceUnits != null) return String(opts.priceUnits);
    return null; // unmapped path under a routePricing config = NOT gated (pass through)
  }
  return opts.priceUnits != null ? String(opts.priceUnits) : null;
}

/** Build an Express middleware that gates requests behind x402 USDM payments. */
export function express(opts: X402MiddlewareOptions = {}): RequestHandler {
  if (opts.priceUnits == null && !opts.routePricing) {
    throw new Error('x402 middleware: priceUnits or routePricing is required');
  }
  const skipPaths = opts.skipPaths ?? /(^\/?$|\$metadata|\$batch|^\/?\?|^\/index)/i;

  return async function x402Middleware(req: Request, res: Response, next: NextFunction) {
    try {
      if (skipPaths.test(req.path)) return next();

      const priceUnits = pickPriceUnits(req, opts);
      if (priceUnits == null) return next();      // unmapped path = pass through

      const requirementsBody = buildPaymentRequirements({
        priceUnits,
        resource:    req.originalUrl ?? req.url,
        description: opts.description,
      });

      const xPaymentHeader = req.headers['x-payment'];
      const result = await processX402({
        xPaymentHeader,
        requirementsBody,
        feedKind:       opts.feedKind ?? 'aggregated',
        feedRef:        req.originalUrl,
      });

      if (result.kind === 'accepted') {
        res.setHeader('X-PAYMENT-RESPONSE', result.paymentResponseB64);
        req.payment = result.payment;
        return next();
      }

      // rejected | pending → 402
      const body: Record<string, unknown> = { ...result.requirementsBody };
      if (result.code && result.code !== Codes.MISSING_HEADER) {
        body.error = `${result.requirementsBody.error} (${result.code}): ${result.reason ?? ''}`.trim();
      }
      if (result.kind === 'pending') {
        body.pending     = true;
        body.transaction = result.txHash;
      }
      log.debug(`402 ${result.kind} ${result.code}: ${result.reason ?? ''}`);
      res.status(402).json(body);
    } catch (err) {
      // Fall through to Express's error handler with a descriptive 500.
      log.error('x402 middleware unhandled error:', (err as Error)?.stack ?? err);
      next(err);
    }
  };
}
