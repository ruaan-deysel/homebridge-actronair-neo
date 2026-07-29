import type { StatusTree } from '../src/neo/schemas.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { ModeSwitchAccessory } from '../src/accessories/modeSwitch.js'
import { isTurboModeSupported } from '../src/neo/capabilities.js'
import { StatusResponseSchema } from '../src/neo/schemas.js'
import { NeoState } from '../src/neo/state.js'
import { NeoCommand } from '../src/neo/types.js'

const baseTree = StatusResponseSchema.parse(
  JSON.parse(readFileSync('test/fixtures/rest-status.json', 'utf8')),
).lastKnownState

function tree(overrides: Partial<StatusTree['UserAirconSettings']> = {}): StatusTree {
  return {
    ...baseTree,
    UserAirconSettings: { ...baseTree.UserAirconSettings, ...overrides },
  }
}

function treeWithFanMode(fanMode: string): StatusTree {
  return tree({ FanMode: fanMode } as never)
}

/** Minimal fakes for the slice of HAP this accessory touches. */
class FakeCharacteristic {
  value: unknown
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
    Service: { AccessoryInformation: 'AccessoryInformation', Switch: 'Switch' },
    Characteristic: { Manufacturer: 'Manufacturer', Model: 'Model', Name: 'Name', On: 'On' },
    api: { hap: { HapStatusError: class HapStatusError extends Error {} } },
  } as never
}

function build(mode: 'away' | 'quiet' | 'continuousFan' | 'turbo', initialTree: StatusTree, cloudConnected = true) {
  const platform = makePlatform(initialTree, cloudConnected)
  const accessory = new FakeAccessory(`${mode} switch`) as never
  const modeSwitch = new ModeSwitchAccessory(platform, accessory, mode)
  const service = (accessory as unknown as FakeAccessory).getService('Switch')!
  const onCharacteristic = service.getCharacteristic('On')
  return { platform: platform as unknown as { state: NeoState, commands: { run: ReturnType<typeof vi.fn> } }, accessory, modeSwitch, service, onCharacteristic }
}

describe('isTurboModeSupported', () => {
  it('is false against the real fixture (owner hardware reports TurboMode.Supported: false)', () => {
    const state = new NeoState()
    state.replace(baseTree)
    expect(isTurboModeSupported(state)).toBe(false)
  })

  it('is true when the unit reports support', () => {
    const state = new NeoState()
    state.replace(tree({ TurboMode: { Supported: true, Enabled: false } } as never))
    expect(isTurboModeSupported(state)).toBe(true)
  })
})

