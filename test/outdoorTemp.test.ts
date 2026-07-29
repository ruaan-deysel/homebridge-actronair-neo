import { readFileSync } from 'node:fs'
import { HAPStatus } from 'homebridge'
import { describe, expect, it, vi } from 'vitest'
import { OutdoorTempAccessory } from '../src/accessories/outdoorTemp.js'
import { getUsableOutdoorTemp } from '../src/neo/capabilities.js'
import { StatusResponseSchema } from '../src/neo/schemas.js'
import { NeoState } from '../src/neo/state.js'

/** Minimal fakes for the slice of HAP the accessory touches — mirrors test/master.test.ts. */
class FakeCharacteristic {
  value: unknown
  private getter?: () => unknown

  onGet(fn: () => unknown) {
    this.getter = fn
    return this
  }

  invokeGet() {
    return this.getter?.()
  }
}

class FakeService {
  characteristics = new Map<unknown, FakeCharacteristic>()
  updates: Array<{ id: unknown, value: unknown }> = []

  getCharacteristic(id: unknown) {
    let c = this.characteristics.get(id)
    if (!c) {
      c = new FakeCharacteristic()
      this.characteristics.set(id, c)
    }
    return c
  }

  setCharacteristic(id: unknown, value: unknown) {
    this.getCharacteristic(id).value = value
    return this
  }

  updateCharacteristic(id: unknown, value: unknown) {
    this.updates.push({ id, value })
    this.getCharacteristic(id).value = value
    return this
  }
}

const Characteristic = {
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  SerialNumber: 'SerialNumber',
  Name: 'Name',
  CurrentTemperature: 'CurrentTemperature',
}

const ServiceTokens = {
  AccessoryInformation: 'AccessoryInformation',
  TemperatureSensor: 'TemperatureSensor',
}

function baseTree() {
  return {
    UserAirconSettings: { isOn: true, Mode: 'COOL', FanMode: 'LOW', EnabledZones: [] },
    MasterInfo: { LiveTemp_oC: 24, LiveHumidity_pc: 45, LiveOutdoorTemp_oC: 18 },
    LiveAircon: { CompressorMode: 'COOL', AmRunningFan: true, OutdoorUnit: { AmbientSensErr: false } },
    RemoteZoneInfo: [],
  }
}

function makeHarness(tree: ReturnType<typeof baseTree>) {
  const state = new NeoState()
  state.setCloudConnected(true)
  state.replace(tree)

  const services = new Map<string, FakeService>()
  services.set(ServiceTokens.AccessoryInformation, new FakeService())
  const accessory = {
    displayName: 'Outdoor Temperature',
    getService: (token: string) => services.get(token),
    addService: (token: string) => {
      const s = new FakeService()
      services.set(token, s)
      return s
    },
  }

  const platform = {
    state,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    Service: ServiceTokens,
    Characteristic,
    serial: 'ABC123',
    api: { hap: { HapStatusError: class HapStatusError extends Error {
      constructor(public hapStatus: HAPStatus) { super(`HAP ${hapStatus}`) }
    } } },
  }

  const outdoor = new OutdoorTempAccessory(platform as never, accessory as never)
  const sensor = services.get(ServiceTokens.TemperatureSensor)!

  return { state, outdoor, sensor }
}

const realFixture = JSON.parse(readFileSync('test/fixtures/rest-status.json', 'utf8'))

describe('getUsableOutdoorTemp (gating — single source of truth)', () => {
  it('is undefined on the real fixture (owner\'s actual hardware: sentinel + sensor error)', () => {
    const parsed = StatusResponseSchema.parse(realFixture)
    expect(parsed.lastKnownState.MasterInfo.LiveOutdoorTemp_oC).toBe(3000)
    expect(parsed.lastKnownState.LiveAircon.OutdoorUnit?.AmbientSensErr).toBe(true)

    const state = new NeoState()
    state.replace(parsed.lastKnownState)
    expect(getUsableOutdoorTemp(state)).toBeUndefined()
  })

  it('is undefined when the field is absent', () => {
    const state = new NeoState()
    const tree = baseTree()
    delete (tree.MasterInfo as Record<string, unknown>).LiveOutdoorTemp_oC
    state.replace(tree)
    expect(getUsableOutdoorTemp(state)).toBeUndefined()
  })

  it('is undefined when the value is the 3000 sentinel', () => {
    const state = new NeoState()
    const tree = baseTree()
    tree.MasterInfo.LiveOutdoorTemp_oC = 3000
    state.replace(tree)
    expect(getUsableOutdoorTemp(state)).toBeUndefined()
  })

  it('is undefined when AmbientSensErr is true even though the temperature looks plausible', () => {
    const state = new NeoState()
    const tree = baseTree()
    tree.MasterInfo.LiveOutdoorTemp_oC = 21
    tree.LiveAircon.OutdoorUnit!.AmbientSensErr = true
    state.replace(tree)
    expect(getUsableOutdoorTemp(state)).toBeUndefined()
  })

  it('is undefined when the value is outside the plausible outdoor range', () => {
    const state = new NeoState()
    const tree = baseTree()
    tree.MasterInfo.LiveOutdoorTemp_oC = 85
    state.replace(tree)
    expect(getUsableOutdoorTemp(state)).toBeUndefined()
  })

  it('returns the reading when it is valid', () => {
    const state = new NeoState()
    state.replace(baseTree())
    expect(getUsableOutdoorTemp(state)).toBe(18)
  })
})

describe('outdoorTempAccessory', () => {
  it('registers and reports the correct temperature when the reading is valid', () => {
    const { outdoor, sensor } = makeHarness(baseTree())
    expect(sensor.getCharacteristic(Characteristic.CurrentTemperature).invokeGet()).toBe(18)
    expect(outdoor.getCurrentTemperature()).toBe(18)
  })

  it('serves the last known good reading instead of a fabricated 0 when the reading goes bad at runtime', () => {
    const { state, outdoor } = makeHarness(baseTree())
    expect(outdoor.getCurrentTemperature()).toBe(18)

    // Sentinel arrives after a valid reading was already seen.
    state.applyDelta({ 'MasterInfo.LiveOutdoorTemp_oC': 3000 })
    expect(outdoor.getCurrentTemperature()).toBe(18)
  })

  it('throws SERVICE_COMMUNICATION_FAILURE (never a fabricated value) when there has never been a valid reading', () => {
    const tree = baseTree()
    tree.MasterInfo.LiveOutdoorTemp_oC = 3000
    const { outdoor } = makeHarness(tree)

    expect(() => outdoor.getCurrentTemperature()).toThrow()
    expect(() => outdoor.getCurrentTemperature()).toThrowError(expect.objectContaining({ hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE }))
  })

  it('updates only when the outdoor temperature or sensor-error path changes', () => {
    const { state, sensor } = makeHarness(baseTree())
    sensor.updates.length = 0

    state.applyDelta({ 'MasterInfo.LiveOutdoorTemp_oC': 19 })

    expect(sensor.updates.some(u => u.id === Characteristic.CurrentTemperature && u.value === 19)).toBe(true)

    sensor.updates.length = 0
    state.applyDelta({ 'MasterInfo.LiveHumidity_pc': 50 })

    expect(sensor.updates.length).toBe(0)
  })
})
