import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NeoMqtt } from '../src/neo/mqtt.js'
import { StatusResponseSchema } from '../src/neo/schemas.js'
import { NeoState } from '../src/neo/state.js'

const restStatus = StatusResponseSchema.parse(JSON.parse(readFileSync('test/fixtures/rest-status.json', 'utf8')))
const fullStatusPush = JSON.parse(readFileSync('test/fixtures/full-status.json', 'utf8'))
const statusChangePush = JSON.parse(readFileSync('test/fixtures/status-change.json', 'utf8'))

const SERIAL = '22h09780'
const CONNECTION_DETAILS = { Endpoint: '203.0.113.10', Port: 8883, Protocol: 'TLS', UserId: 'user-1' }

const logMocks = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}
const log = logMocks as never

/** Minimal fake mqtt.Client: enough surface for NeoMqtt (on/subscribe/end/removeAllListeners). */
class FakeClient extends EventEmitter {
  subscribed: string[] = []
  ended = false
  subscribe(topics: string[], _opts: unknown, cb?: (err?: Error) => void): void {
    this.subscribed.push(...topics)
    cb?.()
  }

  end(): void {
    this.ended = true
  }
}

function makeConnectImpl(clients: FakeClient[] = []) {
  const calls: Array<{ url: string, opts: Record<string, unknown> }> = []
  const impl = vi.fn((url: string, opts: Record<string, unknown>) => {
    calls.push({ url, opts })
    const client = new FakeClient()
    clients.push(client)
    return client
  })
  return { impl, calls, clients }
}

function buildRest(getStatusImpl?: () => Promise<typeof restStatus>) {
  return {
    getConnectionDetails: vi.fn(async () => CONNECTION_DETAILS),
    getStatus: vi.fn(getStatusImpl ?? (async () => restStatus)),
  }
}

function buildAuth(tokenImpl?: () => Promise<string>) {
  return { getAccessToken: vi.fn(tokenImpl ?? (async () => 'token-1')), invalidate: vi.fn() }
}