describe('modeSwitchAccessory', () => {
  describe('away', () => {
    it('reads AwayMode', () => {
      const { modeSwitch } = build('away', tree({ AwayMode: true } as never))
      expect(modeSwitch.getOn()).toBe(1)
    })

    it('sends AWAY_MODE_ON / AWAY_MODE_OFF', async () => {
      const { modeSwitch, platform } = build('away', tree({ AwayMode: false } as never))
      await modeSwitch.setOn(true)
      expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.AWAY_MODE_ON)
      await modeSwitch.setOn(false)
      expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.AWAY_MODE_OFF)
    })
  })

  describe('quiet', () => {
    it('reads QuietMode', () => {
      const { modeSwitch } = build('quiet', tree({ QuietMode: false } as never))
      expect(modeSwitch.getOn()).toBe(0)
    })

    it('sends QUIET_MODE_ON / QUIET_MODE_OFF', async () => {
      const { modeSwitch, platform } = build('quiet', tree({ QuietMode: false } as never))
      await modeSwitch.setOn(true)
      expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.QUIET_MODE_ON)
      await modeSwitch.setOn(false)
      expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.QUIET_MODE_OFF)
    })
  })

  describe('continuousFan', () => {
    it('derives state from the FanMode suffix', () => {
      const { modeSwitch, platform } = build('continuousFan', treeWithFanMode('HIGH+CONT'))
      expect(modeSwitch.getOn()).toBe(1)
      platform.state.applyDelta({ 'UserAirconSettings.FanMode': 'HIGH' })
      expect(modeSwitch.getOn()).toBe(0)
    })

    it('preserves MED speed when enabling continuous mode', async () => {
      const { modeSwitch, platform } = build('continuousFan', treeWithFanMode('MED'))
      await modeSwitch.setOn(true)
      expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.FAN_MODE_MEDIUM_CONT)
    })

    it('preserves HIGH speed when enabling continuous mode', async () => {
      const { modeSwitch, platform } = build('continuousFan', treeWithFanMode('HIGH'))
      await modeSwitch.setOn(true)
      expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.FAN_MODE_HIGH_CONT)
    })

    it('preserves MED speed when disabling continuous mode', async () => {
      const { modeSwitch, platform } = build('continuousFan', treeWithFanMode('MED+CONT'))
      await modeSwitch.setOn(false)
      expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.FAN_MODE_MEDIUM)
    })

    it('preserves HIGH speed when disabling continuous mode', async () => {
      const { modeSwitch, platform } = build('continuousFan', treeWithFanMode('HIGH+CONT'))
      await modeSwitch.setOn(false)
      expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.FAN_MODE_HIGH)
    })

    it('preserves AUTO speed in both directions', async () => {
      const { modeSwitch, platform } = build('continuousFan', treeWithFanMode('AUTO'))
      await modeSwitch.setOn(true)
      expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.FAN_MODE_AUTO_CONT)
    })
  })

  describe('turbo', () => {
    it('reads TurboMode.Enabled', () => {
      const { modeSwitch } = build('turbo', tree({ TurboMode: { Supported: true, Enabled: true } } as never))
      expect(modeSwitch.getOn()).toBe(1)
    })

    it('sends TURBO_MODE_ON / TURBO_MODE_OFF', async () => {
      const { modeSwitch, platform } = build('turbo', tree({ TurboMode: { Supported: true, Enabled: false } } as never))
      await modeSwitch.setOn(true)
      expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.TURBO_MODE_ON)
      await modeSwitch.setOn(false)
      expect(platform.commands.run).toHaveBeenCalledWith(NeoCommand.TURBO_MODE_OFF)
    })

    it('throws instead of writing when the cloud is disconnected', async () => {
      const { modeSwitch, platform } = build('turbo', tree({ TurboMode: { Supported: true, Enabled: false } } as never), false)
      await expect(modeSwitch.setOn(true)).rejects.toThrow()
      expect(platform.commands.run).not.toHaveBeenCalled()
    })
  })

  describe('change subscription', () => {
    it('updates the characteristic when its own path changes', () => {
      const { platform, onCharacteristic } = build('away', tree({ AwayMode: false } as never))
      platform.state.applyDelta({ 'UserAirconSettings.AwayMode': true })
      expect(onCharacteristic.value).toBe(1)
    })

    it('ignores changes to the other two switches’ paths', () => {
      const { platform, onCharacteristic } = build('away', tree({ AwayMode: false, QuietMode: false } as never))
      onCharacteristic.value = 'untouched'
      platform.state.applyDelta({ 'UserAirconSettings.QuietMode': true })
      expect(onCharacteristic.value).toBe('untouched')
      platform.state.applyDelta({ 'UserAirconSettings.FanMode': 'HIGH+CONT' })
      expect(onCharacteristic.value).toBe('untouched')
    })

    it('updates on a full reload (changed set contains "*")', () => {
      const { platform, onCharacteristic } = build('quiet', tree({ QuietMode: false } as never))
      onCharacteristic.value = 'untouched'
      platform.state.replace(tree({ QuietMode: true } as never))
      expect(onCharacteristic.value).toBe(1)
    })
  })

  describe('cloud disconnected', () => {
    it('throws HapStatusError instead of writing', async () => {
      const { modeSwitch, platform } = build('away', tree({ AwayMode: false } as never), false)
      await expect(modeSwitch.setOn(true)).rejects.toThrow()
      expect(platform.commands.run).not.toHaveBeenCalled()
    })
  })

  describe('command failure', () => {
    it('throws instead of resolving normally when the command queue reports FAILURE', async () => {
      const { modeSwitch, platform } = build('away', tree({ AwayMode: false } as never))
      platform.commands.run.mockResolvedValue('FAILURE')
      await expect(modeSwitch.setOn(true)).rejects.toThrow()
    })

    it('throws instead of resolving normally when the command queue reports API_ERROR', async () => {
      const { modeSwitch, platform } = build('turbo', tree({ TurboMode: { Supported: true, Enabled: false } } as never))
      platform.commands.run.mockResolvedValue('API_ERROR')
      await expect(modeSwitch.setOn(true)).rejects.toThrow()
    })
  })
})
