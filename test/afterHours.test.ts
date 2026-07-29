import type { StatusTree } from '../src/neo/schemas.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { AfterHoursAccessory } from '../src/accessories/afterHours.js'
import { StatusResponseSchema } from '../src/neo/schemas.js'
import { NeoState } from '../src/neo/state.js'
import { NeoCommand } from '../src/neo/types.js'

const baseTree = StatusResponseSchema.parse(
  JSON.parse(readFileSync('test/fixtures/rest-status.json', 'utf8')),
).lastKnownState

function tree(overrides: { Enabled?: boolean, Duration?: number } = {}): StatusTree {
  return {
    ...baseTree,
    UserAirconSettings: {
      ...baseTree.UserAirconSettings,
      AfterHours: { ...baseTree.UserAirconSettings.AfterHours, ...overrides },
    },
  }
}

/** Minimal fakes for the slice of HAP this accessory touches. */
class FakeCharacteristic {
  value: unknown
  props: Record<string, unknown> = {}
  private getHandler?: () => unknown
  private setHandler?: (v: unknown) => unknown
  onGet(fn: () => unknown) {
    this.getHandler = fn
    return this
  }

  onSet(fn: (v: unknown) => unknown) {
    this.setHandler = fn
    return this
  }

  setProps(props: Record<string, unknown>) {
    this.props = props
    return this
  }

  updateValue(value: unknown) {
    this.value = value
    return this
  }

  async invokeGet() { return this.getHandler?.() }
  async invokeSet(v: unknown) { return this.setHandler?.(v) }
}

class FakeService {
  characteristics = new Map<string, FakeCharacteristic>()
  getCharacteristic(id: string) {
    if (!this.characteristics.has(id))
      this.characteristics.set(id, new FakeCharacteristic())
    return this.characteristics.get(id)!
  }

  setCharacteristic(id: string, value: unknown) {
    this.getCharacteristic(id).value = value
    return this
  }

  updateCharacteristic(id: string, value: unknown) {
    this.getCharacteristic(id).value = value
    return this
  }
}

class FakeAccessory {
  services = new Map<string, FakeService>()
  constructor(public displayName: string) {
    this.services.set('AccessoryInformation', new FakeService())
  }

  getService(type: string) { return this.services.get(type) }
  addService(type: string) {
    const s = new FakeService()
    this.services.set(type, s)
    return s
  }
}

function makePlatform(initialTree: StatusTree, cloudConnected = true) {
  const state = new NeoState()
  state.replace(initialTree)
  state.setCloudConnected(cloudConnected)
  const commands = { run: vi.fn(async () => 'SUCCESS') }
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    state,
    commands,
    log,
    cfg: {},
    Service: { AccessoryInformation: 'AccessoryInformation', Valve: 'Valve' },
    Characteristic: {
      Manufacturer: 'Manufacturer',
      Model: 'Model',
      Name: 'Name',
      Active: 'Active',
      InUse: 'InUse',
      ValveType: 'ValveType',
      SetDuration: 'SetDuration',
    },
    api: { hap: { HapStatusError: class HapStatusError extends Error {} } },
  } as never
}

function build(initialTree: StatusTree, cloudConnected = true) {
  const platform = makePlatform(initialTree, cloudConnected)
  const accessory = new FakeAccessory('After Hours') as never
  const afterHours = new AfterHoursAccessory(platform, accessory)
  const service = (accessory as unknown as FakeAccessory).getService('Valve')!
  return {
    platform: platform as unknown as { state: NeoState, commands: { run: ReturnType<typeof vi.fn> } },
    accessory,
    afterHours,
    service,
    active: service.getCharacteristic('Active'),
    duration: service.getCharacteristic('SetDuration'),
  }
}

