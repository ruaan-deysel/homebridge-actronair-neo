import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deriveCapabilities, deriveModeSupport, getUsableOutdoorTemp, isTurboModeSupported } from '../src/neo/capabilities.js'
import { StatusResponseSchema } from '../src/neo/schemas.js'
import { NeoState } from '../src/neo/state.js'
import { FanMode } from '../src/neo/types.js'

const realFixture = JSON.parse(readFileSync('test/fixtures/rest-status.json', 'utf8'))

function baseTree() {
  return {
    UserAirconSettings: { isOn: true, Mode: 'COOL', FanMode: 'LOW', EnabledZones: [] },
    MasterInfo: { LiveTemp_oC: 24, LiveHumidity_pc: 45, LiveOutdoorTemp_oC: 18 },
    LiveAircon: { CompressorMode: 'COOL', AmRunningFan: true, OutdoorUnit: { AmbientSensErr: false } },
    RemoteZoneInfo: [],
    AirconSystem: {},
  }
}

function stateFrom(tree: ReturnType<typeof baseTree>): NeoState {
  const state = new NeoState()
  state.replace(tree as never)
  return state
}

describe('deriveCapabilities', () => {
  it('matches the owner\'s real fixture: bitmap 3 (LOW+MED) unions in the currently-running HIGH, and excludes AUTO', () => {
    const parsed = StatusResponseSchema.parse(realFixture)
    expect(parsed.lastKnownState.AirconSystem.IndoorUnit?.NV_SupportedFanModes).toBe(3)
    expect(parsed.lastKnownState.AirconSystem.IndoorUnit?.NV_AutoFanEnabled).toBe(false)
    expect(parsed.lastKnownState.UserAirconSettings.FanMode).toBe('HIGH')

    const state = new NeoState()
    state.replace(parsed.lastKnownState)
    const caps = deriveCapabilities(state)

    expect(caps.fanSpeeds).toEqual([FanMode.LOW, FanMode.MEDIUM, FanMode.HIGH])
    expect(caps.supportsAutoFan).toBe(false)
    expect(caps.model).toBe('NTW-1000')
    expect(caps.indoorModel).toBe('EVA150S')
    expect(caps.outdoorFamily).toBe('Fixed Speed: Classic')
    expect(caps.capacityKw).toBe(15)
    expect(caps.supportsTurbo).toBe(false)
    expect(caps.supportsVft).toBe(false)
    expect(caps.quietModeAvailable).toBe(true)
  })

  it('bitmap 15 with NV_AutoFanEnabled true reports all four speeds', () => {
    const tree = baseTree()
    tree.AirconSystem = { IndoorUnit: { NV_SupportedFanModes: 15, NV_AutoFanEnabled: true } } as never
    const caps = deriveCapabilities(stateFrom(tree))
    expect(caps.fanSpeeds).toEqual([FanMode.LOW, FanMode.MEDIUM, FanMode.HIGH, FanMode.AUTO])
    expect(caps.supportsAutoFan).toBe(true)
  })

  it.each([
    ['absent', undefined],
    ['zero', 0],
    ['garbage (unknown bit only)', 16],
    ['garbage (non-numeric)', 'nonsense'],
  ])('falls back to [LOW, MED, HIGH] when the bitmap is %s', (_label, value) => {
    const tree = baseTree()
    tree.AirconSystem = { IndoorUnit: { NV_SupportedFanModes: value } } as never
    const caps = deriveCapabilities(stateFrom(tree))
    expect(caps.fanSpeeds).toEqual([FanMode.LOW, FanMode.MEDIUM, FanMode.HIGH])
  })

  it('falls back to [LOW, MED, HIGH] when the bitmap is AUTO-only and NV_AutoFanEnabled is false, even with no FanMode to union in (regression: fanSpeeds must never end up empty)', () => {
    const tree = baseTree()
    tree.AirconSystem = { IndoorUnit: { NV_SupportedFanModes: 8, NV_AutoFanEnabled: false } } as never
    delete (tree.UserAirconSettings as Record<string, unknown>).FanMode
    const caps = deriveCapabilities(stateFrom(tree))
    expect(caps.fanSpeeds).toEqual([FanMode.LOW, FanMode.MEDIUM, FanMode.HIGH])
    expect(caps.supportsAutoFan).toBe(false)
  })

  it('retains AUTO for a valid AUTO-only bitmap when NV_AutoFanEnabled is true', () => {
    const tree = baseTree()
    tree.AirconSystem = { IndoorUnit: { NV_SupportedFanModes: 8, NV_AutoFanEnabled: true } } as never
    delete (tree.UserAirconSettings as Record<string, unknown>).FanMode
    const caps = deriveCapabilities(stateFrom(tree))
    expect(caps.fanSpeeds).toEqual([FanMode.AUTO])
    expect(caps.supportsAutoFan).toBe(true)
  })

  it('excludes AUTO when NV_AutoFanEnabled is true but the AUTO bit is unset — the flag gates, it does not override', () => {
    const tree = baseTree()
    tree.AirconSystem = { IndoorUnit: { NV_SupportedFanModes: 7, NV_AutoFanEnabled: true } } as never // 7 = LOW|MED|HIGH, no AUTO bit
    const caps = deriveCapabilities(stateFrom(tree))
    expect(caps.fanSpeeds).toEqual([FanMode.LOW, FanMode.MEDIUM, FanMode.HIGH])
    expect(caps.supportsAutoFan).toBe(false)
  })

  it('unions in the currently-running speed even when the bitmap omits it', () => {
    const tree = baseTree()
    tree.AirconSystem = { IndoorUnit: { NV_SupportedFanModes: 1, NV_AutoFanEnabled: false } } as never // bitmap: LOW only
    tree.UserAirconSettings.FanMode = 'HIGH+CONT'
    const caps = deriveCapabilities(stateFrom(tree))
    expect(caps.fanSpeeds).toEqual([FanMode.LOW, FanMode.HIGH])
  })

  it('yields a usable baseline (never zero features) for an empty/unknown AirconSystem, without throwing', () => {
    const tree = baseTree()
    tree.AirconSystem = {}
    expect(() => deriveCapabilities(stateFrom(tree))).not.toThrow()
    const caps = deriveCapabilities(stateFrom(tree))
    expect(caps.fanSpeeds).toEqual([FanMode.LOW, FanMode.MEDIUM, FanMode.HIGH])
    expect(caps.supportsAutoFan).toBe(false)
    expect(caps.model).toBe('ActronAir Neo (model unknown)')
    expect(caps.supportsTurbo).toBe(false)
    expect(caps.supportsVft).toBe(false)
    expect(caps.quietModeAvailable).toBe(false)
  })

  it('model prefers MasterWCModel, falling back to the indoor unit model', () => {
    const tree = baseTree()
    tree.AirconSystem = { IndoorUnit: { NV_ModelNumber: 'EVA150S' } } as never
    expect(deriveCapabilities(stateFrom(tree)).model).toBe('EVA150S')

    tree.AirconSystem = { MasterWCModel: 'NTW-1000', IndoorUnit: { NV_ModelNumber: 'EVA150S' } } as never
    expect(deriveCapabilities(stateFrom(tree)).model).toBe('NTW-1000')
  })

  it('outdoorTempUsable matches getUsableOutdoorTemp', () => {
    const usable = stateFrom(baseTree())
    expect(deriveCapabilities(usable).outdoorTempUsable).toBe(true)
    expect(getUsableOutdoorTemp(usable)).toBe(18)

    const tree = baseTree()
    tree.MasterInfo.LiveOutdoorTemp_oC = 3000
    const unusable = stateFrom(tree)
    expect(deriveCapabilities(unusable).outdoorTempUsable).toBe(false)
    expect(getUsableOutdoorTemp(unusable)).toBeUndefined()
  })

  it('supportsTurbo matches isTurboModeSupported', () => {
    const tree = baseTree()
    ;(tree.UserAirconSettings as Record<string, unknown>).TurboMode = { Supported: true }
    const state = stateFrom(tree)
    expect(deriveCapabilities(state).supportsTurbo).toBe(true)
    expect(isTurboModeSupported(state)).toBe(true)
  })
})