describe('neoMqtt', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('applies a full-status push by replacing state', async () => {
    const state = new NeoState()
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state, serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    const client = clients[0]
    client.emit('connect')
    await vi.advanceTimersByTimeAsync(0)
    rest.getStatus.mockClear()

    const base = `actron-cloud/${CONNECTION_DETAILS.UserId}/neo/${SERIAL.toLowerCase()}/mwc`
    client.emit('message', `${base}/full-status`, Buffer.from(JSON.stringify(fullStatusPush)))

    expect(state.ready).toBe(true)
    expect(state.get('UserAirconSettings.Mode')).toBe(fullStatusPush.event.UserAirconSettings.Mode)
    // A full-status push must not itself trigger a REST resync.
    expect(rest.getStatus).not.toHaveBeenCalled()
  })

  it('applies a status-change delta', async () => {
    const state = new NeoState()
    state.replace(restStatus.lastKnownState)
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state, serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    const client = clients[0]
    client.emit('connect')
    await vi.advanceTimersByTimeAsync(0)
    rest.getStatus.mockClear()

    const base = `actron-cloud/${CONNECTION_DETAILS.UserId}/neo/${SERIAL.toLowerCase()}/mwc`
    client.emit('message', `${base}/status-change`, Buffer.from(JSON.stringify(statusChangePush)))

    expect(state.get('UserAirconSettings.TemperatureSetpoint_Cool_oC')).toBe(22.5)
    expect(rest.getStatus).not.toHaveBeenCalled()
  })

  it('does not resync for an unknown field the plugin does not read (normal broker traffic)', async () => {
    const state = new NeoState()
    state.replace(restStatus.lastKnownState)
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state, serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    const client = clients[0]
    client.emit('connect')
    await vi.advanceTimersByTimeAsync(0)
    rest.getStatus.mockClear()

    const base = `actron-cloud/${CONNECTION_DETAILS.UserId}/neo/${SERIAL.toLowerCase()}/mwc`
    client.emit('message', `${base}/status-change`, Buffer.from(JSON.stringify({
      event: { 'type': 'status-change-broadcast', 'RemoteZoneInfo[0].ZonePosition': 50 },
    })))
    await vi.advanceTimersByTimeAsync(0)

    expect(rest.getStatus).not.toHaveBeenCalled()
  })

  it('triggers a REST resync when a status-change delta has an invalid value on a known field', async () => {
    const state = new NeoState()
    state.replace(restStatus.lastKnownState)
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state, serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    const client = clients[0]
    client.emit('connect')
    await vi.advanceTimersByTimeAsync(0)
    rest.getStatus.mockClear()

    const base = `actron-cloud/${CONNECTION_DETAILS.UserId}/neo/${SERIAL.toLowerCase()}/mwc`
    client.emit('message', `${base}/status-change`, Buffer.from(JSON.stringify({
      event: { 'type': 'status-change-broadcast', 'UserAirconSettings.isOn': 'not-a-boolean' },
    })))
    await vi.advanceTimersByTimeAsync(0)

    expect(rest.getStatus).toHaveBeenCalledTimes(1)
  })

  it('resyncs via REST on every (re)connect', async () => {
    const state = new NeoState()
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state, serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    clients[0].emit('connect')
    await vi.advanceTimersByTimeAsync(0)

    expect(rest.getStatus).toHaveBeenCalledTimes(1)
    expect(state.ready).toBe(true)
  })

  it('reconnects with exponential backoff (0.5s, 1s, 2s, ...) that actually caps at 60s, resetting after a success', async () => {
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state: new NeoState(), serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    expect(impl).toHaveBeenCalledTimes(1)

    // 500 -> 1000 -> 2000 -> 4000 -> 8000 -> 16000 -> 32000 -> 60000(capped) -> 60000(stays capped)
    const expectedDelays = [500, 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]
    for (const [i, delay] of expectedDelays.entries()) {
      clients[i].emit('close') // failed attempt
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(impl).toHaveBeenCalledTimes(i + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(impl).toHaveBeenCalledTimes(i + 2)
    }

    // Backoff is now sitting at the 60s cap. A success resets it back to 0.5s for next time.
    const last = clients.length - 1
    const totalBefore = clients.length
    clients[last].emit('connect')
    await vi.advanceTimersByTimeAsync(0)
    clients[last].emit('close')
    await vi.advanceTimersByTimeAsync(499)
    expect(impl).toHaveBeenCalledTimes(totalBefore)
    await vi.advanceTimersByTimeAsync(1)
    expect(impl).toHaveBeenCalledTimes(totalBefore + 1)

    mqtt.stop()
  })

  it('reconnects after a CONNACK auth rejection even though mqtt.js never emits close for it', async () => {
    const auth = buildAuth()
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: auth as never, state: new NeoState(), serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    expect(impl).toHaveBeenCalledTimes(1)
    auth.getAccessToken.mockClear()

    // mqtt.js's handleConnack only calls _cleanUp (which is what fires 'close') when
    // `reconnectOnConnackError` is true — which we deliberately leave at its default `false`
    // (we own reconnect ourselves). A rejected CONNACK is therefore 'error' alone, never 'close'.
    const authError = Object.assign(new Error('Connection refused: Not authorized'), { code: 5 })
    clients[0].emit('error', authError)

    expect(mqtt.healthy).toBe(false)
    expect(clients[0].ended).toBe(true) // the half-open socket must not be left dangling
    expect(auth.invalidate).toHaveBeenCalledTimes(1) // don't trust the rejected cached token again
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/rejected by broker/i))

    await vi.advanceTimersByTimeAsync(500) // existing backoff carries the retry, no storm
    expect(impl).toHaveBeenCalledTimes(2)
    expect(auth.getAccessToken).toHaveBeenCalledTimes(1) // re-fetched for the retry

    mqtt.stop()
  })

  it('stop() during an in-flight connect (gated on broker discovery) never opens a socket', async () => {
    let resolveDetails: ((v: typeof CONNECTION_DETAILS) => void) | undefined
    const rest = {
      getConnectionDetails: vi.fn(() => new Promise<typeof CONNECTION_DETAILS>((resolve) => { resolveDetails = resolve })),
      getStatus: vi.fn(async () => restStatus),
    }
    const state = new NeoState()
    state.replace(restStatus.lastKnownState)
    const { impl } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state, serial: SERIAL, log, connectImpl: impl as never })

    const starting = mqtt.start()
    mqtt.stop()
    resolveDetails!(CONNECTION_DETAILS)
    await starting

    expect(impl).not.toHaveBeenCalled() // never connects — stop() was checked after the await
    expect(mqtt.healthy).toBe(false)
    expect(rest.getStatus).not.toHaveBeenCalled() // no resync from an orphaned connect
  })

  it('stop() after the client exists but before it connects leaves the late connect event inert', async () => {
    const rest = buildRest()
    const state = new NeoState()
    state.replace(restStatus.lastKnownState)
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state, serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    expect(clients).toHaveLength(1)

    mqtt.stop()
    clients[0].emit('connect') // the orphan connects late; must be a no-op
    await vi.advanceTimersByTimeAsync(0)

    expect(mqtt.healthy).toBe(false)
    expect(rest.getStatus).not.toHaveBeenCalled()
  })

  it('coalesces concurrent resync triggers (a burst of bad deltas) onto one in-flight REST call', async () => {
    const state = new NeoState()
    state.replace(restStatus.lastKnownState)
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state, serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    const client = clients[0]
    client.emit('connect')
    await vi.advanceTimersByTimeAsync(0) // let the connect-triggered resync finish
    rest.getStatus.mockClear()

    let resolveStatus: (() => void) | undefined
    rest.getStatus.mockImplementation(() => new Promise((resolve) => {
      resolveStatus = () => resolve(restStatus)
    }))

    const base = `actron-cloud/${CONNECTION_DETAILS.UserId}/neo/${SERIAL.toLowerCase()}/mwc`
    for (let i = 0; i < 50; i++) {
      client.emit('message', `${base}/status-change`, Buffer.from(JSON.stringify({
        event: { 'type': 'status-change-broadcast', 'UserAirconSettings.isOn': 'not-a-boolean' },
      })))
    }
    // All 50 rejected deltas fired synchronously above must share the one in-flight call.
    expect(rest.getStatus).toHaveBeenCalledTimes(1)

    resolveStatus!()
    await vi.advanceTimersByTimeAsync(0)
    expect(rest.getStatus).toHaveBeenCalledTimes(1)
  })

  it('never throws when broker discovery fails, and keeps retrying', async () => {
    const rest = {
      getConnectionDetails: vi.fn(async () => { throw new Error('cloud down') }),
      getStatus: vi.fn(async () => restStatus),
    }
    const { impl } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state: new NeoState(), serial: SERIAL, log, connectImpl: impl as never })

    await expect(mqtt.start()).resolves.toBeUndefined()
    expect(impl).not.toHaveBeenCalled()
    expect(mqtt.healthy).toBe(false)

    await vi.advanceTimersByTimeAsync(500)
    expect(rest.getConnectionDetails).toHaveBeenCalledTimes(2)
    mqtt.stop()
  })

  it('the zone-wipe safeguard rejects a full-status push that reports zero zones after previously having some', async () => {
    const state = new NeoState()
    state.replace(restStatus.lastKnownState)
    const zonesBefore = state.get('RemoteZoneInfo')
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state, serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    const client = clients[0]
    client.emit('connect')
    await vi.advanceTimersByTimeAsync(0)

    const wiped = {
      event: { ...fullStatusPush.event, RemoteZoneInfo: fullStatusPush.event.RemoteZoneInfo.map((z: Record<string, unknown>) => ({ ...z, NV_Exists: false })) },
      wcFirmware: fullStatusPush.wcFirmware,
    }
    const base = `actron-cloud/${CONNECTION_DETAILS.UserId}/neo/${SERIAL.toLowerCase()}/mwc`
    client.emit('message', `${base}/full-status`, Buffer.from(JSON.stringify(wiped)))

    expect(state.get('RemoteZoneInfo')).toEqual(zonesBefore)
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/zero zones/i))
  })

  it('marks the heart-beat topic as liveness and goes stale after 180s of silence', async () => {
    const state = new NeoState()
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state, serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    const client = clients[0]
    client.emit('connect')
    await vi.advanceTimersByTimeAsync(0)
    expect(mqtt.healthy).toBe(true)

    await vi.advanceTimersByTimeAsync(179_000)
    expect(mqtt.healthy).toBe(true)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(mqtt.healthy).toBe(false)
  })

  it('re-fetches the access token on every connect attempt', async () => {
    let n = 0
    const auth = buildAuth(async () => `token-${++n}`)
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: auth as never, state: new NeoState(), serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    expect(impl.mock.calls[0][1].password).toBe('token-1')

    clients[0].emit('close')
    await vi.advanceTimersByTimeAsync(500)
    expect(impl.mock.calls[1][1].password).toBe('token-2')

    mqtt.stop()
  })

  it('uses a fresh client id and a clean session on every connect', async () => {
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state: new NeoState(), serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    clients[0].emit('close')
    await vi.advanceTimersByTimeAsync(500)

    const first = impl.mock.calls[0][1]
    const second = impl.mock.calls[1][1]
    expect(first.clean).toBe(true)
    expect(second.clean).toBe(true)
    expect(first.clientId).not.toBe(second.clientId)
    mqtt.stop()
  })

  it('stop() disconnects and clears timers', async () => {
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state: new NeoState(), serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    clients[0].emit('connect')
    await vi.advanceTimersByTimeAsync(0)

    mqtt.stop()
    expect(clients[0].ended).toBe(true)

    clients[0].emit('close')
    await vi.advanceTimersByTimeAsync(60_000)
    // stop() must prevent any further reconnect attempts.
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('resets the backoff on stop(), so a stop/start cycle does not inherit a stale 60s wait', async () => {
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state: new NeoState(), serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    // Fail a few times to grow the backoff well past its initial 0.5s.
    for (let i = 0; i < 4; i++) {
      clients[i].emit('close')
      await vi.advanceTimersByTimeAsync(1 << (i + 10)) // generously overshoots each growing delay
    }
    expect(impl.mock.calls.length).toBeGreaterThan(1)

    mqtt.stop()
    await mqtt.start()
    const clientAfterRestart = clients.at(-1)!
    clientAfterRestart.emit('close')
    const callsBeforeWait = impl.mock.calls.length
    await vi.advanceTimersByTimeAsync(499)
    expect(impl.mock.calls.length).toBe(callsBeforeWait)
    await vi.advanceTimersByTimeAsync(1)
    // Reconnected at 0.5s, not the ~4-8s the backoff would have reached without a reset.
    expect(impl.mock.calls.length).toBe(callsBeforeWait + 1)

    mqtt.stop()
  })
  it('warns on a dropped connection even when the socket reports a string errno code', async () => {
    // Node socket errors carry a *string* code ('ECONNRESET'), not an MQTT CONNACK number,
    // so this took the debug branch and marked the failure handled — silencing the warn that
    // 'close' would otherwise have logged. With push healthy the poll is 5 minutes wide, so
    // that warning is the only signal the user gets.
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state: new NeoState(), serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    clients[0].emit('connect')
    await vi.advanceTimersByTimeAsync(0)
    logMocks.warn.mockClear()

    clients[0].emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    clients[0].emit('close')

    expect(logMocks.warn).toHaveBeenCalledTimes(1)
    expect(logMocks.warn).toHaveBeenCalledWith(expect.stringMatching(/connection lost/i))

    mqtt.stop()
  })

  it('warns when a status-change path it ignores carries an object value', async () => {
    const state = new NeoState()
    state.replace(restStatus.lastKnownState)
    const rest = buildRest()
    const { impl, clients } = makeConnectImpl()
    const mqtt = new NeoMqtt({ rest: rest as never, auth: buildAuth() as never, state, serial: SERIAL, log, connectImpl: impl as never })

    await mqtt.start()
    clients[0].emit('connect')
    await vi.advanceTimersByTimeAsync(0)
    logMocks.warn.mockClear()

    const base = `actron-cloud/${CONNECTION_DETAILS.UserId}/neo/${SERIAL.toLowerCase()}/mwc`
    clients[0].emit('message', `${base}/status-change`, Buffer.from(JSON.stringify({
      event: { 'type': 'status-change-broadcast', 'SomeUnreadSubtree': { LiveTemp_oC: 21 }, 'UserAirconSettings.isOn': true },
    })))

    expect(logMocks.warn).toHaveBeenCalledWith(expect.stringMatching(/object-valued/i))

    mqtt.stop()
  })
})
