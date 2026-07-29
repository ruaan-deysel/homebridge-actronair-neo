import type { Logging } from 'homebridge'
import type { MqttClient } from 'mqtt'
import type { Buffer } from 'node:buffer'
import type { NeoAuth } from './auth.js'
import type { NeoRest } from './rest.js'
import type { StatusTree } from './schemas.js'
import type { NeoState } from './state.js'
import { randomUUID } from 'node:crypto'
import tls from 'node:tls'
import mqttPkg from 'mqtt'
import { SECTIGO_INTERMEDIATE_PEM } from './certs.js'
import { FullStatusPushSchema, StatusChangeSchema } from './schemas.js'

/** Covered by the broker's `*.actronair.com.au` wildcard cert; the broker itself is dialled by IP. */
const SNI = 'nimbus.actronair.com.au'

const MIN_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 60_000

/** No heart-beat message for this long means the push connection is not trustworthy, even if the socket looks open. */
const HEARTBEAT_STALE_MS = 180_000

export interface NeoMqttOptions {
  rest: NeoRest
  auth: NeoAuth
  state: NeoState
  serial: string
  log: Logging
  /** Test seam — the real value is `mqtt.connect`; tests inject a fake client factory. */
  connectImpl?: typeof mqttPkg.connect
  /** Fires whenever `healthy` transitions, so the caller (platform.ts) can re-time its poll loop immediately instead of waiting for the next scheduled tick. */
  onHealthChange?: (healthy: boolean) => void
}

/**
 * MQTT push transport. Overlays the REST poll loop, it never replaces it: every failure
 * here — discovery, TLS, auth, a malformed payload — is caught, logged and backed off,
 * never thrown. `platform.ts` decides how fast to keep polling based on `healthy`, driven by
 * `onHealthChange`.
 *
 * Client id / session: a fresh random id and `clean: true` on every connect. Session
 * resumption exists to redeliver QoS 1/2 messages missed while offline, but every message
 * here is either a snapshot or already covered by the REST resync on reconnect — so there is
 * no session worth resuming, and a persistent one just leaves orphans on the broker. A stable
 * id is also actively worse: brokers evict whichever client already holds it, so two processes
 * briefly overlapping (a container restart) would fight over the connection. A random id
 * cannot collide with itself.
 */
export class NeoMqtt {
  private readonly connectImpl: typeof mqttPkg.connect
  private client?: MqttClient
  private backoffMs = MIN_BACKOFF_MS
  private reconnectTimer?: NodeJS.Timeout
  private staleTimer?: NodeJS.Timeout
  private stopped = true
  private connected = false
  private isHealthy = false
  /** Coalesces concurrent resync triggers (repeated bad deltas, connect + a delta racing) onto one in-flight REST call. */
  private resyncInFlight?: Promise<void>

  constructor(private readonly opts: NeoMqttOptions) {
    this.connectImpl = opts.connectImpl ?? mqttPkg.connect
  }

  get healthy(): boolean {
    return this.isHealthy
  }

  /** Connect after discovery. Never throws — a failure here must never block startup or polling. */
  async start(): Promise<void> {
    this.stopped = false
    await this.attemptConnect()
  }

