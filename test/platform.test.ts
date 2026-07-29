import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZoneAccessory } from '../src/accessories/zone.js'
import { NeoAuthRevokedError } from '../src/neo/auth.js'
import { NeoMqtt } from '../src/neo/mqtt.js'
import { NeoCommand } from '../src/neo/types.js'
import { ActronAirNeoPlatform, sanitizeAccessoryName } from '../src/platform.js'

vi.mock('../src/accessories/zone.js', () => ({
  ZoneAccessory: vi.fn(),
}))

vi.mock('../src/neo/mqtt.js', () => ({
  NeoMqtt: vi.fn().mockImplementation(function NeoMqtt(this: Record<string, unknown>, opts: { onHealthChange?: (healthy: boolean) => void }) {
    this.start = vi.fn().mockResolvedValue(undefined)
    this.stop = vi.fn()
    this.healthy = false
    this.opts = opts
  }),
}))

const restStatus = JSON.parse(readFileSync('test/fixtures/rest-status.json', 'utf8'))
const systems = JSON.parse(readFileSync('test/fixtures/ac-systems.json', 'utf8'))

function makeApi() {
  const handlers: Record<string, () => void> = {}
  return {
    hap: { Service: {}, Characteristic: {}, uuid: { generate: (s: string) => `uuid-${s}` }, HapStatusError: class {} },
    user: { storagePath: () => '/tmp/hb' },
    on: (event: string, cb: () => void) => { handlers[event] = cb },
    platformAccessory: class { constructor(public displayName: string, public UUID: string) { this.context = {} } context: Record<string, unknown> },
    registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
    handlers,
  } as never
}

const log = Object.assign(vi.fn(), {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}) as never

afterEach(() => {
  vi.mocked(ZoneAccessory).mockReset()
  vi.mocked(NeoMqtt).mockClear()
  vi.useRealTimers()
})

