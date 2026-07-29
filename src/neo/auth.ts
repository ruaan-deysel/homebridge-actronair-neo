import type { Logging } from 'homebridge'
import { DeviceCodeSchema, TokenSchema } from './schemas.js'

/** Renew this far ahead of expiry so no request ever races an expiring token. */
const RENEW_MARGIN_MS = 15 * 60 * 1000

/**
 * Per-attempt fetch timeout — Node's fetch has no default, so a half-open connection
 * would otherwise hang forever.
 */
const DEFAULT_TIMEOUT_MS = 15_000

/** The grant is gone — the user must re-link. Never retried. */
export class NeoAuthRevokedError extends Error {
  constructor(detail: string) {
    super(`ActronAir account link is no longer valid (${detail}). Open the plugin settings and link your account again.`)
    this.name = 'NeoAuthRevokedError'
  }
}

export interface NeoAuthOptions {
  baseUrl: string
  clientId: string
  refreshToken?: string
  fetchImpl?: typeof fetch
  log: Logging
  timeoutMs?: number
}

export class NeoAuth {
  private accessToken?: string
  private expiresAt = 0
  private inFlight?: Promise<string>
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly opts: NeoAuthOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private get tokenUrl(): string {
    return `${this.opts.baseUrl}/api/v0/oauth/token`
  }

  private async postForm(body: Record<string, string>): Promise<{ status: number, json: unknown }> {
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, json }
  }

  /** Step 1 of the device-code flow. The Neo cloud takes only client_id + scope here. */
  async requestDeviceCode() {
    const { status, json } = await this.postForm({
      client_id: this.opts.clientId,
      scope: 'read write',
    })
    if (status !== 200)
      throw new Error(`Failed to request device code (HTTP ${status})`)
    return DeviceCodeSchema.parse(json)
  }

  /** Step 2: poll until the user approves, or the deadline passes. */
  async pollForToken(
    deviceCode: string,
    { intervalSeconds = 5, timeoutSeconds = 600 }: { intervalSeconds?: number, timeoutSeconds?: number } = {},
  ) {
    let interval = intervalSeconds
    const deadline = Date.now() + timeoutSeconds * 1000

    while (Date.now() < deadline) {
      const { status, json } = await this.postForm({
        client_id: this.opts.clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
      })

      if (status === 200)
        return TokenSchema.parse(json)

      const error = (json as { error?: string }).error
      if (error === 'slow_down')
        interval += 5
      else if (error !== 'authorization_pending')
        throw new Error(`Authorisation failed: ${error ?? `HTTP ${status}`}`)

      await new Promise(r => setTimeout(r, interval * 1000))
    }
    throw new Error('Timed out waiting for account authorisation')
  }

  /**
   * Current access token, minting or renewing as needed. Concurrent callers share one
   * in-flight refresh rather than stampeding the token endpoint.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - RENEW_MARGIN_MS)
      return this.accessToken

    this.inFlight ??= this.refresh().finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  /** Force the next getAccessToken() to mint a fresh token (used after a 401). */
  invalidate(): void {
    this.accessToken = undefined
    this.expiresAt = 0
  }

  private async refresh(): Promise<string> {
    if (!this.opts.refreshToken)
      throw new NeoAuthRevokedError('no refresh token configured')

    const { status, json } = await this.postForm({
      grant_type: 'refresh_token',
      refresh_token: this.opts.refreshToken,
      client_id: this.opts.clientId,
    })

    if (status === 400 || status === 401)
      throw new NeoAuthRevokedError((json as { error?: string }).error ?? `HTTP ${status}`)
    if (status !== 200)
      throw new Error(`Token refresh failed (HTTP ${status})`)

    const token = TokenSchema.parse(json)
    this.accessToken = token.access_token
    this.expiresAt = Date.now() + token.expires_in * 1000
    this.opts.log.debug(`Access token renewed, valid for ${Math.round(token.expires_in / 3600)}h`)
    return this.accessToken
  }
}