  /** Clean shutdown: stop reconnecting and close the socket. */
  stop(): void {
    this.stopped = true
    this.backoffMs = MIN_BACKOFF_MS
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.staleTimer)
    this.setHealthy(false)
    this.endClient()
  }

  private endClient(): void {
    const client = this.client
    this.client = undefined
    this.connected = false
    if (!client)
      return
    client.removeAllListeners()
    client.end(true)
  }

  private setHealthy(next: boolean): void {
    if (this.isHealthy === next)
      return
    this.isHealthy = next
    this.opts.onHealthChange?.(next)
  }

  /** Reschedules the "no heart-beat for 180s" staleness check from now. */
  private touchHeartbeat(): void {
    this.setHealthy(true)
    clearTimeout(this.staleTimer)
    this.staleTimer = setTimeout(() => this.setHealthy(false), HEARTBEAT_STALE_MS)
  }

  private async attemptConnect(): Promise<void> {
    if (this.stopped)
      return
    // Defensive: attemptConnect() should never run with a live client already attached, but
    // clean up rather than leak a socket if it somehow does (e.g. a future refactor).
    this.endClient()

    let endpoint: { Endpoint: string, Port: number, UserId: string }
    let token: string
    try {
      [endpoint, token] = await Promise.all([
        this.opts.rest.getConnectionDetails(),
        this.opts.auth.getAccessToken(),
      ])
    }
    catch (error) {
      this.opts.log.debug(`MQTT push unavailable (broker discovery/auth failed), keeping to REST polling: ${(error as Error).message}`)
      this.scheduleReconnect()
      return
    }

    // stop() may have been called while the awaits above were in flight — don't open a
    // socket nobody will hold, and don't let it come back to life after shutdown.
    if (this.stopped)
      return

    let client: MqttClient
    try {
      client = this.connectImpl(`mqtts://${endpoint.Endpoint}:${endpoint.Port}`, {
        username: '',
        password: token,
        clientId: `homebridge-actronair-neo-${randomUUID()}`,
        clean: true,
        keepalive: 60,
        reconnectPeriod: 0, // we own reconnect/backoff below
        protocolVersion: 4,
        // `ca` REPLACES Node's trust store, so append the missing intermediate to the
        // built-in roots rather than handing over the intermediate alone — see certs.ts.
        ca: [...tls.rootCertificates, SECTIGO_INTERMEDIATE_PEM],
        servername: SNI,
        rejectUnauthorized: true,
      })
    }
    catch (error) {
      this.opts.log.debug(`MQTT connect failed, keeping to REST polling: ${(error as Error).message}`)
      this.scheduleReconnect()
      return
    }

    if (this.stopped) {
      client.removeAllListeners()
      client.end(true)
      return
    }

    this.client = client
    this.wire(client, endpoint.UserId)
  }

  private wire(client: MqttClient, userId: string): void {
    const base = `actron-cloud/${userId}/neo/${this.opts.serial.toLowerCase()}/mwc`
    const topics = [`${base}/full-status`, `${base}/status-change`, `${base}/heart-beat`, `${base}/cmd-response/+/+`]

    // A connect-time CONNACK rejection (bad/expired token, banned client, etc) and a
    // post-connect socket drop both need the same cleanup + reconnect. mqtt.js only emits
    // 'close' for the latter — with `reconnectOnConnackError` left at its default `false`,
    // a rejected CONNACK emits 'error' alone and otherwise leaves the half-open socket and
    // the reconnect timer untouched forever. `failureHandled` makes both events converge on
    // one path exactly once per connection attempt, regardless of which fires (or if both do).
    let failureHandled = false
    const handleFailure = (): void => {
      if (failureHandled)
        return
      failureHandled = true
      // Warn here rather than in the 'close' handler: a socket error arrives as a *string*
      // errno ('ECONNRESET'), takes the 'error' branch below, and marks the failure handled
      // before 'close' fires — which would otherwise skip the warn for exactly the drops that
      // aren't a clean FIN. Same event, one log level, driven by whether we were connected.
      if (this.connected)
        this.opts.log.warn('MQTT push connection lost, falling back to polling until it recovers')
      if (this.client === client) {
        this.endClient()
      }
      else {
        // Stale closure from a superseded attempt — clean it up without touching this.client.
        client.removeAllListeners()
        client.end(true)
      }
      clearTimeout(this.staleTimer)
      this.setHealthy(false)
      if (this.stopped)
        return
      this.scheduleReconnect()
    }

    client.on('connect', () => {
      this.connected = true
      this.backoffMs = MIN_BACKOFF_MS
      this.touchHeartbeat()
      this.opts.log.info('MQTT push connected')
      client.subscribe(topics, { qos: 0 }, (err) => {
        if (err)
          this.opts.log.debug(`MQTT subscribe failed: ${err.message}`)
      })
      // Always resync on (re)connect: any state change missed while disconnected must not
      // silently persist.
      void this.resyncFromRest()
    })

    client.on('message', (topic, payload) => {
      try {
        this.handleMessage(topic, payload, base)
      }
      catch (error) {
        this.opts.log.debug(`MQTT message handling failed: ${(error as Error).message}`)
      }
    })

    client.on('error', (error: Error & { code?: number }) => {
      // A numeric `code` here is an MQTT CONNACK reason code (see mqtt.js's ReasonCodes) —
      // "Not authorized" / "Bad username or password" / etc — not a plain socket errno. The
      // access token IS the MQTT password and does expire, so this is routine and expected
      // to recur; it is not routine *noise* the way a transient ECONNREFUSED is, so it gets
      // `warn` rather than `debug`, and forces the next attempt to fetch a genuinely fresh
      // token rather than trusting the (apparently rejected) cached one.
      if (typeof error.code === 'number') {
        this.opts.log.warn(`MQTT push rejected by broker: ${error.message} — retrying with a fresh token`)
        this.opts.auth.invalidate()
      }
      else {
        this.opts.log.debug(`MQTT error: ${error.message}`)
      }
      handleFailure()
    })

    client.on('close', () => handleFailure())
  }

  private handleMessage(topic: string, payload: Buffer, base: string): void {
    if (topic === `${base}/heart-beat`) {
      this.touchHeartbeat()
      return
    }

    let json: unknown
    try {
      json = JSON.parse(payload.toString())
    }
    catch {
      this.opts.log.debug(`MQTT payload on ${topic} was not valid JSON`)
      return
    }

    if (topic === `${base}/full-status`) {
      const parsed = FullStatusPushSchema.safeParse(json)
      if (!parsed.success) {
        this.opts.log.debug(`MQTT full-status failed validation, resyncing via REST: ${parsed.error.issues.map(i => i.message).join('; ')}`)
        void this.resyncFromRest()
        return
      }
      this.applyReplace(parsed.data.event, 'full-status push')
      return
    }

    if (topic === `${base}/status-change`) {
      const parsed = StatusChangeSchema.safeParse(json)
      if (!parsed.success) {
        this.opts.log.debug(`MQTT status-change failed validation, resyncing via REST: ${parsed.error.issues.map(i => i.message).join('; ')}`)
        void this.resyncFromRest()
        return
      }
      const result = this.opts.state.applyDelta(parsed.data.event)
      if (result.ignored.length)
        this.opts.log.debug(`MQTT status-change ignored unread fields: ${result.ignored.join(', ')}`)
      // Ignoring a leaf the plugin doesn't read is normal traffic; ignoring an *object* means
      // a whole subtree went unapplied, which could hide fields we do read nested inside it.
      // Never seen in captured traffic (deltas are leaf-only), so the contract is unchanged —
      // but if it ever happens it must not be invisible.
      const structural = result.ignored.filter(path => typeof parsed.data.event[path] === 'object' && parsed.data.event[path] !== null)
      if (structural.length)
        this.opts.log.warn(`MQTT status-change ignored object-valued fields (${structural.join(', ')}); nested values this plugin reads may be stale until the next poll`)
      if (!result.ok) {
        for (const r of result.rejected)
          this.opts.log.debug(`MQTT status-change rejected ${r.path}: ${r.reason}`)
        void this.resyncFromRest()
      }
    }
    // cmd-response/+/+ is subscribed for completeness (per the observed topic set) but not
    // consumed — command confirmation already happens via CommandQueue's REST re-read.
  }

  /**
   * Zone-wipe safeguard: a full-status push or resync that reports zero zones where we
   * previously had some is treated as suspect (a transient/partial payload) rather than
   * applied, so a bad message can't wipe every zone accessory's state.
   *
   * Deliberately NOT applied to the plain REST poll in platform.ts, which calls
   * `state.replace()` directly — that's what keeps this safeguard itself from being able to
   * wedge state forever on a device that has genuinely lost every zone (deleted them, a
   * factory reset, etc): the poll path always wins eventually, at most one poll interval
   * later. Push only ever gets to *delay* a real zero-zones update, never block it.
   */
  private applyReplace(next: StatusTree, source: string): void {
    const previous = this.opts.state.snapshot()
    const previousZones = previous?.RemoteZoneInfo.filter(z => z.NV_Exists).length ?? 0
    const nextZones = next.RemoteZoneInfo.filter(z => z.NV_Exists).length
    if (previousZones > 0 && nextZones === 0) {
      this.opts.log.warn(`MQTT ${source} reported zero zones (previously ${previousZones}) — treating as suspect and keeping the last known state`)
      return
    }
    this.opts.state.replace(next)
  }

  /** Coalesces concurrent callers (a burst of bad deltas, or a delta racing a connect) onto one in-flight REST call, rather than one request per trigger against a cloud that rate-limits at ~20 req/min. */
  private resyncFromRest(): Promise<void> {
    this.resyncInFlight ??= this.doResync().finally(() => {
      this.resyncInFlight = undefined
    })
    return this.resyncInFlight
  }

  private async doResync(): Promise<void> {
    try {
      const status = await this.opts.rest.getStatus(this.opts.serial)
      this.opts.state.setCloudConnected(status.isOnline)
      this.applyReplace(status.lastKnownState, 'resync')
    }
    catch (error) {
      this.opts.log.debug(`MQTT-triggered REST resync failed: ${(error as Error).message}`)
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped)
      return
    clearTimeout(this.reconnectTimer)
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
    this.reconnectTimer = setTimeout(() => void this.attemptConnect(), delay)
  }
}