describe('actronAirNeoPlatform', () => {
  it('does not start when no account is linked', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x' } as never, api)
    await p.discoverDevices()
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/link your account/i))
  })

  it('registers master, mode switches and one accessory per existing zone', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    const zoneCount = restStatus.lastKnownState.RemoteZoneInfo.filter((z: { NV_Exists?: boolean }) => z.NV_Exists).length
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1 + 3 + 1 + zoneCount)
  })

  it('never unregisters when discovery fails', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.configureAccessory({ UUID: 'uuid-stale', displayName: 'Old Zone', context: {} } as never)
    p.injectForTest({
      getSystems: async () => { throw new Error('cloud down') },
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
  })

  it('unregisters a genuinely stale cached accessory after a successful discovery', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    const stale = { UUID: 'uuid-not-in-discovery', displayName: 'Old Zone', context: {} } as never
    p.configureAccessory(stale)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1)
    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [stale],
    )
  })

  it('does not duplicate accessories on a second discovery', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()
    const firstRunCalls = api.registerPlatformAccessories.mock.calls.length

    await p.discoverDevices()

    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(firstRunCalls)
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
  })

  it('logs and continues when one accessory fails to construct, so the others still register', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    vi.mocked(ZoneAccessory).mockImplementationOnce(() => {
      throw new Error('bad characteristic range')
    })

    await expect(p.discoverDevices()).resolves.toBeUndefined()

    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/failed to initialize accessory/i))
    const zoneCount = restStatus.lastKnownState.RemoteZoneInfo.filter((z: { NV_Exists?: boolean }) => z.NV_Exists).length
    // The broken accessory is still registered (it exists, just uninitialized); the point is
    // that its failure does not stop the other 1 + 3 + 1 + (zoneCount - 1) siblings from registering.
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1 + 3 + 1 + zoneCount)
  })

  it('logs and skips when two discovered devices collide on the same identity', async () => {
    const api = makeApi()
    api.hap.uuid.generate = () => 'uuid-collision'
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/same identity/i))
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1)
  })

  it('does not register an outdoor temperature accessory when the reading is unusable (real fixture: sentinel + sensor error)', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    const zoneCount = restStatus.lastKnownState.RemoteZoneInfo.filter((z: { NV_Exists?: boolean }) => z.NV_Exists).length
    // 1 master + 3 mode switches + zones, no outdoor sensor — matches the owner's real hardware.
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1 + 3 + 1 + zoneCount)
  })

  it('registers an outdoor temperature accessory when the reading is valid', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    const validOutdoorStatus = {
      ...restStatus,
      lastKnownState: {
        ...restStatus.lastKnownState,
        MasterInfo: { ...restStatus.lastKnownState.MasterInfo, LiveOutdoorTemp_oC: 18 },
        LiveAircon: {
          ...restStatus.lastKnownState.LiveAircon,
          OutdoorUnit: { ...restStatus.lastKnownState.LiveAircon.OutdoorUnit, AmbientSensErr: false },
        },
      },
    }
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => validOutdoorStatus,
    } as never)

    await p.discoverDevices()

    const zoneCount = restStatus.lastKnownState.RemoteZoneInfo.filter((z: { NV_Exists?: boolean }) => z.NV_Exists).length
    // 1 master + 3 mode switches + 1 after-hours + 1 outdoor temp + zones.
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1 + 3 + 1 + 1 + zoneCount)
  })

  it('does not register a turbo accessory when the unit does not report support (real fixture: Supported false)', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    const zoneCount = restStatus.lastKnownState.RemoteZoneInfo.filter((z: { NV_Exists?: boolean }) => z.NV_Exists).length
    // 1 master + 3 mode switches + 1 after-hours + zones, no turbo — matches the owner's
    // real hardware (UserAirconSettings.TurboMode.Supported === false).
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1 + 3 + 1 + zoneCount)
  })

  it('registers a turbo accessory when the unit reports support', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    const turboSupportedStatus = {
      ...restStatus,
      lastKnownState: {
        ...restStatus.lastKnownState,
        UserAirconSettings: {
          ...restStatus.lastKnownState.UserAirconSettings,
          TurboMode: { Supported: true, Enabled: false },
        },
      },
    }
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => turboSupportedStatus,
    } as never)

    await p.discoverDevices()

    const zoneCount = restStatus.lastKnownState.RemoteZoneInfo.filter((z: { NV_Exists?: boolean }) => z.NV_Exists).length
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1 + 3 + 1 + 1 + zoneCount)
  })

  it('does not register a quiet mode switch when the unit does not report QuietModeEnabled', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    const noQuietStatus = {
      ...restStatus,
      lastKnownState: {
        ...restStatus.lastKnownState,
        UserAirconSettings: { ...restStatus.lastKnownState.UserAirconSettings, QuietModeEnabled: false },
      },
    }
    p.injectForTest({ getSystems: async () => systems, getStatus: async () => noQuietStatus } as never)

    await p.discoverDevices()

    const zoneCount = restStatus.lastKnownState.RemoteZoneInfo.filter((z: { NV_Exists?: boolean }) => z.NV_Exists).length
    // 1 master + away + continuousFan (no quiet) + 1 after-hours + zones.
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1 + 2 + 1 + zoneCount)
  })

  it('derives capabilities once after the first successful status fetch and logs the detected model', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({ getSystems: async () => systems, getStatus: async () => restStatus } as never)

    await p.discoverDevices()

    expect(p.capabilities?.model).toBe('NTW-1000')
    expect(p.capabilities?.fanSpeeds).toEqual(['LOW', 'MED', 'HIGH'])
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/Detected NTW-1000/))
  })

  it('clears the poll timer on shutdown', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)
    await p.discoverDevices()

    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    api.handlers.shutdown()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })

  it('polls on the configured interval, refreshing state and enabled zones', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    const p = new ActronAirNeoPlatform(
      log,
      { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt', refreshInterval: 1 } as never,
      api,
    )
    const getStatus = vi.fn(async () => restStatus)
    p.injectForTest({ getSystems: async () => systems, getStatus } as never)

    await p.discoverDevices()
    getStatus.mockClear()
    const syncSpy = vi.spyOn(p.commands, 'syncEnabledZones')

    await vi.advanceTimersByTimeAsync(1000)

    expect(getStatus).toHaveBeenCalledWith(systems._embedded['ac-system'][0].serial)
    expect(syncSpy).toHaveBeenCalled()
  })

  it('retries discovery on poll() after a failed initial discovery, recovering without a restart', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    let failDiscovery = true
    p.injectForTest({
      getSystems: async () => {
        if (failDiscovery)
          throw new Error('cloud down')
        return systems
      },
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()
    // Failed discovery leaves serial unset and commands never constructed — poll() must not
    // be permanently inert against this.
    expect(p.serial).toBe('')
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled()

    failDiscovery = false
    await p.poll()

    expect(p.serial).not.toBe('')
    expect(p.commands).toBeDefined()
    expect(api.registerPlatformAccessories).toHaveBeenCalled()
  })

  it('does not run an overlapping poll while one is still in flight', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({ getSystems: async () => systems, getStatus: async () => restStatus } as never)
    await p.discoverDevices()

    let releaseStatus: (() => void) | undefined
    const slowGetStatus = vi.fn(() => new Promise((resolve) => {
      releaseStatus = () => resolve(restStatus)
    }))
    p.injectForTest({ getSystems: async () => systems, getStatus: slowGetStatus } as never)

    const first = p.poll()
    const second = p.poll() // must be a no-op skip, not a second overlapping request

    releaseStatus!()
    await Promise.all([first, second])

    expect(slowGetStatus).toHaveBeenCalledTimes(1)
  })

  it('clears cloudConnected when a poll fails, so the accessory comms guard means something', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({ getSystems: async () => systems, getStatus: async () => restStatus } as never)
    await p.discoverDevices()
    expect(p.state.cloudConnected).toBe(true)

    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => { throw new Error('cloud down') },
    } as never)

    await p.poll()

    expect(p.state.cloudConnected).toBe(false)
  })

  it('migrates a zone accessory cached under the old index-plus-title identity to the new index-only scheme, keeping the same accessory', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)

    const zone0 = restStatus.lastKnownState.RemoteZoneInfo[0]
    const oldUuid = `uuid-zone-0-${zone0.NV_Title}`
    const cached = { UUID: oldUuid, displayName: zone0.NV_Title, context: { device: { kind: 'zone', zoneIndex: 0, id: `zone-0-${zone0.NV_Title}` } } }
    p.configureAccessory(cached as never)

    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    // Not treated as stale — the migrated accessory keeps its old UUID rather than being
    // unregistered and replaced by a freshly generated one.
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/migrating zone/i))
    expect(p.accessories).toContain(cached)
  })

  it('renaming a zone in the source data does not change its accessory identity', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)
    await p.discoverDevices()
    const zone0Accessory = p.accessories.find(a => (a.context.device as { kind?: string, zoneIndex?: number } | undefined)?.kind === 'zone' && (a.context.device as { zoneIndex?: number }).zoneIndex === 0)
    expect(zone0Accessory).toBeDefined()
    const uuidBeforeRename = zone0Accessory!.UUID

    const renamed = {
      ...restStatus,
      lastKnownState: {
        ...restStatus.lastKnownState,
        RemoteZoneInfo: restStatus.lastKnownState.RemoteZoneInfo.map((z: { NV_Title?: string }, i: number) =>
          i === 0 ? { ...z, NV_Title: 'Totally Renamed Zone' } : z),
      },
    }
    p.injectForTest({ getSystems: async () => systems, getStatus: async () => renamed } as never)
    await p.discoverDevices()

    const zone0AfterRename = p.accessories.find(a => (a.context.device as { kind?: string, zoneIndex?: number } | undefined)?.kind === 'zone' && (a.context.device as { zoneIndex?: number }).zoneIndex === 0)
    expect(zone0AfterRename!.UUID).toBe(uuidBeforeRename)
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
  })

  it('connects MQTT push after a successful discovery, by default', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
      getConnectionDetails: vi.fn(),
    } as never)

    await p.discoverDevices()

    expect(NeoMqtt).toHaveBeenCalledTimes(1)
    expect(vi.mocked(NeoMqtt).mock.results[0].value.start).toHaveBeenCalled()
  })

  it('disconnects MQTT push on shutdown', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
      getConnectionDetails: vi.fn(),
    } as never)
    await p.discoverDevices()
    const instance = vi.mocked(NeoMqtt).mock.results[0].value

    api.handlers.shutdown()

    expect(instance.stop).toHaveBeenCalled()
  })

  it('a failed discovery never starts MQTT push and leaves REST polling running', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    const p = new ActronAirNeoPlatform(
      log,
      { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt', refreshInterval: 1 } as never,
      api,
    )
    const getSystems = vi.fn(async () => {
      throw new Error('cloud down')
    })
    p.injectForTest({ getSystems, getStatus: async () => restStatus, getConnectionDetails: vi.fn() } as never)

    await p.discoverDevices()
    expect(NeoMqtt).not.toHaveBeenCalled()

    getSystems.mockClear()
    await vi.advanceTimersByTimeAsync(1000)
    // The scheduled poll retried discovery — polling did not stop because push never started.
    expect(getSystems).toHaveBeenCalled()
  })

  it('widens the poll interval to the push-healthy cadence the instant push reports healthy', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    const p = new ActronAirNeoPlatform(
      log,
      { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt', refreshInterval: 1 } as never,
      api,
    )
    const getStatus = vi.fn(async () => restStatus)
    p.injectForTest({ getSystems: async () => systems, getStatus, getConnectionDetails: vi.fn() } as never)

    await p.discoverDevices()
    const instance = vi.mocked(NeoMqtt).mock.results[0].value as { healthy: boolean, opts: { onHealthChange: (h: boolean) => void } }
    getStatus.mockClear()

    instance.healthy = true
    instance.opts.onHealthChange(true)

    // Push reports healthy — the configured 1s interval must no longer drive polling.
    await vi.advanceTimersByTimeAsync(4000)
    expect(getStatus).not.toHaveBeenCalled()

    // Only the 5-minute safety-net cadence fires while push stays healthy.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 4000)
    expect(getStatus).toHaveBeenCalled()
  })

  it('narrows the poll interval back immediately the instant push reports stale/down, without waiting out the wide interval', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    const p = new ActronAirNeoPlatform(
      log,
      { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt', refreshInterval: 1 } as never,
      api,
    )
    const getStatus = vi.fn(async () => restStatus)
    p.injectForTest({ getSystems: async () => systems, getStatus, getConnectionDetails: vi.fn() } as never)

    await p.discoverDevices()
    const instance = vi.mocked(NeoMqtt).mock.results[0].value as { healthy: boolean, opts: { onHealthChange: (h: boolean) => void } }
    instance.healthy = true
    instance.opts.onHealthChange(true) // widen to the 5-minute safety-net cadence

    getStatus.mockClear()
    instance.healthy = false
    instance.opts.onHealthChange(false) // push just went stale/down — narrow back now, not in 5 minutes

    await vi.advanceTimersByTimeAsync(1000)
    expect(getStatus).toHaveBeenCalled()
  })

  it('does not resurrect the poll timer if shutdown fires while a poll is already in flight', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    const p = new ActronAirNeoPlatform(
      log,
      { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt', refreshInterval: 1 } as never,
      api,
    )
    p.injectForTest({ getSystems: async () => systems, getStatus: async () => restStatus, getConnectionDetails: vi.fn() } as never)
    await p.discoverDevices()

    let releaseStatus: (() => void) | undefined
    const slowGetStatus = vi.fn(() => new Promise((resolve) => {
      releaseStatus = () => resolve(restStatus)
    }))
    p.injectForTest({ getSystems: async () => systems, getStatus: slowGetStatus, getConnectionDetails: vi.fn() } as never)

    await vi.advanceTimersByTimeAsync(1000) // fires the scheduled poll; it's now in flight, blocked on releaseStatus
    expect(slowGetStatus).toHaveBeenCalledTimes(1)

    api.handlers.shutdown() // shutdown while that poll is still in flight
    releaseStatus!()
    await vi.advanceTimersByTimeAsync(0) // let poll()'s .finally(() => this.startPolling()) run

    slowGetStatus.mockClear()
    await vi.advanceTimersByTimeAsync(3500)
    // startPolling() must have refused to reschedule after shutdown — no further polls.
    expect(slowGetStatus).not.toHaveBeenCalled()
  })
  it('reconciles CommandQueue.enabledZones from a push update, not only from a poll', async () => {
    // With push healthy the poll widens to 5 minutes, so a zone the user disabled in the
    // ActronAir app would stay "on" in the queue's local array for that whole window — and
    // the next HomeKit zone toggle, which always sends the complete array, would silently
    // turn it back on.
    const api = makeApi()
    const p = new ActronAirNeoPlatform(
      log,
      { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never,
      api,
    )
    const sendCommand = vi.fn(async () => ({ type: 'ack' }))
    p.injectForTest({ getSystems: async () => systems, getStatus: async () => restStatus, sendCommand } as never)
    await p.discoverDevices()

    // Zone 0 disabled elsewhere; only MQTT sees it (no poll runs in between).
    const pushed = restStatus.lastKnownState.UserAirconSettings.EnabledZones.map((on: boolean, i: number) => i === 0 ? false : on)
    p.state.applyDelta({ 'UserAirconSettings.EnabledZones': pushed })

    await p.commands.run(NeoCommand.ZONE_ENABLE, { zoneIndex: 1 })

    const expected = [...pushed]
    expected[1] = true
    expect(sendCommand).toHaveBeenCalledWith(
      systems._embedded['ac-system'][0].serial,
      { command: { 'UserAirconSettings.EnabledZones': expected, 'type': 'set-settings' } },
    )
  })

  it('logs a revoked account link from the poll loop at error, not debug', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({ getSystems: async () => systems, getStatus: async () => restStatus } as never)
    await p.discoverDevices()

    log.error.mockClear()
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => { throw new NeoAuthRevokedError('invalid_grant') },
    } as never)
    await p.poll()

    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/link your account again/i))
  })

  it('logs the revoked account link once, not once per poll', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({ getSystems: async () => systems, getStatus: async () => restStatus } as never)
    await p.discoverDevices()

    log.error.mockClear()
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => { throw new NeoAuthRevokedError('invalid_grant') },
    } as never)

    await p.poll()
    await p.poll()
    await p.poll()

    // The message is actionable exactly once; repeating it every 60s until the user re-links
    // is noise, not information.
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  it('clears the failure counters once a poll recovers, so the next blip is quiet again', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    let fail = false
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => {
        if (fail)
          throw new Error('cloud down')
        return restStatus
      },
    } as never)
    await p.discoverDevices()

    fail = true
    await p.poll()
    await p.poll()
    await p.poll() // now past the warn threshold

    fail = false
    await p.poll() // recovered

    log.warn.mockClear()
    fail = true
    await p.poll() // a fresh single blip must be quiet again

    expect(log.warn).not.toHaveBeenCalled()
  })

  it('warns once repeated polls keep failing, instead of staying silent at debug forever', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({ getSystems: async () => systems, getStatus: async () => restStatus } as never)
    await p.discoverDevices()

    log.warn.mockClear()
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => { throw new Error('cloud down') },
    } as never)

    await p.poll()
    expect(log.warn).not.toHaveBeenCalled() // a single blip stays quiet

    await p.poll()
    await p.poll()
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/cloud down/))
  })

  it('cancels debounced commands on shutdown rather than leaving them pending', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(
      log,
      { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never,
      api,
    )
    p.injectForTest({ getSystems: async () => systems, getStatus: async () => restStatus, sendCommand: vi.fn() } as never)
    await p.discoverDevices()

    const pending = p.commands.run(NeoCommand.ON)
    api.handlers.shutdown()

    await expect(pending).rejects.toThrow(/cancelled/i)
  })
  it('makes the debug config option real by routing log.debug to log.info', () => {
    // Homebridge gates log.debug on its own -D flag, so without this the documented option
    // produced byte-identical output. The wrapped logger is what every collaborator gets.
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', debug: true } as never, api)

    log.info.mockClear()
    p.log.debug('queued command')

    expect(log.info).toHaveBeenCalledWith('queued command')
  })

  it('leaves Homebridge\'s own debug behaviour alone when the option is off', () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x' } as never, api)

    log.info.mockClear()
    log.debug.mockClear()
    p.log.debug('queued command')

    expect(log.debug).toHaveBeenCalledWith('queued command')
    expect(log.info).not.toHaveBeenCalled()
  })
})

