import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils'

const BASE = 'https://nimbus.actronair.com.au'
const DEFAULT_CLIENT_ID = 'home_assistant'
/**
 * Node's fetch has no default timeout — a half-open connection would otherwise hang the
 * settings UI forever.
 */
const TIMEOUT_MS = 10_000

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super()
    this.onRequest('/device-code', ({ clientId }) => this.requestDeviceCode(clientId))
    this.onRequest('/poll-token', p => this.pollToken(p))
    this.onRequest('/account', p => this.account(p))
    this.onRequest('/session', p => this.session(p))
    this.ready()
  }

  async form(body) {
    const res = await fetch(`${BASE}/api/v0/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return { status: res.status, json: await res.json().catch(() => ({})) }
  }

  async requestDeviceCode(clientId = DEFAULT_CLIENT_ID) {
    const { status, json } = await this.form({ client_id: clientId, scope: 'read write' })
    if (status !== 200)
      throw new Error(`Could not start account linking (HTTP ${status})`)
    return json
  }

  /** One poll attempt — the browser drives the loop so it can show progress. */
  async pollToken({ clientId = DEFAULT_CLIENT_ID, deviceCode }) {
    const { status, json } = await this.form({
      client_id: clientId,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
    })
    if (status === 200)
      return { state: 'authorised', refreshToken: json.refresh_token, accessToken: json.access_token }
    if (json.error === 'authorization_pending' || json.error === 'slow_down')
      return { state: 'pending', slowDown: json.error === 'slow_down' }
    return { state: 'failed', error: json.error ?? `HTTP ${status}` }
  }

  /**
   * Exchange the stored refresh token for a fresh access token, so a reopened
   * settings page can show who's linked without ever persisting the access token.
   * The API does not rotate the refresh token on this call — do not expect one back.
   */
  async session({ clientId = DEFAULT_CLIENT_ID, refreshToken }) {
    const { status, json } = await this.form({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
    if (status !== 200)
      return { state: 'invalid' }
    return { state: 'ok', accessToken: json.access_token }
  }

  /**
   * GET returning JSON, with the status actually checked. Without the `res.ok` guard a
   * 429/5xx (or an HTML error page) parses to something without `_embedded`, which the
   * caller's `?? []` then renders as a perfectly calm "linked, zero systems" — a transient
   * cloud failure made indistinguishable from an empty account, on the first screen the
   * user sees after linking.
   */
  async getJson(url, headers, signal) {
    const res = await fetch(url, { headers, signal })
    if (!res.ok)
      throw new Error(`Could not reach the ActronAir cloud (HTTP ${res.status}). Please try again.`)
    return res.json().catch(() => {
      throw new Error('The ActronAir cloud returned an unreadable response. Please try again.')
    })
  }

  /** Confirm which account was linked and list its systems, so the user can sanity-check. */
  async account({ accessToken }) {
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    const [account, systems] = await Promise.all([
      this.getJson(`${BASE}/api/v0/client/account`, headers, signal),
      this.getJson(`${BASE}/api/v0/client/ac-systems?includeNeo=true`, headers, signal),
    ])
    return {
      email: account.email,
      systems: (systems?._embedded?.['ac-system'] ?? []).map(s => ({ serial: s.serial, name: s.description })),
    }
  }
}

export default new UiServer()
