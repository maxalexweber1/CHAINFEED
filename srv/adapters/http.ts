/**
 * Shared HTTP helper for DEX adapters. Hard timeout, structured error.
 * No retries — the cache layer's stale-while-revalidate absorbs transient
 * failures, and every retry inside an adapter doubles upstream pressure.
 */

const DEFAULT_TIMEOUT_MS = 5_000;

export interface HttpOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? `HTTP ${status}: ${String(body).slice(0, 120)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/** GET a JSON URL with a hard timeout. */
export async function getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...(opts.headers ?? {}) },
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new HttpError(res.status, body);
    }
    return await res.json() as T;
  } finally {
    clearTimeout(t);
  }
}

/** POST JSON, expect JSON back. */
export async function postJson<T = unknown>(
  url: string,
  payload: unknown,
  opts: HttpOptions = {},
): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new HttpError(res.status, body);
    }
    return await res.json() as T;
  } finally {
    clearTimeout(t);
  }
}