describe('afterHoursAccessory', () => {
  it('reads AfterHours.Enabled', () => {
    const { afterHours } = build(tree({ Enabled: true }))
    expect(afterHours.getActive()).toBe(1)
  })

  it('sends AFTER_HOURS_ON / AFTER_HOURS_OFF', async () => {
    const { afterHours, platform } = build(tree({ Enabled: false }))
    await afterHours.setActive(true)
    expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.AFTER_HOURS_ON)
    await afterHours.setActive(false)
    expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.AFTER_HOURS_OFF)
  })

  it('reads AfterHours.Duration converted from wire minutes to HomeKit seconds', () => {
    const { afterHours } = build(tree({ Duration: 120 }))
    expect(afterHours.getDuration()).toBe(7200)
  })

  it('exposes the SetDuration characteristic with range 1800-28800 seconds, step 1800 (30-480 min, step 30)', () => {
    const { duration } = build(tree())
    expect(duration.props).toEqual({ minValue: 1800, maxValue: 28800, minStep: 1800 })
  })

  it('sends AFTER_HOURS_DURATION with the value converted from HomeKit seconds to wire minutes', async () => {
    const { afterHours, platform } = build(tree({ Duration: 120 }))
    await afterHours.setDuration(14400) // 240 minutes
    expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.AFTER_HOURS_DURATION, { duration: 240 })
  })

  it('round-trips the lower bound exactly (30 min <-> 1800 s)', async () => {
    const { afterHours, platform } = build(tree({ Duration: 30 }))
    expect(afterHours.getDuration()).toBe(1800)
    await afterHours.setDuration(1800)
    expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.AFTER_HOURS_DURATION, { duration: 30 })
  })

  it('round-trips the upper bound exactly (480 min <-> 28800 s)', async () => {
    const { afterHours, platform } = build(tree({ Duration: 480 }))
    expect(afterHours.getDuration()).toBe(28800)
    await afterHours.setDuration(28800)
    expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.AFTER_HOURS_DURATION, { duration: 480 })
  })

  it('clamps a write below the minimum', async () => {
    const { afterHours, platform } = build(tree())
    await afterHours.setDuration(0)
    expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.AFTER_HOURS_DURATION, { duration: 30 })
  })

  it('clamps a write above the maximum', async () => {
    const { afterHours, platform } = build(tree())
    await afterHours.setDuration(36000) // 600 minutes
    expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.AFTER_HOURS_DURATION, { duration: 480 })
  })

  it('clamps an out-of-range reading from the cloud rather than passing it through raw', () => {
    const { afterHours } = build(tree({ Duration: 5000 }))
    expect(afterHours.getDuration()).toBe(28800)
  })

  describe('change subscription', () => {
    it('updates Active/InUse when its own path changes', () => {
      const { platform, active } = build(tree({ Enabled: false }))
      platform.state.applyDelta({ 'UserAirconSettings.AfterHours.Enabled': true })
      expect(active.value).toBe(1)
    })

    it('updates SetDuration (in seconds) when its own path (minutes) changes', () => {
      const { platform, duration } = build(tree({ Duration: 120 }))
      platform.state.applyDelta({ 'UserAirconSettings.AfterHours.Duration': 240 })
      expect(duration.value).toBe(14400)
    })

    it('ignores changes to unrelated paths', () => {
      const { platform, active, duration } = build(tree({ Enabled: false, Duration: 120 }))
      active.value = 'untouched'
      duration.value = 'untouched'
      platform.state.applyDelta({ 'UserAirconSettings.QuietMode': true })
      expect(active.value).toBe('untouched')
      expect(duration.value).toBe('untouched')
    })
  })

  describe('cloud disconnected', () => {
    it('throws instead of writing the enable state', async () => {
      const { afterHours, platform } = build(tree({ Enabled: false }), false)
      await expect(afterHours.setActive(true)).rejects.toThrow()
      expect(platform.commands.run).not.toHaveBeenCalled()
    })

    it('throws instead of writing the duration', async () => {
      const { afterHours, platform } = build(tree(), false)
      await expect(afterHours.setDuration(60)).rejects.toThrow()
      expect(platform.commands.run).not.toHaveBeenCalled()
    })
  })

  describe('command failure', () => {
    it('throws instead of resolving normally when the command queue reports FAILURE', async () => {
      const { afterHours, platform } = build(tree({ Enabled: false }))
      platform.commands.run.mockResolvedValue('FAILURE')
      await expect(afterHours.setActive(true)).rejects.toThrow()
    })

    it('throws instead of resolving normally when the command queue reports API_ERROR', async () => {
      const { afterHours, platform } = build(tree({ Duration: 120 }))
      platform.commands.run.mockResolvedValue('API_ERROR')
      await expect(afterHours.setDuration(14400)).rejects.toThrow()
    })
  })
})