describe('sanitizeAccessoryName', () => {
  // HAP warns that a name not starting and ending with a letter or number "may prevent the
  // accessory from being added in the Home App or cause unresponsiveness". Zone names are
  // whatever the user typed in the ActronAir app, where a trailing space is invisible.
  it('trims edge characters HAP rejects', () => {
    expect(sanitizeAccessoryName('Office 1 ', 'Zone 3')).toBe('Office 1')
    expect(sanitizeAccessoryName('  Master Bedroom  ', 'Zone 1')).toBe('Master Bedroom')
  })

  it('leaves a name HAP already accepts untouched, including interior punctuation', () => {
    expect(sanitizeAccessoryName('Office 1', 'Zone 3')).toBe('Office 1')
    expect(sanitizeAccessoryName('Kids\' Room', 'Zone 2')).toBe('Kids\' Room')
    expect(sanitizeAccessoryName('Zone-A', 'Zone 8')).toBe('Zone-A')
  })

  it('keeps non-ASCII letters, which are valid and common in room names', () => {
    expect(sanitizeAccessoryName('Café', 'Zone 9')).toBe('Café')
  })

  it('falls back when nothing usable survives, rather than naming an accessory ""', () => {
    expect(sanitizeAccessoryName('...', 'Zone 5')).toBe('Zone 5')
    expect(sanitizeAccessoryName('', 'Zone 6')).toBe('Zone 6')
    expect(sanitizeAccessoryName('   ', 'Zone 7')).toBe('Zone 7')
  })
})
