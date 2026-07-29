import type { Logging } from 'homebridge'
import type { ZodType } from 'zod'
import type { NeoAuth } from './auth.js'
import {
  AccountSchema,
  AcSystemsSchema,
  CommandResponseSchema,
  ConnectionDetailsSchema,
  StatusResponseSchema,
} from './schemas.js'

/** A handled API/transport failure. Callers degrade to cached state rather than crash. */
export class NeoApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NeoApiError'
  }
}

export interface NeoRestOptions {
  baseUrl: string
  auth: NeoAuth
  log: Logging
  fetchImpl?: typeof fetch
  retryDelayMs?: number
  /**
   * Per-attempt fetch timeout. Node's fetch has no default — a half-open connection would
   * otherwise hang forever and never let the retry budget engage.
   */
  timeoutMs?: number
}

const MAX_ATTEMPTS = 3
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Bounds for honouring a 429's Retry-After: cap the wait and the number of retries so a
 * hostile/broken server (e.g. `Retry-After: 86400`) cannot park the plugin. Worst case:
 * MAX_429_RETRIES * MAX_RETRY_AFTER_MS = 3 * 60s = 180s.
 */
const MAX_429_RETRIES = 3
const MAX_RETRY_AFTER_MS = 60_000

/**
 * Parses `Retry-After` as either delta-seconds or an HTTP-date, capped at `MAX_RETRY_AFTER_MS`.
 * Falls back to `fallbackMs` (also capped) when absent or unparseable.
 */
export function parseRetryAfterMs(header: string | null, fallbackMs: number): number {
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)

    const dateMs = Date.parse(header)
    if (!Number.isNaN(dateMs))
      return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RETRY_AFTER_MS)
  }
  return Math.min(fallbackMs, MAX_RETRY_AFTER_MS)
}

export class NeoRest {
  private readonly fetchImpl: typeof fetch
  private readonly retryDelayMs: number
  private readonly timeoutMs: number

  constructor(private readonly opts: NeoRestOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.retryDelayMs = opts.retryDelayMs ?? 3000
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async getSystems() {
    return this.request('api/v0/client/ac-systems?includeNeo=true', AcSystemsSchema)
  }

  async getAccount() {
    return this.request('api/v0/client/account', AccountSchema)
  }

  async getConnectionDetails() {
    return this.request('api/v0/messaging/connection/details', ConnectionDetailsSchema)
  }

  async getStatus(serial: string) {
    return this.request(
      `api/v0/client/ac-systems/status/latest?serial=${encodeURIComponent(serial)}`,
      StatusResponseSchema,
    )
  }

  async sendCommand(serial: string, command: object) {
    return this.request(
      `api/v0/client/ac-systems/cmds/send?serial=${encodeURIComponent(serial)}`,
      CommandResponseSchema,
      { method: 'POST', body: JSON.stringify(command) },
    )
  }

  private async request<T>(
    path: string,
    schema: ZodType<T>,
    init: { method?: string, body?: string } = {},
  ): Promise<T> {
    const url = `${this.opts.baseUrl}/${path.replace(/^\//, '')}`
    let refreshed = false
    let retries429 = 0

    // `attempt` only tracks the 5xx retry budget. A 401 refresh-and-retry, and a 429
    // rate-limit wait (tracked separately via `retries429`), do not consume it, so either
    // landing on the final 5xx attempt still gets its own retry.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Auth failures (e.g. a revoked grant) are not transport failures — let them
      // propagate as themselves so callers can tell "cloud unreachable" from "re-link account".
      const token = await this.opts.auth.getAccessToken()

      let res: Response
      try {
        res = await this.fetchImpl(url, {
          method: init.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: init.body,
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      }
      catch (error) {
        // Network-level failure: log and let the caller serve cached state.
        throw new NeoApiError(`Cannot reach the ActronAir cloud: ${(error as Error).message}`)
      }

      if (res.status === 200)
        return this.parseBody(res, schema, path)

      // One refresh-and-retry. A second 401 means the grant is gone, not a stale token.
      if (res.status === 401 && !refreshed) {
        refreshed = true
        this.opts.auth.invalidate()
        attempt-- // don't spend a 5xx-retry attempt on the 401 refresh
        continue
      }

      // The Neo cloud rate-limits at ~20 req/min and returns 429 with Retry-After. Honour
      // it (bounded), separately from the 5xx budget above.
      if (res.status === 429 && retries429 < MAX_429_RETRIES) {
        retries429++
        const delay = parseRetryAfterMs(res.headers.get('Retry-After'), this.retryDelayMs)
        this.opts.log.debug(`ActronAir cloud rate-limited (429), retrying in ${delay}ms (${retries429}/${MAX_429_RETRIES})`)
        await new Promise(r => setTimeout(r, delay))
        attempt-- // don't spend a 5xx-retry attempt on a 429 wait
        continue
      }

      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        this.opts.log.debug(`ActronAir cloud returned ${res.status}, retrying (${attempt}/${MAX_ATTEMPTS})`)
        await new Promise(r => setTimeout(r, this.retryDelayMs))
        continue
      }

      throw new NeoApiError(`ActronAir cloud request failed (HTTP ${res.status}) for ${path}`)
    }

    throw new NeoApiError(`ActronAir cloud request failed after ${MAX_ATTEMPTS} attempts for ${path}`)
  }

  /** Parse and validate a 200 body. A raw SyntaxError or ZodError must never escape `request()`. */
  private async parseBody<T>(res: Response, schema: ZodType<T>, path: string): Promise<T> {
    let json: unknown
    try {
      json = await res.json()
    }
    catch (error) {
      throw new NeoApiError(`ActronAir cloud returned an unparseable response for ${path}: ${(error as Error).message}`)
    }

    const result = schema.safeParse(json)
    if (!result.success) {
      const issues = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      throw new NeoApiError(`ActronAir cloud response failed validation for ${path}: ${issues}`)
    }
    return result.data
  }
}