describe('deriveModeSupport', () => {
  it('reads the owner\'s real fixture: cool/heat/fan/auto supported, dry not', () => {
    const state = new NeoState()
    state.replace(StatusResponseSchema.parse(realFixture).lastKnownState)

    expect(deriveModeSupport(state)).toEqual({ cool: true, heat: true, auto: true, fan: true, dry: false })
  })

  it('assumes the four long-standing modes (but not dry) when the unit reports no ModeSupport', () => {
    expect(deriveModeSupport(stateFrom(baseTree())))
      .toEqual({ cool: true, heat: true, auto: true, fan: true, dry: false })
  })

  it('honours a mode the unit says it does not have', () => {
    const tree = baseTree()
    ;(tree.UserAirconSettings as Record<string, unknown>).ModeSupport = { Cool: true, Heat: false, Auto: false, Fan: false, Dry: false }

    expect(deriveModeSupport(stateFrom(tree))).toEqual({ cool: true, heat: false, auto: false, fan: false, dry: false })
  })

  it('reports an all-false thermostat mode set honestly instead of rewriting it', () => {
    // HAP does need a non-empty validValues list, but that compromise belongs to
    // MasterAccessory — capabilities must not tell every other consumer the unit can cool.
    const tree = baseTree()
    ;(tree.UserAirconSettings as Record<string, unknown>).ModeSupport = { Cool: false, Heat: false, Auto: false, Fan: true }

    expect(deriveModeSupport(stateFrom(tree))).toEqual({ cool: false, heat: false, auto: false, fan: true, dry: false })
  })

  it('falls back per field, so a partial ModeSupport does not lose the modes it omits', () => {
    const tree = baseTree()
    ;(tree.UserAirconSettings as Record<string, unknown>).ModeSupport = { Cool: false, Dry: true }

    expect(deriveModeSupport(stateFrom(tree)))
      .toEqual({ cool: false, heat: true, auto: true, fan: true, dry: true })
  })
})
